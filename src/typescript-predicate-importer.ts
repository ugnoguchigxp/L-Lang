import { basename, extname, isAbsolute, relative, resolve } from "node:path";

import ts from "typescript";

import {
  canonicalTypeHash,
  type CanonicalPredicateType,
} from "./canonical-type-ir";
import {
  projectCanonicalTypeToJsonSchema,
  type JsonSchemaProjection,
} from "./canonical-type-json-schema";
import {
  renderImplementationSpecification,
  type ImplementationSpecificationProjection,
} from "./hybrid-specification";
import { parsePredicateExpression, type PredicateExpression } from "./ir";
import { SEMANTIC_LIMITS } from "./semantic-limits";
import {
  buildTypeSchema,
  findTypeDeclaration,
  type TypeSchema,
} from "./semantic-source-type-schema";
import { fingerprintFor, sha256 } from "./stable-hash";
import {
  loadTypeScriptSource,
  TypeScriptSourceLoadError,
  type LoadedTypeScriptSource,
} from "./typescript-source-loader";
import { mapTypeScriptSchema } from "./typescript-type-provider";
import { type WasmContract, WasmError } from "./wasm-contract";
import { contractFromCanonicalType, lowerPredicate } from "./wasm-core";

export type TypeScriptImportErrorCode =
  | "SOURCE_OUTSIDE_WORKSPACE"
  | "SOURCE_TOO_LARGE"
  | "TSCONFIG_NOT_FOUND"
  | "TYPESCRIPT_DIAGNOSTIC"
  | "FUNCTION_NOT_FOUND"
  | "AMBIGUOUS_FUNCTION"
  | "UNSUPPORTED_SIGNATURE"
  | "UNSUPPORTED_SYNTAX"
  | "UNSUPPORTED_TYPE"
  | "INVALID_IR";

export class TypeScriptImportError extends Error {
  override name = "TypeScriptImportError";

  constructor(
    public readonly code: TypeScriptImportErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(boundDiagnostic(`${code}: ${message}`), options);
  }
}

export type ImportedTypeScriptPredicate = {
  version: 1;
  profile: "predicate-i32-v1";
  source: {
    file: string;
    functionName: string;
    sourceHash: string;
  };
  input: {
    parameterName: string;
    typeName: string;
    schema: TypeSchema;
    canonicalType: CanonicalPredicateType;
    canonicalTypeHash: string;
    mapping: {
      provider: "typescript";
      status: "lossless";
      diagnostics: [];
    };
  };
  body: PredicateExpression;
  contract: WasmContract;
  projections: {
    jsonSchema: JsonSchemaProjection;
    specification: ImplementationSpecificationProjection;
  };
  semanticHash: string;
};

