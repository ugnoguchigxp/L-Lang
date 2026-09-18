import { readFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import ts from "typescript";
import { resolveContainedFile } from "./contained-path";
import {
  effectsManifest,
  HostOperationRegistry,
  operationSignature,
  type OperationDefinition,
} from "./llang-effects-contract";
import {
  BUILTIN_IO_OPERATIONS,
  BUILTIN_IO_TYPES,
  checkTypedEffectsProgram,
  decodeEffectValue,
  effectValueTypeJson,
  type EffectValueType,
  parseEffectValueType,
  type TypedAwait,
  type TypedEffectNode,
  type TypedEffectsProgram,
} from "./llang-effects-ir";
import { decodeUtf8, LLANG_SOURCE_BYTES, parseLlangJsonc } from "./llang-jsonc";
import { ModuleError } from "./llang-module-ir";
import { fingerprintFor } from "./stable-hash";
import { digest } from "./wasm-contract";

export type EffectsGraphImport = Readonly<{ source: string; module: string }>;
export type EffectsGraphSource = Readonly<{
  language: "l-lang";
  version: 5;
  kind: "module";
  profile: "module-effects-v1";
  module: string;
  entry?: string;
  imports: readonly EffectsGraphImport[];
  operations: readonly OperationDefinition[];
  resultType: EffectValueType;
  nodes: readonly unknown[];
}>;
export type CheckedEffectsGraph = Readonly<{
  entry: string;
  modules: readonly EffectsGraphSource[];
  sources: readonly Readonly<{ path: string; hash: string }>[];
  sourceSetHash: string;
  programHash: string;
  interfaceHash: string;
  registry: HostOperationRegistry;
  operations: readonly OperationDefinition[];
  manifest: ReturnType<typeof effectsManifest>;
  program: TypedEffectsProgram;
}>;

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ModuleError("LLE001", `${label} must be an object`);
  return value as Record<string, unknown>;
};
const exact = (value: unknown, keys: readonly string[], label: string) => {
  const item = object(value, label),
    unknown = Object.keys(item).find((key) => !keys.includes(key));
  if (unknown)
    throw new ModuleError("LLE001", `unknown ${label} key ${unknown}`);
  return item;
};
const string = (value: unknown, label: string) => {
  if (typeof value !== "string" || !value)
    throw new ModuleError("LLE001", `${label} must be a non-empty string`);
  return value;
};
const integer = (value: unknown, label: string) => {
  if (!Number.isInteger(value))
    throw new ModuleError("LLE001", `${label} must be an integer`);
  return Number(value);
};
const list = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value))
    throw new ModuleError("LLE001", `${label} must be an array`);
  return value;
};

const operation = (value: unknown): OperationDefinition => {
  const item = exact(
    value,
    [
      "id",
      "version",
      "requestType",
      "responseType",
      "errorType",
      "effect",
      "resource",
      "cancellable",
      "idempotent",
    ],
    "operation",
  );
  if (
    !["file", "http", "clock", "host"].includes(String(item.effect)) ||
    !["none", "file", "http-body", "stream"].includes(String(item.resource)) ||
    typeof item.cancellable !== "boolean" ||
    typeof item.idempotent !== "boolean"
  )
    throw new ModuleError("LLE001", "invalid operation definition");
  parseEffectValueType(item.requestType);
  parseEffectValueType(item.responseType);
  return Object.freeze({
    id: string(item.id, "operation id"),
    version: (() => {
      const version = integer(item.version, "operation version");
      if (version < 1)
        throw new ModuleError("LLE001", "operation version must be positive");
      return version;
    })(),
    requestType: item.requestType,
    responseType: item.responseType,
    errorType: item.errorType,
    effect: item.effect as OperationDefinition["effect"],
    resource: item.resource as OperationDefinition["resource"],
    cancellable: item.cancellable,
    idempotent: item.idempotent,
  });
};

