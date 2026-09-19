import { afterEach, describe, expect, test } from "bun:test";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { executeLlangCli, runLlangCli } from "./llang-cli";
import { inspectEffectsModuleBundle } from "./llang-effects-bundle-inspection";
import { buildEffectsModuleProgram } from "./llang-module-effects-build";
import { digest } from "./wasm-contract";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const operation = (
  id: string,
  effect: "clock" | "host",
  responseType: unknown = "i64",
) => ({
  id,
  version: 1,
  requestType: "string",
  responseType,
  errorType: { code: "string" },
  effect,
  resource: "none",
  cancellable: true,
  idempotent: true,
});

const graphSource = {
  language: "l-lang",
  version: 5,
  kind: "module",
  profile: "module-effects-v1",
  module: "inspection/main",
  entry: "main",
  imports: [],
  operations: [
    operation("host.echo", "host"),
    operation("clock.read", "clock"),
    operation("host.stream", "host", "bytes"),
  ],
  resultType: "bytes",
  nodes: [
    {
      kind: "await",
      operation: "host.echo",
      version: 1,
      request: "safe-value",
    },
    {
      kind: "file",
      action: "write",
      path: "output.bin",
      bytes: { bytes: "AQID" },
      replace: false,
    },
    { kind: "file", action: "read", path: "output.bin" },
    {
      kind: "http",
      url: "https://example.test/a*/quoted",
      method: "POST",
      headers: { "x-note": 'quoted"\n__proto__' },
      body: { bytes: "" },
    },
    {
      kind: "task",
      tasks: [
        {
          kind: "await",
          operation: "host.echo",
          version: 1,
          request: "task-one",
        },
        {
          kind: "await",
          operation: "clock.read",
          version: 1,
          request: "task-two",
        },
      ],
    },
    {
      kind: "stream",
      operation: "host.stream",
      version: 1,
      request: "stream-input",
      maximumChunks: 2,
    },
  ],
} as const;

async function built(target: "all" | "wasm" = "all") {
  const root = await mkdtemp(join(tmpdir(), "llang-effects-inspection-"));
  roots.push(root);
  const entry = join(root, "main.llang.jsonc"),
    out = join(root, "bundle");
  await writeFile(entry, JSON.stringify(graphSource));
  const manifest = await buildEffectsModuleProgram({
    entry: "main.llang.jsonc",
    root,
    entryName: "main",
    target,
    outDir: out,
  });
  return {
    root,
    entry,
    out,
    manifest,
    manifestPath: join(out, "module-build.json"),
  };
}

async function rewriteArtifact(
  item: Awaited<ReturnType<typeof built>>,
  path: string,
  value: string | Uint8Array,
) {
  const absolute = join(item.out, path),
    bytes = typeof value === "string" ? new TextEncoder().encode(value) : value,
    manifest = JSON.parse(await readFile(item.manifestPath, "utf8"));
  await writeFile(absolute, value);
  const record = manifest.artifacts.find(
    (artifact: { path: string }) => artifact.path === path,
  );
  record.hash = digest(bytes);
  record.bytes = bytes.length;
  if (path === "wasm/program.wasm") manifest.wasm.wasmHash = digest(bytes);
  await writeFile(item.manifestPath, JSON.stringify(manifest));
}