export async function importTypeScriptPredicate(input: {
  workspaceRoot: string;
  sourcePath: string;
  functionName: string;
}): Promise<ImportedTypeScriptPredicate> {
  const workspaceRoot = resolve(input.workspaceRoot);
  let loaded: LoadedTypeScriptSource;
  try {
    loaded = await loadTypeScriptSource({
      sourcePath: input.sourcePath,
      workspaceRoot,
      maximumBytes: SEMANTIC_LIMITS.typescriptSourceBytes,
      rejectSymbolicLinks: true,
      includeConfigDiagnostics: true,
    });
  } catch (error) {
    throw translateLoadError(error, workspaceRoot, input.sourcePath);
  }

  const sourcePath = relativePath(workspaceRoot, loaded.absolutePath);
  if (extname(loaded.absolutePath) !== ".ts") {
    throw importError(
      "UNSUPPORTED_SYNTAX",
      sourcePath,
      "source must be a .ts file",
    );
  }
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(input.functionName)) {
    throw importError(
      "FUNCTION_NOT_FOUND",
      sourcePath,
      "function name must be a TypeScript identifier",
    );
  }

  const declaration = findFunction(
    loaded.sourceFile,
    input.functionName,
    sourcePath,
  );
  const { parameterName, typeName, typeNode, returnExpression } =
    validateFunction(declaration, loaded.sourceFile, sourcePath);

  const inputType = loaded.checker.getTypeFromTypeNode(typeNode);
  let schema: TypeSchema;
  try {
    findTypeDeclaration(inputType, loaded.sourceFile);
    assertRecordShapeSupported(inputType, loaded.checker);
    assertSameFileTypeDependencies(
      inputType,
      loaded.checker,
      loaded.program,
      loaded.sourceFile,
      typeNode,
    );
    schema = buildTypeSchema(inputType, loaded.checker, typeNode, 0);
  } catch (error) {
    throw nodeError(
      "UNSUPPORTED_TYPE",
      loaded.sourceFile,
      typeNode,
      sourcePath,
      errorMessage(error),
      error,
    );
  }
  const mapping = mapTypeScriptSchema(schema);
  if (mapping.status !== "lossless") {
    throw nodeError(
      "UNSUPPORTED_TYPE",
      loaded.sourceFile,
      typeNode,
      sourcePath,
      mapping.diagnostics
        .map(
          (diagnostic) =>
            `${diagnostic.code} at ${diagnostic.path.join(".") || "input"}: ${diagnostic.message}`,
        )
        .join("; "),
    );
  }
  const canonicalType = mapping.type;
  let contract: WasmContract;
  try {
    contract = contractFromCanonicalType(canonicalType);
  } catch (error) {
    throw nodeError(
      "UNSUPPORTED_TYPE",
      loaded.sourceFile,
      typeNode,
      sourcePath,
      errorMessage(error),
      error,
    );
  }

  let body: PredicateExpression;
  try {
    assertUndefinedIsUnshadowed(
      returnExpression,
      loaded.checker,
      loaded.sourceFile,
      sourcePath,
    );
    const lowered = lowerExpression(
      returnExpression,
      parameterName,
      loaded.sourceFile,
      sourcePath,
    );
    body = parsePredicateExpression(lowered);
  } catch (error) {
    if (error instanceof TypeScriptImportError) throw error;
    throw nodeError(
      "INVALID_IR",
      loaded.sourceFile,
      returnExpression,
      sourcePath,
      errorMessage(error),
      error,
    );
  }

  try {
    lowerPredicate(body, contract);
  } catch (error) {
    const code =
      error instanceof WasmError && error.code === "UNSUPPORTED_TYPE"
        ? "UNSUPPORTED_TYPE"
        : "INVALID_IR";
    throw nodeError(
      code,
      loaded.sourceFile,
      returnExpression,
      sourcePath,
      errorMessage(error),
      error,
    );
  }

  const profile = "predicate-i32-v1" as const;
  const jsonSchema = projectCanonicalTypeToJsonSchema(canonicalType);
  const specification = renderImplementationSpecification({
    functionName: input.functionName,
    parameterName,
    canonicalType,
    expression: body,
    jsonSchema,
  });
  return {
    version: 1,
    profile,
    source: {
      file: sourcePath,
      functionName: input.functionName,
      sourceHash: sha256(loaded.sourceText),
    },
    input: {
      parameterName,
      typeName,
      schema,
      canonicalType,
      canonicalTypeHash: canonicalTypeHash(canonicalType),
      mapping: {
        provider: mapping.provider,
        status: mapping.status,
        diagnostics: mapping.diagnostics,
      },
    },
    body,
    contract,
    projections: { jsonSchema, specification },
    semanticHash: fingerprintFor({ profile, contract, body }),
  };
}

function findFunction(
  sourceFile: ts.SourceFile,
  functionName: string,
  sourcePath: string,
): ts.FunctionDeclaration {
  const matches = sourceFile.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === functionName,
  );
  if (matches.length === 0) {
    throw importError(
      "FUNCTION_NOT_FOUND",
      sourcePath,
      `top-level function ${functionName} was not found`,
    );
  }
  if (matches.length !== 1) {
    throw nodeError(
      "AMBIGUOUS_FUNCTION",
      sourceFile,
      matches[0] ?? sourceFile,
      sourcePath,
      `top-level function ${functionName} has multiple declarations`,
    );
  }
  const declaration = matches[0];
  if (declaration === undefined) {
    throw importError(
      "FUNCTION_NOT_FOUND",
      sourcePath,
      `top-level function ${functionName} was not found`,
    );
  }
  const modifiers = ts.getModifiers(declaration) ?? [];
  if (
    !modifiers.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) ||
    modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
  ) {
    throw nodeError(
      "UNSUPPORTED_SIGNATURE",
      sourceFile,
      declaration,
      sourcePath,
      "function must be a named export",
    );
  }
  return declaration;
}

