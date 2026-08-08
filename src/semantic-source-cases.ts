import ts from "typescript";

import { sourceError } from "./semantic-source-diagnostics";

export function findArrayProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
  sourceFile: ts.SourceFile,
): ts.ArrayLiteralExpression {
  const property = object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      propertyName(candidate.name) === name,
  );
  if (
    property === undefined ||
    !ts.isArrayLiteralExpression(property.initializer)
  ) {
    throw sourceError(
      sourceFile,
      object,
      `semanticTest.${name} must be an array literal`,
    );
  }
  return property.initializer;
}

export function findOptionalArrayProperty(
  object: ts.ObjectLiteralExpression,
  name: "boundary" | "counterfactual" | "invariance",
  sourceFile: ts.SourceFile,
): ts.ArrayLiteralExpression | null {
  const properties = object.properties.filter(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      propertyName(candidate.name) === name,
  );
  if (properties.length === 0) return null;
  const [property] = properties;
  if (property === undefined) return null;
  if (!ts.isArrayLiteralExpression(property.initializer)) {
    throw sourceError(
      sourceFile,
      property.initializer,
      `semanticTest.${name} must be an array literal`,
    );
  }
  return property.initializer;
}

export function assertObjectPropertyKeys(
  object: ts.ObjectLiteralExpression,
  allowed: string[],
  path: string,
  sourceFile: ts.SourceFile,
): void {
  const seen = new Set<string>();
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) {
      throw sourceError(
        sourceFile,
        property,
        `${path} only supports explicit property assignments`,
      );
    }
    const name = propertyName(property.name);
    if (name === undefined || !allowed.includes(name)) {
      throw sourceError(
        sourceFile,
        property.name,
        `${path} contains unknown field ${name ?? property.name.getText(sourceFile)}`,
      );
    }
    if (seen.has(name)) {
      throw sourceError(
        sourceFile,
        property.name,
        `${path}.${name} is duplicated`,
      );
    }
    seen.add(name);
  }
}

export function assertNamedSemanticCases(
  array: ts.ArrayLiteralExpression,
  sectionPath: string,
  sourceFile: ts.SourceFile,
): void {
  const names = new Set<string>();
  array.elements.forEach((element, index) => {
    if (!ts.isObjectLiteralExpression(element)) {
      throw sourceError(
        sourceFile,
        element,
        `${sectionPath}[${index}] must be an object literal`,
      );
    }
    const path = `${sectionPath}[${index}]`;
    assertObjectPropertyKeys(
      element,
      ["name", "input", "expected"],
      path,
      sourceFile,
    );
    const name = stringLiteralProperty(element, "name", path, sourceFile);
    if (name.trim().length === 0) {
      throw sourceError(
        sourceFile,
        element,
        `${path}.name must be a non-empty string literal`,
      );
    }
    if (names.has(name)) {
      throw sourceError(
        sourceFile,
        element,
        `${sectionPath} contains duplicate name ${name}`,
      );
    }
    names.add(name);
    const input = requiredProperty(element, "input", path, sourceFile);
    assertStaticExpression(input, sourceFile);
    assertSemanticExpected(element, path, sourceFile);
  });
}

export function assertCounterfactualCases(
  array: ts.ArrayLiteralExpression,
  sourceFile: ts.SourceFile,
): void {
  const names = new Set<string>();
  array.elements.forEach((element, index) => {
    if (!ts.isObjectLiteralExpression(element)) {
      throw sourceError(
        sourceFile,
        element,
        `semanticTest.counterfactual[${index}] must be an object literal`,
      );
    }
    const path = `semanticTest.counterfactual[${index}]`;
    assertObjectPropertyKeys(
      element,
      ["name", "base", "variants"],
      path,
      sourceFile,
    );
    const name = stringLiteralProperty(element, "name", path, sourceFile);
    if (name.trim().length === 0) {
      throw sourceError(sourceFile, element, `${path}.name must be non-empty`);
    }
    if (names.has(name)) {
      throw sourceError(
        sourceFile,
        element,
        `semanticTest.counterfactual contains duplicate name ${name}`,
      );
    }
    names.add(name);
    const base = requiredProperty(element, "base", path, sourceFile);
    if (!ts.isObjectLiteralExpression(base)) {
      throw sourceError(
        sourceFile,
        base,
        `${path}.base must be an object literal`,
      );
    }
    assertObjectPropertyKeys(
      base,
      ["input", "expected"],
      `${path}.base`,
      sourceFile,
    );
    assertStaticExpression(
      requiredProperty(base, "input", `${path}.base`, sourceFile),
      sourceFile,
    );
    assertSemanticExpected(base, `${path}.base`, sourceFile);
    const variants = requiredProperty(element, "variants", path, sourceFile);
    if (
      !ts.isArrayLiteralExpression(variants) ||
      variants.elements.length === 0
    ) {
      throw sourceError(
        sourceFile,
        variants,
        `${path}.variants must be a non-empty array literal`,
      );
    }
    assertNamedSemanticCases(variants, `${path}.variants`, sourceFile);
  });
}

