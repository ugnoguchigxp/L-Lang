import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { decodeUtf8, parseLlangJsonc } from "./llang-jsonc";
import { digest } from "./wasm-contract";
import {
  MODULE_LIMITS,
  ModuleError,
  type ModuleImport,
} from "./llang-module-ir";
import {
  checkCollectionProgram,
  type CheckedCollectionProgram,
  type CollectionBody,
  type CollectionExpression,
  type CollectionFunctionSource,
  type CollectionIntrinsic,
  type CollectionModuleSnapshot,
  type CollectionModuleSource,
  type CollectionStatement,
  type CollectionTypeDeclaration,
  type CollectionTypeUse,
} from "./llang-module-collection-ir";

const EXTENSIONS = [".llang.jsonc", ".ts"] as const;
const object = (v: unknown, label: string): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new ModuleError("LLC001", `${label} must be an object`);
  return v as Record<string, unknown>;
};
const exact = (v: unknown, keys: string[], label: string) => {
  const x = object(v, label),
    unknown = Object.keys(x).find((k) => !keys.includes(k));
  if (unknown)
    throw new ModuleError("LLC001", `unknown ${label} key ${unknown}`);
  return x;
};
const array = (v: unknown, label: string): unknown[] => {
  if (!Array.isArray(v))
    throw new ModuleError("LLC001", `${label} must be an array`);
  return v;
};
const string = (v: unknown, label: string): string => {
  if (typeof v !== "string")
    throw new ModuleError("LLC001", `${label} must be a string`);
  return v;
};

function typeUse(raw: unknown): CollectionTypeUse {
  if (raw === "boolean" || raw === "i32" || raw === "string") return raw;
  const x = object(raw, "type use"),
    keys = Object.keys(x);
  if (keys.length === 1 && keys[0] === "list") return { list: typeUse(x.list) };
  if (
    keys.every((k) => ["ref", "arguments"].includes(k)) &&
    typeof x.ref === "string"
  )
    return {
      ref: x.ref,
      ...(x.arguments === undefined
        ? {}
        : { arguments: array(x.arguments, "type arguments").map(typeUse) }),
    };
  if (keys.length === 1 && x.function) {
    const f = exact(x.function, ["parameters", "returns"], "function type");
    return {
      function: {
        parameters: array(f.parameters, "function parameters").map(typeUse),
        returns: typeUse(f.returns),
      },
    };
  }
  throw new ModuleError("LLC001", "invalid type use");
}
const typedFields = (raw: unknown) =>
  array(raw, "fields").map((v) => {
    const x = exact(v, ["name", "type"], "field");
    return { name: string(x.name, "field name"), type: typeUse(x.type) };
  });