const graphSource = (
  value: unknown,
  entryName?: string,
): EffectsGraphSource => {
  const item = exact(
    value,
    [
      "language",
      "version",
      "kind",
      "profile",
      "module",
      "entry",
      "imports",
      "operations",
      "resultType",
      "nodes",
    ],
    "effects graph module",
  );
  if (
    item.language !== "l-lang" ||
    item.version !== 5 ||
    item.kind !== "module" ||
    item.profile !== "module-effects-v1"
  )
    throw new ModuleError("LLE001", "invalid module-effects-v1 header");
  const entry =
    entryName ??
    (item.entry === undefined ? undefined : string(item.entry, "entry"));
  if (entryName && item.entry !== undefined)
    throw new ModuleError(
      "LLE001",
      "TypeScript definition must not contain entry",
    );
  return Object.freeze({
    language: "l-lang",
    version: 5,
    kind: "module",
    profile: "module-effects-v1",
    module: string(item.module, "module"),
    ...(entry ? { entry } : {}),
    imports: Object.freeze(
      list(item.imports ?? [], "imports").map((raw) => {
        const imported = exact(raw, ["source", "module"], "import");
        return Object.freeze({
          source: string(imported.source, "import source"),
          module: string(imported.module, "import module"),
        });
      }),
    ),
    operations: Object.freeze(
      list(item.operations ?? [], "operations").map(operation),
    ),
    resultType: parseEffectValueType(item.resultType),
    nodes: Object.freeze(list(item.nodes, "nodes")),
  });
};

const literal = (
  node: ts.Expression,
  count = { value: 0 },
  depth = 0,
): unknown => {
  if (++count.value > 20_000 || depth > 64)
    throw new ModuleError(
      "LLE001",
      "TypeScript effects graph literal is too large",
    );
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  )
    return -Number(node.operand.text);
  if (ts.isArrayLiteralExpression(node))
    return node.elements.map((item) => literal(item, count, depth + 1));
  if (ts.isObjectLiteralExpression(node)) {
    const result: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const property of node.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))
      )
        throw new ModuleError("LLE001", "unsupported TypeScript property");
      if (Object.hasOwn(result, property.name.text))
        throw new ModuleError(
          "LLE001",
          `duplicate TypeScript property ${property.name.text}`,
        );
      result[property.name.text] = literal(
        property.initializer,
        count,
        depth + 1,
      );
    }
    return result;
  }
  throw new ModuleError(
    "LLE001",
    "unsupported TypeScript effects graph literal",
  );
};

export function parseEffectsGraphJsonc(
  text: string,
  file = "<module>",
): EffectsGraphSource {
  const parsed = parseLlangJsonc(text, file);
  if (!parsed.document || !parsed.report.ok)
    throw new ModuleError(
      "LLE001",
      parsed.report.diagnostics[0]?.message ?? "invalid JSONC",
      file,
    );
  return graphSource(parsed.document.value);
}

export function parseEffectsGraphTypeScript(
  text: string,
  file = "<module.ts>",
): EffectsGraphSource {
  const root = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    ),
    statements = root.statements,
    first = statements[0],
    second = statements[1];
  if (
    statements.length !== 2 ||
    !first ||
    !second ||
    !ts.isImportDeclaration(first) ||
    !ts.isVariableStatement(second)
  )
    throw new ModuleError("LLE001", "invalid effects graph TypeScript shape");
  const imported = first,
    clause = imported.importClause,
    binding = clause?.namedBindings;
  if (
    !ts.isStringLiteral(imported.moduleSpecifier) ||
    imported.moduleSpecifier.text !== "llang:effects" ||
    !binding ||
    !ts.isNamedImports(binding) ||
    binding.elements.length !== 1 ||
    binding.elements[0]?.name.text !== "defineEffects"
  )
    throw new ModuleError("LLE001", "invalid llang:effects import");
  const statement = second,
    declaration = statement.declarationList.declarations[0];
  if (
    !statement.modifiers?.some(
      (item) => item.kind === ts.SyntaxKind.ExportKeyword,
    ) ||
    !(statement.declarationList.flags & ts.NodeFlags.Const) ||
    statement.declarationList.declarations.length !== 1 ||
    !declaration ||
    !ts.isIdentifier(declaration.name) ||
    !declaration.initializer ||
    !ts.isCallExpression(declaration.initializer) ||
    !ts.isIdentifier(declaration.initializer.expression) ||
    declaration.initializer.expression.text !== "defineEffects" ||
    declaration.initializer.arguments.length !== 1
  )
    throw new ModuleError(
      "LLE001",
      "invalid exported effects graph definition",
    );
  return graphSource(
    {
      language: "l-lang",
      version: 5,
      kind: "module",
      profile: "module-effects-v1",
      ...object(
        literal(declaration.initializer.arguments[0] as ts.Expression),
        "effects definition",
      ),
    },
    declaration.name.text,
  );
}

const sameType = (a: EffectValueType, b: EffectValueType) =>
  JSON.stringify(effectValueTypeJson(a)) ===
  JSON.stringify(effectValueTypeJson(b));

