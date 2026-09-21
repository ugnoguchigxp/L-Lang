import { describe, expect, test } from "bun:test";
import { loadCollectionModuleProgram } from "./llang-module-collection-loader";
import { instantiateCollectionModule } from "./llang-module-collection-runtime";
import { emitUnoptimizedCollectionModuleWasm } from "./llang-module-collection-wasm";
import { COLLECTION_BINARYEN_RECIPES } from "./llang-collection-binaryen-recipe";
import { optimizeCollectionWasm } from "./llang-collection-optimized-wasm";

describe("isolated Collection Binaryen optimization", () => {
  test("product emission retains the frozen baseline decision", async () => {
    const program = await loadCollectionModuleProgram(
        "application/evaluate.llang.jsonc",
        "examples/module-order-batch",
        "evaluate",
      ),
      baseline = emitUnoptimizedCollectionModuleWasm(program);
    const { emitCollectionModuleWasm } = await import(
      "./llang-module-collection-wasm"
    );
    expect(emitCollectionModuleWasm(program).bytes).toEqual(baseline.bytes);
  });

  test("preserves the product interface and result for every frozen recipe", async () => {
    const program = await loadCollectionModuleProgram(
        "application/evaluate.llang.jsonc",
        "examples/module-order-batch",
        "evaluate",
      ),
      baseline = emitUnoptimizedCollectionModuleWasm(program),
      input = { values: [5, 1, 3, 2, 3], threshold: 2 },
      expected = { values: [2, 3, 3, 5], total: 13 };
    const results = await Promise.all(
      COLLECTION_BINARYEN_RECIPES.map((recipe) =>
        optimizeCollectionWasm(baseline.bytes, recipe),
      ),
    );
    for (const result of results)
      expect(
        instantiateCollectionModule(baseline.contract, result.bytes).evaluate(
          input,
        ),
      ).toEqual(expected);
    expect(results[0]?.bytes).toEqual(baseline.bytes);
  }, 120_000);

  test("is deterministic across concurrent isolated processes", async () => {
    const program = await loadCollectionModuleProgram(
        "application/evaluate.llang.jsonc",
        "examples/module-order-batch",
        "evaluate",
      ),
      baseline = emitUnoptimizedCollectionModuleWasm(program),
      candidates = COLLECTION_BINARYEN_RECIPES.filter(
        (recipe) => recipe.recipeId !== "baseline-v1",
      ),
      first = await Promise.all(
        candidates.map((recipe) =>
          optimizeCollectionWasm(baseline.bytes, recipe),
        ),
      ),
      second = await Promise.all(
        [...candidates]
          .reverse()
          .map((recipe) => optimizeCollectionWasm(baseline.bytes, recipe)),
      ),
      hashes = new Map(
        second.map((item) => [item.recipe.recipeId, item.wasmHash]),
      );
    for (const item of first) {
      const expected = hashes.get(item.recipe.recipeId);
      if (!expected) throw new Error("missing repeated recipe result");
      expect(item.wasmHash).toBe(expected);
    }
  }, 120_000);
});
