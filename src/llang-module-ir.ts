import { fingerprintFor } from "./stable-hash";

export const MODULE_LIMITS = {
  sourceBytes: 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
  modules: 64,
  functionsPerModule: 64,
  typesPerModule: 64,
  importsPerModule: 256,
  functions: 256,
  types: 256,
  imports: 1024,
  parameters: 8,
  fields: 64,
  expressionNodes: 256,
  expressionDepth: 32,
  callDepth: 32,
  evaluationSteps: 100_000,
} as const;

export type ModuleTypeUse = "boolean" | { ref: string };
export type ModuleRecordType = {
  name: string;
  export: boolean;
  kind: "record";
  fields: { name: string; type: "boolean" }[];
};
export type ModuleExpression =
  | { kind: "literal"; value: boolean }
  | { kind: "param"; name: string }
  | { kind: "field"; base: { kind: "param"; name: string }; name: string }
  | { kind: "not"; condition: ModuleExpression }
  | { kind: "all" | "any"; conditions: ModuleExpression[] }
  | { kind: "equals"; left: ModuleExpression; right: ModuleExpression }
  | { kind: "call"; callee: string; arguments: ModuleExpression[] };
export type ModuleFunction = {
  name: string;
  export: boolean;
  parameters: { name: string; type: ModuleTypeUse }[];
  returns: "boolean";
  body: ModuleExpression;
};
export type ModuleImport = {
  from: string;
  bindings: { kind: "type" | "function"; name: string; as: string }[];
};
export type ModuleSource = {
  language: "l-lang";
  version: 2;
  kind: "module";
  profile: "module-bool-v1";
  description?: string;
  imports: ModuleImport[];
  types: ModuleRecordType[];
  functions: ModuleFunction[];
};

export type ModuleSnapshot = {
  id: string;
  absolutePath: string;
  realPath: string;
  rootPath: string;
  rootRealPath: string;
  relativePath: string;
  sourceHash: string;
  bytes: Uint8Array;
  text: string;
  source: ModuleSource;
};
export type CanonicalRecord = { kind: "record"; fields: string[] };
export type ResolvedType = { kind: "boolean" } | CanonicalRecord;
export type CheckedParameter = { name: string; type: ResolvedType };
export type CheckedFunction = {
  symbol: string;
  moduleId: string;
  name: string;
  export: boolean;
  parameters: CheckedParameter[];
  body: ModuleExpression;
  callees: Record<string, string>;
};
export type CheckedModuleProgram = {
  profile: "module-bool-v1";
  entry: string;
  entryModuleId: string;
  modules: ModuleSnapshot[];
  functions: CheckedFunction[];
  programHash: string;
  interfaceHash: string;
  sourceSetHash: string;
};

export class ModuleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly file = "<module>",
    public readonly path = "",
  ) {
    super(`${code}: ${message}`);
    this.name = "ModuleError";
  }
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "null",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

export function assertBindingName(
  name: unknown,
  label: string,
): asserts name is string {
  if (
    typeof name !== "string" ||
    name.length > 128 ||
    !IDENTIFIER.test(name) ||
    RESERVED.has(name)
  )
    throw new ModuleError(
      "LLM003",
      `invalid ${label} name ${JSON.stringify(name)}`,
    );
}

function sameType(left: ResolvedType, right: ResolvedType): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "boolean" ||
      (right.kind === "record" &&
        left.fields.join("\0") === right.fields.join("\0")))
  );
}

function expressionStats(expression: ModuleExpression): {
  nodes: number;
  depth: number;
} {
  const children =
    expression.kind === "not"
      ? [expression.condition]
      : expression.kind === "all" || expression.kind === "any"
        ? expression.conditions
        : expression.kind === "equals"
          ? [expression.left, expression.right]
          : expression.kind === "call"
            ? expression.arguments
            : [];
  const child = children.map(expressionStats);
  return {
    nodes: 1 + child.reduce((n, x) => n + x.nodes, 0),
    depth: 1 + Math.max(0, ...child.map((x) => x.depth)),
  };
}

