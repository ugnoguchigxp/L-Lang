import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { parseLlangJsonc, decodeUtf8 } from "./llang-jsonc";
import { digest } from "./wasm-contract";
import {
  MODULE_LIMITS,
  ModuleError,
  assertBindingName,
  checkModuleProgram,
  type CheckedModuleProgram,
  type ModuleExpression,
  type ModuleFunction,
  type ModuleImport,
  type ModuleRecordType,
  type ModuleSnapshot,
  type ModuleSource,
  type ModuleTypeUse,
} from "./llang-module-ir";

const SOURCE_EXTENSIONS = [".llang.jsonc", ".ts"] as const;
const TOP_KEYS = new Set([
  "language",
  "version",
  "kind",
  "profile",
  "description",
  "imports",
  "types",
  "functions",
]);

function object(
  value: unknown,
  keys: Set<string>,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ModuleError("LLM001", `${label} must be an object`);
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !keys.has(key));
  if (unknown)
    throw new ModuleError("LLM001", `unknown ${label} key ${unknown}`);
  return record;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value))
    throw new ModuleError("LLM001", `${label} must be an array`);
  return value;
}

export function parseModuleJsonc(
  text: string,
  file = "<module>",
): ModuleSource {
  const parsed = parseLlangJsonc(text, file);
  if (!parsed.document || !parsed.report.ok)
    throw new ModuleError(
      "LLM001",
      parsed.report.diagnostics[0]?.message ?? "invalid JSONC",
      file,
      parsed.report.diagnostics[0]?.path,
    );
  const root = object(parsed.document.value, TOP_KEYS, "module");
  if (
    root.language !== "l-lang" ||
    root.version !== 2 ||
    root.kind !== "module" ||
    root.profile !== "module-bool-v1"
  )
    throw new ModuleError("LLM001", "invalid module header", file);
  if (
    root.description !== undefined &&
    (typeof root.description !== "string" ||
      [...root.description].length > 4096)
  )
    throw new ModuleError("LLM001", "invalid description", file);
  const imports = array(root.imports, "imports").map((raw): ModuleImport => {
    const value = object(raw, new Set(["from", "bindings"]), "import");
    if (typeof value.from !== "string")
      throw new ModuleError("LLM001", "import.from must be a string", file);
    return {
      from: value.from,
      bindings: array(value.bindings, "bindings").map((rawBinding) => {
        const binding = object(
          rawBinding,
          new Set(["kind", "name", "as"]),
          "binding",
        );
        if (
          (binding.kind !== "type" && binding.kind !== "function") ||
          typeof binding.name !== "string" ||
          typeof binding.as !== "string"
        )
          throw new ModuleError("LLM001", "invalid import binding", file);
        return { kind: binding.kind, name: binding.name, as: binding.as };
      }),
    };
  });
  const types = array(root.types, "types").map((raw): ModuleRecordType => {
    const value = object(
      raw,
      new Set(["name", "export", "kind", "fields"]),
      "type",
    );
    if (
      typeof value.name !== "string" ||
      typeof value.export !== "boolean" ||
      value.kind !== "record"
    )
      throw new ModuleError("LLM001", "invalid type declaration", file);
    return {
      name: value.name,
      export: value.export,
      kind: "record",
      fields: array(value.fields, "fields").map((rawField) => {
        const field = object(rawField, new Set(["name", "type"]), "field");
        if (typeof field.name !== "string" || field.type !== "boolean")
          throw new ModuleError("LLM001", "invalid record field", file);
        return { name: field.name, type: "boolean" };
      }),
    };
  });
  const typesUse = (raw: unknown): ModuleTypeUse => {
    if (raw === "boolean") return "boolean";
    const value = object(raw, new Set(["ref"]), "type use");
    if (typeof value.ref !== "string")
      throw new ModuleError("LLM001", "invalid type use", file);
    return { ref: value.ref };
  };
  const expression = (raw: unknown): ModuleExpression => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new ModuleError("LLM001", "expression must be an object", file);
    const kind = (raw as { kind?: unknown }).kind;
    if (kind === "literal") {
      const v = object(raw, new Set(["kind", "value"]), "literal");
      if (typeof v.value !== "boolean")
        throw new ModuleError("LLM001", "literal must be boolean", file);
      return { kind, value: v.value };
    }
    if (kind === "param") {
      const v = object(raw, new Set(["kind", "name"]), "param");
      if (typeof v.name !== "string")
        throw new ModuleError("LLM001", "invalid param", file);
      return { kind, name: v.name };
    }
    if (kind === "field") {
      const v = object(raw, new Set(["kind", "base", "name"]), "field");
      const base = expression(v.base);
      if (base.kind !== "param" || typeof v.name !== "string")
        throw new ModuleError("LLM001", "invalid field", file);
      return { kind, base, name: v.name };
    }
    if (kind === "not") {
      const v = object(raw, new Set(["kind", "condition"]), "not");
      return { kind, condition: expression(v.condition) };
    }
    if (kind === "all" || kind === "any") {
      const v = object(raw, new Set(["kind", "conditions"]), kind);
      return {
        kind,
        conditions: array(v.conditions, "conditions").map(expression),
      };
    }
    if (kind === "equals") {
      const v = object(raw, new Set(["kind", "left", "right"]), "equals");
      return { kind, left: expression(v.left), right: expression(v.right) };
    }
    if (kind === "call") {
      const v = object(raw, new Set(["kind", "callee", "arguments"]), "call");
      if (typeof v.callee !== "string")
        throw new ModuleError("LLM001", "invalid callee", file);
      return {
        kind,
        callee: v.callee,
        arguments: array(v.arguments, "arguments").map(expression),
      };
    }
    throw new ModuleError(
      "LLM001",
      `unknown expression kind ${JSON.stringify(kind)}`,
      file,
    );
  };
  const functions = array(root.functions, "functions").map(
    (raw): ModuleFunction => {
      const value = object(
        raw,
        new Set(["name", "export", "parameters", "returns", "body"]),
        "function",
      );
      if (
        typeof value.name !== "string" ||
        typeof value.export !== "boolean" ||
        value.returns !== "boolean"
      )
        throw new ModuleError("LLM001", "invalid function declaration", file);
      return {
        name: value.name,
        export: value.export,
        returns: "boolean",
        parameters: array(value.parameters, "parameters").map((rawParam) => {
          const p = object(rawParam, new Set(["name", "type"]), "parameter");
          if (typeof p.name !== "string")
            throw new ModuleError("LLM001", "invalid parameter", file);
          return { name: p.name, type: typesUse(p.type) };
        }),
        body: expression(value.body),
      };
    },
  );
  return {
    language: "l-lang",
    version: 2,
    kind: "module",
    profile: "module-bool-v1",
    ...(typeof root.description === "string"
      ? { description: root.description }
      : {}),
    imports,
    types,
    functions,
  };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return Boolean(
    ts
      .getModifiers(node as ts.HasModifiers)
      ?.some((item) => item.kind === kind),
  );
}
function assertOnlyExportModifier(node: ts.Node, file: string): void {
  const modifiers = ts.getModifiers(node as ts.HasModifiers) ?? [];
  if (modifiers.some((item) => item.kind !== ts.SyntaxKind.ExportKeyword))
    throw new ModuleError(
      "LLM008",
      "only the export modifier is supported",
      file,
    );
}
function tsType(node: ts.TypeNode | undefined, file: string): ModuleTypeUse {
  if (!node)
    throw new ModuleError(
      "LLM008",
      "explicit type annotation is required",
      file,
    );
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return "boolean";
  if (
    ts.isTypeReferenceNode(node) &&
    ts.isIdentifier(node.typeName) &&
    !node.typeArguments
  )
    return { ref: node.typeName.text };
  throw new ModuleError(
    "LLM008",
    "only boolean and named record types are supported",
    file,
  );
}
function tsExpression(node: ts.Expression, file: string): ModuleExpression {
  if (
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword
  )
    return { kind: "literal", value: node.kind === ts.SyntaxKind.TrueKeyword };
  if (ts.isIdentifier(node)) return { kind: "param", name: node.text };
  if (ts.isParenthesizedExpression(node))
    return tsExpression(node.expression, file);
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression))
    return {
      kind: "field",
      base: { kind: "param", name: node.expression.text },
      name: node.name.text,
    };
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.ExclamationToken
  )
    return { kind: "not", condition: tsExpression(node.operand, file) };
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    const kind =
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        ? "all"
        : "any";
    const left = tsExpression(node.left, file),
      right = tsExpression(node.right, file);
    return {
      kind,
      conditions: [
        ...(left.kind === kind ? left.conditions : [left]),
        ...(right.kind === kind ? right.conditions : [right]),
      ],
    };
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
  )
    return {
      kind: "equals",
      left: tsExpression(node.left, file),
      right: tsExpression(node.right, file),
    };
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    !node.typeArguments?.length
  )
    return {
      kind: "call",
      callee: node.expression.text,
      arguments: node.arguments.map((x) => tsExpression(x, file)),
    };
  throw new ModuleError(
    "LLM008",
    `unsupported TypeScript expression: ${node.getText()}`,
    file,
  );
}

