import { describe, expect, test } from "bun:test";

import type { PredicateExpression } from "./ir";
import {
  assertPreImplementationRed,
  createRedCertificate,
} from "./semantic-red-certificate";
import type { SemanticTestPlan } from "./semantic-test-ir";
import type { TypeSchema } from "./semantic-source";

const typeSchema: TypeSchema = {
  kind: "object",
  properties: [
    {
      name: "status",
      optional: false,
      type: {
        kind: "union",
        types: [
          { kind: "literal", value: "active" },
          { kind: "literal", value: "suspended" },
        ],
      },
    },
    {
      name: "deletedAt",
      optional: false,
      type: {
        kind: "union",
        types: [{ kind: "string" }, { kind: "null" }],
      },
    },
    {
      name: "email",
      optional: false,
      type: {
        kind: "union",
        types: [{ kind: "string" }, { kind: "null" }],
      },
    },
  ],
};

const implementation: PredicateExpression = {
  kind: "all",
  conditions: [
    { kind: "equals", property: ["status"], value: "active" },
    { kind: "equals", property: ["deletedAt"], value: null },
    { kind: "present", property: ["email"] },
  ],
};

describe("Semantic TDD Red Certificate", () => {
  test("kills constant and single-condition Predicate mutants", () => {
    const plan = completePlan();
    const pre = createRedCertificate({
      plan,
      testPlanHash: "b".repeat(64),
      typeSchema,
      hardClauseCoverage: 1,
    });
    expect(() => assertPreImplementationRed(pre.certificate)).not.toThrow();
    expect(pre.certificate.mutants).toHaveLength(2);

    const post = createRedCertificate({
      plan,
      testPlanHash: "b".repeat(64),
      typeSchema,
      hardClauseCoverage: 1,
      implementation,
    });
    expect(post.redCertificateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      post.certificate.mutants.filter(
        (mutant) => mutant.classification === "survived",
      ),
    ).toEqual([]);
    expect(post.certificate.mutationScore).toBe(1);
  });

  test("rejects a vacuous hard plan before implementation generation", () => {
    const plan = completePlan();
    plan.obligations = plan.obligations.filter(
      (obligation) =>
        obligation.kind === "example" && obligation.expected === true,
    );
    const pre = createRedCertificate({
      plan,
      testPlanHash: "b".repeat(64),
      typeSchema,
      hardClauseCoverage: 1,
    });
    expect(() => assertPreImplementationRed(pre.certificate)).toThrow(
      "constant-true",
    );
  });
});

function completePlan(): SemanticTestPlan {
  return {
    version: 1,
    contractHash: "a".repeat(64),
    obligations: [
      {
        id: "accepted",
        kind: "example",
        sourceClauses: ["requirements[0]"],
        strength: "hard",
        rationale: "positive",
        input: {
          status: "active",
          deletedAt: null,
          email: "a@example.com",
        },
        expected: true,
      },
      {
        id: "status",
        kind: "example",
        sourceClauses: ["exclusions[0]"],
        strength: "hard",
        rationale: "status",
        input: {
          status: "suspended",
          deletedAt: null,
          email: "a@example.com",
        },
        expected: false,
      },
      {
        id: "deleted",
        kind: "example",
        sourceClauses: ["exclusions[1]"],
        strength: "hard",
        rationale: "deleted",
        input: {
          status: "active",
          deletedAt: "2026-07-23T00:00:00Z",
          email: "a@example.com",
        },
        expected: false,
      },
      {
        id: "email",
        kind: "example",
        sourceClauses: ["requirements[2]"],
        strength: "hard",
        rationale: "email",
        input: { status: "active", deletedAt: null, email: null },
        expected: false,
      },
    ],
  };
}
