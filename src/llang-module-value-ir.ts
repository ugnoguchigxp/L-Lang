import { fingerprintFor } from "./stable-hash";
import {
  MODULE_LIMITS,
  ModuleError,
  resolveImportId,
  type ModuleImport,
} from "./llang-module-ir";

export const VALUE_LIMITS = {
  expressionNodes: 1_024,
  expressionDepth: 64,
  locals: 64,
  typeDepth: 8,
  typeNodes: 4_096,
  stringBytes: 16 * 1024,
  payloadBytes: 64 * 1024,
  evaluationSteps: 100_000,
} as const;

export type ValuePrimitive = "boolean" | "i32" | "string";
export type ValueTypeUse = ValuePrimitive | { ref: string };
export type ValueRecordDeclaration = {
  name: string;
  export: boolean;
  kind: "record";
  fields: { name: string; type: ValueTypeUse }[];
};
export type ValueUnionDeclaration = {
  name: string;
  export: boolean;
  kind: "union";
  variants: { tag: string; fields: { name: string; type: ValueTypeUse }[] }[];
};
export type ValueTypeDeclaration =
  | ValueRecordDeclaration
  | ValueUnionDeclaration;
export type ValueBinding = {
  name: string;
  type: ValueTypeUse;
  value: ValueExpression;
};
export type ValueMatchCase = { tag: string; body: ValueExpression };
export type ValueExpression =
  | { kind: "literal"; type: ValuePrimitive; value: boolean | number | string }
  | { kind: "param" | "local"; name: string }
  | { kind: "field"; base: ValueExpression; name: string }
  | { kind: "unary"; op: "not" | "minus"; operand: ValueExpression }
  | {
      kind: "binary";
      op: string;
      left: ValueExpression;
      right: ValueExpression;
    }
  | { kind: "call"; callee: string; arguments: ValueExpression[] }
  | {
      kind: "intrinsic";
      name: "concat" | "scalarLength";
      arguments: ValueExpression[];
    }
  | {
      kind: "record";
      type: string;
      fields: { name: string; value: ValueExpression }[];
    }
  | {
      kind: "variant";
      type: string;
      tag: string;
      fields: { name: string; value: ValueExpression }[];
    }
  | { kind: "block"; bindings: ValueBinding[]; result: ValueExpression }
  | {
      kind: "if";
      condition: ValueExpression;
      whenTrue: ValueExpression;
      whenFalse: ValueExpression;
    }
  | { kind: "match"; value: ValueExpression; cases: ValueMatchCase[] };

export type ValueFunctionSource = {
  name: string;
  export: boolean;
  parameters: { name: string; type: ValueTypeUse }[];
  returns: ValueTypeUse;
  body: ValueExpression;
};
export type ValueModuleSource = {
  language: "l-lang";
  version: 3;
  kind: "module";
  profile: "module-value-v1";
  description?: string;
  imports: ModuleImport[];
  types: ValueTypeDeclaration[];
  functions: ValueFunctionSource[];
};
export type ValueModuleSnapshot = {
  id: string;
  absolutePath: string;
  realPath: string;
  rootPath: string;
  rootRealPath: string;
  relativePath: string;
  sourceHash: string;
  bytes: Uint8Array;
  text: string;
  source: ValueModuleSource;
};
export type ValueType =
  | { kind: "boolean" }
  | { kind: "i32" }
  | { kind: "string" }
  | {
      kind: "record";
      symbol: string;
      fields: { name: string; type: ValueType }[];
    }
  | {
      kind: "union";
      symbol: string;
      variants: { tag: string; fields: { name: string; type: ValueType }[] }[];
    };
