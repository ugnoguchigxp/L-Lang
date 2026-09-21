import { describe, expect, test } from "bun:test";
import {
  decideCollectionBinaryenRecipe,
  summarizeCollectionRecipeSamples,
  type CollectionRecipeSample,
} from "./llang-collection-recipe-report";

const sample = (
  recipeId: string,
  caseId: string,
  index: number,
  endToEndMs: number,
  buildMs = 1,
): CollectionRecipeSample => ({
  recipeId,
  caseId,
  partition: "holdout",
  sample: index,
  buildMs,
  loadMs: 0.1,
  emitMs: 0.2,
  optimizerReadMs: 0.1,
  optimizerPreValidationMs: 0.1,
  optimizerCoreMs: buildMs,
  optimizerPostValidationMs: 0.1,
  optimizerEmitMs: 0.1,
  compileMs: 1,
  instantiateMs: 1,
  encodeMs: 1,
  hostValidationMs: 1,
  evaluateMs: endToEndMs / 2,
  decodeMs: 1,
  endToEndMs,
  artifactBytes: recipeId === "baseline-v1" ? 100 : 110,
  linearMemoryBytes: 8_388_608,
  arenaPeakBytes: 1_024,
  allocationCalls: 2,
  allocationBytes: 128,
  copyCalls: 1,
  copyBytes: 64,
  peakRssBytes: 100,
});

