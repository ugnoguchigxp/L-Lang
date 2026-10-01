import { copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { buildCollectionModuleProgram } from "../../src/llang-module-collection-build";

export const REVERSI_BUILD_DIR = join(import.meta.dir, "dist");

export async function buildReversi(outDir = REVERSI_BUILD_DIR): Promise<void> {
  const target = resolve(outDir);
  await mkdir(dirname(target), { recursive: true });
  const temporary = await mkdtemp(join(dirname(target), ".reversi-build-"));
  try {
    const staged = join(temporary, "bundle");
    await buildCollectionModuleProgram({
      entry: "reversi.semantic.llang.jsonc",
      root: import.meta.dir,
      entryName: "evaluate",
      target: "wasm",
      outDir: staged,
    });
    const browser = join(staged, "browser");
    await mkdir(browser);
    await Promise.all([
      copyFile(
        join(import.meta.dir, "index.html"),
        join(browser, "index.html"),
      ),
      copyFile(join(import.meta.dir, "style.css"), join(browser, "style.css")),
      copyFile(join(import.meta.dir, "bridge.js"), join(browser, "bridge.js")),
      copyFile(
        join(import.meta.dir, "wasm-runtime.js"),
        join(browser, "wasm-runtime.js"),
      ),
      copyFile(
        join(import.meta.dir, "reversi.semantic.llang.jsonc"),
        join(staged, "semantic-ir.json"),
      ),
      copyFile(
        join(import.meta.dir, "semantic-request.json"),
        join(staged, "semantic-request.json"),
      ),
    ]);
    // Build only Wasm; HTML/CSS and the plain JavaScript bridge are copied verbatim.
    await rm(target, { recursive: true, force: true });
    await rename(staged, target);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await buildReversi();
  console.log(`Wasm: ${join(REVERSI_BUILD_DIR, "wasm/program.wasm")}`);
  console.log(`Manifest: ${join(REVERSI_BUILD_DIR, "module-build.json")}`);
}