function expression(raw: unknown): CollectionExpression {
  const kind = string(object(raw, "expression").kind, "expression kind"),
    x = object(raw, kind);
  if (kind === "literal") {
    exact(raw, ["kind", "type", "value"], kind);
    if (x.type !== "boolean" && x.type !== "i32" && x.type !== "string")
      throw new ModuleError("LLC001", "invalid literal type");
    return { kind, type: x.type, value: x.value as boolean | number | string };
  }
  if (kind === "param" || kind === "local") {
    exact(raw, ["kind", "name"], kind);
    return { kind, name: string(x.name, "binding") };
  }
  if (kind === "list") {
    exact(raw, ["kind", "elementType", "elements"], kind);
    return {
      kind,
      elementType: typeUse(x.elementType),
      elements: array(x.elements, "elements").map(expression),
    };
  }
  if (kind === "field") {
    exact(raw, ["kind", "base", "name"], kind);
    return { kind, base: expression(x.base), name: string(x.name, "field") };
  }
  if (kind === "unary") {
    exact(raw, ["kind", "op", "operand"], kind);
    if (x.op !== "not" && x.op !== "minus")
      throw new ModuleError("LLC001", "invalid unary operator");
    return { kind, op: x.op, operand: expression(x.operand) };
  }
  if (kind === "binary") {
    exact(raw, ["kind", "op", "left", "right"], kind);
    return {
      kind,
      op: string(x.op, "operator"),
      left: expression(x.left),
      right: expression(x.right),
    };
  }
  if (kind === "call") {
    exact(raw, ["kind", "callee", "typeArguments", "arguments"], kind);
    return {
      kind,
      callee: string(x.callee, "callee"),
      typeArguments: array(x.typeArguments, "type arguments").map(typeUse),
      arguments: array(x.arguments, "arguments").map(expression),
    };
  }
  if (kind === "invoke") {
    exact(raw, ["kind", "callee", "arguments"], kind);
    return {
      kind,
      callee: expression(x.callee),
      arguments: array(x.arguments, "arguments").map(expression),
    };
  }
  if (kind === "intrinsic") {
    exact(raw, ["kind", "name", "typeArguments", "arguments"], kind);
    const intrinsic = string(x.name, "intrinsic") as CollectionIntrinsic;
    if (
      ![
        "concat",
        "scalarLength",
        "length",
        "at",
        "set",
        "append",
        "map",
        "filter",
        "fold",
        "stableSort",
      ].includes(intrinsic)
    )
      throw new ModuleError("LLC001", "invalid intrinsic");
    return {
      kind,
      name: intrinsic,
      typeArguments: array(x.typeArguments, "type arguments").map(typeUse),
      arguments: array(x.arguments, "arguments").map(expression),
    };
  }
  if (kind === "lambda") {
    exact(raw, ["kind", "parameters", "returns", "body"], kind);
    return {
      kind,
      parameters: parameters(x.parameters),
      returns: typeUse(x.returns),
      body: body(x.body),
    };
  }
  if (kind === "record" || kind === "variant") {
    exact(
      raw,
      kind === "record"
        ? ["kind", "type", "typeArguments", "fields"]
        : ["kind", "type", "typeArguments", "tag", "fields"],
      kind,
    );
    const fields = array(x.fields, "fields").map((v) => {
      const f = exact(v, ["name", "value"], "constructor field");
      return { name: string(f.name, "field"), value: expression(f.value) };
    });
    return kind === "record"
      ? {
          kind,
          type: string(x.type, "type"),
          typeArguments: array(x.typeArguments, "type arguments").map(typeUse),
          fields,
        }
      : {
          kind,
          type: string(x.type, "type"),
          typeArguments: array(x.typeArguments, "type arguments").map(typeUse),
          tag: string(x.tag, "tag"),
          fields,
        };
  }
  if (kind === "if") {
    exact(raw, ["kind", "condition", "then", "else"], kind);
    return {
      kind,
      condition: expression(x.condition),
      whenTrue: expression(x.then),
      whenFalse: expression(x.else),
    };
  }
  throw new ModuleError("LLC001", `unknown expression kind ${kind}`);
}
const parameters = (raw: unknown) =>
  array(raw, "parameters").map((v) => {
    const x = exact(v, ["name", "type"], "parameter");
    return { name: string(x.name, "parameter name"), type: typeUse(x.type) };
  });
