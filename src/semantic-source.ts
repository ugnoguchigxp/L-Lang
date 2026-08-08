import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import ts from "typescript";

import {
  parseConceptSpecification,
  validateConceptSpecificationForUse,
  type ConceptSpecificationUse,
  type StructuredConceptSpecification,
} from "./concept-specification";

export type TypeSchema =
  | { kind: "string" | "number" | "boolean" | "null" | "undefined" }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "union"; types: TypeSchema[] }
  | { kind: "array"; elementType: TypeSchema }
  | {
      kind: "object";
      properties: Array<{ name: string; optional: boolean; type: TypeSchema }>;
    };

export type SemanticSourceBase = {
  absolutePath: string;
  sourceText: string;
  sourceFile: ts.SourceFile;
  program: ts.Program;
  checker: ts.TypeChecker;
  concept: {
    name: string;
    id: string;
    hash: string;
    shared: boolean;
    definitionName: string;
    definitionPath: string;
    specification: string;
    structure: StructuredConceptSpecification;
    inputType: ts.Type;
    typeName: string;
    typeDeclaration: string;
    typeSchema: TypeSchema;
    node: ts.Node;
  };
  predicate: {
    name: string;
    conceptName: string;
    parameterName: string;
  };
};

export type SemanticSource = SemanticSourceBase & {
  sourceForm: "semantic-test";
  tests: {
    predicateName: string;
    acceptSource: string;
    rejectSource: string;
    boundarySource: string | null;
    counterfactualSource: string | null;
    invarianceSource: string | null;
  };
};

export type BenchmarkSemanticSource = SemanticSourceBase & {
  sourceForm: "benchmark-probe";
  probe: {
    predicateName: string;
  };
};

export class SemanticSourceError extends Error {
  override name = "SemanticSourceError";
}

export async function scanSemanticSource(
  sourcePath: string,
): Promise<SemanticSource> {
  const source = await scanPredicateSource(sourcePath, "semantic-test");
  if (source.sourceForm !== "semantic-test") {
    throw new SemanticSourceError("internal error: expected a semantic-test source");
  }
  return source;
}

export async function scanBenchmarkSource(
  sourcePath: string,
): Promise<BenchmarkSemanticSource> {
  const source = await scanPredicateSource(sourcePath, "benchmark-probe");
  if (source.sourceForm !== "benchmark-probe") {
    throw new SemanticSourceError("internal error: expected a benchmark-probe source");
  }
  return source;
}

