import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import Ajv2020 from "ajv/dist/2020";
import {
  buildEffectsModuleProgram,
  readEffectsModuleBuildManifest,
} from "./llang-module-effects-build";
import { loadEffectsModuleGraph } from "./llang-module-effects-graph";
import {
  createTypedIoExecutor,
  runTypedEffectsGraph,
} from "./llang-effects-typed-runtime";
import { LocalFileAdapter } from "./llang-io-file-adapter";
import { LoopbackHttpAdapter } from "./llang-io-http-adapter";
import { LBytes } from "./llang-effects-values";
import { BoundedPullStream } from "./llang-effects-concurrency";
import { runLlangCli } from "./llang-cli";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const operation = {
  id: "host.echo",
  version: 1,
  requestType: "i64",
  responseType: "i64",
  errorType: { code: "string" },
  effect: "host",
  resource: "none",
  cancellable: true,
  idempotent: true,
} as const;

const definition = (
  module: string,
  imports: unknown[],
  withOperation: boolean,
  value: string,
) => ({
  module,
  imports,
  operations: withOperation ? [operation] : [],
  resultType: "i64",
  nodes: [
    {
      kind: "await",
      operation: "host.echo",
      version: 1,
      request: { i64: value },
    },
  ],
});

const jsonSource = (
  module: string,
  entry: string | undefined,
  imports: unknown[],
  withOperation: boolean,
  value: string,
) =>
  `${JSON.stringify({ language: "l-lang", version: 5, kind: "module", profile: "module-effects-v1", ...(entry ? { entry } : {}), ...definition(module, imports, withOperation, value) }, null, 2)}\n`;
const tsSource = (
  entry: string,
  module: string,
  imports: unknown[],
  withOperation: boolean,
  value: string,
) =>
  `import { defineEffects } from "llang:effects";\nexport const ${entry} = defineEffects(${JSON.stringify(definition(module, imports, withOperation, value), null, 2)});\n`;