export function parseModuleTypeScript(
  text: string,
  file = "<module.ts>",
): ModuleSource {
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const parseDiagnostics = (
    sourceFile as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  if (parseDiagnostics.length)
    throw new ModuleError(
      "LLM008",
      ts.flattenDiagnosticMessageText(
        parseDiagnostics[0]?.messageText ?? "invalid TypeScript",
        "\n",
      ),
      file,
    );
  const imports: ModuleImport[] = [],
    types: ModuleRecordType[] = [],
    functions: ModuleFunction[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !statement.importClause?.namedBindings ||
        !ts.isNamedImports(statement.importClause.namedBindings) ||
        statement.importClause.name
      )
        throw new ModuleError(
          "LLM008",
          "only named imports are supported",
          file,
        );
      const bindings = statement.importClause.namedBindings.elements.map(
        (element) => ({
          kind: (statement.importClause?.isTypeOnly || element.isTypeOnly
            ? "type"
            : "function") as "type" | "function",
          name: element.propertyName?.text ?? element.name.text,
          as: element.name.text,
        }),
      );
      imports.push({ from: statement.moduleSpecifier.text, bindings });
      continue;
    }
    if (ts.isTypeAliasDeclaration(statement)) {
      assertOnlyExportModifier(statement, file);
      assertBindingName(statement.name.text, "type");
      if (statement.typeParameters || !ts.isTypeLiteralNode(statement.type))
        throw new ModuleError(
          "LLM008",
          "type aliases must be flat records",
          file,
        );
      const fields = statement.type.members.map((member) => {
        if (
          !ts.isPropertySignature(member) ||
          (ts.getModifiers(member)?.length ?? 0) > 0 ||
          member.questionToken ||
          !member.type ||
          member.type.kind !== ts.SyntaxKind.BooleanKeyword ||
          !member.name ||
          (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name))
        )
          throw new ModuleError(
            "LLM008",
            "record fields must be required booleans",
            file,
          );
        return { name: member.name.text, type: "boolean" as const };
      });
      types.push({
        name: statement.name.text,
        export: hasModifier(statement, ts.SyntaxKind.ExportKeyword),
        kind: "record",
        fields,
      });
      continue;
    }
    if (ts.isFunctionDeclaration(statement)) {
      assertOnlyExportModifier(statement, file);
      const only = statement.body?.statements[0];
      if (
        !statement.name ||
        statement.asteriskToken ||
        statement.typeParameters ||
        !statement.body ||
        statement.body.statements.length !== 1 ||
        !only ||
        !ts.isReturnStatement(only) ||
        !only.expression
      )
        throw new ModuleError(
          "LLM008",
          "functions must be named and contain one return statement",
          file,
        );
      const parameters = statement.parameters.map((parameter) => {
        if (
          !ts.isIdentifier(parameter.name) ||
          parameter.questionToken ||
          parameter.dotDotDotToken ||
          parameter.initializer
        )
          throw new ModuleError("LLM008", "unsupported parameter", file);
        return {
          name: parameter.name.text,
          type: tsType(parameter.type, file),
        };
      });
      if (tsType(statement.type, file) !== "boolean")
        throw new ModuleError(
          "LLM008",
          "function return type must be boolean",
          file,
        );
      functions.push({
        name: statement.name.text,
        export: hasModifier(statement, ts.SyntaxKind.ExportKeyword),
        parameters,
        returns: "boolean",
        body: tsExpression(only.expression, file),
      });
      continue;
    }
    if (!ts.isEmptyStatement(statement))
      throw new ModuleError(
        "LLM008",
        `unsupported top-level TypeScript: ${statement.getText(sourceFile)}`,
        file,
      );
  }
  return {
    language: "l-lang",
    version: 2,
    kind: "module",
    profile: "module-bool-v1",
    imports,
    types,
    functions,
  };
}