export type CheckedValueExpression = ValueExpression & {
  checkedType?: ValueType;
};
export type CheckedValueFunction = {
  symbol: string;
  moduleId: string;
  name: string;
  export: boolean;
  parameters: { name: string; type: ValueType }[];
  returns: ValueType;
  body: ValueExpression;
  callees: Record<string, string>;
  typeBindings: Record<string, string>;
};
export type CheckedValueProgram = {
  profile: "module-value-v1";
  entry: string;
  entryModuleId: string;
  modules: ValueModuleSnapshot[];
  functions: CheckedValueFunction[];
  types: ValueType[];
  entryInput: ValueType;
  entryOutput: ValueType;
  programHash: string;
  interfaceHash: string;
  sourceSetHash: string;
  layoutHash: string;
};

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const TAG = /^[A-Za-z_][A-Za-z0-9_]*$/;
const primitive = (name: ValuePrimitive): ValueType => ({ kind: name });
const compareAscii = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

function assertStringLiteral(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new ModuleError(
          "LLV004",
          "string literal contains lone surrogate",
        );
    } else if (unit >= 0xdc00 && unit <= 0xdfff)
      throw new ModuleError("LLV004", "string literal contains lone surrogate");
  }
  if (new TextEncoder().encode(value).byteLength > VALUE_LIMITS.stringBytes)
    throw new ModuleError("LLV007", "string literal exceeds 16 KiB");
}

export function canonicalValueType(type: ValueType): unknown {
  if (type.kind === "boolean" || type.kind === "i32" || type.kind === "string")
    return type.kind;
  if (type.kind === "record")
    return {
      kind: "record",
      fields: type.fields.map((f) => ({
        name: f.name,
        type: canonicalValueType(f.type),
      })),
    };
  return {
    kind: "union",
    variants: type.variants.map((v) => ({
      tag: v.tag,
      fields: v.fields.map((f) => ({
        name: f.name,
        type: canonicalValueType(f.type),
      })),
    })),
  };
}
export function sameValueType(a: ValueType, b: ValueType): boolean {
  return (
    JSON.stringify(canonicalValueType(a)) ===
    JSON.stringify(canonicalValueType(b))
  );
}
function assertName(name: string, label: string): void {
  if (!IDENTIFIER.test(name) || name.length > 128)
    throw new ModuleError("LLV003", `invalid ${label} ${JSON.stringify(name)}`);
}
function assertUnique(names: string[], label: string): void {
  if (new Set(names).size !== names.length)
    throw new ModuleError("LLV003", `duplicate ${label}`);
}