function validateFunction(
  declaration: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
  sourcePath: string,
): {
  parameterName: string;
  typeName: string;
  typeNode: ts.TypeReferenceNode;
  returnExpression: ts.Expression;
} {
  const modifiers = ts.getModifiers(declaration) ?? [];
  if (
    modifiers.some(
      (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
    ) ||
    declaration.asteriskToken !== undefined ||
    (declaration.typeParameters?.length ?? 0) > 0
  ) {
    throw signatureError(
      declaration,
      sourceFile,
      sourcePath,
      "async, generator, and generic functions are not supported",
    );
  }
  if (declaration.parameters.length !== 1) {
    throw signatureError(
      declaration,
      sourceFile,
      sourcePath,
      "function must have exactly one parameter",
    );
  }
  const parameter = declaration.parameters[0];
  if (parameter === undefined || !ts.isIdentifier(parameter.name)) {
    throw signatureError(
      parameter ?? declaration,
      sourceFile,
      sourcePath,
      "parameter must be an identifier",
    );
  }
  if (
    parameter.dotDotDotToken !== undefined ||
    parameter.questionToken !== undefined ||
    parameter.initializer !== undefined
  ) {
    throw signatureError(
      parameter,
      sourceFile,
      sourcePath,
      "optional, rest, and default parameters are not supported",
    );
  }
  if (
    parameter.type === undefined ||
    !ts.isTypeReferenceNode(parameter.type) ||
    !ts.isIdentifier(parameter.type.typeName) ||
    (parameter.type.typeArguments?.length ?? 0) > 0
  ) {
    throw nodeError(
      "UNSUPPORTED_TYPE",
      sourceFile,
      parameter,
      sourcePath,
      "parameter must use a same-file named type",
    );
  }
  if (
    declaration.type === undefined ||
    declaration.type.kind !== ts.SyntaxKind.BooleanKeyword
  ) {
    throw signatureError(
      declaration.type ?? declaration,
      sourceFile,
      sourcePath,
      "function must declare a boolean return type",
    );
  }
  const body = declaration.body;
  const statement = body?.statements[0];
  if (
    body === undefined ||
    body.statements.length !== 1 ||
    statement === undefined ||
    !ts.isReturnStatement(statement) ||
    statement.expression === undefined
  ) {
    throw signatureError(
      declaration.body ?? declaration,
      sourceFile,
      sourcePath,
      "function body must contain exactly one return expression",
    );
  }
  return {
    parameterName: parameter.name.text,
    typeName: parameter.type.typeName.text,
    typeNode: parameter.type,
    returnExpression: statement.expression,
  };
}

function lowerExpression(
  input: ts.Expression,
  parameterName: string,
  sourceFile: ts.SourceFile,
  sourcePath: string,
): PredicateExpression {
  const expression = unwrapParentheses(input);
  if (ts.isBinaryExpression(expression)) {
    const presence = lowerNullishPattern(
      expression,
      parameterName,
      sourceFile,
      sourcePath,
    );
    if (presence !== null) return presence;
    if (
      expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
    ) {
      return {
        kind:
          expression.operatorToken.kind ===
          ts.SyntaxKind.AmpersandAmpersandToken
            ? "all"
            : "any",
        conditions: [
          lowerExpression(
            expression.left,
            parameterName,
            sourceFile,
            sourcePath,
          ),
          lowerExpression(
            expression.right,
            parameterName,
            sourceFile,
            sourcePath,
          ),
        ],
      };
    }
    if (
      expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      expression.operatorToken.kind ===
        ts.SyntaxKind.ExclamationEqualsEqualsToken
    ) {
      const equality = lowerEquality(
        expression,
        parameterName,
        sourceFile,
        sourcePath,
      );
      return expression.operatorToken.kind ===
        ts.SyntaxKind.ExclamationEqualsEqualsToken
        ? { kind: "not", condition: equality }
        : equality;
    }
  }
  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return {
      kind: "not",
      condition: lowerExpression(
        expression.operand,
        parameterName,
        sourceFile,
        sourcePath,
      ),
    };
  }
  throw nodeError(
    "UNSUPPORTED_SYNTAX",
    sourceFile,
    expression,
    sourcePath,
    `unsupported expression kind ${ts.SyntaxKind[expression.kind] ?? expression.kind}`,
  );
}

