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
  checkValueProgram,
  type CheckedValueProgram,
  type ValueExpression,
  type ValueFunctionSource,
  type ValueModuleSnapshot,
  type ValueModuleSource,
  type ValueTypeDeclaration,
  type ValueTypeUse,
} from "./llang-module-value-ir";

const SOURCE_EXTENSIONS = [".llang.jsonc", ".ts"] as const;
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ModuleError("LLV001", `${label} must be an object`);
  return value as Record<string, unknown>;
}
function exact(
  value: unknown,
  keys: string[],
  label: string,
): Record<string, unknown> {
  const result = record(value, label);
  const unknown = Object.keys(result).find((x) => !keys.includes(x));
  if (unknown)
    throw new ModuleError("LLV001", `unknown ${label} key ${unknown}`);
  return result;
}
function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value))
    throw new ModuleError("LLV001", `${label} must be an array`);
  return value;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string")
    throw new ModuleError("LLV001", `${label} must be a string`);
  return value;
}
function typeUse(value: unknown): ValueTypeUse {
  if (value === "boolean" || value === "i32" || value === "string")
    return value;
  const item = exact(value, ["ref"], "type use");
  return { ref: string(item.ref, "type ref") };
}
function fields(value: unknown): { name: string; type: ValueTypeUse }[] {
  return list(value, "fields").map((raw) => {
    const f = exact(raw, ["name", "type"], "field");
    return { name: string(f.name, "field name"), type: typeUse(f.type) };
  });
}
function expression(raw: unknown): ValueExpression {
  const kind = string(record(raw, "expression").kind, "expression kind");
  if (kind === "literal") {
    const v = exact(raw, ["kind", "type", "value"], kind),
      type = v.type;
    if (type !== "boolean" && type !== "i32" && type !== "string")
      throw new ModuleError("LLV001", "invalid literal type");
    return { kind, type, value: v.value as boolean | number | string };
  }
  if (kind === "param" || kind === "local") {
    const v = exact(raw, ["kind", "name"], kind);
    return { kind, name: string(v.name, "binding name") };
  }
  if (kind === "field") {
    const v = exact(raw, ["kind", "base", "name"], kind);
    return {
      kind,
      base: expression(v.base),
      name: string(v.name, "field name"),
    };
  }
  if (kind === "unary") {
    const v = exact(raw, ["kind", "op", "operand"], kind);
    if (v.op !== "not" && v.op !== "minus")
      throw new ModuleError("LLV001", "invalid unary operator");
    return { kind, op: v.op, operand: expression(v.operand) };
  }
  if (kind === "binary") {
    const v = exact(raw, ["kind", "op", "left", "right"], kind);
    return {
      kind,
      op: string(v.op, "operator"),
      left: expression(v.left),
      right: expression(v.right),
    };
  }
  if (kind === "call") {
    const v = exact(raw, ["kind", "callee", "arguments"], kind);
    return {
      kind,
      callee: string(v.callee, "callee"),
      arguments: list(v.arguments, "arguments").map(expression),
    };
  }
  if (kind === "intrinsic") {
    const v = exact(raw, ["kind", "name", "arguments"], kind);
    if (v.name !== "concat" && v.name !== "scalarLength")
      throw new ModuleError("LLV001", "invalid intrinsic");
    return {
      kind,
      name: v.name,
      arguments: list(v.arguments, "arguments").map(expression),
    };
  }
  if (kind === "record" || kind === "variant") {
    const keys =
        kind === "record"
          ? ["kind", "type", "fields"]
          : ["kind", "type", "tag", "fields"],
      v = exact(raw, keys, kind),
      fs = list(v.fields, "constructor fields").map((item) => {
        const f = exact(item, ["name", "value"], "constructor field");
        return {
          name: string(f.name, "field name"),
          value: expression(f.value),
        };
      });
    return kind === "record"
      ? { kind, type: string(v.type, "type"), fields: fs }
      : {
          kind,
          type: string(v.type, "type"),
          tag: string(v.tag, "tag"),
          fields: fs,
        };
  }
  if (kind === "block") {
    const v = exact(raw, ["kind", "bindings", "result"], kind);
    return {
      kind,
      bindings: list(v.bindings, "bindings").map((item) => {
        const b = exact(item, ["name", "type", "value"], "binding");
        return {
          name: string(b.name, "binding name"),
          type: typeUse(b.type),
          value: expression(b.value),
        };
      }),
      result: expression(v.result),
    };
  }
  if (kind === "if") {
    const v = exact(raw, ["kind", "condition", "then", "else"], kind);
    return {
      kind,
      condition: expression(v.condition),
      whenTrue: expression(v.then),
      whenFalse: expression(v.else),
    };
  }
  if (kind === "match") {
    const v = exact(raw, ["kind", "value", "cases"], kind);
    return {
      kind,
      value: expression(v.value),
      cases: list(v.cases, "cases").map((item) => {
        const c = exact(item, ["tag", "body"], "case");
        return { tag: string(c.tag, "tag"), body: expression(c.body) };
      }),
    };
  }
  throw new ModuleError("LLV001", `unknown expression kind ${kind}`);
}
export function parseValueModuleJsonc(
  text: string,
  file = "<module>",
): ValueModuleSource {
  const parsed = parseLlangJsonc(text, file);
  if (!parsed.document || !parsed.report.ok)
    throw new ModuleError(
      "LLV001",
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
    root.version !== 3 ||
    root.kind !== "module" ||
    root.profile !== "module-value-v1"
  )
    throw new ModuleError("LLV001", "invalid module-value-v1 header", file);
  const imports: ModuleImport[] = list(root.imports, "imports").map((raw) => {
    const item = exact(raw, ["from", "bindings"], "import");
    return {
      from: string(item.from, "import path"),
      bindings: list(item.bindings, "bindings").map((rawBinding) => {
        const b = exact(rawBinding, ["kind", "name", "as"], "binding");
        if (b.kind !== "type" && b.kind !== "function")
          throw new ModuleError("LLV001", "invalid import binding kind");
        return {
          kind: b.kind,
          name: string(b.name, "import name"),
          as: string(b.as, "import alias"),
        };
      }),
    };
  });
  const types: ValueTypeDeclaration[] = list(root.types, "types").map((raw) => {
    const base = record(raw, "type");
    if (base.kind === "record") {
      const item = exact(
        raw,
        ["name", "export", "kind", "fields"],
        "record type",
      );
      if (typeof item.export !== "boolean")
        throw new ModuleError("LLV001", "type export must be boolean");
      return {
        name: string(item.name, "type name"),
        export: item.export,
        kind: "record",
        fields: fields(item.fields),
      };
    }
    if (base.kind === "union") {
      const item = exact(
        raw,
        ["name", "export", "kind", "variants"],
        "union type",
      );
      if (typeof item.export !== "boolean")
        throw new ModuleError("LLV001", "type export must be boolean");
      return {
        name: string(item.name, "type name"),
        export: item.export,
        kind: "union",
        variants: list(item.variants, "variants").map((rawVariant) => {
          const v = exact(rawVariant, ["tag", "fields"], "variant");
          return { tag: string(v.tag, "tag"), fields: fields(v.fields) };
        }),
      };
    }
    throw new ModuleError("LLV001", "invalid type kind");
  });
  const functions: ValueFunctionSource[] = list(
    root.functions,
    "functions",
  ).map((raw) => {
    const item = exact(
      raw,
      ["name", "export", "parameters", "returns", "body"],
      "function",
    );
    if (typeof item.export !== "boolean")
      throw new ModuleError("LLV001", "function export must be boolean");
    return {
      name: string(item.name, "function name"),
      export: item.export,
      parameters: list(item.parameters, "parameters").map((rawParameter) => {
        const p = exact(rawParameter, ["name", "type"], "parameter");
        return {
          name: string(p.name, "parameter name"),
          type: typeUse(p.type),
        };
      }),
      returns: typeUse(item.returns),
      body: expression(item.body),
    };
  });
  return {
    language: "l-lang",
    version: 3,
    kind: "module",
    profile: "module-value-v1",
    ...(typeof root.description === "string"
      ? { description: root.description }
      : {}),
    imports,
    types,
    functions,
  };
}

