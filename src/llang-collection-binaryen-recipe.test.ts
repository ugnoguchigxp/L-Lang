import { describe, expect, test } from "bun:test";
import {
  COLLECTION_BINARYEN_RECIPES,
  canonicalCollectionBinaryenRecipe,
  collectionBinaryenRecipeHash,
  parseCollectionBinaryenRecipe,
} from "./llang-collection-binaryen-recipe";

describe("collection Binaryen recipes", () => {
  test("freezes five explicit and canonically hashed recipes", () => {
    expect(COLLECTION_BINARYEN_RECIPES.map((value) => value.recipeId)).toEqual([
      "baseline-v1",
      "binaryen-o2-v1",
      "binaryen-o3-v1",
      "binaryen-o2s-v1",
      "binaryen-o2sz-v1",
    ]);
    for (const value of COLLECTION_BINARYEN_RECIPES) {
      expect(canonicalCollectionBinaryenRecipe(value)).toBe(
        canonicalCollectionBinaryenRecipe(JSON.parse(JSON.stringify(value))),
      );
      expect(collectionBinaryenRecipeHash(value)).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  test("rejects implicit, unknown and unsafe settings", () => {
    const valid = COLLECTION_BINARYEN_RECIPES[1];
    if (!valid) throw new Error("missing fixture");
    for (const invalid of [
      { ...valid, unexpected: true },
      { ...valid, optimizeLevel: 5 },
      { ...valid, shrinkLevel: -1 },
      { ...valid, debugInfo: true },
      { ...valid, lowMemoryUnused: true },
      { ...valid, passes: ["flatten"] },
      { ...valid, binaryenVersion: "latest" },
      { ...valid, recipeId: "custom-v1" },
      { ...valid, recipeId: "baseline-v1" },
      Object.fromEntries(
        Object.entries(valid).filter(([key]) => key !== "shrinkLevel"),
      ),
    ])
      expect(() => parseCollectionBinaryenRecipe(invalid)).toThrow(
        "INVALID_COLLECTION_BINARYEN_RECIPE",
      );
  });
});
