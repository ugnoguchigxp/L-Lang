import { describe, expect, test } from "bun:test";

import { parsePredicateDefinition, parsePredicateExpression } from "./ir";
import { SEMANTIC_LIMITS } from "./semantic-limits";

describe("Predicate IR limits", () => {
  test("accepts the configured depth and rejects one level more", () => {
    expect(() =>
      parsePredicateExpression(
        nestedNot(SEMANTIC_LIMITS.predicateExpressionDepth),
      ),
    ).not.toThrow();
    expect(() =>
      parsePredicateExpression(
        nestedNot(SEMANTIC_LIMITS.predicateExpressionDepth + 1),
      ),
    ).toThrow("depth limit");
  });

  test("accepts the configured node count and rejects one node more", () => {
    expect(() =>
      parsePredicateExpression(expressionWithNodes(256)),
    ).not.toThrow();
    expect(() => parsePredicateExpression(expressionWithNodes(257))).toThrow(
      "node limit",
    );
  });

  test("bounds condition fanout and property paths", () => {
    expect(() =>
      parsePredicateExpression({
        kind: "all",
        conditions: Array.from(
          { length: SEMANTIC_LIMITS.predicateConditions },
          () => leaf(),
        ),
      }),
    ).not.toThrow();
    expect(() =>
      parsePredicateExpression({
        kind: "all",
        conditions: Array.from(
          { length: SEMANTIC_LIMITS.predicateConditions + 1 },
          () => leaf(),
        ),
      }),
    ).toThrow("at most 64 items");

    expect(() =>
      parsePredicateExpression({
        kind: "present",
        property: Array.from(
          { length: SEMANTIC_LIMITS.propertyPathSegments },
          () => "property",
        ),
      }),
    ).not.toThrow();
    expect(() =>
      parsePredicateExpression({
        kind: "present",
        property: Array.from(
          { length: SEMANTIC_LIMITS.propertyPathSegments + 1 },
          () => "property",
        ),
      }),
    ).toThrow("at most 8 segments");
  });

  test("bounds property segment length", () => {
    expect(() =>
      parsePredicateExpression({
        kind: "present",
        property: ["a".repeat(SEMANTIC_LIMITS.propertySegmentCharacters)],
      }),
    ).not.toThrow();
    expect(() =>
      parsePredicateExpression({
        kind: "present",
        property: ["a".repeat(SEMANTIC_LIMITS.propertySegmentCharacters + 1)],
      }),
    ).toThrow("at most 128 characters");
  });

  test("rejects unknown fields in definitions and every expression kind", () => {
    expect(() =>
      parsePredicateDefinition({
        version: 1,
        name: "isReady",
        description: "Ready",
        input: {
          parameter: "customer",
          type: "Customer",
          module: "./customer",
          extra: true,
        },
        returns: "boolean",
        body: leaf(),
      }),
    ).toThrow("definition.input contains unknown field extra");

    for (const expression of [
      { kind: "all", conditions: [leaf()], extra: true },
      { kind: "not", condition: leaf(), extra: true },
      { ...leaf(), extra: true },
      { kind: "present", property: ["ready"], extra: true },
    ]) {
      expect(() => parsePredicateExpression(expression)).toThrow(
        "contains unknown field extra",
      );
    }
  });

  test("bounds cyclic object input without hanging or overflowing the stack", () => {
    const expression: Record<string, unknown> = { kind: "not" };
    expression.condition = expression;

    expect(() => parsePredicateExpression(expression)).toThrow("depth limit");
  });
});

function leaf(): object {
  return { kind: "equals", property: ["ready"], value: true };
}

function nestedNot(depth: number): object {
  let expression = leaf();
  for (let index = 1; index < depth; index += 1) {
    expression = { kind: "not", condition: expression };
  }
  return expression;
}

function expressionWithNodes(nodes: 256 | 257): object {
  const conditions = Array.from({ length: 64 }, (_, index) => {
    const wrappers = nodes === 257 || index < 63 ? 3 : 2;
    let expression = leaf();
    for (let depth = 0; depth < wrappers; depth += 1) {
      expression = { kind: "not", condition: expression };
    }
    return expression;
  });
  return { kind: "all", conditions };
}