function exported(node: ts.Node): boolean {
  return Boolean(
    ts
      .getModifiers(node as ts.HasModifiers)
      ?.some((x) => x.kind === ts.SyntaxKind.ExportKeyword),
  );
}
function tsType(node: ts.TypeNode | undefined, file: string): ValueTypeUse {
  if (!node)
    throw new ModuleError(
      "LLV008",
      "explicit type annotation is required",
      file,
    );
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return "boolean";
  if (node.kind === ts.SyntaxKind.NumberKeyword) return "i32";
  if (node.kind === ts.SyntaxKind.StringKeyword) return "string";
  if (
    ts.isTypeReferenceNode(node) &&
    ts.isIdentifier(node.typeName) &&
    !node.typeArguments
  )
    return { ref: node.typeName.text };
  throw new ModuleError("LLV008", `unsupported type ${node.getText()}`, file);
}
function expectedName(type: ValueTypeUse | undefined): string | undefined {
  return type && typeof type === "object" ? type.ref : undefined;
}
function tsExpr(
  node: ts.Expression,
  file: string,
  expected?: ValueTypeUse,
): ValueExpression {
  if (ts.isParenthesizedExpression(node))
    return tsExpr(node.expression, file, expected);
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
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return { kind: "literal", type: "string", value: node.text };
  if (ts.isIdentifier(node)) return { kind: "local", name: node.text };
  if (ts.isPropertyAccessExpression(node))
    return {
      kind: "field",
      base: tsExpr(node.expression, file),
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
      operand: tsExpr(node.operand, file),
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
        "===",
        "!==",
        "<",
        "<=",
        ">",
        ">=",
        "&&",
        "||",
      ].includes(op)
    )
      throw new ModuleError("LLV008", `unsupported operator ${op}`, file);
    return {
      kind: "binary",
      op,
      left: tsExpr(node.left, file),
      right: tsExpr(node.right, file),
    };
  }
  if (ts.isConditionalExpression(node))
    return {
      kind: "if",
      condition: tsExpr(node.condition, file),
      whenTrue: tsExpr(node.whenTrue, file, expected),
      whenFalse: tsExpr(node.whenFalse, file, expected),
    };
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    !node.typeArguments?.length
  ) {
    const name = node.expression.text;
    return name === "concat" || name === "scalarLength"
      ? {
          kind: "intrinsic",
          name,
          arguments: node.arguments.map((x) => tsExpr(x, file)),
        }
      : {
          kind: "call",
          callee: name,
          arguments: node.arguments.map((x) => tsExpr(x, file)),
        };
  }
  if (ts.isObjectLiteralExpression(node)) {
    const type = expectedName(expected);
    if (!type)
      throw new ModuleError(
        "LLV008",
        "object literals require a named contextual type",
        file,
      );
    const properties = node.properties.map((p) => {
      if (
        !ts.isPropertyAssignment(p) ||
        (!ts.isIdentifier(p.name) && !ts.isStringLiteral(p.name))
      )
        throw new ModuleError(
          "LLV008",
          "object fields must be property assignments",
          file,
        );
      return { name: p.name.text, value: p.initializer };
    });
    const tag = properties.find((x) => x.name === "tag");
    if (tag) {
      if (!ts.isStringLiteral(tag.value))
        throw new ModuleError(
          "LLV008",
          "union tag must be a string literal",
          file,
        );
      return {
        kind: "variant",
        type,
        tag: tag.value.text,
        fields: properties
          .filter((x) => x.name !== "tag")
          .map((x) => ({ name: x.name, value: tsExpr(x.value, file) })),
      };
    }
    return {
      kind: "record",
      type,
      fields: properties.map((x) => ({
        name: x.name,
        value: tsExpr(x.value, file),
      })),
    };
  }
  throw new ModuleError(
    "LLV008",
    `unsupported TypeScript expression: ${node.getText()}`,
    file,
  );
}
function returnExpression(
  statement: ts.Statement,
  file: string,
  returns: ValueTypeUse,
): ValueExpression {
  if (ts.isReturnStatement(statement) && statement.expression)
    return tsExpr(statement.expression, file, returns);
  if (ts.isIfStatement(statement)) {
    const then = singleReturn(statement.thenStatement, file, returns),
      otherwise = statement.elseStatement
        ? singleReturn(statement.elseStatement, file, returns)
        : undefined;
    if (!otherwise)
      throw new ModuleError(
        "LLV008",
        "if must have an else returning a value",
        file,
      );
    return {
      kind: "if",
      condition: tsExpr(statement.expression, file),
      whenTrue: then,
      whenFalse: otherwise,
    };
  }
  if (ts.isSwitchStatement(statement)) {
    const cases = statement.caseBlock.clauses.map((clause) => {
      if (
        !ts.isCaseClause(clause) ||
        !ts.isStringLiteral(clause.expression) ||
        clause.statements.length !== 1
      )
        throw new ModuleError(
          "LLV008",
          "switch requires explicit string cases with one return",
          file,
        );
      return {
        tag: clause.expression.text,
        body: returnExpression(clause.statements[0]!, file, returns),
      };
    });
    return {
      kind: "match",
      value:
        ts.isPropertyAccessExpression(statement.expression) &&
        statement.expression.name.text === "tag"
          ? tsExpr(statement.expression.expression, file)
          : tsExpr(statement.expression, file),
      cases,
    };
  }
  throw new ModuleError(
    "LLV008",
    "expected return, if/else, or exhaustive switch",
    file,
  );
}
function singleReturn(
  statement: ts.Statement,
  file: string,
  returns: ValueTypeUse,
): ValueExpression {
  if (ts.isBlock(statement)) {
    if (statement.statements.length !== 1)
      throw new ModuleError("LLV008", "branch must contain one return", file);
    return returnExpression(statement.statements[0]!, file, returns);
  }
  return returnExpression(statement, file, returns);
}
export function parseValueModuleTypeScript(
  text: string,
  file = "<module.ts>",
): ValueModuleSource {
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
  if (diagnostics.length)
    throw new ModuleError(
      "LLV008",
      ts.flattenDiagnosticMessageText(diagnostics[0]!.messageText, "\n"),
      file,
    );
  const imports: ModuleImport[] = [],
    types: ValueTypeDeclaration[] = [],
    functions: ValueFunctionSource[] = [],
    coreImports = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !statement.importClause?.namedBindings ||
        !ts.isNamedImports(statement.importClause.namedBindings)
      )
        throw new ModuleError(
          "LLV008",
          "only named imports are supported",
          file,
        );
      if (statement.moduleSpecifier.text === "llang:core") {
        if (
          statement.importClause.isTypeOnly ||
          statement.importClause.namedBindings.elements.some(
            (x) =>
              !["concat", "scalarLength"].includes(x.name.text) ||
              x.propertyName ||
              x.isTypeOnly ||
              coreImports.has(x.name.text),
          )
        )
          throw new ModuleError("LLV008", "invalid llang:core import", file);
        for (const item of statement.importClause.namedBindings.elements)
          coreImports.add(item.name.text);
        continue;
      }
      if (
        statement.importClause.namedBindings.elements.some((x) =>
          ["concat", "scalarLength"].includes(x.name.text),
        )
      )
        throw new ModuleError("LLV008", "intrinsic name is reserved", file);
      imports.push({
        from: statement.moduleSpecifier.text,
        bindings: statement.importClause.namedBindings.elements.map((x) => ({
          kind:
            statement.importClause!.isTypeOnly || x.isTypeOnly
              ? "type"
              : "function",
          name: x.propertyName?.text ?? x.name.text,
          as: x.name.text,
        })),
      });
      continue;
    }
    if (ts.isTypeAliasDeclaration(statement)) {
      if (statement.typeParameters)
        throw new ModuleError("LLV008", "generic types are unsupported", file);
      const name = statement.name.text,
        ex = exported(statement);
      if (ts.isTypeLiteralNode(statement.type)) {
        types.push({
          name,
          export: ex,
          kind: "record",
          fields: statement.type.members.map((m) => {
            if (
              !ts.isPropertySignature(m) ||
              m.questionToken ||
              !m.type ||
              !m.name ||
              (!ts.isIdentifier(m.name) && !ts.isStringLiteral(m.name))
            )
              throw new ModuleError("LLV008", "invalid record field", file);
            return { name: m.name.text, type: tsType(m.type, file) };
          }),
        });
        continue;
      }
      if (ts.isUnionTypeNode(statement.type)) {
        const variants = statement.type.types.map((part) => {
          if (!ts.isTypeLiteralNode(part))
            throw new ModuleError(
              "LLV008",
              "union variants must be object types",
              file,
            );
          let tag: string | undefined;
          const fs: { name: string; type: ValueTypeUse }[] = [];
          for (const m of part.members) {
            if (
              !ts.isPropertySignature(m) ||
              !m.type ||
              !m.name ||
              (!ts.isIdentifier(m.name) && !ts.isStringLiteral(m.name))
            )
              throw new ModuleError("LLV008", "invalid union field", file);
            if (m.name.text === "tag") {
              if (
                !ts.isLiteralTypeNode(m.type) ||
                !ts.isStringLiteral(m.type.literal)
              )
                throw new ModuleError(
                  "LLV008",
                  "tag must be a string literal",
                  file,
                );
              tag = m.type.literal.text;
            } else fs.push({ name: m.name.text, type: tsType(m.type, file) });
          }
          if (!tag)
            throw new ModuleError("LLV008", "union variant needs tag", file);
          return { tag, fields: fs };
        });
        types.push({ name, export: ex, kind: "union", variants });
        continue;
      }
      throw new ModuleError(
        "LLV008",
        "type alias must be record or tagged union",
        file,
      );
    }
    if (ts.isFunctionDeclaration(statement)) {
      if (
        !statement.name ||
        !statement.body ||
        statement.typeParameters ||
        statement.asteriskToken
      )
        throw new ModuleError("LLV008", "invalid function", file);
      const returns = tsType(statement.type, file),
        bindings: {
          name: string;
          type: ValueTypeUse;
          value: ValueExpression;
        }[] = [];
      if (["concat", "scalarLength"].includes(statement.name.text))
        throw new ModuleError("LLV008", "intrinsic name is reserved", file);
      const bodyStatements = [...statement.body.statements];
      while (bodyStatements.length > 1) {
        const current = bodyStatements.shift()!;
        if (
          !ts.isVariableStatement(current) ||
          current.declarationList.flags !== ts.NodeFlags.Const ||
          current.declarationList.declarations.length !== 1
        )
          throw new ModuleError(
            "LLV008",
            "only annotated const bindings may precede return",
            file,
          );
        const d = current.declarationList.declarations[0]!;
        if (!ts.isIdentifier(d.name) || !d.type || !d.initializer)
          throw new ModuleError(
            "LLV008",
            "const requires name, type and initializer",
            file,
          );
        const type = tsType(d.type, file);
        bindings.push({
          name: d.name.text,
          type,
          value: tsExpr(d.initializer, file, type),
        });
      }
      if (bodyStatements.length !== 1)
        throw new ModuleError(
          "LLV008",
          "function must return on all paths",
          file,
        );
      const result = returnExpression(bodyStatements[0]!, file, returns);
      functions.push({
        name: statement.name.text,
        export: exported(statement),
        parameters: statement.parameters.map((p) => {
          if (
            !ts.isIdentifier(p.name) ||
            !p.type ||
            p.initializer ||
            p.questionToken ||
            p.dotDotDotToken
          )
            throw new ModuleError("LLV008", "invalid parameter", file);
          return { name: p.name.text, type: tsType(p.type, file) };
        }),
        returns,
        body: bindings.length ? { kind: "block", bindings, result } : result,
      });
      continue;
    }
    if (!ts.isEmptyStatement(statement))
      throw new ModuleError(
        "LLV008",
        `unsupported top-level syntax ${statement.getText()}`,
        file,
      );
  }
  const visitIntrinsics = (
    expression: ValueExpression,
    used = new Set<string>(),
  ): Set<string> => {
    const visit = (item: ValueExpression) => visitIntrinsics(item, used);
    if (expression.kind === "intrinsic") {
      used.add(expression.name);
      expression.arguments.forEach(visit);
    } else if (expression.kind === "field") visit(expression.base);
    else if (expression.kind === "unary") visit(expression.operand);
    else if (expression.kind === "binary") {
      visit(expression.left);
      visit(expression.right);
    } else if (expression.kind === "call") expression.arguments.forEach(visit);
    else if (expression.kind === "record" || expression.kind === "variant")
      expression.fields.forEach((field) => {
        visit(field.value);
      });
    else if (expression.kind === "block") {
      expression.bindings.forEach((binding) => {
        visit(binding.value);
      });
      visit(expression.result);
    } else if (expression.kind === "if") {
      visit(expression.condition);
      visit(expression.whenTrue);
      visit(expression.whenFalse);
    } else if (expression.kind === "match") {
      visit(expression.value);
      expression.cases.forEach((item) => {
        visit(item.body);
      });
    }
    return used;
  };
  for (const fn of functions)
    for (const name of visitIntrinsics(fn.body))
      if (!coreImports.has(name))
        throw new ModuleError(
          "LLV008",
          `${name} must be imported from llang:core`,
          file,
        );
  return {
    language: "l-lang",
    version: 3,
    kind: "module",
    profile: "module-value-v1",
    imports,
    types,
    functions,
  };
}

