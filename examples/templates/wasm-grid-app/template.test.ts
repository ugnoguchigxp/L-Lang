import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readCollectionModuleBuildManifest } from "../../../src/llang-module-collection-build";
import { instantiateCollectionModule } from "../../../src/llang-module-collection-runtime";
import { buildGridApp } from "./build";
import { readGridConfig } from "./config";
import { createGridApp } from "./server";
import { runGridTests } from "./test";

const app = resolve(import.meta.dir, "../../tetris");
let temporary: string, output: string;
beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "semantic-grid-test-"));
  output = join(temporary, "dist");
  await buildGridApp(app, output);
});
afterAll(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

test("game and test JSON SemanticIR build directly to saved native Wasm without browser/template copies", async () => {
  const game = await readCollectionModuleBuildManifest(
    join(output, "module-build.json"),
  );
  const tests = await readCollectionModuleBuildManifest(
    join(output, "tests/module-build.json"),
  );
  expect(game.manifest.targets).toEqual(["wasm"]);
  expect(tests.manifest.targets).toEqual(["wasm"]);
  expect(game.manifest.sources.map((s) => s.path)).toEqual([
    "game.semantic.llang.jsonc",
  ]);
  expect(tests.manifest.sources.map((s) => s.path).sort()).toEqual([
    "game.semantic.llang.jsonc",
    "tests.semantic.llang.jsonc",
  ]);
  expect((await readdir(output)).sort()).toEqual([
    "module-build.json",
    "provenance.json",
    "tests",
    "wasm",
  ]);
  for (const manifest of [game, tests]) {
    const wasm = manifest.manifest.wasm;
    if (!wasm) throw new Error("Missing Wasm");
    const bytes = manifest.artifactBytes.get(wasm.path);
    if (!bytes) throw new Error("Missing Wasm bytes");
    expect(WebAssembly.validate(bytes)).toBe(true);
    expect(
      WebAssembly.Module.imports(
        new WebAssembly.Module(bytes.slice().buffer as ArrayBuffer),
      ),
    ).toEqual([]);
  }
});

test("test assertions execute from their own SemanticIR-derived Wasm", async () => {
  const result = await runGridTests(app, output);
  expect(result.cases).toBeGreaterThanOrEqual(24);
  expect(result.caseChecks).toBe(result.cases * 3);
  expect(result.sequenceChecks).toBeGreaterThan(0);
  expect(result.passed).toBe(result.caseChecks + result.sequenceChecks);
  const saved = await readCollectionModuleBuildManifest(
    join(output, "tests/module-build.json"),
  );
  const artifact = saved.manifest.wasm;
  if (!artifact) throw new Error("Missing test Wasm");
  const bytes = saved.artifactBytes.get(artifact.path);
  if (!bytes) throw new Error("Missing test bytes");
  const runtime = instantiateCollectionModule(artifact.contract, bytes);
  expect(runtime.evaluate({ case: 999, seed: 1 })).toEqual({
    id: "unknown",
    passed: false,
  });
  const seq = await readCollectionModuleBuildManifest(
    join(output, "tests/sequence/module-build.json"),
  );
  const game = await readCollectionModuleBuildManifest(
    join(output, "module-build.json"),
  );
  const config = await readGridConfig(app);
  const native = (saved: typeof seq) => {
    const wasm = saved.manifest.wasm;
    const bytes = wasm && saved.artifactBytes.get(wasm.path);
    if (!wasm || !bytes) throw new Error("Missing Wasm");
    return instantiateCollectionModule(wasm.contract, bytes);
  };
  const before = (
    native(game).evaluate({
      state: config.initialState,
      action: config.resetAction,
    }) as { state: unknown }
  ).state;
  // An unchanged state cannot satisfy a property requiring four newly locked cells.
  expect(native(seq).evaluate({ before, after: before })).toEqual({
    id: "lock-conservation",
    passed: false,
    complete: false,
  });
});

test("test SemanticIR detects corrupted shapes and line scoring instead of returning unconditional success", async () => {
  for (const name of ["shape", "lock"] as const) {
    const copy = join(temporary, `mutant-${name}`);
    await cp(app, copy, { recursive: true });
    const source = await Bun.file(
      join(copy, "game.semantic.llang.jsonc"),
    ).json();
    const fn = source.functions.find(
      (item: { name: string }) => item.name === name,
    );
    if (!fn) throw new Error(`Missing mutation target ${name}`);
    if (name === "shape") {
      // Every kind incorrectly becomes I; independent shape assertions must reject it.
      fn.body = {
        statements: [],
        result: {
          kind: "list",
          elementType: "i32",
          elements: [4, 5, 6, 7].map((value) => ({
            kind: "literal",
            type: "i32",
            value,
          })),
        },
      };
    } else {
      let changed = 0;
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
          for (const item of node) walk(item);
          return;
        }
        if (!node || typeof node !== "object") return;
        const value = node as Record<string, unknown>;
        if (
          value.kind === "literal" &&
          value.type === "i32" &&
          value.value === 300
        ) {
          value.value = 301;
          changed++;
        }
        for (const child of Object.values(value)) walk(child);
      };
      walk(fn);
      expect(changed).toBeGreaterThan(0);
    }
    await Bun.write(
      join(copy, "game.semantic.llang.jsonc"),
      JSON.stringify(source),
    );
    const mutantOutput = join(temporary, `mutant-${name}-dist`);
    await buildGridApp(copy, mutantOutput);
    await expect(runGridTests(copy, mutantOutput)).rejects.toThrow();
  }
});

