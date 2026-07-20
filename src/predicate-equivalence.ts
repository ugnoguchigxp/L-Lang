import type { PredicateExpression } from "./ir";
import type { TypeSchema } from "./semantic-source";

export type PredicateEquivalenceRelation = "exact" | "equivalent" | "different";

export type PredicateEquivalence = {
  relation: PredicateEquivalenceRelation;
  exactSignature: {
    left: string;
    right: string;
  };
  semanticSignature: {
    left: string;
    right: string;
  };
  rewrites: string[];
};

export function comparePredicatesOnType(
  left: PredicateExpression,
  right: PredicateExpression,
  typeSchema: TypeSchema,
): PredicateEquivalence {
  const exactLeft = normalizeExpression(left, typeSchema, false, []).expression;
  const exactRight = normalizeExpression(right, typeSchema, false, []).expression;
  const leftRewrites: string[] = [];
  const rightRewrites: string[] = [];
  const semanticLeft = normalizeExpression(left, typeSchema, true, leftRewrites).expression;
  const semanticRight = normalizeExpression(right, typeSchema, true, rightRewrites).expression;
  const exactSignature = {
    left: stableJson(exactLeft),
    right: stableJson(exactRight),
  };
  const semanticSignature = {
    left: stableJson(semanticLeft),
    right: stableJson(semanticRight),
  };
  return {
    relation:
      exactSignature.left === exactSignature.right
        ? "exact"
        : semanticSignature.left === semanticSignature.right
          ? "equivalent"
          : "different",
    exactSignature,
    semanticSignature,
    rewrites: [...leftRewrites, ...rightRewrites],
  };
}

export function predicateSemanticSignature(
  expression: PredicateExpression,
  typeSchema: TypeSchema,
): { signature: string; rewrites: string[] } {
  const rewrites: string[] = [];
  const normalized = normalizeExpression(expression, typeSchema, true, rewrites);
  return { signature: stableJson(normalized.expression), rewrites };
}

export function normalizePredicateOnType(
  expression: PredicateExpression,
  typeSchema: TypeSchema,
): { expression: PredicateExpression; rewrites: string[] } {
  const rewrites: string[] = [];
  const normalized = normalizeExpression(expression, typeSchema, true, rewrites);
  return { expression: normalized.expression, rewrites };
}

function normalizeExpression(
  expression: PredicateExpression,
  typeSchema: TypeSchema,
  typeAware: boolean,
  rewrites: string[],
): { expression: PredicateExpression } {
  switch (expression.kind) {
    case "all":
    case "any": {
      const children = expression.conditions.flatMap((condition) => {
        const normalized = normalizeExpression(
          condition,
          typeSchema,
          typeAware,
          rewrites,
        ).expression;
        return normalized.kind === expression.kind
          ? normalized.conditions
          : [normalized];
      });
      const unique = new Map(
        children.map((condition) => [stableJson(condition), condition]),
      );
      return {
        expression: {
          kind: expression.kind,
          conditions: [...unique.values()].sort((left, right) =>
            stableJson(left).localeCompare(stableJson(right)),
          ),
        },
      };
    }
    case "not": {
      const condition = normalizeExpression(
        expression.condition,
        typeSchema,
        typeAware,
        rewrites,
      ).expression;
      if (condition.kind === "not") {
        rewrites.push("double negation removed");
        return normalizeExpression(
          condition.condition,
          typeSchema,
          typeAware,
          rewrites,
        );
      }
      if (
        typeAware &&
        condition.kind === "present" &&
        isRequiredNullableWithoutUndefined(typeSchema, condition.property)
      ) {
        const property = condition.property.join(".");
        rewrites.push(
          `${property}: NOT PRESENT normalized to EQUALS null because its declared domain contains null but not undefined`,
        );
        return {
          expression: {
            kind: "equals",
            property: [...condition.property],
            value: null,
          },
        };
      }
      return { expression: { kind: "not", condition } };
    }
    case "equals":
      return {
        expression: {
          kind: "equals",
          property: [...expression.property],
          value: expression.value,
        },
      };
    case "present":
      return {
        expression: { kind: "present", property: [...expression.property] },
      };
  }
}

function isRequiredNullableWithoutUndefined(
  schema: TypeSchema,
  path: string[],
): boolean {
  const resolved = resolveProperty(schema, path);
  if (resolved === null || resolved.optional) return false;
  const kinds = primitiveKinds(resolved.type);
  return kinds.has("null") && !kinds.has("undefined");
}

function resolveProperty(
  schema: TypeSchema,
  path: string[],
): { optional: boolean; type: TypeSchema } | null {
  let current = schema;
  let optional = false;
  for (const part of path) {
    if (current.kind !== "object") return null;
    const property = current.properties.find((candidate) => candidate.name === part);
    if (property === undefined) return null;
    optional ||= property.optional;
    current = property.type;
  }
  return { optional, type: current };
}

function primitiveKinds(schema: TypeSchema): Set<TypeSchema["kind"]> {
  if (schema.kind === "union") {
    return new Set(schema.types.flatMap((part) => [...primitiveKinds(part)]));
  }
  return new Set([schema.kind]);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
