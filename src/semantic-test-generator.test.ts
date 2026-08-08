import { describe, expect, test } from "bun:test";

import type { PredicateExpression } from "./ir";
import {
  evaluatePredicateExpression,
  evaluateSemanticTestPlan,
  renderSemanticTestPlanModule,
} from "./semantic-test-generator";
import type { SemanticTestPlan } from "./semantic-test-ir";

const predicate: PredicateExpression = {
  kind: "all",
  conditions: [
    { kind: "equals", property: ["status"], value: "active" },
    { kind: "equals", property: ["deletedAt"], value: null },
    { kind: "present", property: ["email"] },
  ],
};

const plan: SemanticTestPlan = {
  version: 1,
  contractHash: "a".repeat(64),
  obligations: [
    {
      id: "accepted",
      kind: "example",
      sourceClauses: ["requirements[0]"],
      strength: "hard",
      rationale: "positive",
      input: { status: "active", deletedAt: null, email: "a@example.com" },
      expected: true,
    },
    {
      id: "status-change",
      kind: "counterfactual",
      sourceClauses: ["exclusions[0]"],
      strength: "hard",
      rationale: "status controls acceptance",
      base: { status: "active", deletedAt: null, email: "a@example.com" },
      changes: [{ property: ["status"], value: "suspended" }],
      expectedBefore: true,
      expectedAfter: false,
    },
    {
      id: "email-value",
      kind: "invariance",
      sourceClauses: ["definition"],
      strength: "exploratory",
      rationale: "a present email remains present",
      base: { status: "active", deletedAt: null, email: "a@example.com" },
      changes: [{ property: ["email"], value: "b@example.com" }],
    },
  ],
};

describe("semantic test compiler", () => {
  test("evaluates example, counterfactual, and invariance obligations", () => {
    const result = evaluateSemanticTestPlan(plan, (input) =>
      evaluatePredicateExpression(predicate, input),
    );

    expect(result).toMatchObject({
      passed: true,
      hardPassed: true,
      total: 3,
      hard: 2,
    });
    expect(result.results.every((item) => item.passed)).toBe(true);
  });

  test("renders deterministic Bun tests without arbitrary expressions", () => {
    const first = renderSemanticTestPlanModule({
      candidateModuleName: "candidate",
      predicateName: "isActiveCustomer",
      plan,
    });
    const second = renderSemanticTestPlanModule({
      candidateModuleName: "candidate",
      predicateName: "isActiveCustomer",
      plan,
    });

    expect(first).toBe(second);
    expect(first).toContain("test(`" + "$" + "{obligation.id}");
    expect(first).toContain("expect(after).toBe(before)");
    expect(first).not.toContain("eval(");
    expect(first).not.toContain("fetch(");
  });
});