describe("Collection Binaryen report", () => {
  test("summarizes raw samples deterministically", () => {
    const values = [1, 2, 9].map((value, index) =>
        sample("baseline-v1", "fold-medium", index, value),
      ),
      first = summarizeCollectionRecipeSamples(values),
      second = summarizeCollectionRecipeSamples(values);
    expect(first).toEqual(second);
    expect(first[0]?.endToEndMs.median).toBe(2);
    expect(first[0]?.endToEndMs.mad).toBe(1);
    expect(first[0]?.endToEndMs.p95).toBe(9);
    expect(summarizeCollectionRecipeSamples([...values].reverse())).toEqual(
      first,
    );
  });

  test("requires conservative holdout improvement after safety gates", () => {
    const rows: CollectionRecipeSample[] = [];
    for (const caseId of ["fold-medium", "fold-maximum", "sort-maximum"])
      for (let index = 0; index < 9; index++) {
        rows.push(sample("baseline-v1", caseId, index, 100));
        rows.push(sample("candidate", caseId, index, 80));
      }
    const decision = decideCollectionBinaryenRecipe(
      summarizeCollectionRecipeSamples(rows),
      [
        {
          recipeId: "baseline-v1",
          correctness: true,
          rawAbi: true,
          reproducible: true,
        },
        {
          recipeId: "candidate",
          correctness: true,
          rawAbi: true,
          reproducible: true,
        },
      ],
      ["baseline-v1", "candidate"],
      {
        baselineRecipeId: "baseline-v1",
        maximumRegressionPercent: 5,
        requiredImprovementPercent: 10,
        maximumArtifactRatio: 1.5,
        maximumMemoryRegressionPercent: 10,
      },
    );
    expect(decision.outcome).toBe("adopt");
    expect(decision.selectedRecipeId).toBe("candidate");
  });

  test("does not let speed rescue a failed safety check", () => {
    const rows: CollectionRecipeSample[] = [];
    for (let index = 0; index < 5; index++) {
      rows.push(sample("baseline-v1", "fold-maximum", index, 100));
      rows.push(sample("candidate", "fold-maximum", index, 10));
    }
    const decision = decideCollectionBinaryenRecipe(
      summarizeCollectionRecipeSamples(rows),
      [
        {
          recipeId: "baseline-v1",
          correctness: true,
          rawAbi: true,
          reproducible: true,
        },
        {
          recipeId: "candidate",
          correctness: false,
          rawAbi: true,
          reproducible: true,
        },
      ],
      ["baseline-v1", "candidate"],
      {
        baselineRecipeId: "baseline-v1",
        maximumRegressionPercent: 5,
        requiredImprovementPercent: 10,
        maximumArtifactRatio: 1.5,
        maximumMemoryRegressionPercent: 10,
      },
    );
    expect(decision.outcome).toBe("retain-baseline");
  });

  test("rejects duplicate sample and decision matrix identities", () => {
    const duplicate = sample("baseline-v1", "fold-maximum", 0, 100);
    expect(() =>
      summarizeCollectionRecipeSamples([duplicate, duplicate]),
    ).toThrow("duplicate sample");

    const rows = summarizeCollectionRecipeSamples([
        sample("baseline-v1", "fold-maximum", 0, 100),
        sample("candidate", "fold-maximum", 0, 80),
      ]),
      verifications = [
        {
          recipeId: "baseline-v1",
          correctness: true,
          rawAbi: true,
          reproducible: true,
        },
        {
          recipeId: "candidate",
          correctness: true,
          rawAbi: true,
          reproducible: true,
        },
      ],
      config = {
        baselineRecipeId: "baseline-v1" as const,
        maximumRegressionPercent: 5,
        requiredImprovementPercent: 10,
        maximumArtifactRatio: 1.5,
        maximumMemoryRegressionPercent: 10,
      };
    expect(() =>
      decideCollectionBinaryenRecipe(
        [...rows, rows[0] as (typeof rows)[number]],
        verifications,
        ["baseline-v1", "candidate"],
        config,
      ),
    ).toThrow("duplicate case row");
    expect(() =>
      decideCollectionBinaryenRecipe(
        rows,
        verifications,
        ["baseline-v1", "candidate", "candidate"],
        config,
      ),
    ).toThrow("invalid recipes");
    expect(() =>
      decideCollectionBinaryenRecipe(
        rows,
        [...verifications, verifications[1] as (typeof verifications)[number]],
        ["baseline-v1", "candidate"],
        config,
      ),
    ).toThrow("invalid verifications");
  });

  test("uses build time as the final eligible-recipe tie break", () => {
    const samples: CollectionRecipeSample[] = [];
    for (let index = 0; index < 5; index++) {
      samples.push(sample("baseline-v1", "fold-maximum", index, 100, 0));
      samples.push(
        sample("candidate-slow-build", "fold-maximum", index, 80, 2),
      );
      samples.push(
        sample("candidate-fast-build", "fold-maximum", index, 80, 1),
      );
    }
    const verifications = [
      "baseline-v1",
      "candidate-slow-build",
      "candidate-fast-build",
    ].map((recipeId) => ({
      recipeId,
      correctness: true,
      rawAbi: true,
      reproducible: true,
    }));
    const decision = decideCollectionBinaryenRecipe(
      summarizeCollectionRecipeSamples(samples),
      verifications,
      verifications.map((row) => row.recipeId),
      {
        baselineRecipeId: "baseline-v1",
        maximumRegressionPercent: 5,
        requiredImprovementPercent: 10,
        maximumArtifactRatio: 1.5,
        maximumMemoryRegressionPercent: 10,
      },
    );
    expect(decision.selectedRecipeId).toBe("candidate-fast-build");
  });

  test("accepts exact gate boundaries and rejects the first value beyond them", () => {
    const rows: CollectionRecipeSample[] = [];
    for (let index = 0; index < 5; index++) {
      rows.push({
        ...sample("baseline-v1", "fold-maximum", index, 100),
        artifactBytes: 100,
        arenaPeakBytes: 1_000,
        peakRssBytes: 100,
      });
      rows.push({
        ...sample("candidate", "fold-maximum", index, 90),
        artifactBytes: 150,
        arenaPeakBytes: 1_100,
        peakRssBytes: 110,
      });
    }
    const verification = ["baseline-v1", "candidate"].map((recipeId) => ({
        recipeId,
        correctness: true,
        rawAbi: true,
        reproducible: true,
      })),
      config = {
        baselineRecipeId: "baseline-v1" as const,
        maximumRegressionPercent: 5,
        requiredImprovementPercent: 10,
        maximumArtifactRatio: 1.5,
        maximumMemoryRegressionPercent: 10,
      },
      boundary = summarizeCollectionRecipeSamples(rows);
    expect(
      decideCollectionBinaryenRecipe(
        boundary,
        verification,
        ["baseline-v1", "candidate"],
        config,
      ).outcome,
    ).toBe("adopt");
    const overSize = boundary.map((row) =>
      row.recipeId === "candidate" ? { ...row, artifactBytes: 151 } : row,
    );
    const rejected = decideCollectionBinaryenRecipe(
      overSize,
      verification,
      ["baseline-v1", "candidate"],
      config,
    );
    expect(rejected.outcome).toBe("retain-baseline");
    expect((rejected.candidates as Array<{ status: string }>)[0]?.status).toBe(
      "rejected-size",
    );
  });
});