function validateSpecifier(value: string): void {
  if (
    !(value.startsWith("./") || value.startsWith("../")) ||
    value.includes("\\") ||
    value.includes("\0") ||
    /[?#]/.test(value) ||
    !SOURCE_EXTENSIONS.some((x) => value.endsWith(x))
  )
    throw new ModuleError("LLV002", `invalid import path ${value}`);
}
function moduleId(root: string, path: string): string {
  return relative(root, path)
    .split(sep)
    .join("/")
    .replace(/\.llang\.jsonc$|\.ts$/, "");
}
async function contained(
  root: string,
  rootReal: string,
  path: string,
): Promise<string> {
  const actual = await realpath(path).catch(() => ""),
    rel = relative(rootReal, actual);
  if (!actual || rel === ".." || rel.startsWith(`..${sep}`))
    throw new ModuleError("LLV002", "source escapes root", path);
  if (
    relative(root, path).split(sep).join("/") !==
    relative(rootReal, actual).split(sep).join("/")
  )
    throw new ModuleError(
      "LLV002",
      "source path identity does not match",
      path,
    );
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new ModuleError(
      "LLV002",
      "source must be regular non-symlink file",
      path,
    );
  return actual;
}
export async function loadValueModuleProgram(
  entryPath: string,
  rootPath: string,
  entryName: string,
): Promise<CheckedValueProgram> {
  const root = resolve(rootPath),
    rootInfo = await lstat(root),
    rootReal = await realpath(root),
    initial = resolve(root, entryPath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new ModuleError("LLV002", "root must be regular directory", root);
  const pending = [initial],
    snapshots = new Map<string, ValueModuleSnapshot>();
  let total = 0;
  while (pending.length) {
    const absolute = pending.pop()!,
      actual = await contained(root, rootReal, absolute);
    if (!SOURCE_EXTENSIONS.some((x) => absolute.endsWith(x)))
      throw new ModuleError("LLV002", "invalid source extension", absolute);
    const id = moduleId(root, absolute);
    if (snapshots.has(id)) continue;
    const bytes = await readFile(absolute);
    total += bytes.byteLength;
    if (
      bytes.byteLength > MODULE_LIMITS.sourceBytes ||
      total > MODULE_LIMITS.totalBytes ||
      snapshots.size >= MODULE_LIMITS.modules
    )
      throw new ModuleError("LLV007", "source closure exceeds limit", absolute);
    const text = decodeUtf8(bytes, absolute),
      source = absolute.endsWith(".ts")
        ? parseValueModuleTypeScript(text, absolute)
        : parseValueModuleJsonc(text, absolute);
    const relativePath = relative(root, absolute).split(sep).join("/");
    snapshots.set(id, {
      id,
      absolutePath: absolute,
      realPath: actual,
      rootPath: root,
      rootRealPath: rootReal,
      relativePath,
      sourceHash: digest(bytes),
      bytes,
      text,
      source,
    });
    for (const dependency of source.imports) {
      validateSpecifier(dependency.from);
      pending.push(resolve(dirname(absolute), dependency.from));
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
    );
  const active = new Set<string>(),
    done = new Set<string>();
  const visit = (id: string) => {
    if (active.has(id)) throw new ModuleError("LLV002", "module cycle");
    if (done.has(id)) return;
    active.add(id);
    for (const next of graph.get(id) ?? []) visit(next);
    active.delete(id);
    done.add(id);
  };
  const entryId = moduleId(root, initial);
  visit(entryId);
  if (done.size !== modules.length)
    throw new ModuleError("LLV002", "unreachable source in closure");
  return checkValueProgram(modules, entryId, entryName);
}
export async function revalidateValueModuleSnapshot(
  program: CheckedValueProgram,
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