function statement(raw: unknown): CollectionStatement {
  const kind = string(object(raw, "statement").kind, "statement kind"),
    x = object(raw, kind);
  if (kind === "const" || kind === "let") {
    exact(raw, ["kind", "name", "type", "value"], kind);
    return {
      kind,
      name: string(x.name, "binding"),
      type: typeUse(x.type),
      value: expression(x.value),
    };
  }
  if (kind === "assign") {
    exact(raw, ["kind", "name", "value"], kind);
    return {
      kind,
      name: string(x.name, "binding"),
      value: expression(x.value),
    };
  }
  if (kind === "while") {
    exact(raw, ["kind", "condition", "body"], kind);
    return {
      kind,
      condition: expression(x.condition),
      body: array(x.body, "body").map(statement),
    };
  }
  if (kind === "forEach") {
    exact(raw, ["kind", "name", "type", "value", "body"], kind);
    return {
      kind,
      name: string(x.name, "binding"),
      type: typeUse(x.type),
      value: expression(x.value),
      body: array(x.body, "body").map(statement),
    };
  }
  if (kind === "if") {
    exact(raw, ["kind", "condition", "then", "else"], kind);
    return {
      kind,
      condition: expression(x.condition),
      whenTrue: array(x.then, "then").map(statement),
      whenFalse: array(x.else, "else").map(statement),
    };
  }
  if (kind === "match") {
    exact(raw, ["kind", "value", "cases"], kind);
    return {
      kind,
      value: expression(x.value),
      cases: array(x.cases, "cases").map((rawCase) => {
        const item = exact(rawCase, ["tag", "body"], "match case");
        return {
          tag: string(item.tag, "match tag"),
          body: array(item.body, "match body").map(statement),
        };
      }),
    };
  }
  if (kind === "break" || kind === "continue") {
    exact(raw, ["kind"], kind);
    return { kind };
  }
  if (kind === "return") {
    exact(raw, ["kind", "value"], kind);
    return { kind, value: expression(x.value) };
  }
  throw new ModuleError("LLC001", `unknown statement kind ${kind}`);
}
function body(raw: unknown): CollectionBody {
  const x = exact(raw, ["statements", "result"], "body");
  return {
    statements: array(x.statements, "statements").map(statement),
    ...(x.result === undefined ? {} : { result: expression(x.result) }),
  };
}
export function parseCollectionModuleJsonc(
  text: string,
  file = "<module>",
): CollectionModuleSource {
  const parsed = parseLlangJsonc(text, file);
  if (!parsed.document || !parsed.report.ok)
    throw new ModuleError(
      "LLC001",
      parsed.report.diagnostics[0]?.message ?? "invalid JSONC",
      file,
    );
  const root = exact(
    parsed.document.value,
    [
      "language",
      "version",
      "kind",
      "profile",
      "description",
      "imports",
      "types",
      "functions",
    ],
    "module",
  );
  if (
    root.language !== "l-lang" ||
    root.version !== 4 ||
    root.kind !== "module" ||
    root.profile !== "module-collection-v1"
  )
    throw new ModuleError(
      "LLC001",
      "invalid module-collection-v1 header",
      file,
    );
  const imports: ModuleImport[] = array(root.imports, "imports").map((v) => {
    const x = exact(v, ["from", "bindings"], "import");
    return {
      from: string(x.from, "import path"),
      bindings: array(x.bindings, "bindings").map((b) => {
        const y = exact(b, ["kind", "name", "as"], "binding");
        if (y.kind !== "type" && y.kind !== "function")
          throw new ModuleError("LLC001", "invalid import kind");
        return {
          kind: y.kind,
          name: string(y.name, "import name"),
          as: string(y.as, "import alias"),
        };
      }),
    };
  });
  const types: CollectionTypeDeclaration[] = array(root.types, "types").map(
    (v) => {
      const x = object(v, "type"),
        kind = string(x.kind, "type kind"),
        common = {
          name: string(x.name, "type name"),
          export: Boolean(x.export),
          typeParameters: array(x.typeParameters, "type parameters").map((p) =>
            string(p, "type parameter"),
          ),
        };
      if (kind === "record") {
        exact(
          v,
          ["name", "export", "kind", "typeParameters", "fields"],
          "record",
        );
        return { ...common, kind, fields: typedFields(x.fields) };
      }
      if (kind === "union") {
        exact(
          v,
          ["name", "export", "kind", "typeParameters", "variants"],
          "union",
        );
        return {
          ...common,
          kind,
          variants: array(x.variants, "variants").map((p) => {
            const y = exact(p, ["tag", "fields"], "variant");
            return { tag: string(y.tag, "tag"), fields: typedFields(y.fields) };
          }),
        };
      }
      throw new ModuleError("LLC001", "invalid type kind");
    },
  );
  const functions: CollectionFunctionSource[] = array(
    root.functions,
    "functions",
  ).map((v) => {
    const x = exact(
      v,
      ["name", "export", "typeParameters", "parameters", "returns", "body"],
      "function",
    );
    return {
      name: string(x.name, "function name"),
      export: Boolean(x.export),
      typeParameters: array(x.typeParameters, "type parameters").map((p) =>
        string(p, "type parameter"),
      ),
      parameters: parameters(x.parameters),
      returns: typeUse(x.returns),
      body: body(x.body),
    };
  });
  return {
    language: "l-lang",
    version: 4,
    kind: "module",
    profile: "module-collection-v1",
    ...(typeof root.description === "string"
      ? { description: root.description }
      : {}),
    imports,
    types,
    functions,
  };
}

