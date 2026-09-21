import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020";
import {
  regenerateCollectionRecipeDecision,
  runCollectionRecipeExperiment,
} from "./llang-collection-recipe-experiment";
import { summarizeCollectionRecipeSamples } from "./llang-collection-recipe-report";
import { stableJson } from "./stable-hash";

const load = (path: string) => readFile(path, "utf8").then(JSON.parse);

describe("frozen Collection Binaryen experiment", () => {
  test("validates all checked-in evidence and regenerates the decision", async () => {
    const [recipeSchema, recipeListSchema, corpusSchema, benchmarkSchema] =
        await Promise.all([
          load("schemas/collection-binaryen-recipe-v1.schema.json"),
          load("schemas/collection-binaryen-recipes-v1.schema.json"),
          load("schemas/collection-binaryen-corpus-v1.schema.json"),
          load("schemas/collection-binaryen-benchmark-v1.schema.json"),
        ]),
      ajv = new Ajv2020({ strict: true, allErrors: true });
    ajv.addSchema(recipeSchema);
    const validateRecipe = ajv.getSchema(recipeSchema.$id);
    if (!validateRecipe) throw new Error("missing recipe schema");
    expect(
      validateRecipe({
        format: "llang-collection-binaryen-recipe",
        schemaVersion: 1,
        recipeId: "custom-v1",
        binaryenVersion: "132.0.0",
        optimizeLevel: 2,
        shrinkLevel: 0,
        debugInfo: false,
        lowMemoryUnused: false,
        passes: [],
      }),
    ).toBe(false);
    for (const [schemaPath, valuePath] of [
      [
        "schemas/collection-binaryen-recipes-v1.schema.json",
        "benchmarks/collection-binaryen-v1/recipes.json",
      ],
      [
        "schemas/collection-binaryen-corpus-v1.schema.json",
        "benchmarks/collection-binaryen-v1/corpus.json",
      ],
      [
        "schemas/collection-binaryen-benchmark-v1.schema.json",
        "benchmarks/collection-binaryen-v1/benchmark.json",
      ],
      [
        "schemas/collection-binaryen-freeze-v1.schema.json",
        "benchmarks/collection-binaryen-v1/freeze.json",
      ],
      [
        "schemas/collection-binaryen-observation-v1.schema.json",
        "benchmarks/collection-binaryen-v1/observations/darwin-arm64.json",
      ],
      [
        "schemas/collection-binaryen-decision-v1.schema.json",
        "benchmarks/collection-binaryen-v1/decision.json",
      ],
    ] as const) {
      const schema = await load(schemaPath),
        validate =
          schemaPath === "schemas/collection-binaryen-recipes-v1.schema.json"
            ? ajv.compile(recipeListSchema)
            : ajv.compile(schema),
        value = await load(valuePath);
      expect(validate(value), ajv.errorsText(validate.errors)).toBe(true);
    }
    void corpusSchema;
    void benchmarkSchema;

    const [observation, decision, regenerated] = await Promise.all([
      load("benchmarks/collection-binaryen-v1/observations/darwin-arm64.json"),
      load("benchmarks/collection-binaryen-v1/decision.json"),
      regenerateCollectionRecipeDecision(),
    ]);
    expect(observation.canonical).toBe(true);
    expect(observation.samples).toHaveLength(675);
    expect(summarizeCollectionRecipeSamples(observation.samples)).toEqual(
      observation.summary,
    );
    expect(stableJson(regenerated)).toBe(stableJson(decision));
    expect(decision.outcome).toBe("retain-baseline");
    expect(decision.selectedRecipeId).toBeNull();

    const decisionSchema = await load(
        "schemas/collection-binaryen-decision-v1.schema.json",
      ),
      validateDecision = new Ajv2020({ strict: true, allErrors: true }).compile(
        decisionSchema,
      );
    expect(
      validateDecision({
        ...decision,
        selectedRecipeId: "binaryen-o3-v1",
      }),
    ).toBe(false);
    expect(
      validateDecision({
        ...decision,
        outcome: "adopt",
        selectedRecipeId: null,
      }),
    ).toBe(false);
  });

  test("regenerates the exact deterministic freeze", async () => {
    const [generated, recorded] = await Promise.all([
      runCollectionRecipeExperiment(),
      load("benchmarks/collection-binaryen-v1/freeze.json"),
    ]);
    expect(stableJson(generated.freeze)).toBe(stableJson(recorded));
  }, 120_000);
});
