import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { PredicateExpression } from "./ir";
import { runSchemaEvolutionV2 } from "./schema-evolution-v2";

const workspaceRoot = resolve(import.meta.dir, "..");
const manifestPath = resolve(
  workspaceRoot,
  "benchmarks/schema-evolution-v2/benchmark.json",
);

describe("blind schema evolution v2", () => {
  let outputRoot = "";

  beforeAll(async () => {
    outputRoot = await mkdtemp(join(tmpdir(), "schema-evolution-v2-output-"));
  });

  afterAll(async () => {
    await rm(outputRoot, { recursive: true, force: true });
  });

  test("refuses execution while the authoritative input is draft", async () => {
    let calls = 0;
    await expect(runSchemaEvolutionV2({
      manifestPath,
      workspaceRoot,
      outputRoot,
      provider: "fixture",
      model: "gpt-5.4-mini-test",
      resolve: async () => {
        calls += 1;
        throw new Error("must not be called");
      },
    })).rejects.toThrow("independent human review is required");
    expect(calls).toBe(0);
  });

  test("materializes 24 held-out cases and compares single with consensus", async () => {
    const fixtures = await loadFixtures();
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    const { report } = await runSchemaEvolutionV2({
      manifestPath,
      workspaceRoot,
      outputRoot,
      provider: "fixture",
      model: "gpt-5.4-mini-test",
      requireHumanReview: false,
      resolve: async (input) => {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        const fixture = fixtures.get(input.target.functionName);
        if (fixture === undefined) throw new Error(`missing fixture: ${input.target.functionName}`);
        return {
          responseId: `fixture-${calls}`,
          model: "gpt-5.4-mini-test",
          outputText: JSON.stringify(fixture.body === null
            ? { outcome: "unresolved", body: null, diagnostics: ["role is absent or ambiguous"] }
            : { outcome: "resolved", body: fixture.body, diagnostics: [] }),
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        };
      },
    });
    expect(calls).toBe(72);
    expect(maximumActive).toBe(3);
    expect(report).toMatchObject({
      status: "fixture-gate-passed-human-review-pending",
      evaluation: { primary: "consensus", samples: 3, quorum: 2, parallel: true },
      protocol: {
        concepts: 4,
        cases: 24,
        resolvedCases: 16,
        unresolvedCases: 8,
        totalTrials: 72,
      },
      summary: {
        modelGatePassed: true,
        firstPassCaseRate: 1,
        consensusCasePassRate: 1,
        consensusQuorumRate: 1,
        consensusFalseResolutionRate: 0,
        workspaceMutationCount: 0,
      },
    });
    expect(report.cases).toHaveLength(24);
    expect(report.cases.every((entry) => entry.consensus.passed)).toBe(true);
  }, 60_000);
});

async function loadFixtures() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    concepts: Array<{
      exportName: string;
      cases: Record<string, {
        expectedOutcome: "resolved" | "unresolved";
        fields: Array<{
          path: string[];
          condition?:
            | { kind: "equals"; value: string | number | boolean | null }
            | { kind: "present" };
        }>;
      }>;
    }>;
  };
  const fixtures = new Map<string, { body: PredicateExpression | null }>();
  for (const concept of manifest.concepts) {
    for (const [change, schema] of Object.entries(concept.cases)) {
      const suffix = change.split("-")
        .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
        .join("");
      const functionName = `isV2${concept.exportName.replace(/^V2/, "")}${suffix}`;
      const conditions: PredicateExpression[] = [];
      for (const field of schema.fields) {
        if (field.condition === undefined) continue;
        conditions.push(field.condition.kind === "present"
          ? { kind: "present", property: field.path }
          : { kind: "equals", property: field.path, value: field.condition.value });
      }
      fixtures.set(functionName, {
        body: schema.expectedOutcome === "resolved" ? { kind: "all", conditions } : null,
      });
    }
  }
  return fixtures;
}
