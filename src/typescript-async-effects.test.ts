import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runLlangCli } from "./llang-cli";
import { decodeEffectWire } from "./llang-effects-ir";
import { runTypedEffectsGraph } from "./llang-effects-typed-runtime";
import {
  emitTypedEffectsWasm,
  TypedEffectsRuntime,
} from "./llang-effects-state-machine";
import { SESSION_STATUS } from "./llang-effects-wasm";
import { buildEffectsModuleProgram } from "./llang-module-effects-build";
import {
  loadEffectsModuleGraph,
  parseEffectsGraphTypeScript,
} from "./llang-module-effects-graph";

const fixtureRoot = resolve(
    import.meta.dir,
    "../examples/typescript-wasm-core",
  ),
  temporary: string[] = [];
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
  requestType: "string",
  responseType: "string",
  errorType: { code: "string" },
  effect: "host",
  resource: "none",
  cancellable: true,
  idempotent: true,
};
const source = (
  body: string,
  returns = "string",
  operations: unknown[] = [operation],
) => `
  import { defineEffects, invoke } from "llang:effects";
  export const definition = defineEffects({ module: "app/async", operations: ${JSON.stringify(operations)} });
  export async function main(): Promise<${returns}> { ${body} }
`;

describe("TypeScript async source to existing native effects ABI", () => {
  test("sequential await, typed const and return lower, build, replay and execute", async () => {
    const graph = await loadEffectsModuleGraph("async.ts", fixtureRoot, "main"),
      root = await mkdtemp(join(tmpdir(), "typescript-async-"));
    temporary.push(root);
    const manifest = await buildEffectsModuleProgram({
      entry: "async.ts",
      root: fixtureRoot,
      entryName: "main",
      target: "all",
      outDir: join(root, "dist"),
    });
    expect(manifest.wasm?.contract).toMatchObject({ layout: "typed-wire-v1" });
    const lowered = emitTypedEffectsWasm(
        graph.program,
        graph.manifest.operations,
      ),
      bytes = new Uint8Array(
        await readFile(join(root, "dist/wasm/program.wasm")),
      ),
      runtime = new TypedEffectsRuntime(bytes, lowered.states);
    expect(Array.from(bytes)).toEqual(Array.from(lowered.bytes));
    try {
      const first = runtime.start();
      if (!first.request) throw new Error("missing first request");
      expect(decodeEffectWire({ kind: "string" }, first.request.payload)).toBe(
        "ready",
      );
      const second = runtime.resume(first.request, true, "READY");
      if (!second.request) throw new Error("missing second request");
      expect(decodeEffectWire({ kind: "string" }, second.request.payload)).toBe(
        "done",
      );
      expect(runtime.resume(second.request, true, "DONE")).toEqual({
        status: SESSION_STATUS.DONE,
        result: "DONE",
      });
    } finally {
      runtime.dispose();
    }
    const requests: unknown[] = [];
    const generated = await import(
      pathToFileURL(join(root, "dist/typescript/program.generated.ts")).href
    );
    expect(
      await generated.execute({
        invoke: async (request: { payload: string }) => {
          requests.push(request.payload);
          return request.payload.toUpperCase();
        },
      }),
    ).toBe("DONE");
    expect(requests).toEqual(["ready", "done"]);
    // Only the repository-owned fixture is evaluated here. Compilation itself
    // never imports or evaluates a source module.
    const original = await readFile(join(fixtureRoot, "async.ts"), "utf8"),
      originalRoot = await mkdtemp(
        join(tmpdir(), "typescript-async-original-"),
      );
    temporary.push(originalRoot);
    await writeFile(
      join(originalRoot, "original.ts"),
      original.replace('"llang:effects"', '"./host.ts"'),
    );
    await writeFile(
      join(originalRoot, "host.ts"),
      `
      export const requests: string[] = [];
      export function defineEffects<T>(definition: T): T { return definition; }
      export async function invoke<T>(_operation: string, _version: number, request: string): Promise<T> {
        requests.push(request); return request.toUpperCase() as T;
      }
    `,
    );
    const originalModule = await import(
        pathToFileURL(join(originalRoot, "original.ts")).href
      ),
      hostModule = await import(
        pathToFileURL(join(originalRoot, "host.ts")).href
      );
    expect(await originalModule.main()).toBe("DONE");
    expect(hostModule.requests).toEqual(["ready", "done"]);
    const execution = await runTypedEffectsGraph({
      graph,
      grant: { operations: new Set(["host.echo@1"]), wallClock: false },
      execute: async (_operation, request) => String(request).toUpperCase(),
    });
    expect(execution.result).toBe("DONE");
    let calls = 0;
    await expect(
      runTypedEffectsGraph({
        graph,
        grant: { operations: new Set(), wallClock: false },
        execute: async (_operation, request) => {
          calls++;
          return request;
        },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(0);
    const suite = join(root, "suite.json");
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
            id: "sequential",
            events: [
              {
                operation: "host.echo",
                version: 1,
                request: "ready",
                response: "READY",
              },
              {
                operation: "host.echo",
                version: 1,
                request: "done",
                response: "DONE",
              },
            ],
            expected: "DONE",
          },
        ],
      }),
    );
    const report = await runLlangCli([
      "module",
      "test",
      "async.ts",
      "--root",
      fixtureRoot,
      "--entry",
      "main",
      "--suite",
      suite,
      "--profile",
      "module-effects-v1",
    ]);
    expect(report.exitCode).toBe(0);
  });

  test("return await and explicit record and list response types are checked", () => {
    expect(
      parseEffectsGraphTypeScript(
        source(`return await invoke<string>("host.echo", 1, "ready");`),
      ).resultType,
    ).toEqual({ kind: "string" });
    const typedOperation = {
      ...operation,
      requestType: "f64",
      responseType: {
        kind: "record",
        fields: { values: { kind: "list", element: "i32" } },
      },
    };
    const input = source(
      `return await invoke<Result>("host.echo", 1, 1.5);`,
      "Result",
      [typedOperation],
    ).replace(
      "export async",
      "interface Result { values: number[]; } export async",
    );
    expect(parseEffectsGraphTypeScript(input).resultType.kind).toBe("record");
    expect(
      parseEffectsGraphTypeScript(
        source(
          `const req: Request = { values: [1, 2] }; return await invoke<string>("host.echo", 1, req);`,
          "string",
          [
            {
              ...operation,
              requestType: {
                kind: "record",
                fields: { values: { kind: "list", element: "i32" } },
              },
            },
          ],
        ).replace(
          "export async",
          "interface Request { values: number[]; } export async",
        ),
      ).nodes[0],
    ).toMatchObject({ request: { values: [1, 2] } });
    expect(() =>
      parseEffectsGraphTypeScript(
        input.replace("values: number[]", "values: string[]"),
      ),
    ).toThrow("annotation");
  });

  test("response types, dependencies, control flow, npm and unawaited calls fail explicitly", () => {
    const invalid = [
      source(`return await invoke<number>("host.echo", 1, "ready");`, "number"),
      source(
        `const response: string = await invoke<string>("host.echo", 1, "ready"); return await invoke<string>("host.echo", 1, response);`,
      ),
      source(
        `await invoke<string>("host.echo", 1, "ready"); return "literal";`,
      ),
      source(`if (true) return await invoke<string>("host.echo", 1, "ready");`),
      source(
        `invoke<string>("host.echo", 1, "ready"); return await invoke<string>("host.echo", 1, "done");`,
      ),
      source(`return await invoke<string>("host.missing", 1, "ready");`),
      source(
        `const req: number = "ready"; return await invoke<string>("host.echo", 1, req);`,
      ),
      source(`return await invoke<string>("host.echo", 1, "ready");`).replace(
        "main()",
        "main(input: string)",
      ),
      source(`return await invoke<string>("host.echo", 1, "ready");`).replace(
        '"llang:effects"',
        '"some-package"',
      ),
      source(`return await invoke<string>("host.echo", 1, "ready");`).replace(
        "main()",
        "invoke()",
      ),
      source(`return await invoke<string>("host.echo", 1, "ready");`).replace(
        "return await",
        "return await ;",
      ),
      source(
        `const unused: number = "wrong"; return await invoke<string>("host.echo", 1, "ready");`,
      ),
      source(
        `const unused: number[] = [1, "wrong"]; return await invoke<string>("host.echo", 1, "ready");`,
      ),
      source(
        `const unused: { value: string } = { value: 1 }; return await invoke<string>("host.echo", 1, "ready");`,
      ),
      source(`return await invoke?.<string>("host.echo", 1, "ready");`),
      source(`return await invoke<string>("host.echo", 1, "ready");`).replace(
        "defineEffects({",
        "defineEffects?.({",
      ),
    ];
    for (const input of invalid)
      expect(() => parseEffectsGraphTypeScript(input)).toThrow();
  });
});
