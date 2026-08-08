import type { PredicateExpression } from "./ir";
import {
  applySemanticTestChanges,
  type SemanticTestObligation,
  type SemanticTestPlan,
  type SemanticTestValue,
} from "./semantic-test-ir";

export type SemanticTestCaseResult = {
  obligationId: string;
  strength: "hard" | "exploratory";
  passed: boolean;
  expected: boolean | "unchanged";
  actual: boolean | { before: boolean; after: boolean };
};

export type SemanticTestPlanResult = {
  passed: boolean;
  hardPassed: boolean;
  total: number;
  hard: number;
  results: SemanticTestCaseResult[];
};

export function evaluatePredicateExpression(
  expression: PredicateExpression,
  input: SemanticTestValue,
): boolean {
  switch (expression.kind) {
    case "all":
      return expression.conditions.every((condition) =>
        evaluatePredicateExpression(condition, input),
      );
    case "any":
      return expression.conditions.some((condition) =>
        evaluatePredicateExpression(condition, input),
      );
    case "not":
      return !evaluatePredicateExpression(expression.condition, input);
    case "equals":
      return readProperty(input, expression.property) === expression.value;
    case "present": {
      const value = readProperty(input, expression.property);
      return value !== null && value !== undefined;
    }
  }
}

export function evaluateSemanticTestPlan(
  plan: SemanticTestPlan,
  evaluate: (input: SemanticTestValue) => boolean,
): SemanticTestPlanResult {
  const results = plan.obligations.map((obligation) =>
    evaluateObligation(obligation, evaluate),
  );
  const hard = results.filter((result) => result.strength === "hard");
  return {
    passed: results.every((result) => result.passed),
    hardPassed: hard.every((result) => result.passed),
    total: results.length,
    hard: hard.length,
    results,
  };
}

export function renderSemanticTestPlanModule(input: {
  candidateModuleName: string;
  predicateName: string;
  plan: SemanticTestPlan;
}): string {
  const planJson = JSON.stringify(input.plan, null, 2);
  return [
    'import { describe, expect, test } from "bun:test";',
    `import { ${input.predicateName} } from ${JSON.stringify(`./${input.candidateModuleName}`)};`,
    "",
    `type SemanticInput = Parameters<typeof ${input.predicateName}>[0];`,
    "",
    `const plan = ${planJson} as const;`,
    "",
    "function clone<T>(value: T): T {",
    "  return structuredClone(value);",
    "}",
    "",
    "function changed(base: unknown, changes: readonly {",
    "  property: readonly string[];",
    "  value: unknown;",
    "}[]): SemanticInput {",
    "  const result = clone(base) as Record<string, unknown>;",
    "  for (const change of changes) {",
    "    let current: Record<string, unknown> = result;",
    "    for (const part of change.property.slice(0, -1)) {",
    "      current = current[part] as Record<string, unknown>;",
    "    }",
    "    current[change.property.at(-1)!] = clone(change.value);",
    "  }",
    "  return result as SemanticInput;",
    "}",
    "",
    `describe(${JSON.stringify(`${input.predicateName} semantic Test Plan`)}, () => {`,
    "  for (const obligation of plan.obligations) {",
    "    test(`" +
      "$" +
      "{obligation.id} [" +
      "$" +
      "{obligation.strength}]`, () => {",
    '      if (obligation.kind === "example") {',
    `        expect(${input.predicateName}(obligation.input as SemanticInput)).toBe(obligation.expected);`,
    "        return;",
    "      }",
    `      const before = ${input.predicateName}(obligation.base as SemanticInput);`,
    `      const after = ${input.predicateName}(changed(obligation.base, obligation.changes));`,
    '      if (obligation.kind === "counterfactual") {',
    "        expect(before).toBe(obligation.expectedBefore);",
    "        expect(after).toBe(obligation.expectedAfter);",
    "        return;",
    "      }",
    "      expect(after).toBe(before);",
    "    });",
    "  }",
    "});",
    "",
  ].join("\n");
}

function evaluateObligation(
  obligation: SemanticTestObligation,
  evaluate: (input: SemanticTestValue) => boolean,
): SemanticTestCaseResult {
  if (obligation.kind === "example") {
    const actual = evaluate(obligation.input);
    return {
      obligationId: obligation.id,
      strength: obligation.strength,
      passed: actual === obligation.expected,
      expected: obligation.expected,
      actual,
    };
  }
  const before = evaluate(obligation.base);
  const after = evaluate(
    applySemanticTestChanges(obligation.base, obligation.changes),
  );
  if (obligation.kind === "counterfactual") {
    return {
      obligationId: obligation.id,
      strength: obligation.strength,
      passed:
        before === obligation.expectedBefore &&
        after === obligation.expectedAfter,
      expected: obligation.expectedAfter,
      actual: { before, after },
    };
  }
  return {
    obligationId: obligation.id,
    strength: obligation.strength,
    passed: before === after,
    expected: "unchanged",
    actual: { before, after },
  };
}

function readProperty(
  input: SemanticTestValue,
  property: string[],
): SemanticTestValue | undefined {
  let current: SemanticTestValue | undefined = input;
  for (const part of property) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}