function lowerNullishPattern(
  expression: ts.BinaryExpression,
  parameterName: string,
  sourceFile: ts.SourceFile,
  sourcePath: string,
): PredicateExpression | null {
  const operator = expression.operatorToken.kind;
  const comparisonOperator =
    operator === ts.SyntaxKind.AmpersandAmpersandToken
      ? ts.SyntaxKind.ExclamationEqualsEqualsToken
      : operator === ts.SyntaxKind.BarBarToken
        ? ts.SyntaxKind.EqualsEqualsEqualsToken
        : null;
  if (comparisonOperator === null) return null;
  const left = readNullishComparison(
    expression.left,
    comparisonOperator,
    parameterName,
    sourceFile,
    sourcePath,
  );
  const right = readNullishComparison(
    expression.right,
    comparisonOperator,
    parameterName,
    sourceFile,
    sourcePath,
  );
  if (
    left === null ||
    right === null ||
    left.nullish === right.nullish ||
    left.property[0] !== right.property[0]
  ) {
    return null;
  }
  const present: PredicateExpression = {
    kind: "present",
    property: left.property,
  };
  return operator === ts.SyntaxKind.AmpersandAmpersandToken
    ? present
    : { kind: "not", condition: present };
}

function readNullishComparison(
  input: ts.Expression,
  operator: ts.SyntaxKind,
  parameterName: string,
  sourceFile: ts.SourceFile,
  sourcePath: string,
): { property: string[]; nullish: "null" | "undefined" } | null {
  const expression = unwrapParentheses(input);
  if (
    !ts.isBinaryExpression(expression) ||
    expression.operatorToken.kind !== operator
  ) {
    return null;
  }
  const leftProperty = readProperty(
    expression.left,
    parameterName,
    sourceFile,
    sourcePath,
  );
  const rightProperty = readProperty(
    expression.right,
    parameterName,
    sourceFile,
    sourcePath,
  );
  const leftNullish = readNullish(expression.left);
  const rightNullish = readNullish(expression.right);
  if (leftProperty !== null && rightNullish !== null) {
    return { property: leftProperty, nullish: rightNullish };
  }
  if (rightProperty !== null && leftNullish !== null) {
    return { property: rightProperty, nullish: leftNullish };
  }
  return null;
}

function lowerEquality(
  expression: ts.BinaryExpression,
  parameterName: string,
  sourceFile: ts.SourceFile,
  sourcePath: string,
): PredicateExpression {
  const leftProperty = readProperty(
    expression.left,
    parameterName,
    sourceFile,
    sourcePath,
  );
  const rightProperty = readProperty(
    expression.right,
    parameterName,
    sourceFile,
    sourcePath,
  );
  if (leftProperty !== null) {
    return {
      kind: "equals",
      property: leftProperty,
      value: readLiteral(expression.right, sourceFile, sourcePath),
    };
  }
  if (rightProperty !== null) {
    return {
      kind: "equals",
      property: rightProperty,
      value: readLiteral(expression.left, sourceFile, sourcePath),
    };
  }
  throw nodeError(
    "UNSUPPORTED_SYNTAX",
    sourceFile,
    expression,
    sourcePath,
    "strict comparison must compare a direct input property with a literal",
  );
}

