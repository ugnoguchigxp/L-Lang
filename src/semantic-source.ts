import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import ts from "typescript";

export type TypeSchema =
  | { kind: "string" | "number" | "boolean" | "null" | "undefined" }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "union"; types: TypeSchema[] }
  | { kind: "array"; elementType: TypeSchema }
  | {
      kind: "object";
      properties: Array<{ name: string; optional: boolean; type: TypeSchema }>;
    };

export type SemanticSource = {
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
  tests: {
    predicateName: string;
    acceptSource: string;
    rejectSource: string;
  };
};

export class SemanticSourceError extends Error {
  override name = "SemanticSourceError";
}

export async function scanSemanticSource(
  sourcePath: string,
): Promise<SemanticSource> {
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
  const concepts: SemanticSource["concept"][] = [];
  const predicates: SemanticSource["predicate"][] = [];
  const tests: SemanticSource["tests"][] = [];

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

          const typeNode = typeArguments[0]!;
          if (!ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) {
            throw sourceError(sourceFile, typeNode, "concept input must be a named TypeScript type");
          }
          const inputType = checker.getTypeFromTypeNode(typeNode);
          const typeName = typeNode.typeName.text;
          const conceptId = `local:${declaration.name.text}`;
          const specification = initializer.template.text.trim();
          concepts.push({
            name: declaration.name.text,
            id: conceptId,
            hash: hashConcept(conceptId, specification),
            shared: false,
            definitionName: declaration.name.text,
            definitionPath: sourceFile.fileName,
            specification,
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
          if (initializer.arguments.length !== 1 || !ts.isIdentifier(initializer.arguments[0]!)) {
            throw sourceError(sourceFile, initializer, "bindConcept requires one concept definition identifier");
          }

          const typeNode = typeArguments[0]!;
          if (!ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) {
            throw sourceError(sourceFile, typeNode, "bindConcept input must be a named TypeScript type");
          }
          const definition = resolveConceptDefinition(
            initializer.arguments[0]!,
            checker,
            sourceFile,
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
          if (initializer.arguments.length !== 1 || !ts.isIdentifier(initializer.arguments[0]!)) {
            throw sourceError(sourceFile, initializer, "generatePredicate requires one concept identifier");
          }
          predicates.push({
            name: declaration.name.text,
            conceptName: initializer.arguments[0]!.text,
            parameterName: lowerFirst(typeNameFromConceptReference(initializer.arguments[0]!.text, concepts)),
          });
        }
      }
      continue;
    }

    if (
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      ts.isIdentifier(statement.expression.expression) &&
      statement.expression.expression.text === "semanticTest"
    ) {
      const call = statement.expression;
      if (
        call.arguments.length !== 2 ||
        !ts.isIdentifier(call.arguments[0]!) ||
        !ts.isObjectLiteralExpression(call.arguments[1]!)
      ) {
        throw sourceError(sourceFile, call, "semanticTest requires a predicate and a case object");
      }
      const caseObject = call.arguments[1]!;
      const accept = findArrayProperty(caseObject, "accept", sourceFile);
      const reject = findArrayProperty(caseObject, "reject", sourceFile);
      assertStaticArray(accept, sourceFile);
      assertStaticArray(reject, sourceFile);
      tests.push({
        predicateName: call.arguments[0]!.text,
        acceptSource: accept.getText(sourceFile),
        rejectSource: reject.getText(sourceFile),
      });
    }
  }

  if (concepts.length !== 1 || predicates.length !== 1 || tests.length !== 1) {
    throw new SemanticSourceError(
      `MVP requires exactly one concept, one generated predicate, and one semanticTest; found ${concepts.length}/${predicates.length}/${tests.length}`,
    );
  }

  const conceptValue = concepts[0]!;
  const predicate = predicates[0]!;
  const semanticTests = tests[0]!;
  predicate.parameterName = lowerFirst(conceptValue.typeName);

  if (predicate.conceptName !== conceptValue.name) {
    throw new SemanticSourceError(
      `semantic closure failed: ${predicate.name} references unknown concept ${predicate.conceptName}`,
    );
  }
  if (semanticTests.predicateName !== predicate.name) {
    throw new SemanticSourceError(
      `semantic closure failed: semanticTest references ${semanticTests.predicateName}, expected ${predicate.name}`,
    );
  }

  return {
    absolutePath,
    sourceText,
    sourceFile,
    program,
    checker,
    concept: conceptValue,
    predicate,
    tests: semanticTests,
  };
}

function resolveConceptDefinition(
  reference: ts.Identifier,
  checker: ts.TypeChecker,
  bindingSourceFile: ts.SourceFile,
): {
  id: string;
  name: string;
  specification: string;
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
  if (
    !ts.isCallExpression(tagged.tag) ||
    !ts.isIdentifier(tagged.tag.expression) ||
    tagged.tag.expression.text !== "defineConcept" ||
    tagged.tag.arguments.length !== 1 ||
    !ts.isStringLiteral(tagged.tag.arguments[0]!)
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

  const id = tagged.tag.arguments[0]!.text;
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(id)) {
    throw sourceError(
      bindingSourceFile,
      reference,
      `concept ID must be a stable lowercase dotted identifier: ${id}`,
    );
  }

  return {
    id,
    name: declaration.name.text,
    specification: tagged.template.text.trim(),
    sourceFile: declaration.getSourceFile(),
  };
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

function assertStaticArray(array: ts.ArrayLiteralExpression, sourceFile: ts.SourceFile): void {
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
  return value.length === 0 ? "value" : value[0]!.toLowerCase() + value.slice(1);
}

export function hashConcept(id: string, specification: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ id, specification }))
    .digest("hex");
}

function sourceError(sourceFile: ts.SourceFile, node: ts.Node, message: string): SemanticSourceError {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return new SemanticSourceError(`${basename(sourceFile.fileName)}:${position.line + 1}:${position.character + 1}: ${message}`);
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => ts.sys.newLine,
  });
}
