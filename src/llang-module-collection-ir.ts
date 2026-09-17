import { fingerprintFor } from "./stable-hash";
import {
  MODULE_LIMITS,
  ModuleError,
  resolveImportId,
  type ModuleImport,
} from "./llang-module-ir";

export const COLLECTION_LIMITS = {
  expressionNodes: 4096,
  expressionDepth: 64,
  typeDepth: 8,
  typeNodes: 4096,
  stringBytes: 16 * 1024,
  wireBytes: 256 * 1024,
  listElements: 4096,
  totalListElements: 16384,
  arenaBytes: 4 * 1024 * 1024,
  memoryPages: 128,
  fuel: 1_000_000,
  callDepth: 64,
  typeArguments: 8,
  captures: 16,
  instances: 1024,
  closures: 256,
} as const;

export type CollectionPrimitive = "boolean" | "i32" | "string";
export type CollectionTypeUse =
  | CollectionPrimitive
  | { ref: string; arguments?: CollectionTypeUse[] }
  | { list: CollectionTypeUse }
  | {
      function: { parameters: CollectionTypeUse[]; returns: CollectionTypeUse };
    };
export type CollectionTypeDeclaration = {
  name: string;
  export: boolean;
  typeParameters: string[];
} & (
  | { kind: "record"; fields: { name: string; type: CollectionTypeUse }[] }
  | {
      kind: "union";
      variants: {
        tag: string;
        fields: { name: string; type: CollectionTypeUse }[];
      }[];
    }
);
export type CollectionExpression =
  | {
      kind: "literal";
      type: CollectionPrimitive;
      value: boolean | number | string;
    }
  | {
      kind: "list";
      elementType: CollectionTypeUse;
      elements: CollectionExpression[];
    }
  | { kind: "param" | "local"; name: string }
  | { kind: "field"; base: CollectionExpression; name: string }
  | { kind: "unary"; op: "not" | "minus"; operand: CollectionExpression }
  | {
      kind: "binary";
      op: string;
      left: CollectionExpression;
      right: CollectionExpression;
    }
  | {
      kind: "call";
      callee: string;
      typeArguments: CollectionTypeUse[];
      arguments: CollectionExpression[];
    }
  | {
      kind: "invoke";
      callee: CollectionExpression;
      arguments: CollectionExpression[];
    }
  | {
      kind: "intrinsic";
      name: CollectionIntrinsic;
      typeArguments: CollectionTypeUse[];
      arguments: CollectionExpression[];
    }
  | {
      kind: "lambda";
      parameters: { name: string; type: CollectionTypeUse }[];
      returns: CollectionTypeUse;
      body: CollectionBody;
    }
  | {
      kind: "record";
      type: string;
      typeArguments: CollectionTypeUse[];
      fields: { name: string; value: CollectionExpression }[];
    }
  | {
      kind: "variant";
      type: string;
      typeArguments: CollectionTypeUse[];
      tag: string;
      fields: { name: string; value: CollectionExpression }[];
    }
  | {
      kind: "if";
      condition: CollectionExpression;
      whenTrue: CollectionExpression;
      whenFalse: CollectionExpression;
    };
export type CollectionIntrinsic =
  | "concat"
  | "scalarLength"
  | "length"
  | "at"
  | "set"
  | "append"
  | "map"
  | "filter"
  | "fold"
  | "stableSort";
export type CollectionStatement =
  | {
      kind: "const" | "let";
      name: string;
      type: CollectionTypeUse;
      value: CollectionExpression;
    }
  | { kind: "assign"; name: string; value: CollectionExpression }
  | {
      kind: "while";
      condition: CollectionExpression;
      body: CollectionStatement[];
    }
  | {
      kind: "forEach";
      name: string;
      type: CollectionTypeUse;
      value: CollectionExpression;
      body: CollectionStatement[];
    }
  | {
      kind: "if";
      condition: CollectionExpression;
      whenTrue: CollectionStatement[];
      whenFalse: CollectionStatement[];
    }
  | {
      kind: "match";
      value: CollectionExpression;
      cases: { tag: string; body: CollectionStatement[] }[];
    }
  | { kind: "break" | "continue" }
  | { kind: "return"; value: CollectionExpression };
