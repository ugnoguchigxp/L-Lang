import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import binaryen from "binaryen";
import { parseCollectionBinaryenRecipe } from "./llang-collection-binaryen-recipe";
import { parseStrictJsonObject } from "./llang-jsonc";

const MAX_WASM_BYTES = 4 * 1024 * 1024;

export async function runCollectionOptimizeChild(
  inputArgument: string,
  recipeArgument: string,
  outputArgument: string,
  timingArgument: string,
): Promise<void> {
  const input = resolve(inputArgument),
    recipePath = resolve(recipeArgument),
    output = resolve(outputArgument),
    timing = resolve(timingArgument),
    parents = await Promise.all([
      realpath(dirname(input)),
      realpath(dirname(recipePath)),
      realpath(dirname(output)),
      realpath(dirname(timing)),
    ]);
  if (new Set(parents).size !== 1)
    throw new Error("COLLECTION_OPTIMIZER_PATH: files must share one root");
  const [inputInfo, recipeInfo, outputInfo, timingInfo] = await Promise.all([
    lstat(input),
    lstat(recipePath),
    lstat(output).catch(() => undefined),
    lstat(timing).catch(() => undefined),
  ]);
  if (
    !inputInfo.isFile() ||
    inputInfo.isSymbolicLink() ||
    !recipeInfo.isFile() ||
    recipeInfo.isSymbolicLink() ||
    (outputInfo ?? timingInfo) ||
    inputInfo.size > MAX_WASM_BYTES ||
    recipeInfo.size > 16 * 1024
  )
    throw new Error("COLLECTION_OPTIMIZER_PATH: invalid input or output");
  const [inputBytes, recipeText] = await Promise.all([
      readFile(input),
      readFile(recipePath, "utf8"),
    ]),
    recipe = parseCollectionBinaryenRecipe(
      parseStrictJsonObject(recipeText, recipePath),
    );
  if (recipe.recipeId === "baseline-v1")
    throw new Error("COLLECTION_OPTIMIZER_RECIPE: baseline bypasses optimizer");
  if (!WebAssembly.validate(inputBytes))
    throw new Error("COLLECTION_OPTIMIZER_INPUT: invalid Wasm");

  binaryen.setOptimizeLevel(recipe.optimizeLevel);
  binaryen.setShrinkLevel(recipe.shrinkLevel);
  binaryen.setDebugInfo(recipe.debugInfo);
  binaryen.setLowMemoryUnused(recipe.lowMemoryUnused);
  binaryen.setOptimizeStackIR(false);
  binaryen.clearPassArguments();
  binaryen.clearPassesToSkip();
  const readStart = performance.now(),
    module = binaryen.readBinary(inputBytes),
    readMs = performance.now() - readStart;
  try {
    const preValidationStart = performance.now();
    if (!module.validate())
      throw new Error("COLLECTION_OPTIMIZER_INPUT: Binaryen validation failed");
    const preValidationMs = performance.now() - preValidationStart,
      optimizeStart = performance.now();
    module.optimize();
    const optimizeMs = performance.now() - optimizeStart,
      postValidationStart = performance.now();
    if (!module.validate())
      throw new Error(
        "COLLECTION_OPTIMIZER_OUTPUT: Binaryen validation failed",
      );
    const postValidationMs = performance.now() - postValidationStart,
      emitStart = performance.now(),
      optimized = new Uint8Array(module.emitBinary());
    if (
      optimized.length > MAX_WASM_BYTES ||
      !WebAssembly.validate(optimized as BufferSource)
    )
      throw new Error("COLLECTION_OPTIMIZER_OUTPUT: invalid Wasm");
    const emitMs = performance.now() - emitStart;
    await Promise.all([
      writeFile(output, optimized, { flag: "wx", mode: 0o600 }),
      writeFile(
        timing,
        `${JSON.stringify({ readMs, preValidationMs, optimizeMs, postValidationMs, emitMs })}\n`,
        { flag: "wx", mode: 0o600 },
      ),
    ]);
  } finally {
    module.dispose();
  }
}

if (import.meta.main) {
  const [input, recipe, output, timing, ...extra] = process.argv.slice(2);
  if (!input || !recipe || !output || !timing || extra.length)
    throw new Error(
      "usage: llang-collection-optimize-child <input.wasm> <recipe.json> <output.wasm> <timing.json>",
    );
  await runCollectionOptimizeChild(input, recipe, output, timing);
}
