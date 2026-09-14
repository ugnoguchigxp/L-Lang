import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compileSemanticSource } from "./semantic-compiler";
import { readSemanticResolution } from "./semantic-resolution-reader";
import { runWasmCli } from "./wasm-cli";
import { buildWasm } from "./wasm-compiler";
import { customerBody } from "./wasm-test-fixture";

const repo = resolve(import.meta.dir, "..");
const childEnv = {
  ...process.env,
  OPENAI_API_KEY: "",
  AZURE_OPENAI_API_KEY: "",
};

async function fixture(run: (root: string, source: string) => Promise<void>) {
  const parent = resolve(repo, ".semantic", "wasm-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, "case-"));
  const source = resolve(root, "semantic.ts");
  const original = await readFile(
    resolve(repo, "examples/active-customer/semantic.ts"),
    "utf8",
  );
  await writeFile(
    source,
    original.replace(
      '"../../src/dsl"',
      JSON.stringify(resolve(repo, "src/dsl").replaceAll("\\", "/")),
    ),
  );
  try {
    // Test-only resolution fixture. Command execution is covered by existing
    // compiler integration tests; no model accuracy or promotion claim is made.
    await compileSemanticSource({
      sourcePath: source,
      workspaceRoot: root,
      mode: "build",
      provider: "fixture",
      model: "fixture",
      countsAsApiCall: false,
      commandRunner: async () => {},
      resolve: async () => ({
        elaboration: {
          outcome: "resolved",
          body: customerBody,
          diagnostics: [],
        },
        response: null,
        rawOutput: {},
      }),
    });
    await run(root, source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function child(args: string[], cwd = repo) {
  const p = Bun.spawn([process.execPath, ...args], {
    cwd,
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { stdout, stderr, code };
}

describe("Wasm offline end-to-end", () => {
  test(
    "reads legacy resolution, builds twice in separate processes, runs without compiler imports",
    async () =>
      fixture(async (root, source) => {
        const lock = resolve(root, "semantic.lock");
        const before = await readFile(lock, "utf8");
        const sourceBefore = await readFile(source, "utf8");
        const cli = resolve(repo, "src/wasm-cli.ts");
        const first = await child(
          [cli, "build", source, "--out-dir", resolve(root, "first")],
          root,
        );
        expect(first.code).toBe(0);
        const second = await child(
          [cli, "build", source, "--out-dir", resolve(root, "second")],
          root,
        );
        expect(second.code).toBe(0);
        const a = JSON.parse(first.stdout);
        const b = JSON.parse(second.stdout);
        expect(a.wasmHash).toBe(b.wasmHash);
        expect(a.apiCalls).toBe(0);
        expect(await readFile(a.manifest, "utf8")).toBe(
          await readFile(b.manifest, "utf8"),
        );
        const input = resolve(root, "input.json");
        await writeFile(
          input,
          '{"status":"active","deletedAt":null,"email":""}',
        );
        const run = await child(
          [cli, "run", a.manifest, "--input", input],
          root,
        );
        expect(run.code).toBe(0);
        expect(JSON.parse(run.stdout)).toEqual({ result: true });
        const isolated = resolve(root, "isolated.ts");
        await writeFile(
          isolated,
          `import { plugin } from "bun";
plugin({ name: "forbid-compiler", setup(b) { b.onResolve({ filter: /binaryen|typescript|openai|semantic-source|wasm-compiler/ }, () => { throw new Error("compiler dependency in runtime"); }); } });
const { loadWasmPredicate } = await import(${JSON.stringify(resolve(repo, "src/wasm-runtime.ts"))});
const p = await loadWasmPredicate(${JSON.stringify(a.manifest)});
console.log(JSON.stringify([p.evaluate({status:"active",deletedAt:null,email:""}),p.evaluate({status:"active",deletedAt:null,email:undefined})]));`,
        );
        const standalone = await child([isolated], root);
        expect(standalone.code).toBe(0);
        expect(JSON.parse(standalone.stdout)).toEqual([true, false]);
        expect(await readFile(lock, "utf8")).toBe(before);
        expect(await readFile(source, "utf8")).toBe(sourceBefore);
        const build = await buildWasm(source, resolve(root, "third"), root);
        expect(build.wasmHash).toBe(a.wasmHash);
      }),
    30000,
  );

  test(
    "refuses changed source, missing lock, and tampered resolved IR without writing output",
    async () =>
      fixture(async (root, source) => {
        const lockPath = resolve(root, "semantic.lock");
        const lockText = await readFile(lockPath, "utf8");
        const sourceText = await readFile(source, "utf8");
        await writeFile(source, `${sourceText}\n// changed\n`);
        await expect(readSemanticResolution(source, root)).rejects.toThrow(
          "LOCK_STALE",
        );
        await writeFile(source, sourceText);
        await expect(
          readSemanticResolution(source, root, resolve(root, "missing.lock")),
        ).rejects.toThrow("LOCK_MISSING");
        for (const key of [
          "sourceHash",
          "typeHash",
          "testHash",
          "promptHash",
          "contextHash",
          "conceptHash",
        ]) {
          const changed = JSON.parse(lockText);
          const candidate = Object.values(changed.entries)[0] as Record<
            string,
            unknown
          >;
          candidate[key] = "0".repeat(64);
          await writeFile(lockPath, JSON.stringify(changed));
          await expect(readSemanticResolution(source, root)).rejects.toThrow(
            "LOCK_STALE",
          );
        }
        const lock = JSON.parse(lockText);
        const entry = Object.values(lock.entries)[0] as { resolvedIr: unknown };
        entry.resolvedIr = { kind: "not", condition: customerBody };
        await writeFile(lockPath, JSON.stringify(lock));
        await expect(
          buildWasm(source, resolve(root, "bad"), root),
        ).rejects.toThrow("INVALID_IR");
        expect(
          await Bun.file(resolve(root, "bad/manifest.json")).exists(),
        ).toBe(false);
        entry.resolvedIr = { kind: "call" };
        await writeFile(lockPath, JSON.stringify(lock));
        await expect(readSemanticResolution(source, root)).rejects.toThrow();
        await writeFile(lockPath, lockText);
        expect((await readSemanticResolution(source, root)).body).toEqual(
          customerBody,
        );
      }),
    30000,
  );
  test("public CLI build uses a current checked-in resolution", async () => {
    const parent = resolve(repo, ".semantic", "wasm-cli-tests");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(resolve(parent, "out-"));
    try {
      const result = await runWasmCli([
        "build",
        resolve(repo, "examples/active-customer/semantic.ts"),
        "--out-dir",
        root,
      ]);
      expect(result).toHaveProperty("apiCalls", 0);
      const bad = await child([resolve(repo, "src/wasm-cli.ts"), "bad"]);
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain("USAGE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);
});