export type CollectionBody = {
  statements: CollectionStatement[];
  result?: CollectionExpression;
};
export type CollectionFunctionSource = {
  name: string;
  export: boolean;
  typeParameters: string[];
  parameters: { name: string; type: CollectionTypeUse }[];
  returns: CollectionTypeUse;
  body: CollectionBody;
};
export type CollectionModuleSource = {
  language: "l-lang";
  version: 4;
  kind: "module";
  profile: "module-collection-v1";
  description?: string;
  imports: ModuleImport[];
  types: CollectionTypeDeclaration[];
  functions: CollectionFunctionSource[];
};
export type CollectionModuleSnapshot = {
  id: string;
  absolutePath: string;
  realPath: string;
  rootPath: string;
  rootRealPath: string;
  relativePath: string;
  sourceHash: string;
  bytes: Uint8Array;
  text: string;
  source: CollectionModuleSource;
};
export type CollectionType =
  | { kind: "boolean" }
  | { kind: "i32" }
  | { kind: "string" }
  | { kind: "parameter"; name: string }
  | { kind: "list"; element: CollectionType }
  | { kind: "function"; parameters: CollectionType[]; returns: CollectionType }
  | {
      kind: "record";
      symbol: string;
      arguments: CollectionType[];
      fields: { name: string; type: CollectionType }[];
    }
  | {
      kind: "union";
      symbol: string;
      arguments: CollectionType[];
      variants: {
        tag: string;
        fields: { name: string; type: CollectionType }[];
      }[];
    };
export type CheckedCollectionFunction = CollectionFunctionSource & {
  symbol: string;
  moduleId: string;
  parameterTypes: CollectionType[];
  returnType: CollectionType;
  callees: Record<string, string>;
  typeBindings: Record<string, string>;
};
export type CheckedCollectionProgram = {
  profile: "module-collection-v1";
  entry: string;
  entryModuleId: string;
  modules: CollectionModuleSnapshot[];
  functions: CheckedCollectionFunction[];
  entryInput: CollectionType;
  entryOutput: CollectionType;
  programHash: string;
  loweredHash: string;
  interfaceHash: string;
  sourceSetHash: string;
  layoutHash: string;
  instances: string[];
};

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const primitive = (kind: CollectionPrimitive): CollectionType => ({ kind });
const ascii = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const unique = (xs: string[], label: string) => {
  if (new Set(xs).size !== xs.length)
    throw new ModuleError("LLC003", `duplicate ${label}`);
};
const name = (x: string, label: string) => {
  if (!IDENTIFIER.test(x) || x.length > 128)
    throw new ModuleError("LLC003", `invalid ${label} ${JSON.stringify(x)}`);
};

export function canonicalCollectionType(type: CollectionType): unknown {
  if (type.kind === "boolean" || type.kind === "i32" || type.kind === "string")
    return type.kind;
  if (type.kind === "parameter") return { parameter: type.name };
  if (type.kind === "list")
    return { list: canonicalCollectionType(type.element) };
  if (type.kind === "function")
    return {
      function: {
        parameters: type.parameters.map(canonicalCollectionType),
        returns: canonicalCollectionType(type.returns),
      },
    };
  const common = {
    kind: type.kind,
    arguments: type.arguments.map(canonicalCollectionType),
  };
  return type.kind === "record"
    ? {
        ...common,
        fields: type.fields.map((f) => ({
          name: f.name,
          type: canonicalCollectionType(f.type),
        })),
      }
    : {
        ...common,
        variants: type.variants.map((v) => ({
          tag: v.tag,
          fields: v.fields.map((f) => ({
            name: f.name,
            type: canonicalCollectionType(f.type),
          })),
        })),
      };
}
export const sameCollectionType = (
  a: CollectionType,
  b: CollectionType,
): boolean =>
  JSON.stringify(canonicalCollectionType(a)) ===
  JSON.stringify(canonicalCollectionType(b));
export function containsFunctionType(type: CollectionType): boolean {
  if (type.kind === "function") return true;
  if (type.kind === "list") return containsFunctionType(type.element);
  if (type.kind === "record")
    return type.fields.some((f) => containsFunctionType(f.type));
  if (type.kind === "union")
    return type.variants.some((v) =>
      v.fields.some((f) => containsFunctionType(f.type)),
    );
  return false;
}

