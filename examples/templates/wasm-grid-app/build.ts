import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { buildCollectionModuleProgram } from "../../../src/llang-module-collection-build";
import { digest } from "../../../src/wasm-contract";
import { readGridConfig } from "./config";

/** Shared tooling: never copies or compiles browser support files into dist. */
export async function buildGridApp(
  appDir: string,
  outDir = join(appDir, "dist"),
) {
  const root = resolve(appDir);
  const target = resolve(outDir);
  if (target === root || root.startsWith(`${target}/`))
    throw new Error("Build output must not contain application sources");
  const config = await readGridConfig(root);
  if (
    config.entry !== "game.semantic.llang.jsonc" ||
    config.tests.entry !== "tests.semantic.llang.jsonc"
  )
    throw new Error("Expected canonical game and test SemanticIR paths");
  await mkdir(dirname(target), { recursive: true });
  const temp = await mkdtemp(join(dirname(target), ".grid-build-"));
  try {
    const staged = join(temp, "bundle");
    await buildCollectionModuleProgram({
      root,
      entry: config.entry,
      entryName: "evaluate",
      target: "wasm",
      outDir: staged,
    });
    await buildCollectionModuleProgram({
      root,
      entry: config.tests.entry,
      entryName: "evaluate",
      target: "wasm",
      outDir: join(staged, "tests"),
    });
    if (config.tests.sequence)
      await buildCollectionModuleProgram({
        root,
        entry: config.tests.entry,
        entryName: config.tests.sequence.entryName,
        target: "wasm",
        outDir: join(staged, "tests/sequence"),
      });
    const sourceHashes: Record<string, string> = {};
    for (const name of [
      "prompt.md",
      "app.json",
      "style.css",
      config.entry,
      config.tests.entry,
    ])
      sourceHashes[name] = digest(
        new Uint8Array(await readFile(join(root, name))),
      );
    await writeFile(
      join(staged, "provenance.json"),
      `${JSON.stringify({ format: "semantic-grid-provenance", version: 1, sourceHashes }, null, 2)}\n`,
    );
    await rm(target, { recursive: true, force: true });
    await rename(staged, target);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const appDir = process.argv[2];
  if (!appDir)
    throw new Error(
      "Usage: bun run examples/templates/wasm-grid-app/build.ts examples/<app>",
    );
  await buildGridApp(appDir);
  console.log(`Saved game and test Wasm: ${resolve(appDir, "dist")}`);
}