async function scanPredicateSource(
  sourcePath: string,
  expectedForm: "semantic-test" | "benchmark-probe",
): Promise<SemanticSource | BenchmarkSemanticSource> {
  const absolutePath = resolve(sourcePath);
  const sourceText = await readFile(absolutePath, "utf8");
  const configPath = ts.findConfigFile(dirname(absolutePath), ts.sys.fileExists);

  if (configPath === undefined) {
    throw new SemanticSourceError(`tsconfig.json was not found for ${absolutePath}`);
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new SemanticSourceError(formatDiagnostics([configFile.error]));
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    dirname(configPath),
  );
  const rootNames = parsed.fileNames.includes(absolutePath)
    ? parsed.fileNames
    : [...parsed.fileNames, absolutePath];
  const program = ts.createProgram({ rootNames, options: parsed.options });
  const sourceFile = program.getSourceFile(absolutePath);

  if (sourceFile === undefined) {
    throw new SemanticSourceError(`TypeScript could not load ${absolutePath}`);
  }

  const sourceDiagnostics = ts
    .getPreEmitDiagnostics(program, sourceFile)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (sourceDiagnostics.length > 0) {
    throw new SemanticSourceError(formatDiagnostics(sourceDiagnostics));
  }

  const checker = program.getTypeChecker();
  const concepts: SemanticSourceBase["concept"][] = [];
  const predicates: SemanticSourceBase["predicate"][] = [];
  const tests: SemanticSource["tests"][] = [];
  const probes: BenchmarkSemanticSource["probe"][] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) {
          continue;
        }

        const initializer = declaration.initializer;
        if (
          ts.isTaggedTemplateExpression(initializer) &&
          ts.isIdentifier(initializer.tag) &&
          initializer.tag.text === "concept"
        ) {
          const typeArguments = initializer.typeArguments;
          if (typeArguments === undefined || typeArguments.length !== 1) {
            throw sourceError(sourceFile, initializer, "concept requires exactly one type argument");
          }
          if (!ts.isNoSubstitutionTemplateLiteral(initializer.template)) {
            throw sourceError(sourceFile, initializer, "concept template substitutions are not supported");
          }

          const [typeNode] = typeArguments;
          if (typeNode === undefined) {
            throw sourceError(sourceFile, initializer, "concept requires exactly one type argument");
          }
          if (!ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) {
            throw sourceError(sourceFile, typeNode, "concept input must be a named TypeScript type");
          }
          const inputType = checker.getTypeFromTypeNode(typeNode);
          const typeName = typeNode.typeName.text;
          const conceptId = `local:${declaration.name.text}`;
          const parsedSpecification = parseConceptSpecificationAt(
            initializer.template.text,
            sourceFile,
            initializer.template,
            "predicate",
          );
          const specification = parsedSpecification.specification;
          concepts.push({
            name: declaration.name.text,
            id: conceptId,
            hash: hashConcept(conceptId, specification),
            shared: false,
            definitionName: declaration.name.text,
            definitionPath: sourceFile.fileName,
            specification,
            structure: parsedSpecification.structure,
            inputType,
            typeName,
            typeDeclaration: findTypeDeclaration(inputType, sourceFile),
            typeSchema: buildTypeSchema(inputType, checker, initializer, 0),
            node: initializer,
          });
          continue;
        }

        if (
          ts.isCallExpression(initializer) &&
          ts.isIdentifier(initializer.expression) &&
          initializer.expression.text === "bindConcept"
        ) {
          const typeArguments = initializer.typeArguments;
          if (typeArguments === undefined || typeArguments.length !== 1) {
            throw sourceError(sourceFile, initializer, "bindConcept requires exactly one type argument");
          }
          const [conceptArgument] = initializer.arguments;
          if (
            initializer.arguments.length !== 1 ||
            conceptArgument === undefined ||
            !ts.isIdentifier(conceptArgument)
          ) {
            throw sourceError(sourceFile, initializer, "bindConcept requires one concept definition identifier");
          }

          const [typeNode] = typeArguments;
          if (typeNode === undefined) {
            throw sourceError(sourceFile, initializer, "bindConcept requires exactly one type argument");
          }
          if (!ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) {
            throw sourceError(sourceFile, typeNode, "bindConcept input must be a named TypeScript type");
          }
          const definition = resolveConceptDefinition(
            conceptArgument,
            checker,
            sourceFile,
            "predicate",
          );
          const inputType = checker.getTypeFromTypeNode(typeNode);
          const typeName = typeNode.typeName.text;
          concepts.push({
            name: declaration.name.text,
            id: definition.id,
            hash: hashConcept(definition.id, definition.specification),
            shared: true,
            definitionName: definition.name,
            definitionPath: definition.sourceFile.fileName,
            specification: definition.specification,
            structure: definition.structure,
            inputType,
            typeName,
            typeDeclaration: findTypeDeclaration(inputType, sourceFile),
            typeSchema: buildTypeSchema(inputType, checker, initializer, 0),
            node: initializer,
          });
          continue;
        }

        if (
          ts.isCallExpression(initializer) &&
          ts.isIdentifier(initializer.expression) &&
          initializer.expression.text === "generatePredicate"
        ) {
          const [conceptArgument] = initializer.arguments;
          if (
            initializer.arguments.length !== 1 ||
            conceptArgument === undefined ||
            !ts.isIdentifier(conceptArgument)
          ) {
            throw sourceError(sourceFile, initializer, "generatePredicate requires one concept identifier");
          }
          predicates.push({
            name: declaration.name.text,
            conceptName: conceptArgument.text,
            parameterName: lowerFirst(typeNameFromConceptReference(conceptArgument.text, concepts)),
          });
        }
      }
      continue;
    }

    if (
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression)
    ) {
      const call = statement.expression;
      if (!ts.isIdentifier(call.expression)) continue;
      const callName = call.expression.text;
      if (callName === "benchmarkProbe") {
        const [predicateArgument] = call.arguments;
        if (
          call.arguments.length !== 1 ||
          predicateArgument === undefined ||
          !ts.isIdentifier(predicateArgument)
        ) {
          throw sourceError(
            sourceFile,
            call,
            "benchmarkProbe requires exactly one predicate",
          );
        }
        probes.push({ predicateName: predicateArgument.text });
        continue;
      }
      if (callName !== "semanticTest") continue;
      const [predicateArgument, caseArgument] = call.arguments;
      if (
        call.arguments.length !== 2 ||
        predicateArgument === undefined ||
        caseArgument === undefined ||
        !ts.isIdentifier(predicateArgument) ||
        !ts.isObjectLiteralExpression(caseArgument)
      ) {
        throw sourceError(sourceFile, call, "semanticTest requires a predicate and a case object");
      }
      const caseObject = caseArgument;
      assertObjectPropertyKeys(
        caseObject,
        ["accept", "reject", "boundary", "counterfactual", "invariance"],
        "semanticTest",
        sourceFile,
      );
      const accept = findArrayProperty(caseObject, "accept", sourceFile);
      const reject = findArrayProperty(caseObject, "reject", sourceFile);
      assertNonEmptyStaticArray(accept, "accept", sourceFile);
      assertNonEmptyStaticArray(reject, "reject", sourceFile);
      const boundary = findOptionalArrayProperty(
        caseObject,
        "boundary",
        sourceFile,
      );
      const counterfactual = findOptionalArrayProperty(
        caseObject,
        "counterfactual",
        sourceFile,
      );
      const invariance = findOptionalArrayProperty(
        caseObject,
        "invariance",
        sourceFile,
      );
      if (boundary !== null) {
        assertNamedSemanticCases(boundary, "semanticTest.boundary", sourceFile);
      }
      if (counterfactual !== null) {
        assertCounterfactualCases(counterfactual, sourceFile);
      }
      if (invariance !== null) {
        assertInvarianceCases(invariance, sourceFile);
      }
      tests.push({
        predicateName: predicateArgument.text,
        acceptSource: accept.getText(sourceFile),
        rejectSource: reject.getText(sourceFile),
        boundarySource: boundary?.getText(sourceFile) ?? null,
        counterfactualSource: counterfactual?.getText(sourceFile) ?? null,
        invarianceSource: invariance?.getText(sourceFile) ?? null,
      });
    }
  }

  if (expectedForm === "semantic-test" && probes.length > 0) {
    throw new SemanticSourceError(
      "benchmarkProbe is restricted to research benchmark runners",
    );
  }
  if (expectedForm === "benchmark-probe" && tests.length > 0) {
    throw new SemanticSourceError(
      "research benchmark sources must use benchmarkProbe instead of semanticTest",
    );
  }

  const formCount = expectedForm === "semantic-test" ? tests.length : probes.length;
  if (concepts.length !== 1 || predicates.length !== 1 || formCount !== 1) {
    const formName = expectedForm === "semantic-test"
      ? "semanticTest"
      : "benchmarkProbe";
    throw new SemanticSourceError(
      `MVP requires exactly one concept, one generated predicate, and one ${formName}; found ${concepts.length}/${predicates.length}/${formCount}`,
    );
  }

  const [conceptValue] = concepts;
  const [predicate] = predicates;
  if (conceptValue === undefined || predicate === undefined) {
    throw new SemanticSourceError("semantic source cardinality validation failed");
  }
  predicate.parameterName = lowerFirst(conceptValue.typeName);

  if (predicate.conceptName !== conceptValue.name) {
    throw new SemanticSourceError(
      `semantic closure failed: ${predicate.name} references unknown concept ${predicate.conceptName}`,
    );
  }
  const selectedForm = expectedForm === "semantic-test" ? tests[0] : probes[0];
  if (selectedForm === undefined) {
    throw new SemanticSourceError("semantic source form validation failed");
  }
  const formPredicateName = selectedForm.predicateName;
  const formName = expectedForm === "semantic-test"
    ? "semanticTest"
    : "benchmarkProbe";
  if (formPredicateName !== predicate.name) {
    throw new SemanticSourceError(
      `semantic closure failed: ${formName} references ${formPredicateName}, expected ${predicate.name}`,
    );
  }

  const base: SemanticSourceBase = {
    absolutePath,
    sourceText,
    sourceFile,
    program,
    checker,
    concept: conceptValue,
    predicate,
  };
  if (expectedForm === "semantic-test") {
    const [test] = tests;
    if (test === undefined) {
      throw new SemanticSourceError("semantic test validation failed");
    }
    return { ...base, sourceForm: "semantic-test", tests: test };
  }
  const [probe] = probes;
  if (probe === undefined) {
    throw new SemanticSourceError("benchmark probe validation failed");
  }
  return { ...base, sourceForm: "benchmark-probe", probe };
}