export function checkCollectionProgram(
  modulesInput: CollectionModuleSnapshot[],
  entryModuleId: string,
  entryName: string,
): CheckedCollectionProgram {
  const modules = [...modulesInput].sort((a, b) => ascii(a.id, b.id));
  if (!modules.length || modules.length > MODULE_LIMITS.modules)
    throw new ModuleError("LLC007", "module count exceeds limit");
  const byId = new Map(modules.map((m) => [m.id, m]));
  const imports = new Map<
    string,
    Map<string, { kind: "type" | "function"; symbol: string }>
  >();
  for (const mod of modules) {
    const locals = [
      ...mod.source.types.map((x) => x.name),
      ...mod.source.functions.map((x) => x.name),
    ];
    locals.forEach((x) => {
      name(x, "binding");
    });
    unique(locals, "binding");
    const table = new Map<
      string,
      { kind: "type" | "function"; symbol: string }
    >();
    for (const item of mod.source.imports)
      for (const binding of item.bindings) {
        const targetId = resolveImportId(mod.id, item.from),
          target = byId.get(targetId);
        const exported =
          binding.kind === "type"
            ? target?.source.types.find((x) => x.name === binding.name)?.export
            : target?.source.functions.find((x) => x.name === binding.name)
                ?.export;
        if (!exported)
          throw new ModuleError(
            "LLC003",
            `${binding.kind} ${binding.name} is not exported by ${targetId}`,
          );
        if (table.has(binding.as) || locals.includes(binding.as))
          throw new ModuleError("LLC003", `duplicate binding ${binding.as}`);
        table.set(binding.as, {
          kind: binding.kind,
          symbol: `${targetId}#${binding.name}`,
        });
      }
    imports.set(mod.id, table);
  }
  const typeDecls = new Map<string, CollectionTypeDeclaration>();
  for (const mod of modules)
    for (const decl of mod.source.types)
      typeDecls.set(`${mod.id}#${decl.name}`, decl);
  let typeNodes = 0;
  const resolving = new Set<string>();
  const resolveUse = (
    moduleId: string,
    use: CollectionTypeUse,
    params = new Map<string, CollectionType>(),
    depth = 0,
  ): CollectionType => {
    if (
      ++typeNodes > COLLECTION_LIMITS.typeNodes ||
      depth > COLLECTION_LIMITS.typeDepth
    )
      throw new ModuleError("LLC005", "type expansion exceeds limit");
    if (typeof use === "string") return primitive(use);
    if ("list" in use)
      return {
        kind: "list",
        element: resolveUse(moduleId, use.list, params, depth + 1),
      };
    if ("function" in use)
      return {
        kind: "function",
        parameters: use.function.parameters.map((x) =>
          resolveUse(moduleId, x, params, depth + 1),
        ),
        returns: resolveUse(moduleId, use.function.returns, params, depth + 1),
      };
    const parameter = params.get(use.ref);
    if (parameter) {
      if (use.arguments?.length)
        throw new ModuleError("LLC005", "type parameter cannot have arguments");
      return parameter;
    }
    const imported = imports.get(moduleId)?.get(use.ref),
      symbol =
        imported?.kind === "type" ? imported.symbol : `${moduleId}#${use.ref}`;
    const decl = typeDecls.get(symbol);
    if (!decl) throw new ModuleError("LLC005", `unknown type ${use.ref}`);
    const args = (use.arguments ?? []).map((x) =>
      resolveUse(moduleId, x, params, depth + 1),
    );
    if (args.length !== decl.typeParameters.length)
      throw new ModuleError(
        "LLC005",
        `type argument count mismatch for ${use.ref}`,
      );
    const key = `${symbol}<${args.map((x) => JSON.stringify(canonicalCollectionType(x))).join(",")}>`;
    if (resolving.has(key))
      throw new ModuleError("LLC005", `recursive type ${symbol}`);
    resolving.add(key);
    const local = new Map<string, CollectionType>();
    decl.typeParameters.forEach((parameter, index) => {
      const argument = args[index];
      if (!argument) throw new ModuleError("LLC005", "missing type argument");
      local.set(parameter, argument);
    });
    const fields = (items: { name: string; type: CollectionTypeUse }[]) => {
      unique(
        items.map((x) => x.name),
        "field",
      );
      return [...items]
        .sort((a, b) => ascii(a.name, b.name))
        .map((f) => ({
          name: f.name,
          type: resolveUse(
            symbol.slice(0, symbol.lastIndexOf("#")),
            f.type,
            local,
            depth + 1,
          ),
        }));
    };
    const result: CollectionType =
      decl.kind === "record"
        ? {
            kind: "record",
            symbol,
            arguments: args,
            fields: fields(decl.fields),
          }
        : {
            kind: "union",
            symbol,
            arguments: args,
            variants: [...decl.variants]
              .sort((a, b) => ascii(a.tag, b.tag))
              .map((v) => ({ tag: v.tag, fields: fields(v.fields) })),
          };
    resolving.delete(key);
    return result;
  };
  const functions: CheckedCollectionFunction[] = [];
  for (const mod of modules)
    for (const fn of mod.source.functions) {
      unique(fn.typeParameters, "type parameter");
      fn.typeParameters.forEach((x) => {
        name(x, "type parameter");
      });
      if (fn.typeParameters.length > COLLECTION_LIMITS.typeArguments)
        throw new ModuleError("LLC007", "too many type parameters");
      const params = new Map(
        fn.typeParameters.map((x) => [
          x,
          { kind: "parameter", name: x } as CollectionType,
        ]),
      );
      const callees: Record<string, string> = {},
        typeBindings: Record<string, string> = {};
      for (const [n, item] of imports.get(mod.id) ?? [])
        (item.kind === "function" ? callees : typeBindings)[n] = item.symbol;
      mod.source.functions.forEach((x) => {
        callees[x.name] = `${mod.id}#${x.name}`;
      });
      mod.source.types.forEach((x) => {
        typeBindings[x.name] = `${mod.id}#${x.name}`;
      });
      functions.push({
        ...fn,
        symbol: `${mod.id}#${fn.name}`,
        moduleId: mod.id,
        parameterTypes: fn.parameters.map((p) =>
          resolveUse(mod.id, p.type, params),
        ),
        returnType: resolveUse(mod.id, fn.returns, params),
        callees,
        typeBindings,
      });
    }
  const functionMap = new Map(functions.map((x) => [x.symbol, x]));
  const callNames = (
    value: unknown,
    output = new Set<string>(),
  ): Set<string> => {
    if (!value || typeof value !== "object") return output;
    const item = value as Record<string, unknown>;
    if (item.kind === "call" && typeof item.callee === "string")
      output.add(item.callee);
    Object.values(item).forEach((x) => {
      callNames(x, output);
    });
    return output;
  };
  const callGraph = new Map(
    functions.map((fn) => [
      fn.symbol,
      [...callNames(fn.body)]
        .map((x) => fn.callees[x])
        .filter((x): x is string => Boolean(x)),
    ]),
  );
  const reaches = (
    from: string,
    target: string,
    seen = new Set<string>(),
  ): boolean => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (callGraph.get(from) ?? []).some((next) =>
      reaches(next, target, seen),
    );
  };
  const instances = new Set<string>();
  let closureCount = 0;
  type Binding = {
    type: CollectionType;
    mutable: boolean;
    capturable: boolean;
  };
  const substitute = (
    t: CollectionType,
    map: Map<string, CollectionType>,
  ): CollectionType => {
    if (t.kind === "parameter") return map.get(t.name) ?? t;
    if (t.kind === "list")
      return { kind: "list", element: substitute(t.element, map) };
    if (t.kind === "function")
      return {
        kind: "function",
        parameters: t.parameters.map((x) => substitute(x, map)),
        returns: substitute(t.returns, map),
      };
    if (t.kind === "record")
      return {
        ...t,
        arguments: t.arguments.map((x) => substitute(x, map)),
        fields: t.fields.map((f) => ({ ...f, type: substitute(f.type, map) })),
      };
    if (t.kind === "union")
      return {
        ...t,
        arguments: t.arguments.map((x) => substitute(x, map)),
        variants: t.variants.map((v) => ({
          ...v,
          fields: v.fields.map((f) => ({
            ...f,
            type: substitute(f.type, map),
          })),
        })),
      };
    return t;
  };
  const checkFunction = (fn: CheckedCollectionFunction): void => {
    const typeParams = new Map(
      fn.typeParameters.map((x) => [
        x,
        { kind: "parameter", name: x } as CollectionType,
      ]),
    );
    const base = new Map<string, Binding>();
    fn.parameters.forEach((p, i) => {
      name(p.name, "parameter");
      if (base.has(p.name))
        throw new ModuleError("LLC003", `duplicate parameter ${p.name}`);
      const parameterType = fn.parameterTypes[i];
      if (!parameterType)
        throw new ModuleError("LLC004", "missing parameter type");
      base.set(p.name, {
        type: parameterType,
        mutable: false,
        capturable: true,
      });
    });
    let nodes = 0;
    const infer = (
      expr: CollectionExpression,
      env: Map<string, Binding>,
      depth = 0,
    ): CollectionType => {
      if (
        ++nodes > COLLECTION_LIMITS.expressionNodes ||
        depth > COLLECTION_LIMITS.expressionDepth
      )
        throw new ModuleError("LLC007", "expression limit exceeded");
      const child = (x: CollectionExpression, e = env) =>
        infer(x, e, depth + 1);
      if (expr.kind === "literal") {
        if (
          expr.type === "i32" &&
          (!Number.isInteger(expr.value) ||
            Number(expr.value) < -2147483648 ||
            Number(expr.value) > 2147483647)
        )
          throw new ModuleError("LLC004", "invalid i32 literal");
        if (
          expr.type === "string" &&
          new TextEncoder().encode(String(expr.value)).length >
            COLLECTION_LIMITS.stringBytes
        )
          throw new ModuleError("LLC007", "string literal exceeds limit");
        if (typeof expr.value !== (expr.type === "i32" ? "number" : expr.type))
          throw new ModuleError("LLC004", "literal type mismatch");
        return primitive(expr.type);
      }
      if (expr.kind === "param" || expr.kind === "local") {
        const b = env.get(expr.name);
        if (!b) throw new ModuleError("LLC004", `unknown binding ${expr.name}`);
        return b.type;
      }
      if (expr.kind === "list") {
        const element = resolveUse(fn.moduleId, expr.elementType, typeParams);
        if (containsFunctionType(element))
          throw new ModuleError(
            "LLC005",
            "function values cannot be stored in List",
          );
        if (expr.elements.length > COLLECTION_LIMITS.listElements)
          throw new ModuleError("LLC007", "List exceeds element limit");
        expr.elements.forEach((x) => {
          if (!sameCollectionType(child(x), element))
            throw new ModuleError("LLC004", "List element type mismatch");
        });
        return { kind: "list", element };
      }
      if (expr.kind === "field") {
        const b = child(expr.base);
        if (b.kind !== "record")
          throw new ModuleError("LLC004", "field base must be record");
        const f = b.fields.find((x) => x.name === expr.name);
        if (!f) throw new ModuleError("LLC004", `unknown field ${expr.name}`);
        return f.type;
      }
      if (expr.kind === "unary") {
        const t = child(expr.operand),
          k = expr.op === "not" ? "boolean" : "i32";
        if (t.kind !== k)
          throw new ModuleError("LLC004", "unary operand mismatch");
        return primitive(k);
      }
      if (expr.kind === "binary") {
        const a = child(expr.left),
          b = child(expr.right);
        if (!sameCollectionType(a, b))
          throw new ModuleError("LLC004", "binary operands differ");
        if (["+", "-", "*", "/", "%"].includes(expr.op)) {
          if (a.kind !== "i32")
            throw new ModuleError("LLC004", "arithmetic requires i32");
          return primitive("i32");
        }
        if (["<", "<=", ">", ">="].includes(expr.op)) {
          if (a.kind !== "i32")
            throw new ModuleError("LLC004", "ordering requires i32");
          return primitive("boolean");
        }
        if (["===", "!=="].includes(expr.op)) {
          if (!["boolean", "i32", "string"].includes(a.kind))
            throw new ModuleError("LLC004", "equality requires scalar");
          return primitive("boolean");
        }
        if (["&&", "||"].includes(expr.op)) {
          if (a.kind !== "boolean")
            throw new ModuleError("LLC004", "logic requires boolean");
          return primitive("boolean");
        }
        throw new ModuleError("LLC004", `unknown operator ${expr.op}`);
      }
      if (expr.kind === "if") {
        if (child(expr.condition).kind !== "boolean")
          throw new ModuleError("LLC004", "if condition must be boolean");
        const a = child(expr.whenTrue),
          b = child(expr.whenFalse);
        if (!sameCollectionType(a, b))
          throw new ModuleError("LLC004", "if branches differ");
        return a;
      }
      if (expr.kind === "call") {
        const target = functionMap.get(fn.callees[expr.callee] ?? "");
        if (!target)
          throw new ModuleError("LLC004", `unknown call ${expr.callee}`);
        if (expr.typeArguments.length !== target.typeParameters.length)
          throw new ModuleError(
            "LLC004",
            `explicit type arguments required for ${expr.callee}`,
          );
        const args = expr.typeArguments.map((x) =>
          resolveUse(fn.moduleId, x, typeParams),
        );
        if (target.typeParameters.length && reaches(target.symbol, fn.symbol)) {
          if (
            fn.typeParameters.length !== target.typeParameters.length ||
            args.some(
              (arg, i) =>
                arg.kind !== "parameter" || arg.name !== fn.typeParameters[i],
            )
          )
            throw new ModuleError(
              "LLC006",
              "polymorphic recursion is unsupported",
            );
        }
        const substitutions = new Map<string, CollectionType>();
        target.typeParameters.forEach((parameter, index) => {
          const argument = args[index];
          if (!argument)
            throw new ModuleError("LLC004", "missing call type argument");
          substitutions.set(parameter, argument);
        });
        const ps = target.parameterTypes.map((x) =>
          substitute(x, substitutions),
        );
        if (ps.length !== expr.arguments.length)
          throw new ModuleError("LLC004", "call arity mismatch");
        expr.arguments.forEach((x, i) => {
          const expected = ps[i];
          if (!expected || !sameCollectionType(child(x), expected))
            throw new ModuleError("LLC004", "call argument type mismatch");
        });
        const key = `${target.symbol}<${args.map((x) => JSON.stringify(canonicalCollectionType(x))).join(",")}>`;
        instances.add(key);
        if (instances.size > COLLECTION_LIMITS.instances)
          throw new ModuleError("LLC007", "monomorphization limit exceeded");
        return substitute(target.returnType, substitutions);
      }
      if (expr.kind === "invoke") {
        const c = child(expr.callee);
        if (
          c.kind !== "function" ||
          c.parameters.length !== expr.arguments.length
        )
          throw new ModuleError("LLC004", "invalid function invocation");
        expr.arguments.forEach((x, i) => {
          const expected = c.parameters[i];
          if (!expected || !sameCollectionType(child(x), expected))
            throw new ModuleError("LLC004", "callback argument mismatch");
        });
        return c.returns;
      }
      if (expr.kind === "lambda") {
        if (++closureCount > COLLECTION_LIMITS.closures)
          throw new ModuleError("LLC007", "closure definition limit exceeded");
        const lambdaEnv = new Map(env),
          own = new Set<string>();
        expr.parameters.forEach((p) => {
          const t = resolveUse(fn.moduleId, p.type, typeParams);
          own.add(p.name);
          lambdaEnv.set(p.name, { type: t, mutable: false, capturable: true });
        });
        const refs = new Set<string>();
        const scan = (value: unknown): void => {
          if (!value || typeof value !== "object") return;
          const x = value as Record<string, unknown>;
          if (
            (x.kind === "local" || x.kind === "param") &&
            typeof x.name === "string" &&
            !own.has(x.name)
          )
            refs.add(x.name);
          Object.values(x).forEach(scan);
        };
        scan(expr.body);
        for (const ref of refs) {
          const b = env.get(ref);
          if (!b?.capturable || b.mutable)
            throw new ModuleError(
              "LLC004",
              `lambda cannot capture mutable binding ${ref}`,
            );
        }
        if (refs.size > COLLECTION_LIMITS.captures)
          throw new ModuleError("LLC007", "capture limit exceeded");
        const returns = resolveUse(fn.moduleId, expr.returns, typeParams);
        checkBody(expr.body, lambdaEnv, returns, 0);
        return {
          kind: "function",
          parameters: expr.parameters.map((p) =>
            resolveUse(fn.moduleId, p.type, typeParams),
          ),
          returns,
        };
      }
      if (expr.kind === "record" || expr.kind === "variant") {
        const t = resolveUse(
          fn.moduleId,
          { ref: expr.type, arguments: expr.typeArguments },
          typeParams,
        );
        const expected =
          t.kind === "record"
            ? t.fields
            : t.kind === "union"
              ? t.variants.find(
                  (v) => v.tag === (expr.kind === "variant" ? expr.tag : ""),
                )?.fields
              : undefined;
        if (!expected || expected.length !== expr.fields.length)
          throw new ModuleError("LLC004", "invalid constructor");
        for (const f of expected) {
          const actual = expr.fields.find((x) => x.name === f.name);
          if (!actual || !sameCollectionType(child(actual.value), f.type))
            throw new ModuleError(
              "LLC004",
              `constructor field mismatch ${f.name}`,
            );
        }
        return t;
      }
      if (expr.kind !== "intrinsic")
        throw new ModuleError("LLC004", "invalid expression");
      const args = expr.arguments.map((x) => child(x));
      const list = (i: number) => {
        const t = args[i];
        if (t?.kind !== "list")
          throw new ModuleError("LLC004", `${expr.name} requires List`);
        return t;
      };
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
      if (expr.name === "length" && args.length === 1) {
        list(0);
        return primitive("i32");
      }
      if (expr.name === "at" && args.length === 2 && args[1]?.kind === "i32")
        return list(0).element;
      if (
        (expr.name === "set" || expr.name === "append") &&
        args.length === (expr.name === "set" ? 3 : 2)
      ) {
        const l = list(0),
          value = args.at(-1);
        if (
          value &&
          (expr.name !== "set" || args[1]?.kind === "i32") &&
          sameCollectionType(l.element, value)
        )
          return l;
      }
      if (
        (expr.name === "map" || expr.name === "filter") &&
        args.length === 2
      ) {
        const l = list(0),
          cb = args[1],
          parameter = cb?.kind === "function" ? cb.parameters[0] : undefined;
        if (
          cb?.kind === "function" &&
          cb.parameters.length === 1 &&
          parameter &&
          sameCollectionType(parameter, l.element)
        ) {
          if (expr.name === "filter" && cb.returns.kind !== "boolean")
            throw new ModuleError(
              "LLC004",
              "filter callback must return boolean",
            );
          return expr.name === "filter"
            ? l
            : { kind: "list", element: cb.returns };
        }
      }
      if (expr.name === "fold" && args.length === 3) {
        const l = list(0),
          init = args[1],
          cb = args[2],
          first = cb?.kind === "function" ? cb.parameters[0] : undefined,
          second = cb?.kind === "function" ? cb.parameters[1] : undefined;
        if (
          init &&
          cb?.kind === "function" &&
          cb.parameters.length === 2 &&
          first &&
          second &&
          sameCollectionType(first, init) &&
          sameCollectionType(second, l.element) &&
          sameCollectionType(cb.returns, init)
        )
          return init;
      }
      if (expr.name === "stableSort" && args.length === 2) {
        const l = list(0),
          cb = args[1];
        if (
          cb?.kind === "function" &&
          cb.parameters.length === 2 &&
          cb.returns.kind === "i32" &&
          cb.parameters.every((x) => sameCollectionType(x, l.element))
        )
          return l;
      }
      throw new ModuleError("LLC004", `invalid intrinsic ${expr.name}`);
    };
    const checkStatements = (
      statements: CollectionStatement[],
      env: Map<string, Binding>,
      returns: CollectionType,
      loopDepth: number,
    ): boolean => {
      let terminated = false;
      for (const s of statements) {
        if (terminated)
          throw new ModuleError("LLC004", "unreachable statement");
        if (s.kind === "const" || s.kind === "let") {
          name(s.name, "local");
          if (env.has(s.name))
            throw new ModuleError("LLC003", `shadowing ${s.name}`);
          const t = resolveUse(fn.moduleId, s.type, typeParams);
          if (!sameCollectionType(infer(s.value, env), t))
            throw new ModuleError("LLC004", "binding type mismatch");
          env.set(s.name, {
            type: t,
            mutable: s.kind === "let",
            capturable: s.kind === "const",
          });
        } else if (s.kind === "assign") {
          const b = env.get(s.name);
          if (!b?.mutable)
            throw new ModuleError(
              "LLC004",
              `assignment requires let ${s.name}`,
            );
          if (!sameCollectionType(infer(s.value, env), b.type))
            throw new ModuleError("LLC004", "assignment type mismatch");
        } else if (s.kind === "while") {
          if (infer(s.condition, env).kind !== "boolean")
            throw new ModuleError("LLC004", "while condition must be boolean");
          checkStatements(s.body, new Map(env), returns, loopDepth + 1);
        } else if (s.kind === "forEach") {
          const value = infer(s.value, env),
            declared = resolveUse(fn.moduleId, s.type, typeParams);
          if (
            value.kind !== "list" ||
            !sameCollectionType(value.element, declared)
          )
            throw new ModuleError("LLC004", "for-of type mismatch");
          const nested = new Map(env);
          if (nested.has(s.name))
            throw new ModuleError("LLC003", `shadowing ${s.name}`);
          nested.set(s.name, {
            type: declared,
            mutable: false,
            capturable: false,
          });
          checkStatements(s.body, nested, returns, loopDepth + 1);
        } else if (s.kind === "if") {
          if (infer(s.condition, env).kind !== "boolean")
            throw new ModuleError("LLC004", "if condition must be boolean");
          const a = checkStatements(
              s.whenTrue,
              new Map(env),
              returns,
              loopDepth,
            ),
            b = checkStatements(s.whenFalse, new Map(env), returns, loopDepth);
          terminated = a && b;
        } else if (s.kind === "match") {
          const value = infer(s.value, env);
          if (value.kind !== "union")
            throw new ModuleError("LLC004", "match requires union");
          unique(
            s.cases.map((item) => item.tag),
            "match tag",
          );
          if (
            s.cases.length !== value.variants.length ||
            value.variants.some(
              (variant) => !s.cases.some((item) => item.tag === variant.tag),
            )
          )
            throw new ModuleError("LLC004", "match must be exhaustive");
          terminated = s.cases.every((item) =>
            checkStatements(item.body, new Map(env), returns, loopDepth),
          );
        } else if (s.kind === "break" || s.kind === "continue") {
          if (!loopDepth)
            throw new ModuleError("LLC004", `${s.kind} outside loop`);
          terminated = true;
        } else if (s.kind === "return") {
          if (!sameCollectionType(infer(s.value, env), returns))
            throw new ModuleError("LLC004", "return type mismatch");
          terminated = true;
        }
      }
      return terminated;
    };
    const checkBody = (
      body: CollectionBody,
      env: Map<string, Binding>,
      returns: CollectionType,
      loopDepth: number,
    ): void => {
      const terminated = checkStatements(
        body.statements,
        env,
        returns,
        loopDepth,
      );
      if (body.result) {
        if (terminated)
          throw new ModuleError("LLC004", "result after terminator");
        if (!sameCollectionType(infer(body.result, env), returns))
          throw new ModuleError("LLC004", "result type mismatch");
      } else if (!terminated)
        throw new ModuleError(
          "LLC004",
          "function does not return on all paths",
        );
    };
    checkBody(fn.body, base, fn.returnType, 0);
  };
  functions.forEach(checkFunction);
  const entry = functionMap.get(`${entryModuleId}#${entryName}`);
  if (
    !entry?.export ||
    entry.typeParameters.length ||
    entry.parameterTypes.length !== 1
  )
    throw new ModuleError(
      "LLC006",
      "entry must be exported, non-generic and unary",
    );
  const entryInput = entry.parameterTypes[0];
  if (!entryInput) throw new ModuleError("LLC006", "entry input type missing");
  if (
    containsFunctionType(entryInput) ||
    containsFunctionType(entry.returnType)
  )
    throw new ModuleError(
      "LLC006",
      "entry wire type cannot contain function values",
    );
  const sourceSetHash = fingerprintFor(
    modules.map((m) => ({ id: m.id, hash: m.sourceHash })),
  );
  const programHash = fingerprintFor({
    profile: "module-collection-v1",
    entry: entry.symbol,
    modules: modules.map((m) => ({
      id: m.id,
      source: {
        ...m.source,
        description: undefined,
        imports: m.source.imports.map((x) => ({
          ...x,
          from: x.from.replace(/\.ts$/, ".llang.jsonc"),
        })),
      },
    })),
  });
  const sortedInstances = [...instances].sort(ascii),
    loweredHash = fingerprintFor({
      programHash,
      instances: sortedInstances,
      closureConversion: 1,
    });
  const interfaceHash = fingerprintFor({
    profile: "module-collection-v1",
    input: canonicalCollectionType(entryInput),
    output: canonicalCollectionType(entry.returnType),
  });
  const layoutHash = fingerprintFor({
    abi: "llang-collection-memory-v1",
    input: canonicalCollectionType(entryInput),
    output: canonicalCollectionType(entry.returnType),
  });
  return {
    profile: "module-collection-v1",
    entry: entry.symbol,
    entryModuleId,
    modules,
    functions,
    entryInput,
    entryOutput: entry.returnType,
    programHash,
    loweredHash,
    interfaceHash,
    sourceSetHash,
    layoutHash,
    instances: sortedInstances,
  };
}