describe("module-effects-v1 bundle inspection", () => {
  test("reconstructs TypeScript and Wasm while reporting effects without authority", async () => {
    const item = await built();
    await rm(item.entry);
    const report = await inspectEffectsModuleBundle(item.manifestPath);
    expect(report).toMatchObject({
      format: "llang-effects-bundle-inspection",
      version: 1,
      profile: "module-effects-v1",
      abi: "llang-effects-session-v1",
      authority: {
        declaredEffects: ["clock", "file", "host", "http"],
        runtimeGrant: "not-provided",
      },
      resources: {
        memoryPages: 512,
        wireBytes: 2_097_152,
        chunkBytes: 65_536,
        hostRequests: 1_024,
        tasks: 1_024,
        fuel: 10_000_000,
      },
      reconstruction: {
        flattenedJsonc: "checked",
        typescriptBytes: "checked",
        typescriptTypecheck: "checked",
        wasmBytes: "checked",
        wasmContract: "checked",
        wasmStates: "checked",
      },
      inspection: {
        integrity: "checked-by-regeneration",
        execution: "not-run",
        transcript: "not-provided",
        credentials: "not-accessed",
        apiCalls: 0,
      },
    });
    expect(report.typescript.projectionHash).toBe(
      digest(report.typescript.source),
    );
    expect(report.semantics.programHash).toBe(item.manifest.programHash);
    expect(report.semantics.loweredHash).toBe(item.manifest.loweredHash);
    expect(report.authority.requiredOperations.map(({ id }) => id)).toEqual([
      "clock.read",
      "file.read",
      "file.write",
      "host.echo",
      "host.stream",
      "http.request",
    ]);
    expect(report.continuationStates).toContainEqual(
      expect.objectContaining({
        kind: "task",
        internal: "task.join",
        requiresHostGrant: false,
      }),
    );
    expect(
      report.continuationStates
        .filter((state) => state.kind !== "task")
        .every((state) => state.requiresHostGrant),
    ).toBe(true);
    expect(
      report.continuationStates.flatMap((state) =>
        "operation" in state && state.operation ? [state.operation.id] : [],
      ),
    ).toEqual([
      "host.echo",
      "file.write",
      "file.read",
      "http.request",
      "host.stream",
    ]);
    expect(
      report.continuationStates.flatMap((state) =>
        "taskOperations" in state
          ? state.taskOperations.map((item) => ({
              id: item.operation.id,
              requiresHostGrant: item.requiresHostGrant,
            }))
          : [],
      ),
    ).toEqual([
      { id: "host.echo", requiresHostGrant: true },
      { id: "clock.read", requiresHostGrant: true },
    ]);
    expect(report.authority).not.toHaveProperty("fileRoot");
    expect(report.authority).not.toHaveProperty("origins");
    expect(report.typescript.source).toContain('quoted\\"\\n__proto__');
  });

  test("is relocation-independent and publishes the report after the projection", async () => {
    const item = await built();
    const first = await inspectEffectsModuleBundle(item.manifestPath),
      moved = join(item.root, "moved"),
      output = join(item.root, "inspection");
    await cp(item.out, moved, { recursive: true });
    const second = await inspectEffectsModuleBundle(
      join(moved, "module-build.json"),
      output,
    );
    expect(second).toEqual(first);
    expect(await readFile(join(output, "program.inspection.ts"), "utf8")).toBe(
      first.typescript.source,
    );
    expect(
      JSON.parse(
        await readFile(join(output, "effects-inspection.json"), "utf8"),
      ),
    ).toEqual(first);
  });

  test("rejects individual manifest, JSONC, TypeScript, and Wasm changes", async () => {
    for (const role of ["manifest", "jsonc", "typescript", "wasm"] as const) {
      const item = await built(),
        output = join(item.root, `failed-${role}`);
      if (role === "manifest") {
        const manifest = JSON.parse(await readFile(item.manifestPath, "utf8"));
        manifest.entry = "other/module#main";
        await writeFile(item.manifestPath, JSON.stringify(manifest));
      } else {
        const path =
          role === "jsonc"
            ? "jsonc/program.llang.jsonc"
            : role === "typescript"
              ? "typescript/program.generated.ts"
              : "wasm/program.wasm";
        await writeFile(join(item.out, path), "tampered");
      }
      await expect(
        inspectEffectsModuleBundle(item.manifestPath, output),
      ).rejects.toThrow();
      await expect(access(output)).rejects.toThrow();
    }
  });

  test("detects coordinated TypeScript and manifest hash tampering", async () => {
    const item = await built(),
      path = "typescript/program.generated.ts",
      original = await readFile(join(item.out, path), "utf8");
    await rewriteArtifact(
      item,
      path,
      original.replace("safe-value", "changed"),
    );
    await expect(inspectEffectsModuleBundle(item.manifestPath)).rejects.toThrow(
      "regenerated TypeScript",
    );
  });

  test("detects coordinated JSONC and TypeScript tampering through Wasm regeneration", async () => {
    const item = await built(),
      jsonPath = "jsonc/program.llang.jsonc",
      tsPath = "typescript/program.generated.ts",
      jsonc = await readFile(join(item.out, jsonPath), "utf8"),
      typescript = await readFile(join(item.out, tsPath), "utf8");
    await rewriteArtifact(
      item,
      jsonPath,
      jsonc.replace("safe-value", "changed"),
    );
    await rewriteArtifact(
      item,
      tsPath,
      typescript.replace("safe-value", "changed"),
    );
    await expect(inspectEffectsModuleBundle(item.manifestPath)).rejects.toThrow(
      "regenerated Wasm",
    );
  });

  test("assigns a different identity to another internally consistent bundle", async () => {
    const first = await built(),
      second = await built(),
      source = JSON.parse(await readFile(second.entry, "utf8"));
    source.nodes[0].request = "different-consistent-value";
    await writeFile(second.entry, JSON.stringify(source));
    await rm(second.out, { recursive: true });
    await buildEffectsModuleProgram({
      entry: "main.llang.jsonc",
      root: second.root,
      entryName: "main",
      target: "all",
      outDir: second.out,
    });
    const firstReport = await inspectEffectsModuleBundle(first.manifestPath),
      secondReport = await inspectEffectsModuleBundle(second.manifestPath);
    expect(secondReport.bundleIdentityHash).not.toBe(
      firstReport.bundleIdentityHash,
    );
    expect(secondReport.inspection.authenticity).toContain(
      "externally trusted",
    );
  });

  test("does not instantiate Wasm, start workers, fetch, or import the projection", async () => {
    const item = await built(),
      nativeInstantiate = WebAssembly.instantiate,
      NativeWorker = globalThis.Worker,
      nativeFetch = globalThis.fetch;
    let instantiateCalls = 0,
      workerCalls = 0,
      fetchCalls = 0;
    class FailingWorker {
      constructor() {
        workerCalls++;
        throw new Error("inspection must not start a worker");
      }
    }
    try {
      WebAssembly.instantiate = ((..._args: unknown[]) => {
        instantiateCalls++;
        throw new Error("inspection must not instantiate Wasm");
      }) as typeof WebAssembly.instantiate;
      globalThis.Worker = FailingWorker as unknown as typeof Worker;
      globalThis.fetch = (async () => {
        fetchCalls++;
        throw new Error("inspection must not fetch");
      }) as unknown as typeof fetch;
      await expect(
        inspectEffectsModuleBundle(item.manifestPath),
      ).resolves.toMatchObject({ inspection: { execution: "not-run" } });
      expect({ instantiateCalls, workerCalls, fetchCalls }).toEqual({
        instantiateCalls: 0,
        workerCalls: 0,
        fetchCalls: 0,
      });
    } finally {
      WebAssembly.instantiate = nativeInstantiate;
      globalThis.Worker = NativeWorker;
      globalThis.fetch = nativeFetch;
    }
  });

  test("rejects incomplete targets and a linear compatibility bundle", async () => {
    const incomplete = await built("wasm");
    await expect(
      inspectEffectsModuleBundle(incomplete.manifestPath),
    ).rejects.toThrow("--target all");

    const root = await mkdtemp(join(tmpdir(), "llang-effects-linear-"));
    roots.push(root);
    const source = {
      language: "l-lang",
      version: 5,
      kind: "module",
      profile: "module-effects-v1",
      module: "linear/main",
      entry: "main",
      operations: [
        {
          id: "host.increment",
          version: 1,
          requestType: { value: "i32" },
          responseType: { value: "i32" },
          errorType: { code: "string" },
          effect: "host",
          resource: "none",
          cancellable: true,
          idempotent: true,
        },
      ],
      initial: 0,
      steps: [
        {
          operation: "host.increment",
          version: 1,
          payload: 1,
          combine: "replace",
        },
      ],
    };
    await writeFile(join(root, "linear.llang.jsonc"), JSON.stringify(source));
    await buildEffectsModuleProgram({
      entry: "linear.llang.jsonc",
      root,
      entryName: "main",
      target: "all",
      outDir: join(root, "bundle"),
    });
    await expect(
      inspectEffectsModuleBundle(join(root, "bundle/module-build.json")),
    ).rejects.toThrow("typed-wire-v1");
  });

  test("rejects unsupported manifest versions and profiles", async () => {
    for (const mutation of [{ version: 4 }, { profile: "module-value-v1" }]) {
      const item = await built(),
        manifest = JSON.parse(await readFile(item.manifestPath, "utf8"));
      Object.assign(manifest, mutation);
      await writeFile(item.manifestPath, JSON.stringify(manifest));
      await expect(
        inspectEffectsModuleBundle(item.manifestPath),
      ).rejects.toThrow("effects module manifest");
    }
  });

  test("rejects contained, symlink-parent, and existing outputs without damage", async () => {
    const item = await built();
    await expect(
      inspectEffectsModuleBundle(
        item.manifestPath,
        join(item.out, "inspection"),
      ),
    ).rejects.toThrow("outside the bundle");

    const external = join(item.root, "external");
    await mkdir(external);
    const linked = join(item.root, "linked");
    await symlink(external, linked);
    await expect(
      inspectEffectsModuleBundle(item.manifestPath, join(linked, "inspection")),
    ).rejects.toThrow("symbolic link");

    const existing = join(item.root, "existing"),
      sentinel = join(existing, "keep.txt");
    await mkdir(existing);
    await writeFile(sentinel, "keep");
    await expect(
      inspectEffectsModuleBundle(item.manifestPath, existing),
    ).rejects.toThrow();
    expect(await readFile(sentinel, "utf8")).toBe("keep");
  });

  test("rejects symbolic-link manifests and artifacts without output", async () => {
    const manifestItem = await built(),
      manifestTarget = join(manifestItem.out, "manifest-target.json"),
      manifestOutput = join(manifestItem.root, "manifest-output");
    await rename(manifestItem.manifestPath, manifestTarget);
    await symlink(manifestTarget, manifestItem.manifestPath);
    await expect(
      inspectEffectsModuleBundle(manifestItem.manifestPath, manifestOutput),
    ).rejects.toThrow("effects module manifest");
    await expect(access(manifestOutput)).rejects.toThrow();

    const artifactItem = await built(),
      wasmPath = join(artifactItem.out, "wasm/program.wasm"),
      wasmTarget = join(artifactItem.root, "program-target.wasm"),
      artifactOutput = join(artifactItem.root, "artifact-output");
    await rename(wasmPath, wasmTarget);
    await symlink(wasmTarget, wasmPath);
    await expect(
      inspectEffectsModuleBundle(artifactItem.manifestPath, artifactOutput),
    ).rejects.toThrow();
    await expect(access(artifactOutput)).rejects.toThrow();
  });

  test("cleans owned partial output but preserves a replacement directory", async () => {
    const item = await built(),
      failed = join(item.root, "failed");
    await expect(
      inspectEffectsModuleBundle(
        item.manifestPath,
        failed,
        async (path, value) => {
          await writeFile(path, value);
          throw new Error("injected write failure");
        },
      ),
    ).rejects.toThrow("injected write failure");
    await expect(access(failed)).rejects.toThrow();

    const replaced = join(item.root, "replaced"),
      displaced = join(item.root, "displaced"),
      sentinel = join(replaced, "keep.txt");
    await expect(
      inspectEffectsModuleBundle(item.manifestPath, replaced, async (path) => {
        await rename(resolve(path, ".."), displaced);
        await mkdir(resolve(path, ".."));
        await writeFile(sentinel, "keep");
        throw new Error("injected replacement");
      }),
    ).rejects.toThrow("injected replacement");
    expect(await readFile(sentinel, "utf8")).toBe("keep");
    await access(displaced);
  });

  test("detects a bundle change before publishing the final report", async () => {
    const item = await built(),
      output = join(item.root, "changed-during-output");
    await expect(
      inspectEffectsModuleBundle(
        item.manifestPath,
        output,
        async (path, value) => {
          await writeFile(path, value);
          const manifest = JSON.parse(
            await readFile(item.manifestPath, "utf8"),
          );
          manifest.entry = "replacement#main";
          await writeFile(item.manifestPath, JSON.stringify(manifest));
        },
      ),
    ).rejects.toThrow();
    await expect(access(output)).rejects.toThrow();
  });

  test("detects a bundle change while publishing the final report", async () => {
    const item = await built(),
      output = join(item.root, "changed-during-report");
    let writes = 0;
    await expect(
      inspectEffectsModuleBundle(
        item.manifestPath,
        output,
        async (path, value) => {
          await writeFile(path, value);
          writes++;
          if (writes === 2) {
            const manifest = JSON.parse(
              await readFile(item.manifestPath, "utf8"),
            );
            manifest.entry = "replacement#main";
            await writeFile(item.manifestPath, JSON.stringify(manifest));
          }
        },
      ),
    ).rejects.toThrow();
    expect(writes).toBe(2);
    await expect(access(output)).rejects.toThrow();
  });

  test("detects an output file change without a directory replacement", async () => {
    const item = await built(),
      output = join(item.root, "changed-output-file");
    let writes = 0;
    await expect(
      inspectEffectsModuleBundle(
        item.manifestPath,
        output,
        async (path, value) => {
          await writeFile(path, value);
          writes++;
          if (writes === 2)
            await writeFile(join(output, "program.inspection.ts"), "tampered");
        },
      ),
    ).rejects.toThrow("output changed during publication");
    await expect(access(output)).rejects.toThrow();
  });

  test("supports JSON-only and output CLI forms and rejects misuse", async () => {
    const item = await built();
    expect(
      await runLlangCli(["module", "inspect", item.manifestPath]),
    ).toMatchObject({
      exitCode: 0,
      output: { inspection: { execution: "not-run", apiCalls: 0 } },
    });
    const output = join(item.root, "cli-inspection");
    expect(
      await runLlangCli([
        "module",
        "inspect",
        item.manifestPath,
        "--out-dir",
        output,
      ]),
    ).toMatchObject({ exitCode: 0 });
    expect(
      await executeLlangCli([
        "module",
        "inspect",
        item.manifestPath,
        "--bad",
        output,
        "--json",
      ]),
    ).toMatchObject({
      exitCode: 2,
      output: { ok: false, error: { code: "INVALID_ARGUMENT" } },
    });
    for (const invalid of [
      ["--out-dir"],
      ["extra", "value"],
      ["--out-dir", output, "--out-dir", `${output}-again`],
    ])
      expect(
        await executeLlangCli([
          "module",
          "inspect",
          item.manifestPath,
          ...invalid,
          "--json",
        ]),
      ).toMatchObject({
        exitCode: 2,
        output: { ok: false, error: { code: "INVALID_ARGUMENT" } },
      });

    const incomplete = await built("wasm");
    expect(
      await executeLlangCli([
        "module",
        "inspect",
        incomplete.manifestPath,
        "--json",
      ]),
    ).toMatchObject({ exitCode: 2, output: { ok: false } });
  });
});