function tsType(
  node: ts.TypeNode | undefined,
  file: string,
): CollectionTypeUse {
  if (!node)
    throw new ModuleError("LLC008", "type annotation is required", file);
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return "boolean";
  if (node.kind === ts.SyntaxKind.NumberKeyword) return "i32";
  if (node.kind === ts.SyntaxKind.StringKeyword) return "string";
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const args = node.typeArguments?.map((x) => tsType(x, file)) ?? [];
    if (node.typeName.text === "List") {
      if (args.length !== 1)
        throw new ModuleError("LLC008", "List needs one argument", file);
      const element = args[0];
      if (!element)
        throw new ModuleError("LLC008", "List needs one argument", file);
      return { list: element };
    }
    return {
      ref: node.typeName.text,
      ...(args.length ? { arguments: args } : {}),
    };
  }
  if (ts.isFunctionTypeNode(node))
    return {
      function: {
        parameters: node.parameters.map((p) => tsType(p.type, file)),
        returns: tsType(node.type, file),
      },
    };
  throw new ModuleError("LLC008", `unsupported type ${node.getText()}`, file);
}
const exported = (
  node: ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> },
) =>
  Boolean(node.modifiers?.some((x) => x.kind === ts.SyntaxKind.ExportKeyword));
function typeName(
  use: CollectionTypeUse,
): { name: string; arguments: CollectionTypeUse[] } | undefined {
  return typeof use === "object" && "ref" in use
    ? { name: use.ref, arguments: use.arguments ?? [] }
    : undefined;
}
function tsExpression(
  node: ts.Expression,
  file: string,
  expected?: CollectionTypeUse,
): CollectionExpression {
  if (ts.isParenthesizedExpression(node))
    return tsExpression(node.expression, file, expected);
  if (ts.isAsExpression(node))
    return tsExpression(node.expression, file, tsType(node.type, file));
  if (
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword
  )
    return {
      kind: "literal",
      type: "boolean",
      value: node.kind === ts.SyntaxKind.TrueKeyword,
    };
  if (ts.isNumericLiteral(node))
    return { kind: "literal", type: "i32", value: Number(node.text) };
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  )
    return { kind: "literal", type: "i32", value: -Number(node.operand.text) };
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return { kind: "literal", type: "string", value: node.text };
  if (ts.isIdentifier(node)) return { kind: "local", name: node.text };
  if (ts.isArrayLiteralExpression(node)) {
    if (!expected || typeof expected === "string" || !("list" in expected))
      throw new ModuleError(
        "LLC008",
        "List literal requires contextual List type",
        file,
      );
    return {
      kind: "list",
      elementType: expected.list,
      elements: node.elements.map((x) => {
        if (!ts.isExpression(x) || ts.isSpreadElement(x))
          throw new ModuleError("LLC008", "spread is unsupported", file);
        return tsExpression(x, file, expected.list);
      }),
    };
  }
  if (ts.isPropertyAccessExpression(node))
    return {
      kind: "field",
      base: tsExpression(node.expression, file),
      name: node.name.text,
    };
  if (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.ExclamationToken ||
      node.operator === ts.SyntaxKind.MinusToken)
  )
    return {
      kind: "unary",
      op: node.operator === ts.SyntaxKind.ExclamationToken ? "not" : "minus",
      operand: tsExpression(node.operand, file),
    };
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.getText();
    if (
      ![
        "+",
        "-",
        "*",
        "/",
        "%",
        "<",
        "<=",
        ">",
        ">=",
        "===",
        "!==",
        "&&",
        "||",
      ].includes(op)
    )
      throw new ModuleError("LLC008", `unsupported operator ${op}`, file);
    return {
      kind: "binary",
      op,
      left: tsExpression(node.left, file),
      right: tsExpression(node.right, file),
    };
  }
  if (ts.isConditionalExpression(node))
    return {
      kind: "if",
      condition: tsExpression(node.condition, file),
      whenTrue: tsExpression(node.whenTrue, file, expected),
      whenFalse: tsExpression(node.whenFalse, file, expected),
    };
  if (ts.isArrowFunction(node)) {
    const returns = tsType(node.type, file),
      ps = node.parameters.map((p) => {
        if (!ts.isIdentifier(p.name) || !p.type)
          throw new ModuleError(
            "LLC008",
            "lambda parameters require types",
            file,
          );
        return { name: p.name.text, type: tsType(p.type, file) };
      });
    return {
      kind: "lambda",
      parameters: ps,
      returns,
      body: ts.isBlock(node.body)
        ? tsBody(node.body, file, returns)
        : { statements: [], result: tsExpression(node.body, file, returns) },
    };
  }
  if (ts.isCallExpression(node)) {
    const args = node.arguments.map((x) => tsExpression(x, file)),
      typeArguments = node.typeArguments?.map((x) => tsType(x, file)) ?? [];
    if (ts.isIdentifier(node.expression)) {
      const n = node.expression.text,
        intrinsics = [
          "concat",
          "scalarLength",
          "length",
          "at",
          "set",
          "append",
          "map",
          "filter",
          "fold",
          "stableSort",
        ];
      return intrinsics.includes(n)
        ? {
            kind: "intrinsic",
            name: n as CollectionIntrinsic,
            typeArguments,
            arguments: args,
          }
        : { kind: "call", callee: n, typeArguments, arguments: args };
    }
    return {
      kind: "invoke",
      callee: tsExpression(node.expression, file),
      arguments: args,
    };
  }
  if (ts.isObjectLiteralExpression(node)) {
    const named = expected && typeName(expected);
    if (!named)
      throw new ModuleError(
        "LLC008",
        "object literal requires named type assertion",
        file,
      );
    const fields: { name: string; value: CollectionExpression }[] = [];
    let tag: string | undefined;
    for (const p of node.properties) {
      if (
        !ts.isPropertyAssignment(p) ||
        (!ts.isIdentifier(p.name) && !ts.isStringLiteral(p.name))
      )
        throw new ModuleError("LLC008", "invalid object field", file);
      if (p.name.text === "tag" && ts.isStringLiteral(p.initializer))
        tag = p.initializer.text;
      else
        fields.push({
          name: p.name.text,
          value: tsExpression(p.initializer, file),
        });
    }
    return tag
      ? {
          kind: "variant",
          type: named.name,
          typeArguments: named.arguments,
          tag,
          fields,
        }
      : {
          kind: "record",
          type: named.name,
          typeArguments: named.arguments,
          fields,
        };
  }
  throw new ModuleError(
    "LLC008",
    `unsupported expression ${node.getText()}`,
    file,
  );
}
function tsStatement(
  node: ts.Statement,
  file: string,
  returns: CollectionTypeUse,
): CollectionStatement | CollectionStatement[] {
  if (ts.isVariableStatement(node)) {
    if (node.declarationList.declarations.length !== 1)
      throw new ModuleError("LLC008", "one declaration per statement", file);
    const d = node.declarationList.declarations[0];
    if (!d) throw new ModuleError("LLC008", "declaration is required", file);
    if (!ts.isIdentifier(d.name) || !d.type || !d.initializer)
      throw new ModuleError(
        "LLC008",
        "binding requires name, type and initializer",
        file,
      );
    const kind =
      (node.declarationList.flags & ts.NodeFlags.Let) !== 0
        ? "let"
        : (node.declarationList.flags & ts.NodeFlags.Const) !== 0
          ? "const"
          : undefined;
    if (!kind) throw new ModuleError("LLC008", "var is unsupported", file);
    const type = tsType(d.type, file);
    return {
      kind,
      name: d.name.text,
      type,
      value: tsExpression(d.initializer, file, type),
    };
  }
  if (
    ts.isExpressionStatement(node) &&
    ts.isBinaryExpression(node.expression) &&
    node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(node.expression.left)
  )
    return {
      kind: "assign",
      name: node.expression.left.text,
      value: tsExpression(node.expression.right, file),
    };
  if (ts.isReturnStatement(node) && node.expression)
    return {
      kind: "return",
      value: tsExpression(node.expression, file, returns),
    };
  if (ts.isBreakStatement(node) && !node.label) return { kind: "break" };
  if (ts.isContinueStatement(node) && !node.label) return { kind: "continue" };
  if (ts.isWhileStatement(node))
    return {
      kind: "while",
      condition: tsExpression(node.expression, file),
      body: tsStatements(node.statement, file, returns),
    };
  if (
    ts.isForOfStatement(node) &&
    ts.isVariableDeclarationList(node.initializer) &&
    node.initializer.declarations.length === 1
  ) {
    const d = node.initializer.declarations[0];
    if (!d) throw new ModuleError("LLC008", "for-of binding is required", file);
    if (
      !ts.isIdentifier(d.name) ||
      !d.type ||
      !(node.initializer.flags & ts.NodeFlags.Const)
    )
      throw new ModuleError(
        "LLC008",
        "for-of binding must be typed const",
        file,
      );
    return {
      kind: "forEach",
      name: d.name.text,
      type: tsType(d.type, file),
      value: tsExpression(node.expression, file),
      body: tsStatements(node.statement, file, returns),
    };
  }
  if (ts.isIfStatement(node))
    return {
      kind: "if",
      condition: tsExpression(node.expression, file),
      whenTrue: tsStatements(node.thenStatement, file, returns),
      whenFalse: node.elseStatement
        ? tsStatements(node.elseStatement, file, returns)
        : [],
    };
  if (ts.isSwitchStatement(node)) {
    const value =
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "tag"
        ? node.expression.expression
        : node.expression;
    return {
      kind: "match",
      value: tsExpression(value, file),
      cases: node.caseBlock.clauses.map((clause) => {
        if (!ts.isCaseClause(clause) || !ts.isStringLiteral(clause.expression))
          throw new ModuleError(
            "LLC008",
            "switch requires explicit string cases",
            file,
          );
        return {
          tag: clause.expression.text,
          body: clause.statements.flatMap((item) =>
            tsStatement(item, file, returns),
          ),
        };
      }),
    };
  }
  if (ts.isBlock(node)) return tsStatements(node, file, returns);
  throw new ModuleError(
    "LLC008",
    `unsupported statement ${node.getText()}`,
    file,
  );
}
function tsStatements(
  node: ts.Statement,
  file: string,
  returns: CollectionTypeUse,
): CollectionStatement[] {
  const nodes = ts.isBlock(node) ? [...node.statements] : [node];
  return nodes.flatMap((x) => tsStatement(x, file, returns));
}
function tsBody(
  block: ts.Block,
  file: string,
  returns: CollectionTypeUse,
): CollectionBody {
  return {
    statements: block.statements.flatMap((x) => tsStatement(x, file, returns)),
  };
}
export function parseCollectionModuleTypeScript(
  text: string,
  file = "<module.ts>",
): CollectionModuleSource {
  const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    ),
    diagnostics = (
      source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }
    ).parseDiagnostics;
  const diagnostic = diagnostics[0];
  if (diagnostic)
    throw new ModuleError(
      "LLC008",
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      file,
    );
  const imports: ModuleImport[] = [],
    types: CollectionTypeDeclaration[] = [],
    functions: CollectionFunctionSource[] = [],
    coreImports = new Set<string>(),
    allowedCoreImports = new Set([
      "List",
      "concat",
      "scalarLength",
      "length",
      "at",
      "set",
      "append",
      "map",
      "filter",
      "fold",
      "stableSort",
    ]);
  for (const s of source.statements) {
    if (ts.isImportDeclaration(s)) {
      if (
        !ts.isStringLiteral(s.moduleSpecifier) ||
        !s.importClause?.namedBindings ||
        !ts.isNamedImports(s.importClause.namedBindings)
      )
        throw new ModuleError(
          "LLC008",
          "only named imports are supported",
          file,
        );
      if (s.moduleSpecifier.text === "llang:core") {
        for (const element of s.importClause.namedBindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (
            element.propertyName ||
            !allowedCoreImports.has(imported) ||
            coreImports.has(imported)
          )
            throw new ModuleError(
              "LLC008",
              `invalid llang:core import ${element.getText()}`,
              file,
            );
          coreImports.add(imported);
        }
        continue;
      }
      imports.push({
        from: s.moduleSpecifier.text,
        bindings: s.importClause.namedBindings.elements.map((x) => ({
          kind:
            s.importClause?.isTypeOnly || x.isTypeOnly ? "type" : "function",
          name: x.propertyName?.text ?? x.name.text,
          as: x.name.text,
        })),
      });
      continue;
    }
    if (ts.isTypeAliasDeclaration(s)) {
      const common = {
        name: s.name.text,
        export: exported(s),
        typeParameters: s.typeParameters?.map((x) => x.name.text) ?? [],
      };
      if (ts.isTypeLiteralNode(s.type)) {
        types.push({
          ...common,
          kind: "record",
          fields: s.type.members.map((m) => {
            if (
              !ts.isPropertySignature(m) ||
              !m.type ||
              !m.name ||
              (!ts.isIdentifier(m.name) && !ts.isStringLiteral(m.name))
            )
              throw new ModuleError("LLC008", "invalid record", file);
            return { name: m.name.text, type: tsType(m.type, file) };
          }),
        });
        continue;
      }
      if (ts.isUnionTypeNode(s.type)) {
        types.push({
          ...common,
          kind: "union",
          variants: s.type.types.map((p) => {
            if (!ts.isTypeLiteralNode(p))
              throw new ModuleError("LLC008", "invalid union", file);
            let tag = "";
            const fields: { name: string; type: CollectionTypeUse }[] = [];
            for (const m of p.members) {
              if (
                !ts.isPropertySignature(m) ||
                !m.type ||
                !m.name ||
                (!ts.isIdentifier(m.name) && !ts.isStringLiteral(m.name))
              )
                throw new ModuleError("LLC008", "invalid union field", file);
              if (
                m.name.text === "tag" &&
                ts.isLiteralTypeNode(m.type) &&
                ts.isStringLiteral(m.type.literal)
              )
                tag = m.type.literal.text;
              else
                fields.push({ name: m.name.text, type: tsType(m.type, file) });
            }
            if (!tag)
              throw new ModuleError("LLC008", "union tag is required", file);
            return { tag, fields };
          }),
        });
        continue;
      }
      throw new ModuleError(
        "LLC008",
        "type alias must be record or tagged union",
        file,
      );
    }
    if (ts.isFunctionDeclaration(s)) {
      if (!s.name || !s.body || !s.type)
        throw new ModuleError("LLC008", "invalid function", file);
      const returns = tsType(s.type, file);
      functions.push({
        name: s.name.text,
        export: exported(s),
        typeParameters: s.typeParameters?.map((x) => x.name.text) ?? [],
        parameters: s.parameters.map((p) => {
          if (
            !ts.isIdentifier(p.name) ||
            !p.type ||
            p.questionToken ||
            p.dotDotDotToken ||
            p.initializer
          )
            throw new ModuleError("LLC008", "invalid parameter", file);
          return { name: p.name.text, type: tsType(p.type, file) };
        }),
        returns,
        body: tsBody(s.body, file, returns),
      });
      continue;
    }
    if (!ts.isEmptyStatement(s))
      throw new ModuleError(
        "LLC008",
        `unsupported top-level syntax ${s.getText()}`,
        file,
      );
  }
  const requiredCoreImports = new Set<string>();
  const inspect = (node: ts.Node): void => {
    if (
      ts.isTypeReferenceNode(node) &&
      ts.isIdentifier(node.typeName) &&
      node.typeName.text === "List"
    )
      requiredCoreImports.add("List");
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      allowedCoreImports.has(node.expression.text) &&
      node.expression.text !== "List"
    )
      requiredCoreImports.add(node.expression.text);
    ts.forEachChild(node, inspect);
  };
  inspect(source);
  for (const required of requiredCoreImports)
    if (!coreImports.has(required))
      throw new ModuleError(
        "LLC008",
        `${required} must be imported from llang:core`,
        file,
      );
  return {
    language: "l-lang",
    version: 4,
    kind: "module",
    profile: "module-collection-v1",
    imports,
    types,
    functions,
  };
}

