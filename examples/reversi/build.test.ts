import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCollectionModuleBuildManifest } from "../../src/llang-module-collection-build";
import { buildReversi } from "./build";
import { createReversiDemo } from "./server";
let root: string, buildDir: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "reversi-build-test-"));
  buildDir = join(root, "dist");
  await buildReversi(buildDir);
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
test("saved JSON IR builds only native Wasm and copies plain bridge without TS compilation", async () => {
  const saved = await readCollectionModuleBuildManifest(
    join(buildDir, "module-build.json"),
  );
  expect(saved.manifest.targets).toEqual(["wasm"]);
  expect(saved.manifest.sources.map((source) => source.path)).toEqual([
    "reversi.semantic.llang.jsonc",
  ]);
  const bytes = new Uint8Array(
    await Bun.file(join(buildDir, "wasm/program.wasm")).arrayBuffer(),
  );
  expect([...bytes.slice(0, 8)]).toEqual([0, 97, 115, 109, 1, 0, 0, 0]);
  expect(WebAssembly.validate(bytes)).toBe(true);
  expect(await Bun.file(join(buildDir, "semantic-ir.json")).text()).toBe(
    await Bun.file(
      join(import.meta.dir, "reversi.semantic.llang.jsonc"),
    ).text(),
  );
  expect(await Bun.file(join(buildDir, "browser/bridge.js")).text()).toBe(
    await Bun.file(join(import.meta.dir, "bridge.js")).text(),
  );
  expect(await Bun.file(join(buildDir, "browser/client.js")).exists()).toBe(
    false,
  );
  const serve = await createReversiDemo({ buildDir });
  expect((await serve(new Request("http://local/program.wasm"))).status).toBe(
    200,
  );
});
test("rebuild keeps deterministic Wasm hash", async () => {
  const before = await readCollectionModuleBuildManifest(
    join(buildDir, "module-build.json"),
  );
  await buildReversi(buildDir);
  const after = await readCollectionModuleBuildManifest(
    join(buildDir, "module-build.json"),
  );
  expect(after.manifest.wasm?.wasmHash).toBe(before.manifest.wasm?.wasmHash);
});
test("server rejects missing and corrupt Wasm instead of recompiling", async () => {
  await expect(
    createReversiDemo({ buildDir: join(root, "missing") }),
  ).rejects.toThrow("reversi:build");
  const broken = join(root, "broken");
  await cp(buildDir, broken, { recursive: true });
  await Bun.write(
    join(broken, "wasm/program.wasm"),
    new Uint8Array([0, 97, 115, 109]),
  );
  await expect(createReversiDemo({ buildDir: broken })).rejects.toThrow(
    "reversi:build",
  );
});

test("server rejects an IR copy that no longer matches the compiled source hash", async () => {
  const broken = join(root, "changed-ir");
  await cp(buildDir, broken, { recursive: true });
  await Bun.write(join(broken, "semantic-ir.json"), "{}");
  await expect(createReversiDemo({ buildDir: broken })).rejects.toThrow(
    "Semantic IR",
  );
});
