import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  evaluateExpression,
  expressionSignature,
  runCrossSchemaBenchmark,
} from "./cross-schema-benchmark";
import type { PredicateExpression } from "./ir";

const bodies: Record<string, PredicateExpression> = {
  isBenchmarkActiveCustomer: {
    kind: "all",
    conditions: [
      { kind: "equals", property: ["status"], value: "active" },
      { kind: "equals", property: ["deletedAt"], value: null },
      { kind: "present", property: ["email"] },
    ],
  },
  isBenchmarkActiveServiceAccount: {
    kind: "all",
    conditions: [
      { kind: "equals", property: ["serviceEnabled"], value: true },
      { kind: "equals", property: ["blockedAt"], value: null },
      { kind: "present", property: ["primaryEmail"] },
    ],
  },
  isBenchmarkShippableOrder: {
    kind: "all",
    conditions: [
      { kind: "equals", property: ["paymentStatus"], value: "paid" },
      { kind: "equals", property: ["cancelledAt"], value: null },
      { kind: "present", property: ["shippingAddress"] },
    ],
  },
  isBenchmarkShippableRequest: {
    kind: "all",
    conditions: [
      { kind: "equals", property: ["paymentCaptured"], value: true },
      { kind: "equals", property: ["voidedAt"], value: null },
      { kind: "present", property: ["destinationCode"] },
    ],
  },
  isBenchmarkPublishableArticle: {
    kind: "all",
    conditions: [
      { kind: "equals", property: ["reviewStatus"], value: "approved" },
      { kind: "equals", property: ["archivedAt"], value: null },
      { kind: "present", property: ["title"] },
      { kind: "present", property: ["body"] },
    ],
  },
  isBenchmarkPublishableContent: {
    kind: "all",
    conditions: [
      { kind: "equals", property: ["publicationApproved"], value: true },
      { kind: "equals", property: ["retiredAt"], value: null },
      { kind: "present", property: ["headline"] },
      { kind: "present", property: ["content"] },
    ],
  },
};

describe("cross-schema benchmark", () => {
  let outputRoot = "";

  beforeAll(async () => {
    outputRoot = await mkdtemp(join(tmpdir(), "cross-schema-benchmark-"));
  });

  afterAll(async () => {
    await rm(outputRoot, { recursive: true, force: true });
  });

  test("evaluates the restricted Predicate IR", () => {
    const expression = bodies.isBenchmarkActiveCustomer!;
    expect(
      evaluateExpression(expression, {
        status: "active",
        deletedAt: null,
        email: "customer@example.com",
      }),
    ).toBe(true);
    expect(
      evaluateExpression(expression, {
        status: "active",
        deletedAt: null,
        email: null,
      }),
    ).toBe(false);
  });

  test("normalizes commutative condition order for stability", () => {
    const forward = bodies.isBenchmarkActiveCustomer!;
    if (forward.kind !== "all") throw new Error("test fixture must be all");
    const reverse: PredicateExpression = {
      kind: "all",
      conditions: [...forward.conditions].reverse(),
    };
    expect(expressionSignature(forward)).toBe(expressionSignature(reverse));
  });

  test(
    "runs all 27 lockless trials without exposing hidden tests to the resolver",
    async () => {
      const seenInputs: unknown[] = [];
      let responseNumber = 0;
      const { report, runDirectory } = await runCrossSchemaBenchmark({
        manifestPath: resolve("benchmarks/cross-schema/benchmark.json"),
        outputRoot,
        model: "gpt-5.4-mini-test",
        provider: "fixture",
        resolve: async (input) => {
          seenInputs.push(input);
          responseNumber += 1;
          const body = bodies[input.target.functionName];
          const output = body
            ? { outcome: "resolved", body, diagnostics: [] }
            : {
                outcome: "unresolved",
                body: null,
                diagnostics: ["The schema does not identify semantic roles."],
              };
          return {
            responseId: `fixture-${responseNumber}`,
            model: "gpt-5.4-mini-test",
            outputText: JSON.stringify(output),
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          };
        },
      });

      expect(seenInputs).toHaveLength(27);
      expect(JSON.stringify(seenInputs)).not.toContain("customer@example.com");
      expect(report.lockUsed).toBe(false);
      expect(report.oracleAndCasesSentToModel).toBe(false);
      expect(report.protocol).toMatchObject({
        concepts: 3,
        cases: 9,
        resolvedCases: 6,
        ambiguousCases: 3,
        trialsPerCase: 3,
        totalTrials: 27,
      });
      expect(report.summary).toMatchObject({
        modelGatePassed: true,
        trialPassRate: 1,
        firstPassCaseRate: 1,
        stableCaseRate: 1,
        falseResolutionRate: 0,
        hiddenTestPassRate: 1,
        exactIrRate: 1,
      });
      expect(report.status).toBe("model-gate-passed-human-time-pending");
      expect(report.humanTimeComparison.status).toBe("pending");

      const saved = JSON.parse(
        await readFile(
          resolve(runDirectory, "trials/active-customer-record/1.json"),
          "utf8",
        ),
      ) as { actualBody: PredicateExpression; response: { outputText: string } };
      expect(saved.actualBody).toEqual(bodies.isBenchmarkActiveCustomer!);
      expect(saved.response.outputText).toContain('"outcome":"resolved"');
      expect(await readFile(resolve(runDirectory, "report.md"), "utf8")).toContain(
        "Trial pass rate: 100.0%",
      );
    },
    30_000,
  );
});