const awaitNode = (
  raw: unknown,
  operations: ReadonlyMap<string, OperationDefinition>,
): TypedAwait => {
  const item = exact(
      raw,
      ["kind", "operation", "version", "request"],
      "await node",
    ),
    id = string(item.operation, "operation"),
    version = integer(item.version, "version"),
    definition = operations.get(`${id}@${version}`);
  if (!definition)
    throw new ModuleError("LLE002", `unknown operation ${id}@${version}`);
  const requestType = parseEffectValueType(definition.requestType),
    responseType = parseEffectValueType(definition.responseType);
  return Object.freeze({
    kind: "await",
    operation: id,
    version,
    requestType,
    responseType,
    request: decodeEffectValue(requestType, item.request),
  });
};

const compileNode = (
  raw: unknown,
  operations: ReadonlyMap<string, OperationDefinition>,
): TypedEffectNode => {
  const kind = string(object(raw, "effect node").kind, "effect node kind");
  if (kind === "await") return awaitNode(raw, operations);
  if (kind === "file") {
    const base = object(raw, "file node"),
      action = string(base.action, "file action"),
      item = exact(
        raw,
        action === "read"
          ? ["kind", "action", "path"]
          : ["kind", "action", "path", "bytes", "replace"],
        "file node",
      ),
      path = string(item.path, "file path");
    if (action === "read")
      return Object.freeze({
        kind: "await",
        operation: "file.read",
        version: 1,
        requestType: BUILTIN_IO_TYPES.fileRead,
        responseType: { kind: "bytes" } as const,
        request: Object.freeze({ path }),
      });
    if (action === "write")
      return Object.freeze({
        kind: "await",
        operation: "file.write",
        version: 1,
        requestType: BUILTIN_IO_TYPES.fileWrite,
        responseType: { kind: "i64" } as const,
        request: Object.freeze({
          path,
          bytes: decodeEffectValue({ kind: "bytes" }, item.bytes),
          replace: item.replace === true,
        }),
      });
    throw new ModuleError("LLE001", "invalid file action");
  }
  if (kind === "http") {
    const item = exact(
        raw,
        ["kind", "url", "method", "headers", "body"],
        "http node",
      ),
      method = string(item.method, "HTTP method").toUpperCase();
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method))
      throw new ModuleError("LLE001", "invalid HTTP method");
    const headers = object(item.headers ?? {}, "HTTP headers"),
      normalized: { name: string; value: string }[] = [],
      headerNames = new Set<string>();
    for (const [name, value] of Object.entries(headers).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const lower = name.toLowerCase();
      if (headerNames.has(lower))
        throw new ModuleError("LLE001", `duplicate HTTP header ${lower}`);
      headerNames.add(lower);
      normalized.push({
        name: lower,
        value: string(value, "HTTP header"),
      });
    }
    return Object.freeze({
      kind: "await",
      operation: "http.request",
      version: 1,
      requestType: BUILTIN_IO_TYPES.httpRequest,
      responseType: { kind: "bytes" } as const,
      request: Object.freeze({
        url: string(item.url, "HTTP URL"),
        method,
        headers: Object.freeze(normalized),
        body: decodeEffectValue({ kind: "bytes" }, item.body ?? { bytes: "" }),
      }),
    });
  }
  if (kind === "task") {
    const item = exact(raw, ["kind", "tasks"], "task node"),
      tasks = Object.freeze(
        list(item.tasks, "tasks").map((task) => awaitNode(task, operations)),
      ),
      first = tasks[0];
    if (
      !first ||
      !tasks.every((task) => sameType(task.responseType, first.responseType))
    )
      throw new ModuleError("LLE002", "task responses must have one type");
    return Object.freeze({
      kind: "task",
      tasks,
      responseType: { kind: "list" as const, element: first.responseType },
    });
  }
  if (kind === "stream") {
    const item = exact(
        raw,
        ["kind", "operation", "version", "request", "maximumChunks"],
        "stream node",
      ),
      awaited = awaitNode(
        {
          kind: "await",
          operation: item.operation,
          version: item.version,
          request: item.request,
        },
        operations,
      );
    return Object.freeze({
      ...awaited,
      kind: "stream",
      maximumChunks: integer(item.maximumChunks, "maximumChunks"),
    });
  }
  throw new ModuleError("LLE001", `unknown effect node kind ${kind}`);
};