describe("module-effects-v1 source graph and target matrix", () => {
  test("published v5 schema accepts the typed graph shape", async () => {
    const schema = JSON.parse(
        await readFile("schemas/llang-module-v5.schema.json", "utf8"),
      ),
      validate = new Ajv2020({ strict: true }).compile(schema);
    expect(
      validate({
        language: "l-lang",
        version: 5,
        kind: "module",
        profile: "module-effects-v1",
        entry: "main",
        ...definition("app/main", [], true, "1"),
      }),
    ).toBe(true);
  });

  for (const [entryKind, childKind] of [
    ["jsonc", "jsonc"],
    ["ts", "ts"],
    ["jsonc", "ts"],
    ["ts", "jsonc"],
  ] as const) {
    test(`${entryKind} entry + ${childKind} dependency builds all targets`, async () => {
      const root = await mkdtemp(join(tmpdir(), "llang-effects-graph-"));
      temporary.push(root);
      const childName = `child.${childKind === "ts" ? "ts" : "llang.jsonc"}`,
        entryName = `main.${entryKind === "ts" ? "ts" : "llang.jsonc"}`;
      await writeFile(
        join(root, childName),
        childKind === "ts"
          ? tsSource("child", "lib/child", [], true, "1")
          : jsonSource("lib/child", undefined, [], true, "1"),
      );
      const imports = [{ source: `./${childName}`, module: "lib/child" }];
      await writeFile(
        join(root, entryName),
        entryKind === "ts"
          ? tsSource("main", "app/main", imports, false, "2")
          : jsonSource("app/main", "main", imports, false, "2"),
      );
      const graph = await loadEffectsModuleGraph(entryName, root, "main");
      expect(graph.modules.map((module) => module.module)).toEqual([
        "lib/child",
        "app/main",
      ]);
      expect(graph.sources).toHaveLength(2);
      const out = join(root, "dist");
      const manifest = await buildEffectsModuleProgram({
        entry: entryName,
        root,
        entryName: "main",
        target: "all",
        outDir: out,
      });
      expect(manifest.targets).toEqual(["typescript", "jsonc", "wasm"]);
      expect(manifest.sources).toHaveLength(2);
      expect(manifest.wasm?.contract).toMatchObject({
        layout: "typed-wire-v1",
        stateCount: 2,
      });
      expect(
        (await readEffectsModuleBuildManifest(join(out, "module-build.json")))
          .manifest.sourceSetHash,
      ).toBe(graph.sourceSetHash);
      const generated = (await import(
        `${pathToFileURL(join(out, "typescript/program.generated.ts")).href}?${Date.now()}`
      )) as {
        main: { nodes: readonly unknown[] };
        execute(host: {
          invoke(request: { payload: unknown }): Promise<unknown>;
        }): Promise<unknown>;
      };
      expect(generated.main.nodes).toHaveLength(2);
      expect(
        await generated.execute({ invoke: async (request) => request.payload }),
      ).toEqual({ i64: "2" });
      const generatedGraph = await loadEffectsModuleGraph(
        "program.llang.jsonc",
        join(out, "jsonc"),
        "main",
      );
      expect(generatedGraph.program.nodes).toHaveLength(2);
      expect(
        (
          await runTypedEffectsGraph({
            graph: generatedGraph,
            grant: {
              operations: new Set(["host.echo@1"]),
              wallClock: false,
            },
            execute: async (_operation, request) => request,
          })
        ).result,
      ).toBe(2n);
    });
  }

  test("source-level file and HTTP requests execute through typed adapters", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-effects-io-"));
    temporary.push(root);
    const server = createServer((_request, response) =>
      response.end("network"),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("missing address");
      const origin = `http://127.0.0.1:${address.port}`,
        source = {
          language: "l-lang",
          version: 5,
          kind: "module",
          profile: "module-effects-v1",
          module: "app/io",
          entry: "main",
          imports: [],
          operations: [],
          resultType: "bytes",
          nodes: [
            {
              kind: "file",
              action: "write",
              path: "value.bin",
              bytes: { bytes: "AQID" },
              replace: false,
            },
            { kind: "file", action: "read", path: "value.bin" },
            { kind: "http", url: `${origin}/data`, method: "GET" },
          ],
        };
      await writeFile(join(root, "main.llang.jsonc"), JSON.stringify(source));
      const graph = await loadEffectsModuleGraph(
          "main.llang.jsonc",
          root,
          "main",
        ),
        file = await LocalFileAdapter.create(root),
        http = new LoopbackHttpAdapter(new Set([origin]));
      try {
        const execution = await runTypedEffectsGraph({
          graph,
          grant: {
            operations: new Set([
              "file.read@1",
              "file.write@1",
              "http.request@1",
            ]),
            file: {
              roots: ["value.bin"],
              read: true,
              write: true,
              replace: false,
            },
            http: {
              origins: new Set([origin]),
              methods: new Set(["GET"]),
              requestHeaders: new Set(),
            },
            wallClock: false,
          },
          execute: createTypedIoExecutor({ file, http }),
        });
        expect(execution.result).toEqual(LBytes.encodeUtf8("network"));
        expect(new Uint8Array(await readFile(join(root, "value.bin")))).toEqual(
          new Uint8Array([1, 2, 3]),
        );
      } finally {
        await file.dispose();
      }
    } finally {
      server.close();
    }
  });

  test("CLI test replays typed requests and responses", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-effects-suite-"));
    temporary.push(root);
    const entry = "main.llang.jsonc";
    await writeFile(
      join(root, entry),
      jsonSource("app/main", "main", [], true, "2"),
    );
    const graph = await loadEffectsModuleGraph(entry, root, "main"),
      suite = join(root, "suite.json");
    await writeFile(
      suite,
      JSON.stringify({
        format: "llang-module-suite",
        version: 5,
        profile: "module-effects-v1",
        mode: "typed",
        interfaceHash: graph.interfaceHash,
        cases: [
          {
            id: "i64",
            events: [
              {
                operation: "host.echo",
                version: 1,
                request: { i64: "2" },
                response: { i64: "9" },
              },
            ],
            expected: { i64: "9" },
          },
        ],
      }),
    );
    const report = await runLlangCli([
      "module",
      "test",
      entry,
      "--root",
      root,
      "--entry",
      "main",
      "--suite",
      suite,
      "--profile",
      "module-effects-v1",
    ]);
    expect(report.exitCode).toBe(0);
    const out = join(root, "dist");
    await buildEffectsModuleProgram({
      entry,
      root,
      entryName: "main",
      target: "all",
      outDir: out,
    });
    const verified = await runLlangCli([
      "module",
      "verify",
      join(out, "module-build.json"),
      "--suite",
      suite,
    ]);
    expect(verified.exitCode).toBe(0);
  });

  test("task groups execute concurrently and preserve join order", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-effects-task-"));
    temporary.push(root);
    const source = {
      language: "l-lang",
      version: 5,
      kind: "module",
      profile: "module-effects-v1",
      module: "app/task",
      entry: "main",
      imports: [],
      operations: [operation],
      resultType: { kind: "list", element: "i64" },
      nodes: [
        {
          kind: "task",
          tasks: [
            {
              kind: "await",
              operation: "host.echo",
              version: 1,
              request: { i64: "1" },
            },
            {
              kind: "await",
              operation: "host.echo",
              version: 1,
              request: { i64: "2" },
            },
          ],
        },
      ],
    };
    await writeFile(join(root, "main.llang.jsonc"), JSON.stringify(source));
    const graph = await loadEffectsModuleGraph(
        "main.llang.jsonc",
        root,
        "main",
      ),
      started: bigint[] = [];
    const execution = await runTypedEffectsGraph({
      graph,
      grant: {
        operations: new Set(["host.echo@1"]),
        wallClock: false,
      },
      execute: async (_operation, request) => {
        started.push(request as bigint);
        await Bun.sleep(request === 1n ? 5 : 0);
        return request;
      },
    });
    expect(started).toEqual([1n, 2n]);
    expect(execution.result).toEqual([1n, 2n]);
    expect(
      runTypedEffectsGraph({
        graph,
        grant: { operations: new Set(), wallClock: false },
        execute: async (_operation, request) => request,
      }),
    ).rejects.toThrow("PERMISSION_DENIED");
  });

  test("stream nodes pull one bounded chunk at a time and close early", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-effects-stream-"));
    temporary.push(root);
    const pull = {
        ...operation,
        id: "host.pull",
        requestType: "i32",
        responseType: "bytes",
        resource: "stream",
      } as const,
      source = {
        language: "l-lang",
        version: 5,
        kind: "module",
        profile: "module-effects-v1",
        module: "app/stream",
        entry: "main",
        imports: [],
        operations: [pull],
        resultType: "bytes",
        nodes: [
          {
            kind: "stream",
            operation: "host.pull",
            version: 1,
            request: 64,
            maximumChunks: 3,
          },
        ],
      };
    await writeFile(join(root, "main.llang.jsonc"), JSON.stringify(source));
    const graph = await loadEffectsModuleGraph(
        "main.llang.jsonc",
        root,
        "main",
      ),
      chunks = [LBytes.from([1]), LBytes.from([2])],
      closed: number[] = [];
    const execution = await runTypedEffectsGraph({
      graph,
      grant: {
        operations: new Set(["host.pull@1"]),
        wallClock: false,
      },
      execute: async () => {
        throw new Error("stream must use pull path");
      },
      openStream: async () =>
        new BoundedPullStream(
          async () =>
            chunks.length
              ? { eof: false, bytes: chunks.shift() as LBytes }
              : { eof: true },
          () => {
            closed.push(1);
          },
        ),
    });
    expect(execution.result).toEqual(LBytes.from([1, 2]));
    expect(closed).toEqual([1]);
  });

  test("rejects a second path that impersonates an already loaded module", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-effects-duplicate-"));
    temporary.push(root);
    await writeFile(
      join(root, "first.llang.jsonc"),
      jsonSource("lib/shared", undefined, [], true, "1"),
    );
    await writeFile(
      join(root, "second.llang.jsonc"),
      jsonSource("lib/shared", undefined, [], true, "2"),
    );
    await writeFile(
      join(root, "main.llang.jsonc"),
      jsonSource(
        "app/main",
        "main",
        [
          { source: "./first.llang.jsonc", module: "lib/shared" },
          { source: "./second.llang.jsonc", module: "lib/shared" },
        ],
        false,
        "3",
      ),
    );
    expect(
      loadEffectsModuleGraph("main.llang.jsonc", root, "main"),
    ).rejects.toThrow("duplicate module lib/shared");
  });

  test("rejects unknown keys in source-level I/O nodes", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-effects-keys-"));
    temporary.push(root);
    const source = {
      language: "l-lang",
      version: 5,
      kind: "module",
      profile: "module-effects-v1",
      module: "app/main",
      entry: "main",
      imports: [],
      operations: [],
      resultType: "bytes",
      nodes: [
        {
          kind: "http",
          url: "https://example.com",
          method: "GET",
          typo: true,
        },
      ],
    };
    await writeFile(join(root, "main.llang.jsonc"), JSON.stringify(source));
    expect(
      loadEffectsModuleGraph("main.llang.jsonc", root, "main"),
    ).rejects.toThrow("unknown http node key typo");
  });
});