function readProperty(
  input: ts.Expression,
  parameterName: string,
  sourceFile: ts.SourceFile,
  sourcePath: string,
): string[] | null {
  const expression = unwrapParentheses(input);
  if (!ts.isPropertyAccessExpression(expression)) return null;
  if (expression.questionDotToken !== undefined) {
    throw nodeError(
      "UNSUPPORTED_SYNTAX",
      sourceFile,
      expression,
      sourcePath,
      "optional chaining is not supported",
    );
  }
  if (!ts.isIdentifier(expression.expression)) {
    throw nodeError(
      "UNSUPPORTED_SYNTAX",
      sourceFile,
      expression,
      sourcePath,
      "nested property access is not supported",
    );
  }
  if (expression.expression.text !== parameterName) {
    throw nodeError(
      "UNSUPPORTED_SYNTAX",
      sourceFile,
      expression,
      sourcePath,
      `property access must be rooted at ${parameterName}`,
    );
  }
  return [expression.name.text];
}

function readLiteral(
  input: ts.Expression,
  sourceFile: ts.SourceFile,
  sourcePath: string,
): string | boolean | null {
  const expression = unwrapParentheses(input);
  if (ts.isStringLiteral(expression)) return expression.text;
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expression.kind === ts.SyntaxKind.NullKeyword) return null;
  throw nodeError(
    "UNSUPPORTED_SYNTAX",
    sourceFile,
    expression,
    sourcePath,
    "comparison literal must be a boolean, string literal, or null",
  );
}