export async function loadEffectsModuleGraph(
  entry: string,
  root: string,
  entryName: string,
): Promise<CheckedEffectsGraph> {
  const canonicalRoot = resolve(root),
    modules = new Map<string, EffectsGraphSource>(),
    modulesByPath = new Map<string, EffectsGraphSource>(),
    sourceRecords: { path: string; hash: string }[] = [],
    visiting = new Set<string>();
  const visit = async (
    relativePath: string,
    expectedModule?: string,
  ): Promise<EffectsGraphSource> => {
    const path = await resolveContainedFile(
      canonicalRoot,
      relativePath,
      "effects source",
      { rejectSymbolicLinks: true },
    );
    if (visiting.has(path))
      throw new ModuleError("LLE002", "cyclic effects module import", path);
    const known = modulesByPath.get(path);
    if (known) {
      if (expectedModule && known.module !== expectedModule)
        throw new ModuleError(
          "LLE002",
          `import expected module ${expectedModule}`,
          path,
        );
      return known;
    }
    const bytes = await readFile(path);
    if (bytes.length > LLANG_SOURCE_BYTES)
      throw new ModuleError(
        "LLE001",
        "effects source exceeds byte limit",
        path,
      );
    const text = decodeUtf8(bytes, path),
      source =
        extname(path) === ".ts"
          ? parseEffectsGraphTypeScript(text, path)
          : extname(path) === ".jsonc"
            ? parseEffectsGraphJsonc(text, path)
            : (() => {
                throw new ModuleError(
                  "LLE001",
                  "unsupported effects source extension",
                  path,
                );
              })();
    if (expectedModule && source.module !== expectedModule)
      throw new ModuleError(
        "LLE002",
        `import expected module ${expectedModule}`,
        path,
      );
    if (modules.has(source.module))
      throw new ModuleError(
        "LLE002",
        `duplicate module ${source.module}`,
        path,
      );
    visiting.add(path);
    modules.set(source.module, source);
    modulesByPath.set(path, source);
    sourceRecords.push({
      path: relative(canonicalRoot, path).replaceAll("\\", "/"),
      hash: digest(bytes),
    });
    for (const imported of source.imports)
      await visit(
        relative(canonicalRoot, resolve(dirname(path), imported.source)),
        imported.module,
      );
    visiting.delete(path);
    return source;
  };
  const entrySource = await visit(entry);
  if (entrySource.entry !== entryName)
    throw new ModuleError("LLE002", `entry ${entryName} was not found`);
  const definitions = new Map<string, OperationDefinition>();
  for (const definition of [
    ...BUILTIN_IO_OPERATIONS,
    ...[...modules.values()].flatMap((module) => module.operations),
  ]) {
    const key = `${definition.id}@${definition.version}`,
      old = definitions.get(key);
    if (old && operationSignature(old) !== operationSignature(definition))
      throw new ModuleError("LLE002", `operation conflict ${key}`);
    definitions.set(key, definition);
  }
  const orderedModules: EffectsGraphSource[] = [],
    seen = new Set<string>();
  const order = (module: EffectsGraphSource) => {
    if (seen.has(module.module)) return;
    for (const imported of module.imports) {
      const child = modules.get(imported.module);
      if (!child)
        throw new ModuleError("LLE002", `missing module ${imported.module}`);
      order(child);
    }
    seen.add(module.module);
    orderedModules.push(module);
  };
  order(entrySource);
  const nodes = Object.freeze(
      orderedModules.flatMap((module) =>
        module.nodes.map((node) => compileNode(node, definitions)),
      ),
    ),
    last = nodes.at(-1);
  if (
    !last ||
    !sameType(
      last.kind === "task" ? last.responseType : last.responseType,
      entrySource.resultType,
    )
  )
    throw new ModuleError(
      "LLE002",
      "entry result type does not match final node",
    );
  const program = checkTypedEffectsProgram(
      Object.freeze({ nodes, resultType: entrySource.resultType }),
    ),
    requirements = nodes.flatMap((node) =>
      node.kind === "task"
        ? node.tasks.map((task) => ({
            id: task.operation,
            version: task.version,
          }))
        : [{ id: node.operation, version: node.version }],
    ),
    registry = new HostOperationRegistry([...definitions.values()]),
    manifest = effectsManifest(registry, requirements),
    sources = Object.freeze(
      sourceRecords.sort((a, b) => a.path.localeCompare(b.path)),
    ),
    programHash = fingerprintFor({
      modules: orderedModules.map((module) => module.module),
      sources,
      resultType: effectValueTypeJson(program.resultType),
      nodes: nodes.map((node) => node.kind),
    }),
    interfaceHash = fingerprintFor({
      profile: "module-effects-v1",
      entry: entryName,
      resultType: effectValueTypeJson(program.resultType),
      operations: manifest.operations,
      effects: manifest.effects,
    });
  return Object.freeze({
    entry: `${entrySource.module}#${entryName}`,
    modules: Object.freeze(orderedModules),
    sources,
    sourceSetHash: fingerprintFor(sources),
    programHash,
    interfaceHash,
    registry,
    operations: Object.freeze([...definitions.values()]),
    manifest,
    program,
  });
}
