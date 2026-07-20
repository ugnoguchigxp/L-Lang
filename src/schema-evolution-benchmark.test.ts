import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { PredicateExpression } from "./ir";
import {
  assertHumanReviewedFreeze,
  runSchemaEvolutionBenchmark,
  verifyFrozenFileHashes,
} from "./schema-evolution-benchmark";
import { scanSemanticSource } from "./semantic-source";

const workspaceRoot = resolve(import.meta.dir, "..");
const manifestPath = resolve(
  workspaceRoot,
  "benchmarks/schema-evolution/benchmark.json",
);

describe("blind schema evolution benchmark", () => {
  let outputRoot = "";

  beforeAll(async () => {
    outputRoot = await mkdtemp(join(tmpdir(), "schema-evolution-benchmark-"));
  });

  afterAll(async () => {
    await rm(outputRoot, { recursive: true, force: true });
  });

  test("refuses live execution metadata before independent human review", () => {
    expect(() =>
      assertHumanReviewedFreeze({
        status: "draft",
        humanReviewed: false,
        reviewer: null,
        reviewedAt: null,
      }),
    ).toThrow("independent human review is required");
  });

  test("rejects a changed frozen file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "schema-evolution-freeze-"));
    try {
      await writeFile(resolve(directory, "input.txt"), "changed", "utf8");
      await expect(
        verifyFrozenFileHashes(directory, {
          "input.txt": "0000000000000000000000000000000000000000000000000000000000000000",
        }),
      ).rejects.toThrow("frozen input hash mismatch: input.txt");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test(
    "runs 54 model-blind, lockless trials and preserves approved workspace artifacts",
    async () => {
      const fixtureBodies = await loadFixtureBodies();
      const seenInputs: unknown[] = [];
      let responseNumber = 0;
      const { report, runDirectory } = await runSchemaEvolutionBenchmark({
        manifestPath,
        workspaceRoot,
        outputRoot,
        provider: "fixture",
        model: "gpt-5.4-mini-test",
        requireHumanReview: false,
        resolve: async (input) => {
          seenInputs.push(input);
          responseNumber += 1;
          const body = fixtureBodies.get(input.target.functionName);
          const output = body === null
            ? {
                outcome: "unresolved",
                body: null,
                diagnostics: ["The evolved schema is missing or ambiguously represents a required role."],
              }
            : { outcome: "resolved", body, diagnostics: [] };
          if (body === undefined) throw new Error(`fixture missing: ${input.target.functionName}`);
          return {
            responseId: `fixture-${responseNumber}`,
            model: "gpt-5.4-mini-test",
            outputText: JSON.stringify(output),
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          };
        },
      });

      expect(seenInputs).toHaveLength(54);
      const serializedInputs = JSON.stringify(seenInputs);
      expect(serializedInputs).not.toContain("a@example.com");
      expect(serializedInputs).not.toContain("expectedOutcome");
      expect(serializedInputs).not.toContain("hiddenTests");
      expect(report).toMatchObject({
        status: "passed",
        lockUsed: false,
        generatedCodeMutated: false,
        oracleAndCasesSentToModel: false,
        protocol: {
          concepts: 3,
          changeTypes: 6,
          cases: 18,
          resolvedCases: 12,
          unresolvedCases: 6,
          trialsPerCase: 3,
          totalTrials: 54,
        },
        summary: {
          modelGatePassed: true,
          trialPassRate: 1,
          firstPassCaseRate: 1,
          stableCaseRate: 1,
          outcomeAccuracy: 1,
          classificationAccuracy: 1,
          exactIrRate: 1,
          hiddenTestPassRate: 1,
          falseResolutionRate: 0,
          workspaceMutationCount: 0,
        },
      });
      expect(report.cases).toHaveLength(18);
      expect(report.cases.flatMap((entry) => entry.trials)).toHaveLength(54);

      const savedTrial = await readFile(
        resolve(runDirectory, "trials/active-customer-rename/1.json"),
        "utf8",
      );
      expect(savedTrial).toContain('\n  "trial": 1');
      expect(savedTrial).toContain('"actualClassification": "compatible"');
      expect(savedTrial).toContain('"outputText"');
      expect(await readFile(resolve(runDirectory, "report.md"), "utf8")).toContain(
        "Trials: 54",
      );
    },
    60_000,
  );
});

async function loadFixtureBodies(): Promise<Map<string, PredicateExpression | null>> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    cases: Array<{ source: string; oracle: string }>;
  };
  const directory = dirname(manifestPath);
  const result = new Map<string, PredicateExpression | null>();
  for (const entry of manifest.cases) {
    const source = await scanSemanticSource(resolve(directory, entry.source));
    const oracle = JSON.parse(
      await readFile(resolve(directory, entry.oracle), "utf8"),
    ) as { body: PredicateExpression | null };
    result.set(source.predicate.name, oracle.body);
  }
  return result;
}