export function assertInvarianceCases(
  array: ts.ArrayLiteralExpression,
  sourceFile: ts.SourceFile,
): void {
  const names = new Set<string>();
  array.elements.forEach((element, index) => {
    if (!ts.isObjectLiteralExpression(element)) {
      throw sourceError(
        sourceFile,
        element,
        `semanticTest.invariance[${index}] must be an object literal`,
      );
    }
    const path = `semanticTest.invariance[${index}]`;
    assertObjectPropertyKeys(
      element,
      ["name", "expected", "inputs"],
      path,
      sourceFile,
    );
    const name = stringLiteralProperty(element, "name", path, sourceFile);
    if (name.trim().length === 0) {
      throw sourceError(sourceFile, element, `${path}.name must be non-empty`);
    }
    if (names.has(name)) {
      throw sourceError(
        sourceFile,
        element,
        `semanticTest.invariance contains duplicate name ${name}`,
      );
    }
    names.add(name);
    assertSemanticExpected(element, path, sourceFile);
    const inputs = requiredProperty(element, "inputs", path, sourceFile);
    if (!ts.isArrayLiteralExpression(inputs) || inputs.elements.length === 0) {
      throw sourceError(
        sourceFile,
        inputs,
        `${path}.inputs must be a non-empty array literal`,
      );
    }
    for (const input of inputs.elements) {
      assertStaticExpression(input, sourceFile);
    }
  });
}

export function assertNonEmptyStaticArray(
  array: ts.ArrayLiteralExpression,
  name: "accept" | "reject",
  sourceFile: ts.SourceFile,
): void {
  if (array.elements.length === 0) {
    throw sourceError(
      sourceFile,
      array,
      `semanticTest.${name} must contain at least one case`,
    );
  }
  for (const element of array.elements) {
    assertStaticExpression(element, sourceFile);
  }
}

function requiredProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
  path: string,
  sourceFile: ts.SourceFile,
): ts.Expression {
  const property = object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      propertyName(candidate.name) === name,
  );
  if (property === undefined) {
    throw sourceError(sourceFile, object, `${path}.${name} is required`);
  }
  return property.initializer;
}

function stringLiteralProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
  path: string,
  sourceFile: ts.SourceFile,
): string {
  const value = requiredProperty(object, name, path, sourceFile);
  if (!ts.isStringLiteral(value)) {
    throw sourceError(
      sourceFile,
      value,
      `${path}.${name} must be a string literal`,
    );
  }
  return value.text;
}

function assertSemanticExpected(
  object: ts.ObjectLiteralExpression,
  path: string,
  sourceFile: ts.SourceFile,
): void {
  const expected = stringLiteralProperty(
    object,
    "expected",
    path,
    sourceFile,
  );
  if (expected !== "accepted" && expected !== "rejected") {
    throw sourceError(
      sourceFile,
      object,
      `${path}.expected must be accepted or rejected`,
    );
  }
}

function assertStaticExpression(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
): void {
  if (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(node) && node.text === "undefined")
  ) {
    return;
  }
  if (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.PlusToken ||
      node.operator === ts.SyntaxKind.MinusToken) &&
    ts.isNumericLiteral(node.operand)
  ) {
    return;
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) {
      assertStaticExpression(element, sourceFile);
    }
    return;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const names = new Set<string>();
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) {
        throw sourceError(
          sourceFile,
          property,
          "semantic cases only support static object properties",
        );
      }
      const name = propertyName(property.name);
      if (name === undefined) {
        throw sourceError(
          sourceFile,
          property,
          "semantic cases only support static object properties",
        );
      }
      if (names.has(name)) {
        throw sourceError(
          sourceFile,
          property.name,
          `semantic cases contain duplicate object property ${name}`,
        );
      }
      names.add(name);
      assertStaticExpression(property.initializer, sourceFile);
    }
    return;
  }
  throw sourceError(
    sourceFile,
    node,
    "semantic cases must contain only static literals",
  );
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
    ? name.text
    : undefined;
}
