import ts from "typescript";
import {
  effectValueTypeJson,
  parseEffectValueType,
  type EffectValueType,
} from "./llang-effects-ir";
import { ModuleError } from "./llang-module-ir";

// Straight-line async source is lowered without evaluating the module. The
// resulting graph uses the existing grant checks, continuation ABI and replay.
export function lowerAsyncEffects(
  source: ts.SourceFile,
  literal: (node: ts.Expression) => unknown,
): { definition: Record<string, unknown>; entry: string } {
  const fail: (message: string) => never = (message) => {
    throw new ModuleError("LLE001", message, source.fileName);
  };
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail("effects metadata must be an object");
    return value as Record<string, unknown>;
  };
  const typeDeclarations = new Map<
    string,
    ts.TypeNode | ts.InterfaceDeclaration
  >();
  let metadata: Record<string, unknown> | undefined,
    entry: ts.FunctionDeclaration | undefined,
    imported = false;
  const topNames = new Set([
    "defineEffects",
    "invoke",
    "Promise",
    "Array",
    "ReadonlyArray",
  ]);
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause,
        names = clause?.namedBindings;
      if (
        imported ||
        statement.attributes ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== "llang:effects" ||
        clause?.isTypeOnly ||
        clause?.name ||
        !names ||
        !ts.isNamedImports(names) ||
        names.elements.length !== 2 ||
        names.elements.some((name) => name.isTypeOnly || name.propertyName) ||
        new Set(names.elements.map((name) => name.name.text)).size !== 2 ||
        !names.elements.some((name) => name.name.text === "defineEffects") ||
        !names.elements.some((name) => name.name.text === "invoke")
      )
        fail(
          "async source requires named defineEffects and invoke imports from llang:effects",
        );
      imported = true;
    } else if (
      ts.isTypeAliasDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement)
    ) {
      if (topNames.has(statement.name.text) || statement.typeParameters?.length)
        fail("async record types must be unique and non-generic");
      topNames.add(statement.name.text);
      typeDeclarations.set(
        statement.name.text,
        ts.isTypeAliasDeclaration(statement) ? statement.type : statement,
      );
    } else if (ts.isVariableStatement(statement)) {
      const declaration = statement.declarationList.declarations[0];
      if (
        metadata ||
        !(statement.declarationList.flags & ts.NodeFlags.Const) ||
        statement.declarationList.declarations.length !== 1 ||
        !declaration ||
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer ||
        !ts.isCallExpression(declaration.initializer) ||
        declaration.initializer.questionDotToken ||
        !ts.isIdentifier(declaration.initializer.expression) ||
        declaration.initializer.expression.text !== "defineEffects" ||
        declaration.initializer.arguments.length !== 1 ||
        declaration.initializer.typeArguments?.length ||
        statement.modifiers?.some(
          (modifier) => modifier.kind !== ts.SyntaxKind.ExportKeyword,
        )
      )
        fail(
          "async source requires one const defineEffects metadata declaration",
        );
      if (topNames.has(declaration.name.text))
        fail("async top-level binding conflicts with an existing name");
      topNames.add(declaration.name.text);
      metadata = record(
        literal(declaration.initializer.arguments[0] as ts.Expression),
      );
    } else if (ts.isFunctionDeclaration(statement)) {
      if (
        entry ||
        !statement.name ||
        !statement.body ||
        !statement.type ||
        statement.parameters.length ||
        statement.typeParameters?.length ||
        statement.asteriskToken ||
        !statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        ) ||
        !statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
        ) ||
        statement.modifiers?.some(
          (modifier) =>
            modifier.kind !== ts.SyntaxKind.ExportKeyword &&
            modifier.kind !== ts.SyntaxKind.AsyncKeyword,
        )
      )
        fail(
          "async entry must be one named exported async function without parameters",
        );
      if (topNames.has(statement.name.text))
        fail("async entry conflicts with an existing name");
      topNames.add(statement.name.text);
      entry = statement;
    } else if (!ts.isEmptyStatement(statement))
      fail("unsupported async top-level syntax");
  }
  if (!imported || !metadata || !entry?.name || !entry.body || !entry.type)
    fail("async source requires metadata and an exported entry");
  if (
    Object.keys(metadata).some((key) => !["module", "operations"].includes(key))
  )
    fail("async metadata accepts module and operations only");
  if (!Array.isArray(metadata.operations))
    fail("async metadata requires operation definitions");
  const operations = metadata.operations.map(record),
    nodes: {
      kind: "await";
      operation: string;
      version: number;
      request: unknown;
    }[] = [],
    names = new Set(topNames),
    constants = new Map<string, { value: unknown; type: ts.TypeNode }>();
  let finalBinding: string | undefined,
    finalType: EffectValueType | undefined,
    returned = false;
  const matchesType = (
    node: ts.TypeNode,
    expected: EffectValueType,
    depth = 0,
  ): boolean => {
    if (depth > 8) fail("async type expansion exceeds limit");
    if (ts.isParenthesizedTypeNode(node))
      return matchesType(node.type, expected, depth + 1);
    if (
      ts.isTypeOperatorNode(node) &&
      node.operator === ts.SyntaxKind.ReadonlyKeyword &&
      ts.isArrayTypeNode(node.type)
    )
      return matchesType(node.type, expected, depth + 1);
    if (node.kind === ts.SyntaxKind.NumberKeyword)
      return expected.kind === "i32" || expected.kind === "f64";
    if (node.kind === ts.SyntaxKind.StringKeyword)
      return expected.kind === "string";
    if (node.kind === ts.SyntaxKind.BooleanKeyword)
      return expected.kind === "bool";
    if (node.kind === ts.SyntaxKind.BigIntKeyword)
      return expected.kind === "i64";
    if (ts.isArrayTypeNode(node))
      return (
        expected.kind === "list" &&
        matchesType(node.elementType, expected.element, depth + 1)
      );
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      if (["Array", "ReadonlyArray"].includes(node.typeName.text))
        return (
          expected.kind === "list" &&
          node.typeArguments?.length === 1 &&
          matchesType(
            node.typeArguments[0] as ts.TypeNode,
            expected.element,
            depth + 1,
          )
        );
      const declared = typeDeclarations.get(node.typeName.text);
      if (!declared || node.typeArguments?.length) return false;
      if (ts.isInterfaceDeclaration(declared)) {
        if (declared.heritageClauses?.length) return false;
        return matchesType(
          ts.factory.createTypeLiteralNode(declared.members),
          expected,
          depth + 1,
        );
      }
      return matchesType(declared, expected, depth + 1);
    }
    if (ts.isTypeLiteralNode(node) && expected.kind === "record") {
      const fields = Object.keys(expected.fields),
        seen = new Set<string>();
      return (
        node.members.length === fields.length &&
        node.members.every((member) => {
          if (
            !ts.isPropertySignature(member) ||
            member.questionToken ||
            !member.type ||
            (!ts.isIdentifier(member.name) &&
              !ts.isStringLiteral(member.name)) ||
            seen.has(member.name.text)
          )
            return false;
          seen.add(member.name.text);
          const type = expected.fields[member.name.text];
          return !!type && matchesType(member.type, type, depth + 1);
        })
      );
    }
    return false;
  };
  const matchesLiteral = (
    node: ts.TypeNode,
    value: unknown,
    depth = 0,
  ): boolean => {
    if (depth > 8) fail("async type expansion exceeds limit");
    if (
      ts.isParenthesizedTypeNode(node) ||
      (ts.isTypeOperatorNode(node) &&
        node.operator === ts.SyntaxKind.ReadonlyKeyword &&
        ts.isArrayTypeNode(node.type))
    )
      return matchesLiteral(node.type, value, depth + 1);
    if (node.kind === ts.SyntaxKind.NumberKeyword)
      return typeof value === "number" && Number.isFinite(value);
    if (node.kind === ts.SyntaxKind.StringKeyword)
      return typeof value === "string";
    if (node.kind === ts.SyntaxKind.BooleanKeyword)
      return typeof value === "boolean";
    if (ts.isArrayTypeNode(node))
      return (
        Array.isArray(value) &&
        value.every((item) => matchesLiteral(node.elementType, item, depth + 1))
      );
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      if (["Array", "ReadonlyArray"].includes(node.typeName.text))
        return (
          node.typeArguments?.length === 1 &&
          Array.isArray(value) &&
          value.every((item) =>
            matchesLiteral(
              node.typeArguments?.[0] as ts.TypeNode,
              item,
              depth + 1,
            ),
          )
        );
      const declared = typeDeclarations.get(node.typeName.text);
      if (!declared || node.typeArguments?.length) return false;
      if (ts.isInterfaceDeclaration(declared)) {
        if (declared.heritageClauses?.length) return false;
        return matchesLiteral(
          ts.factory.createTypeLiteralNode(declared.members),
          value,
          depth + 1,
        );
      }
      return matchesLiteral(declared, value, depth + 1);
    }
    if (
      ts.isTypeLiteralNode(node) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const fields = value as Record<string, unknown>,
        seen = new Set<string>();
      return (
        node.members.length === Object.keys(fields).length &&
        node.members.every((member) => {
          if (
            !ts.isPropertySignature(member) ||
            member.questionToken ||
            !member.type ||
            (!ts.isIdentifier(member.name) &&
              !ts.isStringLiteral(member.name)) ||
            seen.has(member.name.text) ||
            !Object.hasOwn(fields, member.name.text)
          )
            return false;
          seen.add(member.name.text);
          return matchesLiteral(
            member.type,
            fields[member.name.text],
            depth + 1,
          );
        })
      );
    }
    return false;
  };
  const awaitCall = (node: ts.Expression, annotation?: ts.TypeNode): void => {
    if (!ts.isAwaitExpression(node) || !ts.isCallExpression(node.expression))
      fail("async statements must await registered invoke calls");
    const call = node.expression;
    if (
      !ts.isIdentifier(call.expression) ||
      call.expression.text !== "invoke" ||
      call.questionDotToken ||
      call.arguments.length !== 3 ||
      (call.typeArguments && call.typeArguments.length !== 1)
    )
      fail("invoke requires operation id, version, and a static request");
    const id = literal(call.arguments[0] as ts.Expression),
      version = literal(call.arguments[1] as ts.Expression),
      requestExpression = call.arguments[2] as ts.Expression,
      constant = ts.isIdentifier(requestExpression)
        ? constants.get(requestExpression.text)
        : undefined,
      request = constant ? constant.value : literal(requestExpression),
      operation = operations.find(
        (item) => item.id === id && item.version === version,
      );
    if (typeof id !== "string" || typeof version !== "number" || !operation)
      fail("invoke must reference a declared operation and version");
    const responseType = parseEffectValueType(operation.responseType);
    if (
      constant &&
      !matchesType(constant.type, parseEffectValueType(operation.requestType))
    )
      fail(
        "request constant annotation does not match the registered operation",
      );
    if (
      (annotation && !matchesType(annotation, responseType)) ||
      (call.typeArguments?.[0] &&
        !matchesType(call.typeArguments[0], responseType))
    )
      fail("await response annotation does not match the registered operation");
    nodes.push({ kind: "await", operation: id, version, request });
    finalType = responseType;
    finalBinding = undefined;
  };
  for (const statement of entry.body.statements) {
    if (returned) fail("unreachable async statement after return");
    if (ts.isExpressionStatement(statement)) awaitCall(statement.expression);
    else if (ts.isVariableStatement(statement)) {
      const declaration = statement.declarationList.declarations[0];
      if (
        !(statement.declarationList.flags & ts.NodeFlags.Const) ||
        statement.declarationList.declarations.length !== 1 ||
        !declaration ||
        !ts.isIdentifier(declaration.name) ||
        !declaration.type ||
        !declaration.initializer ||
        names.has(declaration.name.text)
      )
        fail("async locals require unique typed const bindings");
      names.add(declaration.name.text);
      if (ts.isAwaitExpression(declaration.initializer)) {
        awaitCall(declaration.initializer, declaration.type);
        finalBinding = declaration.name.text;
      } else {
        if (nodes.length)
          fail("static request constants must precede the first await");
        const value = literal(declaration.initializer);
        if (!matchesLiteral(declaration.type, value))
          fail("static constant literal does not match its annotation");
        constants.set(declaration.name.text, {
          value,
          type: declaration.type,
        });
      }
    } else if (ts.isReturnStatement(statement) && statement.expression) {
      if (ts.isAwaitExpression(statement.expression))
        awaitCall(statement.expression);
      else if (
        !ts.isIdentifier(statement.expression) ||
        statement.expression.text !== finalBinding
      )
        fail("async return must be the final awaited response");
      returned = true;
    } else
      fail(
        "async source supports sequential awaits and a final return; branches and loops are unsupported",
      );
  }
  const returnType = entry.type;
  if (
    !returned ||
    !finalType ||
    !ts.isTypeReferenceNode(returnType) ||
    !ts.isIdentifier(returnType.typeName) ||
    returnType.typeName.text !== "Promise" ||
    returnType.typeArguments?.length !== 1 ||
    !matchesType(returnType.typeArguments[0] as ts.TypeNode, finalType)
  )
    fail("async entry must return Promise<T> matching the final response");
  return {
    entry: entry.name.text,
    definition: {
      ...metadata,
      nodes,
      resultType: effectValueTypeJson(finalType),
    },
  };
}