export function checkValueProgram(
  modulesInput: ValueModuleSnapshot[],
  entryModuleId: string,
  entryName: string,
): CheckedValueProgram {
  const modules = [...modulesInput].sort((a, b) => compareAscii(a.id, b.id));
  if (!modules.length || modules.length > MODULE_LIMITS.modules)
    throw new ModuleError("LLV007", "module count exceeds limit");
  if (new Set(modules.map((m) => m.id.toLowerCase())).size !== modules.length)
    throw new ModuleError("LLV002", "logical module IDs collide by case");
  const byId = new Map(modules.map((m) => [m.id, m]));
  let importCount = 0;
  for (const mod of modules) {
    const moduleImports = mod.source.imports.reduce(
      (count, item) => count + item.bindings.length,
      0,
    );
    if (
      mod.source.types.length > MODULE_LIMITS.typesPerModule ||
      mod.source.functions.length > MODULE_LIMITS.functionsPerModule ||
      moduleImports > MODULE_LIMITS.importsPerModule
    )
      throw new ModuleError(
        "LLV007",
        "declaration count exceeds module limit",
        mod.absolutePath,
      );
    importCount += moduleImports;
  }
  if (
    modules.reduce((n, m) => n + m.source.functions.length, 0) >
      MODULE_LIMITS.functions ||
    modules.reduce((n, m) => n + m.source.types.length, 0) >
      MODULE_LIMITS.types ||
    importCount > MODULE_LIMITS.imports
  )
    throw new ModuleError("LLV007", "program declaration count exceeds limit");
  const imports = new Map<
    string,
    Map<string, { kind: "type" | "function"; symbol: string }>
  >();
  for (const mod of modules) {
    const names = [
      ...mod.source.types.map((x) => x.name),
      ...mod.source.functions.map((x) => x.name),
    ];
    names.forEach((x) => {
      assertName(x, "binding");
    });
    assertUnique(names, "binding");
    const table = new Map<
      string,
      { kind: "type" | "function"; symbol: string }
    >();
    for (const item of mod.source.imports)
      for (const binding of item.bindings) {
        assertName(binding.name, "imported binding");
        assertName(binding.as, "import");
        if (table.has(binding.as) || names.includes(binding.as))
          throw new ModuleError(
            "LLV003",
            `duplicate binding ${binding.as}`,
            mod.absolutePath,
          );
        const targetId = resolveImportId(mod.id, item.from),
          target = byId.get(targetId),
          exported =
            binding.kind === "type"
              ? target?.source.types.find((x) => x.name === binding.name)
                  ?.export
              : target?.source.functions.find((x) => x.name === binding.name)
                  ?.export;
        if (!exported)
          throw new ModuleError(
            "LLV003",
            `${binding.kind} ${binding.name} is not exported by ${targetId}`,
            mod.absolutePath,
          );
        table.set(binding.as, {
          kind: binding.kind,
          symbol: `${targetId}#${binding.name}`,
        });
      }
    imports.set(mod.id, table);
  }
  const typeDeclarations = new Map<string, ValueTypeDeclaration>();
  for (const mod of modules)
    for (const decl of mod.source.types)
      typeDeclarations.set(`${mod.id}#${decl.name}`, decl);
  const resolving = new Set<string>();
  const resolved = new Map<string, ValueType>();
  let expandedNodes = 0;
  const resolveNamed = (symbol: string, depth = 0): ValueType => {
    if (depth > VALUE_LIMITS.typeDepth)
      throw new ModuleError("LLV005", "type depth exceeds limit");
    const prior = resolved.get(symbol);
    if (prior) return prior;
    if (resolving.has(symbol))
      throw new ModuleError("LLV005", `recursive type ${symbol}`);
    const decl = typeDeclarations.get(symbol);
    if (!decl) throw new ModuleError("LLV005", `unknown type ${symbol}`);
    resolving.add(symbol);
    const moduleId = symbol.slice(0, symbol.lastIndexOf("#"));
    const fields = (items: { name: string; type: ValueTypeUse }[]) => {
      if (!items.length || items.length > 64)
        throw new ModuleError("LLV005", "invalid field count");
      assertUnique(
        items.map((x) => x.name),
        "field",
      );
      return [...items]
        .sort((a, b) => compareAscii(a.name, b.name))
        .map((f) => {
          assertName(f.name, "field");
          return {
            name: f.name,
            type: resolveUse(moduleId, f.type, depth + 1),
          };
        });
    };
    let result: ValueType;
    if (decl.kind === "record")
      result = { kind: "record", symbol, fields: fields(decl.fields) };
    else {
      if (decl.variants.length < 2 || decl.variants.length > 16)
        throw new ModuleError("LLV005", "union must have 2 to 16 variants");
      assertUnique(
        decl.variants.map((x) => x.tag),
        "tag",
      );
      result = {
        kind: "union",
        symbol,
        variants: [...decl.variants]
          .sort((a, b) => compareAscii(a.tag, b.tag))
          .map((v) => {
            if (!TAG.test(v.tag) || v.tag.length > 128)
              throw new ModuleError("LLV005", `invalid tag ${v.tag}`);
            return { tag: v.tag, fields: fields(v.fields) };
          }),
      };
    }
    resolving.delete(symbol);
    resolved.set(symbol, result);
    return result;
  };
  const resolveUse = (
    moduleId: string,
    use: ValueTypeUse,
    depth = 0,
  ): ValueType => {
    if (++expandedNodes > VALUE_LIMITS.typeNodes)
      throw new ModuleError("LLV005", "expanded type nodes exceed limit");
    if (typeof use === "string") return primitive(use);
    const imported = imports.get(moduleId)?.get(use.ref);
    const symbol =
      imported?.kind === "type" ? imported.symbol : `${moduleId}#${use.ref}`;
    return resolveNamed(symbol, depth);
  };
  const declarations = new Map<
    string,
    { moduleId: string; source: ValueFunctionSource; exported: boolean }
  >();
  for (const mod of modules)
    for (const fn of mod.source.functions)
      declarations.set(`${mod.id}#${fn.name}`, {
        moduleId: mod.id,
        source: fn,
        exported: fn.export,
      });
  const functions: CheckedValueFunction[] = [];
  for (const [symbol, decl] of declarations) {
    const fn = decl.source;
    if (fn.parameters.length > 8)
      throw new ModuleError("LLV006", "too many parameters");
    assertUnique(
      fn.parameters.map((x) => x.name),
      "parameter",
    );
    const parameters = fn.parameters.map((p) => ({
      name: p.name,
      type: resolveUse(decl.moduleId, p.type),
    }));
    const returns = resolveUse(decl.moduleId, fn.returns);
    const callees: Record<string, string> = {},
      typeBindings: Record<string, string> = {};
    for (const [name, item] of imports.get(decl.moduleId) ?? [])
      if (item.kind === "function") callees[name] = item.symbol;
      else typeBindings[name] = item.symbol;
    for (const local of modules.find((m) => m.id === decl.moduleId)?.source
      .types ?? [])
      typeBindings[local.name] = `${decl.moduleId}#${local.name}`;
    for (const local of modules.find((m) => m.id === decl.moduleId)?.source
      .functions ?? [])
      callees[local.name] = `${decl.moduleId}#${local.name}`;
    functions.push({
      symbol,
      moduleId: decl.moduleId,
      name: fn.name,
      export: fn.export,
      parameters,
      returns,
      body: fn.body,
      callees,
      typeBindings,
    });
  }
  const functionMap = new Map(functions.map((x) => [x.symbol, x]));
  const directCalls = (
    expr: ValueExpression,
    output = new Set<string>(),
  ): Set<string> => {
    const visit = (item: ValueExpression) => directCalls(item, output);
    switch (expr.kind) {
      case "call":
        output.add(expr.callee);
        expr.arguments.forEach((item) => {
          visit(item);
        });
        break;
      case "field":
        visit(expr.base);
        break;
      case "unary":
        visit(expr.operand);
        break;
      case "binary":
        visit(expr.left);
        visit(expr.right);
        break;
      case "intrinsic":
        expr.arguments.forEach((item) => {
          visit(item);
        });
        break;
      case "record":
      case "variant":
        expr.fields.forEach((field) => {
          visit(field.value);
        });
        break;
      case "block":
        expr.bindings.forEach((binding) => {
          visit(binding.value);
        });
        visit(expr.result);
        break;
      case "if":
        visit(expr.condition);
        visit(expr.whenTrue);
        visit(expr.whenFalse);
        break;
      case "match":
        visit(expr.value);
        expr.cases.forEach((item) => {
          visit(item.body);
        });
        break;
    }
    return output;
  };
  const activeFunctions = new Set<string>(),
    functionDepth = new Map<string, number>();
  const visitFunction = (symbol: string): number => {
    if (activeFunctions.has(symbol))
      throw new ModuleError("LLV006", `recursive call involving ${symbol}`);
    const prior = functionDepth.get(symbol);
    if (prior !== undefined) return prior;
    const fn = functionMap.get(symbol);
    if (!fn) throw new ModuleError("LLV004", `unknown function ${symbol}`);
    activeFunctions.add(symbol);
    let depth = 1;
    for (const name of directCalls(fn.body)) {
      const target = fn.callees[name];
      if (!target) throw new ModuleError("LLV004", `unknown call ${name}`);
      depth = Math.max(depth, 1 + visitFunction(target));
    }
    activeFunctions.delete(symbol);
    if (depth > 32) throw new ModuleError("LLV007", "call depth exceeds limit");
    functionDepth.set(symbol, depth);
    return depth;
  };
  functions.forEach((fn) => {
    visitFunction(fn.symbol);
  });
  const infer = (
    fn: CheckedValueFunction,
    expr: ValueExpression,
    env: Map<string, ValueType>,
    depth = 0,
    state = { nodes: 0 },
  ): ValueType => {
    if (
      ++state.nodes > VALUE_LIMITS.expressionNodes ||
      depth > VALUE_LIMITS.expressionDepth
    )
      throw new ModuleError("LLV007", "expression limit exceeded");
    const child = (x: ValueExpression, e = env) =>
      infer(fn, x, e, depth + 1, state);
    switch (expr.kind) {
      case "literal": {
        if (
          (expr.type === "boolean" && typeof expr.value !== "boolean") ||
          (expr.type === "string" && typeof expr.value !== "string") ||
          (expr.type === "i32" &&
            (!Number.isInteger(expr.value) ||
              Number(expr.value) < -2147483648 ||
              Number(expr.value) > 2147483647))
        )
          throw new ModuleError("LLV004", "invalid literal");
        if (expr.type === "string") assertStringLiteral(expr.value as string);
        return primitive(expr.type);
      }
      case "param":
      case "local": {
        const t = env.get(expr.name);
        if (!t) throw new ModuleError("LLV004", `unknown binding ${expr.name}`);
        return t;
      }
      case "field": {
        const base = child(expr.base);
        if (base.kind !== "record")
          throw new ModuleError("LLV004", "field base must be a record");
        const field = base.fields.find((f) => f.name === expr.name);
        if (!field)
          throw new ModuleError("LLV004", `invalid field ${expr.name}`);
        return field.type;
      }
      case "unary": {
        const value = child(expr.operand);
        const expected = expr.op === "not" ? "boolean" : "i32";
        if (value.kind !== expected)
          throw new ModuleError("LLV004", `invalid ${expr.op} operand`);
        return primitive(expected);
      }
      case "binary": {
        const l = child(expr.left),
          r = child(expr.right);
        if (!sameValueType(l, r))
          throw new ModuleError("LLV004", "binary operands differ");
        if (["+", "-", "*", "/", "%"].includes(expr.op)) {
          if (l.kind !== "i32")
            throw new ModuleError("LLV004", "arithmetic requires i32");
          return primitive("i32");
        }
        if (["<", "<=", ">", ">="].includes(expr.op)) {
          if (l.kind !== "i32")
            throw new ModuleError("LLV004", "ordering requires i32");
          return primitive("boolean");
        }
        if (["===", "!=="].includes(expr.op)) {
          if (!["boolean", "i32", "string"].includes(l.kind))
            throw new ModuleError("LLV004", "equality requires scalar values");
          return primitive("boolean");
        }
        if (["&&", "||"].includes(expr.op)) {
          if (l.kind !== "boolean")
            throw new ModuleError(
              "LLV004",
              "logical operator requires boolean",
            );
          return primitive("boolean");
        }
        throw new ModuleError("LLV004", `unknown operator ${expr.op}`);
      }
      case "call": {
        const target = functionMap.get(fn.callees[expr.callee] ?? "");
        if (!target || target.parameters.length !== expr.arguments.length)
          throw new ModuleError("LLV004", `invalid call ${expr.callee}`);
        expr.arguments.forEach((x, i) => {
          if (!sameValueType(child(x), target.parameters[i]!.type))
            throw new ModuleError("LLV004", "call argument type mismatch");
        });
        return target.returns;
      }
      case "intrinsic": {
        const args = expr.arguments.map((x) => child(x));
        if (
          expr.name === "concat" &&
          args.length === 2 &&
          args.every((x) => x.kind === "string")
        )
          return primitive("string");
        if (
          expr.name === "scalarLength" &&
          args.length === 1 &&
          args[0]?.kind === "string"
        )
          return primitive("i32");
        throw new ModuleError("LLV004", `invalid intrinsic ${expr.name}`);
      }
      case "record":
      case "variant": {
        const type = resolveUse(fn.moduleId, { ref: expr.type });
        if (expr.kind === "record") {
          if (type.kind !== "record")
            throw new ModuleError("LLV004", "constructor type mismatch");
          const expected = type.fields;
          assertUnique(
            expr.fields.map((x) => x.name),
            "constructor field",
          );
          if (expected.length !== expr.fields.length)
            throw new ModuleError("LLV004", "constructor fields differ");
          for (const field of expr.fields) {
            const target = expected.find((x) => x.name === field.name);
            if (!target || !sameValueType(child(field.value), target.type))
              throw new ModuleError(
                "LLV004",
                `invalid constructor field ${field.name}`,
              );
          }
          return type;
        }
        if (type.kind !== "union")
          throw new ModuleError("LLV004", "constructor type mismatch");
        const expected = type.variants.find((v) => v.tag === expr.tag)?.fields;
        if (!expected)
          throw new ModuleError("LLV004", `unknown variant ${expr.tag}`);
        assertUnique(
          expr.fields.map((x) => x.name),
          "constructor field",
        );
        if (expected.length !== expr.fields.length)
          throw new ModuleError("LLV004", "constructor fields differ");
        for (const field of expr.fields) {
          const target = expected.find((x) => x.name === field.name);
          if (!target || !sameValueType(child(field.value), target.type))
            throw new ModuleError(
              "LLV004",
              `invalid constructor field ${field.name}`,
            );
        }
        return type;
      }
      case "block": {
        if (expr.bindings.length > VALUE_LIMITS.locals)
          throw new ModuleError("LLV007", "local limit exceeded");
        const next = new Map(env);
        for (const binding of expr.bindings) {
          assertName(binding.name, "local");
          if (next.has(binding.name))
            throw new ModuleError("LLV004", `shadowing ${binding.name}`);
          const expected = resolveUse(fn.moduleId, binding.type),
            actual = infer(fn, binding.value, next, depth + 1, state);
          if (!sameValueType(expected, actual))
            throw new ModuleError(
              "LLV004",
              `local type mismatch ${binding.name}`,
            );
          next.set(binding.name, expected);
        }
        return infer(fn, expr.result, next, depth + 1, state);
      }
      case "if": {
        if (child(expr.condition).kind !== "boolean")
          throw new ModuleError("LLV004", "if condition must be boolean");
        const a = child(expr.whenTrue),
          b = child(expr.whenFalse);
        if (!sameValueType(a, b))
          throw new ModuleError("LLV004", "if branches differ");
        return a;
      }
      case "match": {
        const value = child(expr.value);
        if (value.kind !== "union")
          throw new ModuleError("LLV004", "match value must be union");
        assertUnique(
          expr.cases.map((x) => x.tag),
          "match case",
        );
        if (
          expr.cases.length !== value.variants.length ||
          value.variants.some((v) => !expr.cases.some((c) => c.tag === v.tag))
        )
          throw new ModuleError("LLV004", "match is not exhaustive");
        let result: ValueType | undefined;
        for (const item of expr.cases) {
          const variant = value.variants.find((x) => x.tag === item.tag)!;
          const next = new Map(env);
          for (const field of variant.fields) {
            if (next.has(field.name))
              throw new ModuleError(
                "LLV004",
                `match payload shadows ${field.name}`,
              );
            next.set(field.name, field.type);
          }
          const actual = infer(fn, item.body, next, depth + 1, state);
          if (result && !sameValueType(result, actual))
            throw new ModuleError("LLV004", "match cases differ");
          result = actual;
        }
        return result!;
      }
    }
  };
  for (const fn of functions) {
    const env = new Map(fn.parameters.map((x) => [x.name, x.type]));
    const actual = infer(fn, fn.body, env);
    if (!sameValueType(actual, fn.returns))
      throw new ModuleError("LLV004", `return type mismatch in ${fn.symbol}`);
  }
  const entry = functionMap.get(`${entryModuleId}#${entryName}`);
  if (
    !entry?.export ||
    entry.parameters.length !== 1 ||
    entry.parameters[0]?.type.kind !== "record"
  )
    throw new ModuleError(
      "LLV004",
      "entry must be an exported function with one record argument",
    );
  const canonicalExpression = (expr: ValueExpression): unknown => {
    switch (expr.kind) {
      case "param":
      case "local":
        return { kind: "binding", name: expr.name };
      case "field":
        return {
          kind: "field",
          base: canonicalExpression(expr.base),
          name: expr.name,
        };
      case "unary":
        return {
          kind: expr.kind,
          op: expr.op,
          operand: canonicalExpression(expr.operand),
        };
      case "binary":
        return {
          kind: expr.kind,
          op: expr.op,
          left: canonicalExpression(expr.left),
          right: canonicalExpression(expr.right),
        };
      case "call":
        return {
          kind: expr.kind,
          callee: expr.callee,
          arguments: expr.arguments.map(canonicalExpression),
        };
      case "intrinsic":
        return {
          kind: expr.kind,
          name: expr.name,
          arguments: expr.arguments.map(canonicalExpression),
        };
      case "record":
        return {
          kind: expr.kind,
          type: expr.type,
          fields: expr.fields.map((x) => ({
            name: x.name,
            value: canonicalExpression(x.value),
          })),
        };
      case "variant":
        return {
          kind: expr.kind,
          type: expr.type,
          tag: expr.tag,
          fields: expr.fields.map((x) => ({
            name: x.name,
            value: canonicalExpression(x.value),
          })),
        };
      case "block":
        return {
          kind: expr.kind,
          bindings: expr.bindings.map((x) => ({
            name: x.name,
            type: x.type,
            value: canonicalExpression(x.value),
          })),
          result: canonicalExpression(expr.result),
        };
      case "if":
        return {
          kind: expr.kind,
          condition: canonicalExpression(expr.condition),
          whenTrue: canonicalExpression(expr.whenTrue),
          whenFalse: canonicalExpression(expr.whenFalse),
        };
      case "match":
        return {
          kind: expr.kind,
          value: canonicalExpression(expr.value),
          cases: expr.cases.map((x) => ({
            tag: x.tag,
            body: canonicalExpression(x.body),
          })),
        };
      default:
        return expr;
    }
  };
  const sourceSetHash = fingerprintFor(
    modules.map((m) => ({ id: m.id, sourceHash: m.sourceHash })),
  );
  const programHash = fingerprintFor({
    profile: "module-value-v1",
    entry: entry.symbol,
    semantics: 1,
    types: [...resolved.entries()]
      .sort(([a], [b]) => compareAscii(a, b))
      .map(([symbol, type]) => ({ symbol, type: canonicalValueType(type) })),
    functions: functions.map((fn) => ({
      symbol: fn.symbol,
      parameters: fn.parameters.map((x) => ({
        name: x.name,
        type: canonicalValueType(x.type),
      })),
      returns: canonicalValueType(fn.returns),
      body: canonicalExpression(fn.body),
      callees: Object.fromEntries(
        Object.entries(fn.callees).sort(([a], [b]) => compareAscii(a, b)),
      ),
    })),
  });
  const interfaceHash = fingerprintFor({
    profile: "module-value-v1",
    input: canonicalValueType(entry.parameters[0].type),
    output: canonicalValueType(entry.returns),
  });
  const layoutHash = fingerprintFor({
    abi: "llang-value-memory-v1",
    input: canonicalValueType(entry.parameters[0].type),
    output: canonicalValueType(entry.returns),
    memoryPages: 16,
  });
  return {
    profile: "module-value-v1",
    entry: entry.symbol,
    entryModuleId,
    modules,
    functions: functions.sort((a, b) => compareAscii(a.symbol, b.symbol)),
    types: [...resolved.values()].sort((a, b) =>
      compareAscii(
        a.kind === "record" || a.kind === "union" ? a.symbol : a.kind,
        b.kind === "record" || b.kind === "union" ? b.symbol : b.kind,
      ),
    ),
    entryInput: entry.parameters[0].type,
    entryOutput: entry.returns,
    sourceSetHash,
    programHash,
    interfaceHash,
    layoutHash,
  };
}