test("generic browser ABI transport agrees with validated native runtime across an action sequence", async () => {
  const saved = await readCollectionModuleBuildManifest(
    join(output, "module-build.json"),
  );
  const artifact = saved.manifest.wasm;
  if (!artifact) throw new Error("Missing Wasm");
  const bytes = saved.artifactBytes.get(artifact.path);
  if (!bytes) throw new Error("Missing Wasm bytes");
  const reference = instantiateCollectionModule(artifact.contract, bytes);
  const runtimePath = join(import.meta.dir, "wasm-runtime.js");
  const { createNativeRuntime } = await import(runtimePath);
  const browser = createNativeRuntime(artifact.contract, bytes);
  const config = await readGridConfig(app);
  let state: unknown = config.initialState;
  for (const action of [
    7, 1, 2, 4, 8, 3, 0, 6, 0, 1, 6, 5, 5, 4, 1, 1, 5, 2, 5, -99, 99, 7,
  ]) {
    const input = { state, action };
    const expected = reference.evaluate(input);
    const actual = browser.evaluate(input);
    expect(actual).toEqual(expected);
    expect(actual.cells).toHaveLength(200);
    expect(actual.preview).toHaveLength(16);
    state = actual.state;
  }
});

test("static server reads shared templates, exposes only fixed GET/HEAD routes, and serves saved Wasm", async () => {
  const fetch = await createGridApp(app, output);
  for (const route of [
    "/",
    "/index.html",
    "/browser.js",
    "/timer.js",
    "/wasm-runtime.js",
    "/template.css",
    "/style.css",
    "/app.json",
    "/semantic-ir.json",
    "/test-ir.json",
    "/prompt.md",
    "/module-build.json",
    "/program.wasm",
  ]) {
    expect((await fetch(new Request(`http://local${route}`))).status).toBe(200);
    const head = await fetch(
      new Request(`http://local${route}`, { method: "HEAD" }),
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(
      (await fetch(new Request(`http://local${route}`, { method: "POST" })))
        .status,
    ).toBe(405);
  }
  expect(
    await (await fetch(new Request("http://local/browser.js"))).text(),
  ).toBe(await Bun.file(join(import.meta.dir, "browser.js")).text());
  const wasm = await fetch(new Request("http://local/program.wasm"));
  expect(wasm.headers.get("content-type")).toBe("application/wasm");
  for (const route of [
    "/api/evaluate",
    "/build.ts",
    "/server.ts",
    "/../package.json",
    "/test-wasm",
  ])
    expect((await fetch(new Request(`http://local${route}`))).status).toBe(404);
});

test("failed test IR compilation preserves the last complete build", async () => {
  const copy = join(temporary, "bad-build");
  await cp(app, copy, { recursive: true });
  const before = await Bun.file(
    join(output, "wasm/program.wasm"),
  ).arrayBuffer();
  await Bun.write(join(copy, "tests.semantic.llang.jsonc"), "{}");
  await expect(buildGridApp(copy, output)).rejects.toThrow();
  expect(
    await Bun.file(join(output, "wasm/program.wasm")).arrayBuffer(),
  ).toEqual(before);
});

test("edited app source and corrupt artifact are rejected until rebuilt", async () => {
  const copy = join(temporary, "changed-source");
  await cp(app, copy, { recursive: true });
  await Bun.write(join(copy, "style.css"), "changed");
  await expect(createGridApp(copy, output)).rejects.toThrow("Changed source");
  await Bun.write(join(copy, "game.semantic.llang.jsonc"), "{}");
  await expect(runGridTests(copy, output)).rejects.toThrow("Stale test Wasm");
  const broken = join(temporary, "broken-dist");
  await cp(output, broken, { recursive: true });
  await Bun.write(
    join(broken, "wasm/program.wasm"),
    new Uint8Array([0, 97, 115, 109]),
  );
  await expect(createGridApp(app, broken)).rejects.toThrow();
});

test("rebuilding yields the same saved Wasm bytes", async () => {
  const first = await Bun.file(join(output, "wasm/program.wasm")).arrayBuffer();
  await buildGridApp(app, join(temporary, "repeat"));
  expect(
    await Bun.file(join(temporary, "repeat/wasm/program.wasm")).arrayBuffer(),
  ).toEqual(first);
});