const validateSpecifier = (v: string) => {
  if (
    !(v.startsWith("./") || v.startsWith("../")) ||
    v.includes("\\") ||
    v.includes("\0") ||
    /[?#]/.test(v) ||
    !EXTENSIONS.some((x) => v.endsWith(x))
  )
    throw new ModuleError("LLC002", `invalid import path ${v}`);
};
const moduleId = (root: string, path: string) =>
  relative(root, path)
    .split(sep)
    .join("/")
    .replace(/\.llang\.jsonc$|\.ts$/, "");
async function contained(
  root: string,
  rootReal: string,
  path: string,
): Promise<string> {
  const actual = await realpath(path).catch(() => ""),
    rel = relative(rootReal, actual);
  if (!actual || rel === ".." || rel.startsWith(`..${sep}`))
    throw new ModuleError("LLC002", "source escapes root", path);
  if (
    relative(root, path).split(sep).join("/") !==
    relative(rootReal, actual).split(sep).join("/")
  )
    throw new ModuleError(
      "LLC002",
      "source path identity does not match",
      path,
    );
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new ModuleError(
      "LLC002",
      "source must be regular non-symlink file",
      path,
    );
  return actual;
}
export async function loadCollectionModuleProgram(
  entryPath: string,
  rootPath: string,
  entryName: string,
): Promise<CheckedCollectionProgram> {
  const root = resolve(rootPath),
    rootInfo = await lstat(root),
    rootReal = await realpath(root),
    initial = resolve(root, entryPath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new ModuleError("LLC002", "root must be regular directory", root);
  const pending = [initial],
    snapshots = new Map<string, CollectionModuleSnapshot>();
  let total = 0;
  while (pending.length) {
    const absolute = pending.pop();
    if (!absolute) break;
    const actual = await contained(root, rootReal, absolute);
    if (!EXTENSIONS.some((x) => absolute.endsWith(x)))
      throw new ModuleError("LLC002", "unsupported source extension", absolute);
    const id = moduleId(root, absolute);
    if (snapshots.has(id)) continue;
    const bytes = await readFile(absolute);
    total += bytes.length;
    if (
      bytes.length > MODULE_LIMITS.sourceBytes ||
      total > MODULE_LIMITS.totalBytes
    )
      throw new ModuleError("LLC007", "source size exceeds limit");
    const text = decodeUtf8(bytes, absolute),
      source = absolute.endsWith(".ts")
        ? parseCollectionModuleTypeScript(text, absolute)
        : parseCollectionModuleJsonc(text, absolute);
    const snapshot: CollectionModuleSnapshot = {
      id,
      absolutePath: absolute,
      realPath: actual,
      rootPath: root,
      rootRealPath: rootReal,
      relativePath: relative(root, absolute).split(sep).join("/"),
      sourceHash: digest(bytes),
      bytes,
      text,
      source,
    };
    snapshots.set(id, snapshot);
    if (snapshots.size > MODULE_LIMITS.modules)
      throw new ModuleError("LLC007", "module count exceeds limit");
    for (const item of source.imports) {
      validateSpecifier(item.from);
      pending.push(resolve(dirname(absolute), item.from));
    }
  }
  const modules = [...snapshots.values()],
    graph = new Map(
      modules.map((m) => [
        m.id,
        m.source.imports.map((x) =>
          moduleId(root, resolve(dirname(m.absolutePath), x.from)),
        ),
      ]),
    ),
    active = new Set<string>(),
    done = new Set<string>();
  const visit = (id: string) => {
    if (active.has(id)) throw new ModuleError("LLC002", "module cycle");
    if (done.has(id)) return;
    active.add(id);
    for (const next of graph.get(id) ?? []) visit(next);
    active.delete(id);
    done.add(id);
  };
  const entryId = moduleId(root, initial);
  visit(entryId);
  if (done.size !== modules.length)
    throw new ModuleError("LLC002", "unreachable source in closure");
  return checkCollectionProgram(modules, entryId, entryName);
}
export async function revalidateCollectionModuleSnapshot(
  program: CheckedCollectionProgram,
): Promise<void> {
  for (const module of program.modules) {
    const actual = await contained(
        module.rootPath,
        module.rootRealPath,
        module.absolutePath,
      ).catch(() => null),
      bytes = actual
        ? await readFile(module.absolutePath).catch(() => null)
        : null;
    if (
      actual !== module.realPath ||
      !bytes ||
      digest(bytes) !== module.sourceHash
    )
      throw new ModuleError(
        "SOURCE_CONFLICT",
        `source changed: ${module.relativePath}`,
      );
  }
}