export function resolveConceptDefinition(
  reference: ts.Identifier,
  checker: ts.TypeChecker,
  bindingSourceFile: ts.SourceFile,
  use: ConceptSpecificationUse,
): {
  id: string;
  name: string;
  specification: string;
  structure: StructuredConceptSpecification;
  sourceFile: ts.SourceFile;
} {
  const referenceSymbol = checker.getSymbolAtLocation(reference);
  if (referenceSymbol === undefined) {
    throw sourceError(bindingSourceFile, reference, `cannot resolve concept definition ${reference.text}`);
  }
  const symbol = referenceSymbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(referenceSymbol)
    : referenceSymbol;
  const declaration = symbol.declarations?.find(ts.isVariableDeclaration);
  if (
    declaration === undefined ||
    !ts.isIdentifier(declaration.name) ||
    declaration.initializer === undefined ||
    !ts.isTaggedTemplateExpression(declaration.initializer)
  ) {
    throw sourceError(
      bindingSourceFile,
      reference,
      `${reference.text} must resolve to a defineConcept declaration`,
    );
  }

  const tagged = declaration.initializer;
  if (!ts.isCallExpression(tagged.tag)) {
    throw sourceError(
      bindingSourceFile,
      reference,
      `${reference.text} must use defineConcept("stable.id")`,
    );
  }
  const [idArgument] = tagged.tag.arguments;
  if (
    !ts.isIdentifier(tagged.tag.expression) ||
    tagged.tag.expression.text !== "defineConcept" ||
    tagged.tag.arguments.length !== 1 ||
    idArgument === undefined ||
    !ts.isStringLiteral(idArgument)
  ) {
    throw sourceError(
      bindingSourceFile,
      reference,
      `${reference.text} must use defineConcept("stable.id")`,
    );
  }
  if (!ts.isNoSubstitutionTemplateLiteral(tagged.template)) {
    throw sourceError(
      bindingSourceFile,
      reference,
      "defineConcept template substitutions are not supported",
    );
  }

  const id = idArgument.text;
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(id)) {
    throw sourceError(
      bindingSourceFile,
      reference,
      `concept ID must be a stable lowercase dotted identifier: ${id}`,
    );
  }

  const parsedSpecification = parseConceptSpecificationAt(
    tagged.template.text,
    tagged.getSourceFile(),
    tagged.template,
    use,
  );
  return {
    id,
    name: declaration.name.text,
    specification: parsedSpecification.specification,
    structure: parsedSpecification.structure,
    sourceFile: declaration.getSourceFile(),
  };
}