export function checkModuleProgram(
  modulesInput: ModuleSnapshot[],
  entryModuleId: string,
  entryName: string,
): CheckedModuleProgram {
  const modules = [...modulesInput].sort((a, b) => a.id.localeCompare(b.id));
  if (!modules.length || modules.length > MODULE_LIMITS.modules)
    throw new ModuleError("LLM007", "module count exceeds limit");
  if (new Set(modules.map((m) => m.id.toLowerCase())).size !== modules.length)
    throw new ModuleError("LLM002", "logical module IDs collide by case");
  const byId = new Map(modules.map((m) => [m.id, m]));
  const typeTables = new Map<
    string,
    Map<string, { exported: boolean; type: CanonicalRecord }>
  >();
  const functionDecls = new Map<string, ModuleFunction>();
  const functionExports = new Map<string, boolean>();
  let importCount = 0;
  for (const module of modules) {
    if (
      module.source.types.length > MODULE_LIMITS.typesPerModule ||
      module.source.functions.length > MODULE_LIMITS.functionsPerModule
    )
      throw new ModuleError(
        "LLM007",
        "declaration count exceeds module limit",
        module.absolutePath,
      );
    if (
      module.source.imports.reduce((n, x) => n + x.bindings.length, 0) >
      MODULE_LIMITS.importsPerModule
    )
      throw new ModuleError(
        "LLM007",
        "import binding count exceeds module limit",
        module.absolutePath,
      );
    importCount += module.source.imports.reduce(
      (n, x) => n + x.bindings.length,
      0,
    );
    const names = new Set<string>();
    const types = new Map<
      string,
      { exported: boolean; type: CanonicalRecord }
    >();
    for (const type of module.source.types) {
      assertBindingName(type.name, "type");
      if (names.has(type.name))
        throw new ModuleError(
          "LLM003",
          `duplicate binding ${type.name}`,
          module.absolutePath,
        );
      names.add(type.name);
      if (!type.fields.length || type.fields.length > MODULE_LIMITS.fields)
        throw new ModuleError(
          "LLM005",
          `invalid field count for ${type.name}`,
          module.absolutePath,
        );
      const fields = type.fields
        .map((f) => {
          if (
            typeof f.name !== "string" ||
            !IDENTIFIER.test(f.name) ||
            f.name.length > 128 ||
            f.type !== "boolean"
          )
            throw new ModuleError(
              "LLM005",
              `invalid field in ${type.name}`,
              module.absolutePath,
            );
          return f.name;
        })
        .sort();
      if (new Set(fields).size !== fields.length)
        throw new ModuleError(
          "LLM003",
          `duplicate field in ${type.name}`,
          module.absolutePath,
        );
      types.set(type.name, {
        exported: type.export,
        type: { kind: "record", fields },
      });
    }
    for (const fn of module.source.functions) {
      assertBindingName(fn.name, "function");
      if (names.has(fn.name))
        throw new ModuleError(
          "LLM003",
          `duplicate binding ${fn.name}`,
          module.absolutePath,
        );
      names.add(fn.name);
      const symbol = `${module.id}#${fn.name}`;
      functionDecls.set(symbol, fn);
      functionExports.set(symbol, fn.export);
    }
    typeTables.set(module.id, types);
  }
  if (
    modules.reduce((n, m) => n + m.source.functions.length, 0) >
      MODULE_LIMITS.functions ||
    modules.reduce((n, m) => n + m.source.types.length, 0) >
      MODULE_LIMITS.types ||
    importCount > MODULE_LIMITS.imports
  )
    throw new ModuleError("LLM007", "program declaration count exceeds limit");

  const environments = new Map<
    string,
    {
      types: Map<string, CanonicalRecord>;
      functions: Map<string, string>;
    }
  >();
  for (const module of modules) {
    const localTypes = new Map<string, CanonicalRecord>();
    for (const [name, value] of typeTables.get(module.id) ?? [])
      localTypes.set(name, value.type);
    const localFunctions = new Map(
      module.source.functions.map((fn) => [fn.name, `${module.id}#${fn.name}`]),
    );
    for (const dependency of module.source.imports) {
      const targetId = resolveImportId(module.id, dependency.from);
      const target = byId.get(targetId);
      if (!target)
        throw new ModuleError(
          "LLM002",
          `unresolved module ${dependency.from}`,
          module.absolutePath,
        );
      for (const binding of dependency.bindings) {
        assertBindingName(binding.as, "import alias");
        if (localTypes.has(binding.as) || localFunctions.has(binding.as))
          throw new ModuleError(
            "LLM003",
            `duplicate binding ${binding.as}`,
            module.absolutePath,
          );
        if (binding.kind === "type") {
          const found = typeTables.get(targetId)?.get(binding.name);
          if (!found?.exported)
            throw new ModuleError(
              "LLM003",
              `type ${binding.name} is not exported by ${targetId}`,
              module.absolutePath,
            );
          localTypes.set(binding.as, found.type);
        } else {
          const symbol = `${targetId}#${binding.name}`;
          if (!functionDecls.has(symbol) || !functionExports.get(symbol))
            throw new ModuleError(
              "LLM003",
              `function ${binding.name} is not exported by ${targetId}`,
              module.absolutePath,
            );
          localFunctions.set(binding.as, symbol);
        }
      }
    }
    environments.set(module.id, {
      types: localTypes,
      functions: localFunctions,
    });
  }

  const signatures = new Map<string, CheckedParameter[]>();
  for (const module of modules) {
    const localTypes = environments.get(module.id)?.types;
    if (!localTypes)
      throw new ModuleError("LLM004", "missing module type environment");
    const resolveType = (value: ModuleTypeUse): ResolvedType => {
      if (value === "boolean") return { kind: "boolean" };
      const found =
        value && typeof value === "object"
          ? localTypes.get(value.ref)
          : undefined;
      if (!found)
        throw new ModuleError(
          "LLM004",
          `unknown type ${JSON.stringify(value)}`,
          module.absolutePath,
        );
      return found;
    };
    for (const fn of module.source.functions) {
      if (
        fn.parameters.length > MODULE_LIMITS.parameters ||
        fn.returns !== "boolean"
      )
        throw new ModuleError(
          "LLM005",
          `invalid signature for ${fn.name}`,
          module.absolutePath,
        );
      const parameters = fn.parameters.map((p) => {
        assertBindingName(p.name, "parameter");
        return { name: p.name, type: resolveType(p.type) };
      });
      if (new Set(parameters.map((p) => p.name)).size !== parameters.length)
        throw new ModuleError(
          "LLM003",
          `duplicate parameter in ${fn.name}`,
          module.absolutePath,
        );
      signatures.set(`${module.id}#${fn.name}`, parameters);
    }
  }

  const resolvedFunctions: CheckedFunction[] = [];
  for (const module of modules) {
    const localFunctions = environments.get(module.id)?.functions;
    if (!localFunctions)
      throw new ModuleError("LLM004", "missing module function environment");
    for (const fn of module.source.functions) {
      const symbol = `${module.id}#${fn.name}`,
        parameters = signatures.get(symbol);
      if (!parameters)
        throw new ModuleError(
          "LLM004",
          `missing signature for ${fn.name}`,
          module.absolutePath,
        );
      const stats = expressionStats(fn.body);
      if (
        stats.nodes > MODULE_LIMITS.expressionNodes ||
        stats.depth > MODULE_LIMITS.expressionDepth
      )
        throw new ModuleError(
          "LLM007",
          `expression limit exceeded in ${fn.name}`,
          module.absolutePath,
        );
      const params = new Map(parameters.map((p) => [p.name, p.type]));
      const callees: Record<string, string> = {};
      const infer = (expression: ModuleExpression): ResolvedType => {
        switch (expression.kind) {
          case "literal":
            if (typeof expression.value !== "boolean") break;
            else return { kind: "boolean" };
          case "param": {
            const type = params.get(expression.name);
            if (type) return type;
            break;
          }
          case "field": {
            const base = params.get(expression.base?.name);
            if (
              base?.kind === "record" &&
              base.fields.includes(expression.name)
            )
              return { kind: "boolean" };
            break;
          }
          case "not":
            if (infer(expression.condition).kind === "boolean")
              return { kind: "boolean" };
            break;
          case "all":
          case "any":
            if (
              expression.conditions.length >= 1 &&
              expression.conditions.length <= 64 &&
              expression.conditions.every((x) => infer(x).kind === "boolean")
            )
              return { kind: "boolean" };
            break;
          case "equals":
            if (
              infer(expression.left).kind === "boolean" &&
              infer(expression.right).kind === "boolean"
            )
              return { kind: "boolean" };
            break;
          case "call": {
            const targetSymbol = localFunctions.get(expression.callee),
              expected = targetSymbol
                ? signatures.get(targetSymbol)
                : undefined;
            if (!targetSymbol || !expected) break;
            if (
              expected.length !== expression.arguments.length ||
              !expected.every((parameter, i) =>
                sameType(
                  parameter.type,
                  infer(expression.arguments[i] as ModuleExpression),
                ),
              )
            )
              break;
            callees[expression.callee] = targetSymbol;
            return { kind: "boolean" };
          }
        }
        throw new ModuleError(
          "LLM004",
          `invalid expression in ${fn.name}`,
          module.absolutePath,
        );
      };
      if (infer(fn.body).kind !== "boolean")
        throw new ModuleError(
          "LLM004",
          `non-boolean body in ${fn.name}`,
          module.absolutePath,
        );
      resolvedFunctions.push({
        symbol,
        moduleId: module.id,
        name: fn.name,
        export: fn.export,
        parameters,
        body: fn.body,
        callees,
      });
    }
  }
  const bySymbol = new Map(resolvedFunctions.map((fn) => [fn.symbol, fn]));
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (symbol: string, trail: string[]) => {
    if (visiting.has(symbol))
      throw new ModuleError(
        "LLM006",
        `call cycle: ${[...trail, symbol].join(" -> ")}`,
      );
    if (visited.has(symbol)) return;
    visiting.add(symbol);
    for (const callee of Object.values(bySymbol.get(symbol)?.callees ?? {}))
      visit(callee, [...trail, symbol]);
    visiting.delete(symbol);
    visited.add(symbol);
  };
  for (const fn of resolvedFunctions) visit(fn.symbol, []);
  const depths = new Map<string, number>();
  const callDepth = (symbol: string): number => {
    const known = depths.get(symbol);
    if (known !== undefined) return known;
    const depth =
      1 +
      Math.max(
        0,
        ...Object.values(bySymbol.get(symbol)?.callees ?? {}).map(callDepth),
      );
    depths.set(symbol, depth);
    return depth;
  };
  for (const fn of resolvedFunctions)
    if (callDepth(fn.symbol) > MODULE_LIMITS.callDepth)
      throw new ModuleError("LLM007", "call depth exceeds limit");
  const entrySymbol = `${entryModuleId}#${entryName}`,
    entry = bySymbol.get(entrySymbol);
  if (
    !entry?.export ||
    entry.parameters.length !== 1 ||
    entry.parameters[0]?.type.kind !== "record"
  )
    throw new ModuleError(
      "LLM004",
      "entry must be an exported record-to-boolean function",
    );
  const semanticModules = modules.map((m) => ({
    id: m.id,
    imports: m.source.imports
      .flatMap((x) =>
        x.bindings.map((binding) => ({
          from: resolveImportId(m.id, x.from),
          ...binding,
        })),
      )
      .sort((a, b) =>
        `${a.from}\0${a.kind}\0${a.name}\0${a.as}`.localeCompare(
          `${b.from}\0${b.kind}\0${b.name}\0${b.as}`,
        ),
      ),
    types: m.source.types
      .map((t) => ({
        name: t.name,
        export: t.export,
        fields: t.fields.map((f) => f.name).sort(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    functions: resolvedFunctions
      .filter((f) => f.moduleId === m.id)
      .map((f) => ({
        name: f.name,
        export: f.export,
        parameters: f.parameters,
        body: f.body,
        callees: f.callees,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }));
  const interfaceValue = {
    entry: entrySymbol,
    fields: entry.parameters[0].type.fields,
  };
  return {
    profile: "module-bool-v1",
    entry: entrySymbol,
    entryModuleId,
    modules,
    functions: resolvedFunctions.sort((a, b) =>
      a.symbol.localeCompare(b.symbol),
    ),
    sourceSetHash: fingerprintFor(
      modules.map((m) => ({ path: m.relativePath, hash: m.sourceHash })),
    ),
    programHash: fingerprintFor({
      format: "llang-module-program",
      version: 1,
      modules: semanticModules,
      entry: entrySymbol,
    }),
    interfaceHash: fingerprintFor({
      format: "llang-module-interface",
      version: 1,
      ...interfaceValue,
    }),
  };
}

export function resolveImportId(
  fromModuleId: string,
  specifier: string,
): string {
  const from = fromModuleId.split("/");
  from.pop();
  for (const part of specifier
    .replace(/\.llang\.jsonc$|\.ts$/, "")
    .split("/")) {
    if (part === "." || !part) continue;
    if (part === "..") from.pop();
    else from.push(part);
  }
  return from.join("/");
}
