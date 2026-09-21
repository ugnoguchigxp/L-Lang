import { fingerprintFor, stableJson } from "./stable-hash";

export const COLLECTION_BINARYEN_RECIPE_FORMAT =
  "llang-collection-binaryen-recipe" as const;
export const COLLECTION_BINARYEN_VERSION = "132.0.0" as const;

export type CollectionBinaryenRecipe = Readonly<{
  format: typeof COLLECTION_BINARYEN_RECIPE_FORMAT;
  schemaVersion: 1;
  recipeId: string;
  binaryenVersion: typeof COLLECTION_BINARYEN_VERSION;
  optimizeLevel: 0 | 1 | 2 | 3 | 4;
  shrinkLevel: 0 | 1 | 2;
  debugInfo: false;
  lowMemoryUnused: false;
  passes: readonly [];
}>;

const KEYS = [
  "binaryenVersion",
  "debugInfo",
  "format",
  "lowMemoryUnused",
  "optimizeLevel",
  "passes",
  "recipeId",
  "schemaVersion",
  "shrinkLevel",
] as const;
const RECIPE_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const FROZEN_LEVELS = new Map<string, readonly [number, number]>([
  ["baseline-v1", [0, 0]],
  ["binaryen-o2-v1", [2, 0]],
  ["binaryen-o3-v1", [3, 0]],
  ["binaryen-o2s-v1", [2, 1]],
  ["binaryen-o2sz-v1", [2, 2]],
]);

export function parseCollectionBinaryenRecipe(
  candidate: unknown,
): CollectionBinaryenRecipe {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    throw new Error("INVALID_COLLECTION_BINARYEN_RECIPE: expected object");
  const value = candidate as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== [...KEYS].sort().join(","))
    throw new Error(
      "INVALID_COLLECTION_BINARYEN_RECIPE: unexpected or missing fields",
    );
  if (
    value.format !== COLLECTION_BINARYEN_RECIPE_FORMAT ||
    value.schemaVersion !== 1 ||
    typeof value.recipeId !== "string" ||
    !RECIPE_ID.test(value.recipeId) ||
    value.binaryenVersion !== COLLECTION_BINARYEN_VERSION ||
    !Number.isInteger(value.optimizeLevel) ||
    (value.optimizeLevel as number) < 0 ||
    (value.optimizeLevel as number) > 4 ||
    !Number.isInteger(value.shrinkLevel) ||
    (value.shrinkLevel as number) < 0 ||
    (value.shrinkLevel as number) > 2 ||
    value.debugInfo !== false ||
    value.lowMemoryUnused !== false ||
    !Array.isArray(value.passes) ||
    value.passes.length !== 0
  )
    throw new Error("INVALID_COLLECTION_BINARYEN_RECIPE: invalid setting");
  const levels = FROZEN_LEVELS.get(value.recipeId);
  if (
    !levels ||
    value.optimizeLevel !== levels[0] ||
    value.shrinkLevel !== levels[1]
  )
    throw new Error("INVALID_COLLECTION_BINARYEN_RECIPE: unknown recipe tuple");
  return Object.freeze({
    format: COLLECTION_BINARYEN_RECIPE_FORMAT,
    schemaVersion: 1,
    recipeId: value.recipeId,
    binaryenVersion: COLLECTION_BINARYEN_VERSION,
    optimizeLevel: value.optimizeLevel as 0 | 1 | 2 | 3 | 4,
    shrinkLevel: value.shrinkLevel as 0 | 1 | 2,
    debugInfo: false,
    lowMemoryUnused: false,
    passes: Object.freeze([]) as readonly [],
  });
}

export function canonicalCollectionBinaryenRecipe(
  recipe: CollectionBinaryenRecipe,
): string {
  return stableJson(parseCollectionBinaryenRecipe(recipe));
}

export function collectionBinaryenRecipeHash(
  recipe: CollectionBinaryenRecipe,
): string {
  return fingerprintFor(parseCollectionBinaryenRecipe(recipe));
}

const recipe = (
  recipeId: string,
  optimizeLevel: CollectionBinaryenRecipe["optimizeLevel"],
  shrinkLevel: CollectionBinaryenRecipe["shrinkLevel"],
): CollectionBinaryenRecipe =>
  parseCollectionBinaryenRecipe({
    format: COLLECTION_BINARYEN_RECIPE_FORMAT,
    schemaVersion: 1,
    recipeId,
    binaryenVersion: COLLECTION_BINARYEN_VERSION,
    optimizeLevel,
    shrinkLevel,
    debugInfo: false,
    lowMemoryUnused: false,
    passes: [],
  });

export const COLLECTION_BINARYEN_RECIPES = Object.freeze([
  recipe("baseline-v1", 0, 0),
  recipe("binaryen-o2-v1", 2, 0),
  recipe("binaryen-o3-v1", 3, 0),
  recipe("binaryen-o2s-v1", 2, 1),
  recipe("binaryen-o2sz-v1", 2, 2),
]);

export function getCollectionBinaryenRecipe(
  recipeId: string,
): CollectionBinaryenRecipe {
  const found = COLLECTION_BINARYEN_RECIPES.find(
    (candidate) => candidate.recipeId === recipeId,
  );
  if (!found)
    throw new Error(`INVALID_COLLECTION_BINARYEN_RECIPE: unknown ${recipeId}`);
  return found;
}
