import { join, resolve } from "node:path";
import { readCollectionModuleBuildManifest } from "../../../src/llang-module-collection-build";
import { instantiateCollectionModule } from "../../../src/llang-module-collection-runtime";
import { digest } from "../../../src/wasm-contract";
import { readGridConfig } from "./config";

/** Assertions live in test SemanticIR, executed as native Wasm per case. */
export async function runGridTests(
  appDir: string,
  buildDir = join(appDir, "dist"),
) {
  const config = await readGridConfig(appDir);
  const ids: string[] = config.tests.cases;
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => typeof id !== "string" || !id)
  )
    throw new Error("Test case IDs must be nonempty and unique");
  const saved = await readCollectionModuleBuildManifest(
    join(buildDir, "tests/module-build.json"),
  );
  const artifact = saved.manifest.wasm;
  if (
    saved.manifest.targets.join() !== "wasm" ||
    saved.manifest.sources.some(
      (source) => !source.path.endsWith(".llang.jsonc"),
    )
  )
    throw new Error("Test SemanticIR must compile directly to Wasm");
  for (const source of saved.manifest.sources) {
    const current = new Uint8Array(
      await Bun.file(join(appDir, source.path)).arrayBuffer(),
    );
    if (digest(current) !== source.hash)
      throw new Error(`Stale test Wasm: ${source.path}`);
  }
  if (!artifact) throw new Error("Missing test Wasm");
  const bytes = saved.artifactBytes.get(artifact.path);
  if (!bytes) throw new Error("Missing test bytes");
  const runtime = instantiateCollectionModule(artifact.contract, bytes);
  let checks = 0;
  for (const seed of [1, 17, 2026])
    for (let index = 0; index < ids.length; index++) {
      const result = runtime.evaluate({ case: index, seed }) as {
        id: string;
        passed: boolean;
      };
      if (result.id !== ids[index] || result.passed !== true)
        throw new Error(
          `SemanticIR test failed: ${ids[index]} seed=${seed}: ${JSON.stringify(result)}`,
        );
      checks++;
    }
  const caseChecks = checks;
  let sequenceChecks = 0;
  const sequence = config.tests.sequence;
  if (sequence) {
    const predicate = await readCollectionModuleBuildManifest(
      join(buildDir, "tests/sequence/module-build.json"),
    );
    const game = await readCollectionModuleBuildManifest(
      join(buildDir, "module-build.json"),
    );
    for (const manifest of [predicate, game])
      for (const source of manifest.manifest.sources) {
        const bytes = new Uint8Array(
          await Bun.file(join(appDir, source.path)).arrayBuffer(),
        );
        if (digest(bytes) !== source.hash)
          throw new Error(`Stale sequence Wasm: ${source.path}`);
      }
    const instantiate = (saved: typeof predicate) => {
      const wasm = saved.manifest.wasm;
      const bytes = wasm && saved.artifactBytes.get(wasm.path);
      if (!wasm || !bytes || saved.manifest.targets.join() !== "wasm")
        throw new Error("Missing sequence native Wasm");
      return instantiateCollectionModule(wasm.contract, bytes);
    };
    const evaluateGame = instantiate(game),
      assertStep = instantiate(predicate);
    let before = (
      evaluateGame.evaluate({
        state: config.initialState,
        action: config.resetAction,
      }) as { state: unknown }
    ).state;
    let complete = false;
    for (let step = 0; step < sequence.maxSteps; step++) {
      const after = (
        evaluateGame.evaluate({ state: before, action: sequence.action }) as {
          state: unknown;
        }
      ).state;
      const result = assertStep.evaluate({ before, after }) as {
        id: string;
        passed: boolean;
        complete: boolean;
      };
      if (
        result.id !== sequence.id ||
        result.passed !== true ||
        typeof result.complete !== "boolean"
      )
        throw new Error(
          `SemanticIR sequence failed at step ${step}: ${JSON.stringify(result)}`,
        );
      sequenceChecks++;
      before = after;
      if (result.complete) {
        complete = true;
        break;
      }
    }
    if (!complete)
      throw new Error("SemanticIR sequence did not complete within its bound");
  }
  checks += sequenceChecks;
  return {
    cases: ids.length,
    seeds: 3,
    caseChecks,
    sequenceChecks,
    checks,
    passed: checks,
  };
}
if (import.meta.main) {
  const appDir = process.argv[2];
  if (!appDir)
    throw new Error(
      "Usage: bun run examples/templates/wasm-grid-app/test.ts examples/<app>",
    );
  console.log(JSON.stringify(await runGridTests(resolve(appDir)), null, 2));
}
