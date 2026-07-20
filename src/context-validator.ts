import ts from "typescript";

import type { Literal, PredicateExpression } from "./ir";
import type { SemanticSource } from "./semantic-source";

export class ContextValidationError extends Error {
  override name = "ContextValidationError";
}

export function validatePredicateContext(
  expression: PredicateExpression,
  source: SemanticSource,
): void {
  validateExpression(expression, source, "body");
}

function validateExpression(
  expression: PredicateExpression,
  source: SemanticSource,
  path: string,
): void {
  switch (expression.kind) {
    case "all":
    case "any":
      expression.conditions.forEach((condition, index) =>
        validateExpression(condition, source, `${path}.conditions[${index}]`),
      );
      return;
    case "not":
      validateExpression(expression.condition, source, `${path}.condition`);
      return;
    case "equals": {
      const property = resolveProperty(expression.property, source, path);
      if (!acceptsLiteral(property.type, expression.value)) {
        throw new ContextValidationError(
          `${path}: ${JSON.stringify(expression.value)} is not assignable to ${expression.property.join(".")} (${source.checker.typeToString(property.type)})`,
        );
      }
      return;
    }
    case "present": {
      const property = resolveProperty(expression.property, source, path);
      if (!property.optional && !containsNullish(property.type)) {
        throw new ContextValidationError(
          `${path}: present is only valid for nullable or optional property ${expression.property.join(".")}`,
        );
      }
    }
  }
}

function resolveProperty(
  propertyPath: string[],
  source: SemanticSource,
  expressionPath: string,
): { type: ts.Type; optional: boolean } {
  let currentType = source.concept.inputType;
  let optional = false;

  for (const part of propertyPath) {
    const objectType = source.checker.getNonNullableType(currentType);
    const symbol = source.checker.getPropertyOfType(objectType, part);
    if (symbol === undefined) {
      throw new ContextValidationError(
        `${expressionPath}: property ${propertyPath.join(".")} does not exist on ${source.checker.typeToString(objectType)}`,
      );
    }
    optional ||= Boolean(symbol.flags & ts.SymbolFlags.Optional);
    currentType = source.checker.getTypeOfSymbolAtLocation(symbol, source.concept.node);
  }

  return { type: currentType, optional };
}

function acceptsLiteral(type: ts.Type, literal: Literal): boolean {
  if (type.isUnion()) return type.types.some((part) => acceptsLiteral(part, literal));
  if (literal === null) return Boolean(type.flags & ts.TypeFlags.Null);
  if (typeof literal === "string") {
    return type.flags & ts.TypeFlags.StringLiteral
      ? (type as ts.StringLiteralType).value === literal
      : Boolean(type.flags & ts.TypeFlags.StringLike);
  }
  if (typeof literal === "number") {
    return type.flags & ts.TypeFlags.NumberLiteral
      ? (type as ts.NumberLiteralType).value === literal
      : Boolean(type.flags & ts.TypeFlags.NumberLike);
  }
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    return ((type as unknown as { intrinsicName: string }).intrinsicName === "true") === literal;
  }
  return Boolean(type.flags & ts.TypeFlags.BooleanLike);
}

function containsNullish(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some(containsNullish);
  return Boolean(type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined));
}