function validateSpecifier(specifier: string): void {
  if (
    !(specifier.startsWith("./") || specifier.startsWith("../")) ||
    specifier.includes("\\") ||
    specifier.includes("\0") ||
    /[?#]/.test(specifier) ||
    !SOURCE_EXTENSIONS.some((ext) => specifier.endsWith(ext))
  )
    throw new ModuleError("LLM002", `invalid import path ${specifier}`);
}
function moduleId(root: string, path: string): string {
  const rel = relative(root, path).split(sep).join("/");
  return rel.replace(/\.llang\.jsonc$|\.ts$/, "");
}
async function assertContainedRegular(
  rootPath: string,
  rootReal: string,
  path: string,
): Promise<string> {
  const actual = await realpath(path).catch(() => "");
  if (
    !actual ||
    !(actual === rootReal || actual.startsWith(`${rootReal}${sep}`))
  )
    throw new ModuleError("LLM002", "source escapes root", path);
  if (
    relative(rootPath, path).split(sep).join("/") !==
    relative(rootReal, actual).split(sep).join("/")
  )
    throw new ModuleError(
      "LLM002",
      "source path case or identity does not match",
      path,
    );
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new ModuleError(
      "LLM002",
      "source must be a regular non-symlink file",
      path,
    );
  const parts = relative(rootPath, path).split(sep);
  let cursor = rootPath;
  for (const part of parts) {
    cursor = resolve(cursor, part);
    const item = await lstat(cursor);
    if (item.isSymbolicLink())
      throw new ModuleError(
        "LLM002",
        "symlink source paths are not allowed",
        path,
      );
  }
  return actual;
}

export async function loadModuleProgram(
  entryPath: string,
  rootPath: string,
  entryName: string,
): Promise<CheckedModuleProgram> {
  const root = resolve(rootPath),
    rootInfo = await lstat(root),
    rootReal = await realpath(root),
    initial = resolve(root, entryPath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new ModuleError(
      "LLM002",
      "root must be a regular non-symlink directory",
      root,
    );
  const pending = [initial],
    snapshots = new Map<string, ModuleSnapshot>();
  let total = 0;
  while (pending.length) {
    const absolute = pending.pop() as string;
    const sourceRealPath = await assertContainedRegular(
      root,
      rootReal,
      absolute,
    );
    if (!SOURCE_EXTENSIONS.some((ext) => absolute.endsWith(ext)))
      throw new ModuleError(
        "LLM002",
        "source extension must be explicit",
        absolute,
      );
    const id = moduleId(root, absolute);
    const prior = snapshots.get(id);
    if (prior) {
      if (prior.absolutePath !== absolute)
        throw new ModuleError(
          "LLM002",
          `ambiguous logical module ${id}`,
          absolute,
        );
      continue;
    }
    const bytes = await readFile(absolute);
    if (bytes.byteLength > MODULE_LIMITS.sourceBytes)
      throw new ModuleError("LLM007", "source exceeds byte limit", absolute);
    total += bytes.byteLength;
    if (
      total > MODULE_LIMITS.totalBytes ||
      snapshots.size >= MODULE_LIMITS.modules
    )
      throw new ModuleError("LLM007", "module closure exceeds limit", absolute);
    const text = decodeUtf8(bytes, absolute),
      source = absolute.endsWith(".ts")
        ? parseModuleTypeScript(text, absolute)
        : parseModuleJsonc(text, absolute);
    const relativePath = relative(root, absolute).split(sep).join("/");
    snapshots.set(id, {
      id,
      absolutePath: absolute,
      realPath: sourceRealPath,
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
      const target = resolve(dirname(absolute), dependency.from);
      if (
        relative(root, target).startsWith(`..${sep}`) ||
        relative(root, target) === ".."
      )
        throw new ModuleError("LLM002", "import escapes root", absolute);
      pending.push(target);
    }
  }
  const modules = [...snapshots.values()];
  const graph = new Map(
    modules.map((m) => [
      m.id,
      m.source.imports.map((x) =>
        moduleId(root, resolve(dirname(m.absolutePath), x.from)),
      ),
    ]),
  );
  const active = new Set<string>(),
    done = new Set<string>();
  const visit = (id: string, trail: string[]) => {
    if (active.has(id))
      throw new ModuleError(
        "LLM002",
        `module cycle: ${[...trail, id].join(" -> ")}`,
      );
    if (done.has(id)) return;
    active.add(id);
    for (const next of graph.get(id) ?? []) visit(next, [...trail, id]);
    active.delete(id);
    done.add(id);
  };
  visit(moduleId(root, initial), []);
  return checkModuleProgram(modules, moduleId(root, initial), entryName);
}

export async function revalidateModuleSnapshot(
  program: CheckedModuleProgram,
): Promise<void> {
  for (const module of program.modules) {
    const actual = await assertContainedRegular(
      module.rootPath,
      module.rootRealPath,
      module.absolutePath,
    ).catch(() => null);
    const bytes = actual
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