function readNullish(input: ts.Expression): "null" | "undefined" | null {
  const expression = unwrapParentheses(input);
  if (expression.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (ts.isIdentifier(expression) && expression.text === "undefined") {
    return "undefined";
  }
  return null;
}

function unwrapParentheses(input: ts.Expression): ts.Expression {
  let expression = input;
  while (ts.isParenthesizedExpression(expression)) {
    expression = expression.expression;
  }
  return expression;
}

function signatureError(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  sourcePath: string,
  message: string,
): TypeScriptImportError {
  return nodeError(
    "UNSUPPORTED_SIGNATURE",
    sourceFile,
    node,
    sourcePath,
    message,
  );
}

function nodeError(
  code: TypeScriptImportErrorCode,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  sourcePath: string,
  message: string,
  cause?: unknown,
): TypeScriptImportError {
  const position = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  return new TypeScriptImportError(
    code,
    `${sourcePath}:${position.line + 1}:${position.character + 1}: ${message}`,
    cause === undefined ? undefined : { cause },
  );
}

function importError(
  code: TypeScriptImportErrorCode,
  sourcePath: string,
  message: string,
  cause?: unknown,
): TypeScriptImportError {
  return new TypeScriptImportError(
    code,
    `${sourcePath}: ${message}`,
    cause === undefined ? undefined : { cause },
  );
}

function translateLoadError(
  error: unknown,
  workspaceRoot: string,
  sourcePath: string,
): TypeScriptImportError {
  const safePath = basename(sourcePath);
  if (!(error instanceof TypeScriptSourceLoadError)) {
    return importError(
      "TYPESCRIPT_DIAGNOSTIC",
      safePath,
      "TypeScript could not load the source",
      error,
    );
  }
  if (error.code === "SOURCE_PATH") {
    return importError(
      "SOURCE_OUTSIDE_WORKSPACE",
      safePath,
      "source must be a regular, non-symbolic file inside the workspace",
      error,
    );
  }
  if (error.code === "SOURCE_TOO_LARGE") {
    return importError("SOURCE_TOO_LARGE", safePath, error.message, error);
  }
  if (error.code === "TSCONFIG_NOT_FOUND") {
    return importError(
      "TSCONFIG_NOT_FOUND",
      safePath,
      "tsconfig.json was not found",
      error,
    );
  }
  if (error.code === "TYPESCRIPT_DIAGNOSTIC") {
    const diagnostic = error.diagnostics[0];
    if (diagnostic !== undefined) {
      const path =
        diagnostic.file === undefined
          ? safePath
          : safeDiagnosticPath(workspaceRoot, diagnostic.file.fileName);
      const position =
        diagnostic.file !== undefined && diagnostic.start !== undefined
          ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
          : null;
      const location =
        position === null
          ? path
          : `${path}:${position.line + 1}:${position.character + 1}`;
      return new TypeScriptImportError(
        "TYPESCRIPT_DIAGNOSTIC",
        `${location}: ${sanitizeDiagnosticText(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
          workspaceRoot,
        )}`,
        { cause: error },
      );
    }
  }
  return importError(
    "TYPESCRIPT_DIAGNOSTIC",
    safePath,
    "TypeScript could not load the source",
    error,
  );
}

function safeDiagnosticPath(workspaceRoot: string, fileName: string): string {
  const path = relativePath(workspaceRoot, fileName);
  return path === ".." || path.startsWith("../") || isAbsolute(path)
    ? basename(fileName)
    : path;
}

function relativePath(workspaceRoot: string, fileName: string): string {
  return relative(resolve(workspaceRoot), resolve(fileName)).replaceAll(
    "\\",
    "/",
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof WasmError) {
    return error.message.replace(`${error.code}: `, "");
  }
  return error instanceof Error ? error.message : String(error);
}

function assertSameFileTypeDependencies(
  input: ts.Type,
  checker: ts.TypeChecker,
  program: ts.Program,
  sourceFile: ts.SourceFile,
  location: ts.Node,
): void {
  const seen = new Set<ts.Type>();
  const visit = (type: ts.Type): void => {
    if (seen.has(type)) return;
    seen.add(type);
    for (const symbol of [type.aliasSymbol, type.getSymbol()]) {
      for (const declaration of symbol?.declarations ?? []) {
        const declarationFile = declaration.getSourceFile();
        if (
          declarationFile !== sourceFile &&
          !program.isSourceFileDefaultLibrary(declarationFile)
        ) {
          throw new Error(
            "input type dependencies must be declared in the source file",
          );
        }
      }
    }
    if (type.isUnionOrIntersection()) {
      for (const part of type.types) visit(part);
      return;
    }
    if (!(type.flags & ts.TypeFlags.Object)) return;
    for (const property of checker.getPropertiesOfType(type)) {
      for (const declaration of property.declarations ?? []) {
        const declarationFile = declaration.getSourceFile();
        if (
          declarationFile !== sourceFile &&
          !program.isSourceFileDefaultLibrary(declarationFile)
        ) {
          throw new Error(
            "input type dependencies must be declared in the source file",
          );
        }
      }
      visit(checker.getTypeOfSymbolAtLocation(property, location));
    }
  };
  visit(input);
}

function assertRecordShapeSupported(
  input: ts.Type,
  checker: ts.TypeChecker,
): void {
  if (
    input.getCallSignatures().length > 0 ||
    input.getConstructSignatures().length > 0 ||
    checker.getIndexInfosOfType(input).length > 0
  ) {
    throw new Error(
      "input type call, construct, and index signatures are not supported",
    );
  }
}

function assertUndefinedIsUnshadowed(
  input: ts.Expression,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  sourcePath: string,
): void {
  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      node.text === "undefined" &&
      !(
        ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
      ) &&
      checker
        .getSymbolAtLocation(node)
        ?.declarations?.some(
          (declaration) => declaration.getSourceFile() === sourceFile,
        )
    ) {
      throw nodeError(
        "UNSUPPORTED_SYNTAX",
        sourceFile,
        node,
        sourcePath,
        "shadowed undefined is not supported",
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(input);
}

function sanitizeDiagnosticText(
  message: string,
  workspaceRoot: string,
): string {
  const roots = new Set([
    resolve(workspaceRoot),
    resolve(workspaceRoot).replaceAll("\\", "/"),
  ]);
  let sanitized = message;
  for (const root of roots) sanitized = sanitized.replaceAll(root, ".");
  return sanitized
    .replace(
      /(['"`])(?:[A-Za-z]:[\\/]|\/)[^'"`\r\n]*\1/g,
      "$1<absolute-path>$1",
    )
    .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s'"`]+/g, "<absolute-path>");
}

function boundDiagnostic(message: string): string {
  if (message.length <= SEMANTIC_LIMITS.diagnosticCharacters) return message;
  return `${message.slice(0, SEMANTIC_LIMITS.diagnosticCharacters - 1)}…`;
}