function parseConceptSpecificationAt(
  specification: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  use: ConceptSpecificationUse,
): ReturnType<typeof parseConceptSpecification> {
  try {
    const parsed = parseConceptSpecification(specification);
    validateConceptSpecificationForUse(parsed.structure, use);
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw sourceError(sourceFile, node, message);
  }
}

function findTypeDeclaration(type: ts.Type, sourceFile: ts.SourceFile): string {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  const declaration = symbol?.declarations?.find(
    (candidate) =>
      ts.isTypeAliasDeclaration(candidate) || ts.isInterfaceDeclaration(candidate),
  );
  if (declaration === undefined) {
    throw new SemanticSourceError("concept input type must have a type alias or interface declaration");
  }
  if (declaration.getSourceFile() !== sourceFile) {
    throw new SemanticSourceError("concept input type must be declared in the semantic source file");
  }
  return declaration.getText(sourceFile);
}

function buildTypeSchema(
  type: ts.Type,
  checker: ts.TypeChecker,
  location: ts.Node,
  depth: number,
): TypeSchema {
  if (depth > 3) {
    throw new SemanticSourceError("concept input type nesting exceeds the MVP limit");
  }
  if (type.isUnion()) {
    return { kind: "union", types: type.types.map((part) => buildTypeSchema(part, checker, location, depth + 1)) };
  }
  if (type.flags & ts.TypeFlags.StringLiteral) {
    return { kind: "literal", value: (type as ts.StringLiteralType).value };
  }
  if (type.flags & ts.TypeFlags.NumberLiteral) {
    return { kind: "literal", value: (type as ts.NumberLiteralType).value };
  }
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    return { kind: "literal", value: checker.typeToString(type) === "true" };
  }
  if (type.flags & ts.TypeFlags.StringLike) return { kind: "string" };
  if (type.flags & ts.TypeFlags.NumberLike) return { kind: "number" };
  if (type.flags & ts.TypeFlags.BooleanLike) return { kind: "boolean" };
  if (type.flags & ts.TypeFlags.Null) return { kind: "null" };
  if (type.flags & ts.TypeFlags.Undefined) return { kind: "undefined" };
  if (type.flags & ts.TypeFlags.Object) {
    if (checker.isArrayType(type)) {
      const typeArguments = checker.getTypeArguments(type as ts.TypeReference);
      const elementType = typeArguments[0];
      if (elementType === undefined) {
        throw new SemanticSourceError("array element type could not be determined");
      }
      return {
        kind: "array",
        elementType: buildTypeSchema(elementType, checker, location, depth + 1),
      };
    }
    return {
      kind: "object",
      properties: checker.getPropertiesOfType(type).map((property) => ({
        name: property.getName(),
        optional: Boolean(property.flags & ts.SymbolFlags.Optional),
        type: buildTypeSchema(
          checker.getTypeOfSymbolAtLocation(property, location),
          checker,
          location,
          depth + 1,
        ),
      })),
    };
  }
  throw new SemanticSourceError(`unsupported concept input type: ${checker.typeToString(type)}`);
}

function findArrayProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
  sourceFile: ts.SourceFile,
): ts.ArrayLiteralExpression {
  const property = object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) && propertyName(candidate.name) === name,
  );
  if (property === undefined || !ts.isArrayLiteralExpression(property.initializer)) {
    throw sourceError(sourceFile, object, `semanticTest.${name} must be an array literal`);
  }
  return property.initializer;
}

function findOptionalArrayProperty(
  object: ts.ObjectLiteralExpression,
  name: "boundary" | "counterfactual" | "invariance",
  sourceFile: ts.SourceFile,
): ts.ArrayLiteralExpression | null {
  const properties = object.properties.filter(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) && propertyName(candidate.name) === name,
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

function assertObjectPropertyKeys(
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
      throw sourceError(sourceFile, property.name, `${path}.${name} is duplicated`);
    }
    seen.add(name);
  }
}

function assertNamedSemanticCases(
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

function assertCounterfactualCases(
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
      throw sourceError(sourceFile, base, `${path}.base must be an object literal`);
    }
    assertObjectPropertyKeys(base, ["input", "expected"], `${path}.base`, sourceFile);
    assertStaticExpression(
      requiredProperty(base, "input", `${path}.base`, sourceFile),
      sourceFile,
    );
    assertSemanticExpected(base, `${path}.base`, sourceFile);
    const variants = requiredProperty(element, "variants", path, sourceFile);
    if (!ts.isArrayLiteralExpression(variants) || variants.elements.length === 0) {
      throw sourceError(
        sourceFile,
        variants,
        `${path}.variants must be a non-empty array literal`,
      );
    }
    assertNamedSemanticCases(variants, `${path}.variants`, sourceFile);
  });
}

function assertInvarianceCases(
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
    for (const input of inputs.elements) assertStaticExpression(input, sourceFile);
  });
}

function requiredProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
  path: string,
  sourceFile: ts.SourceFile,
): ts.Expression {
  const property = object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) && propertyName(candidate.name) === name,
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
  const expected = stringLiteralProperty(object, "expected", path, sourceFile);
  if (expected !== "accepted" && expected !== "rejected") {
    throw sourceError(
      sourceFile,
      object,
      `${path}.expected must be accepted or rejected`,
    );
  }
}

function assertNonEmptyStaticArray(
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

function assertStaticExpression(node: ts.Expression, sourceFile: ts.SourceFile): void {
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
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) return;
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) assertStaticExpression(element, sourceFile);
    return;
  }
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) || propertyName(property.name) === undefined) {
        throw sourceError(sourceFile, property, "semantic cases only support static object properties");
      }
      assertStaticExpression(property.initializer, sourceFile);
    }
    return;
  }
  throw sourceError(sourceFile, node, "semantic cases must contain only static literals");
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
    ? name.text
    : undefined;
}

function typeNameFromConceptReference(
  conceptName: string,
  concepts: SemanticSource["concept"][],
): string {
  return concepts.find((candidate) => candidate.name === conceptName)?.typeName ?? "value";
}

function lowerFirst(value: string): string {
  const first = value.at(0);
  return first === undefined ? "value" : first.toLowerCase() + value.slice(1);
}

export function hashConcept(id: string, specification: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ id, specification }))
    .digest("hex");
}

export function sourceError(sourceFile: ts.SourceFile, node: ts.Node, message: string): SemanticSourceError {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return new SemanticSourceError(`${basename(sourceFile.fileName)}:${position.line + 1}:${position.character + 1}: ${message}`);
}

export function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => ts.sys.newLine,
  });
}
