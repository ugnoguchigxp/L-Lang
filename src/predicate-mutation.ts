import type { PredicateExpression } from "./ir";
import { comparePredicatesOnType } from "./predicate-equivalence";
import { stableJson } from "./semantic-fingerprint";
import type { TypeSchema } from "./semantic-source";

export type PredicateMutant = {
  id: string;
  kind:
    | "constant"
    | "junction-replacement"
    | "condition-deletion"
    | "condition-negation";
  expression: PredicateExpression | null;
  constant: boolean | null;
  equivalent: boolean;
  equivalenceReason: string | null;
};

export function generatePredicateMutants(
  expression: PredicateExpression | null,
  typeSchema: TypeSchema,
): PredicateMutant[] {
  const mutants: PredicateMutant[] = [
    constantMutant(false),
    constantMutant(true),
  ];
  if (expression === null) return mutants;

  for (const candidate of mutateExpression(expression, "root")) {
    const comparison = comparePredicatesOnType(
      expression,
      candidate.expression,
      typeSchema,
    );
    mutants.push({
      id: candidate.id,
      kind: candidate.kind,
      expression: candidate.expression,
      constant: null,
      equivalent: comparison.relation !== "different",
      equivalenceReason:
        comparison.relation === "different"
          ? null
          : comparison.rewrites.join("; ") || comparison.relation,
    });
  }

  const seen = new Set<string>();
  return mutants.filter((mutant) => {
    const signature =
      mutant.constant === null
        ? stableJson(mutant.expression)
        : `constant:${mutant.constant}`;
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

type ExpressionMutation = {
  id: string;
  kind: "junction-replacement" | "condition-deletion" | "condition-negation";
  expression: PredicateExpression;
};

function mutateExpression(
  expression: PredicateExpression,
  path: string,
): ExpressionMutation[] {
  const mutations: ExpressionMutation[] = [];
  switch (expression.kind) {
    case "all":
    case "any": {
      mutations.push({
        id: `${path}:replace-${expression.kind}-with-${expression.kind === "all" ? "any" : "all"}`,
        kind: "junction-replacement",
        expression: {
          kind: expression.kind === "all" ? "any" : "all",
          conditions: expression.conditions.map(cloneExpression),
        },
      });
      if (expression.conditions.length > 1) {
        expression.conditions.forEach((_condition, index) => {
          const remaining = expression.conditions
            .filter((_item, candidateIndex) => candidateIndex !== index)
            .map(cloneExpression);
          const [onlyCondition] = remaining;
          mutations.push({
            id: `${path}:delete-condition-${index}`,
            kind: "condition-deletion",
            expression:
              remaining.length === 1 && onlyCondition !== undefined
                ? onlyCondition
                : { kind: expression.kind, conditions: remaining },
          });
        });
      }
      expression.conditions.forEach((condition, index) => {
        for (const child of mutateExpression(
          condition,
          `${path}.conditions[${index}]`,
        )) {
          mutations.push({
            ...child,
            expression: {
              kind: expression.kind,
              conditions: expression.conditions.map((item, candidateIndex) =>
                candidateIndex === index
                  ? child.expression
                  : cloneExpression(item),
              ),
            },
          });
        }
      });
      return mutations;
    }
    case "not":
      for (const child of mutateExpression(
        expression.condition,
        `${path}.not`,
      )) {
        mutations.push({
          ...child,
          expression: { kind: "not", condition: child.expression },
        });
      }
      return mutations;
    case "equals":
    case "present":
      return [
        {
          id: `${path}:negate-condition`,
          kind: "condition-negation",
          expression: {
            kind: "not",
            condition: cloneExpression(expression),
          },
        },
      ];
  }
}

function constantMutant(value: boolean): PredicateMutant {
  return {
    id: `constant-${value}`,
    kind: "constant",
    expression: null,
    constant: value,
    equivalent: false,
    equivalenceReason: null,
  };
}

function cloneExpression(expression: PredicateExpression): PredicateExpression {
  switch (expression.kind) {
    case "all":
    case "any":
      return {
        kind: expression.kind,
        conditions: expression.conditions.map(cloneExpression),
      };
    case "not":
      return { kind: "not", condition: cloneExpression(expression.condition) };
    case "equals":
      return {
        kind: "equals",
        property: [...expression.property],
        value: expression.value,
      };
    case "present":
      return { kind: "present", property: [...expression.property] };
  }
}
