import { posix } from "node:path";
import { resolveImportId } from "./llang-module-ir";
import {
  canonicalValueType,
  type CheckedValueFunction,
  type CheckedValueProgram,
  type ValueExpression,
  type ValueModuleSource,
  type ValueType,
} from "./llang-module-value-ir";

function safe(value: string): string {
  return `_${Buffer.from(value).toString("hex")}`;
}
function emitType(type: ValueType): string {
  if (type.kind === "boolean") return "boolean";
  if (type.kind === "i32") return "number";
  if (type.kind === "string") return "string";
  if (type.kind === "record")
    return `{ ${type.fields.map((f) => `${JSON.stringify(f.name)}: ${emitType(f.type)}`).join("; ")} }`;
  return type.variants
    .map(
      (v) =>
        `{ tag: ${JSON.stringify(v.tag)}${v.fields.length ? "; " : ""}${v.fields.map((f) => `${JSON.stringify(f.name)}: ${emitType(f.type)}`).join("; ")} }`,
    )
    .join(" | ");
}
function emitExpression(
  expr: ValueExpression,
  fn: CheckedValueFunction,
  bound: Set<string>,
): string {
  const emit = (x: ValueExpression) => emitExpression(x, fn, bound),
    tick = (body: string) => `(tick(state), ${body})`;
  switch (expr.kind) {
    case "literal":
      return tick(JSON.stringify(expr.value));
    case "param":
    case "local":
      return tick(safe(`v:${expr.name}`));
    case "field":
      return tick(`${emit(expr.base)}[${JSON.stringify(expr.name)}]`);
    case "unary":
      return tick(
        expr.op === "not"
          ? `!(${emit(expr.operand)})`
          : `neg(${emit(expr.operand)})`,
      );
    case "binary": {
      if (["+", "-", "*", "/", "%"].includes(expr.op))
        return tick(
          `arith(${JSON.stringify(expr.op)}, ${emit(expr.left)}, ${emit(expr.right)})`,
        );
      return tick(`(${emit(expr.left)} ${expr.op} ${emit(expr.right)})`);
    }
    case "call": {
      const symbol = fn.callees[expr.callee];
      if (!symbol) throw new Error("unresolved value call");
      return tick(
        `${safe(symbol)}(state${expr.arguments.length ? ", " : ""}${expr.arguments.map(emit).join(", ")})`,
      );
    }
    case "intrinsic":
      return tick(
        expr.name === "concat"
          ? `concat(${emit(expr.arguments[0]!)}, ${emit(expr.arguments[1]!)})`
          : `scalarLength(${emit(expr.arguments[0]!)})`,
      );
    case "record":
      return tick(
        `({ ${expr.fields.map((f) => `${JSON.stringify(f.name)}: ${emit(f.value)}`).join(", ")} })`,
      );
    case "variant":
      return tick(
        `({ tag: ${JSON.stringify(expr.tag)}${expr.fields.length ? ", " : ""}${expr.fields.map((f) => `${JSON.stringify(f.name)}: ${emit(f.value)}`).join(", ")} })`,
      );
    case "block": {
      const next = new Set(bound),
        bindings = expr.bindings.map((binding) => {
          const value = emitExpression(binding.value, fn, next);
          next.add(binding.name);
          return `const ${safe(`v:${binding.name}`)} = ${value};`;
        }),
        result = emitExpression(expr.result, fn, next);
      return tick(`(() => { ${bindings.join(" ")} return ${result}; })()`);
    }
    case "if":
      return tick(
        `(${emit(expr.condition)} ? ${emit(expr.whenTrue)} : ${emit(expr.whenFalse)})`,
      );
    case "match": {
      const value = safe("match");
      return tick(
        `(() => { const ${value} = ${emit(expr.value)}; switch (${value}.tag) { ${expr.cases
          .map(
            (c) =>
              `case ${JSON.stringify(c.tag)}: { const { tag: _tag, ..._payload } = ${value}; return ((() => { ${Object.keys(
                collectFreeLocals(c.body, bound),
              )
                .map(
                  (name) =>
                    `const ${safe(`v:${name}`)} = (_payload as Record<string, unknown>)[${JSON.stringify(name)}] as never;`,
                )
                .join(
                  " ",
                )} return ${emitExpression(c.body, fn, new Set([...bound, ...Object.keys(collectFreeLocals(c.body, bound))]))}; })()); }`,
          )
          .join(
            " ",
          )} } throw new Error("INVALID_IR: non-exhaustive match"); })()`,
      );
    }
  }
}
function collectFreeLocals(
  expr: ValueExpression,
  bound: Set<string>,
  output: Record<string, true> = {},
): Record<string, true> {
  if (expr.kind === "local" && !bound.has(expr.name)) output[expr.name] = true;
  const visit = (x: ValueExpression, scope = bound) =>
    collectFreeLocals(x, scope, output);
  switch (expr.kind) {
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
    case "call":
    case "intrinsic":
      expr.arguments.forEach((argument) => {
        visit(argument);
      });
      break;
    case "record":
    case "variant":
      expr.fields.forEach((x) => {
        visit(x.value);
      });
      break;
    case "block":
      {
        const next = new Set(bound);
        for (const binding of expr.bindings) {
          visit(binding.value, next);
          next.add(binding.name);
        }
        visit(expr.result, next);
      }
      break;
    case "if":
      visit(expr.condition);
      visit(expr.whenTrue);
      visit(expr.whenFalse);
      break;
    case "match":
      visit(expr.value);
      break;
  }
  return output;
}

export function emitValueModuleTypeScript(
  program: CheckedValueProgram,
): string {
  const functions = program.functions
    .map(
      (fn) =>
        `function ${safe(fn.symbol)}(state: State${fn.parameters.length ? ", " : ""}${fn.parameters.map((p) => `${safe(`v:${p.name}`)}: ${emitType(p.type)}`).join(", ")}): ${emitType(fn.returns)} { return ${emitExpression(fn.body, fn, new Set(fn.parameters.map((p) => p.name)))}; }`,
    )
    .join("\n\n");
  const inputDescriptor = JSON.stringify(
      canonicalValueType(program.entryInput),
    ),
    outputDescriptor = JSON.stringify(canonicalValueType(program.entryOutput));
  return `// Generated by L-Lang module-value-v1. Do not edit.
type State = { fuel: number };
type Descriptor = "boolean" | "i32" | "string" | { kind: "record"; fields: { name: string; type: Descriptor }[] } | { kind: "union"; variants: { tag: string; fields: { name: string; type: Descriptor }[] }[] };
function fault(code: string, message: string): never { const error = new Error(code + ": " + message) as Error & { code: string }; error.code = code; throw error; }
function tick(state: State): void { if (--state.fuel < 0) fault("RESOURCE_LIMIT", "evaluation fuel exhausted"); }
function unicode(value: string): string { for (let i = 0; i < value.length; i++) { const u = value.charCodeAt(i); if (u >= 0xd800 && u <= 0xdbff) { const n = value.charCodeAt(++i); if (!(n >= 0xdc00 && n <= 0xdfff)) fault("INVALID_INPUT", "lone surrogate"); } else if (u >= 0xdc00 && u <= 0xdfff) fault("INVALID_INPUT", "lone surrogate"); } if (new TextEncoder().encode(value).byteLength > 16384) fault("RESOURCE_LIMIT", "string exceeds 16 KiB"); return value; }
function scalarLength(value: string): number { return [...value].length; }
function concat(left: string, right: string): string { return unicode(left + right); }
function arith(op: string, left: number, right: number): number { if ((op === "/" || op === "%") && right === 0) fault("DIVISION_BY_ZERO", "division by zero"); const a = BigInt(left), b = BigInt(right), value = op === "+" ? a+b : op === "-" ? a-b : op === "*" ? a*b : op === "/" ? a/b : a%b; if (value < -2147483648n || value > 2147483647n) fault("ARITHMETIC_OVERFLOW", "i32 result is out of range"); return Number(value); }
function neg(value: number): number { return arith("-", 0, value); }
function validate(type: Descriptor, value: unknown, path = "input"): unknown { if (type === "boolean") { if (typeof value !== "boolean") fault("INVALID_INPUT", path); return value; } if (type === "i32") { if (typeof value !== "number" || !Number.isInteger(value) || value < -2147483648 || value > 2147483647) fault("INVALID_INPUT", path); return Object.is(value, -0) ? 0 : value; } if (type === "string") { if (typeof value !== "string") fault("INVALID_INPUT", path); return unicode(value); } if (!value || typeof value !== "object" || Array.isArray(value) || Object.getOwnPropertySymbols(value).length) fault("INVALID_INPUT", path); const proto = Object.getPrototypeOf(value); if (proto !== Object.prototype && proto !== null) fault("INVALID_INPUT", path); const descriptors = Object.getOwnPropertyDescriptors(value), source = value as Record<string, unknown>; if (Object.values(descriptors).some((x) => !("value" in x))) fault("INVALID_INPUT", path); if (type.kind === "record") { if (Object.keys(descriptors).length !== type.fields.length || type.fields.some((x) => !Object.hasOwn(descriptors, x.name))) fault("INVALID_INPUT", path); return Object.fromEntries(type.fields.map((f) => [f.name, validate(f.type, source[f.name], path+"."+f.name)])); } const tag = source.tag, variant = type.variants.find((x) => x.tag === tag); if (!variant || Object.keys(descriptors).length !== variant.fields.length + 1) fault("INVALID_INPUT", path); return { tag, ...Object.fromEntries(variant.fields.map((f) => [f.name, validate(f.type, source[f.name], path+"."+f.name)])) }; }
${functions}
export type EntryInput = ${emitType(program.entryInput)};
export type EntryOutput = ${emitType(program.entryOutput)};
const inputType = ${inputDescriptor} as Descriptor, outputType = ${outputDescriptor} as Descriptor;
export function evaluate(input: EntryInput): EntryOutput { const normalized = validate(inputType, input) as EntryInput; return validate(outputType, ${safe(program.entry)}({ fuel: 100000 }, normalized), "output") as EntryOutput; }
`;
}

function generatedPath(id: string): string {
  return `${id}.llang.jsonc`;
}
function jsonExpression(expr: ValueExpression): unknown {
  switch (expr.kind) {
    case "literal":
    case "param":
    case "local":
      return expr;
    case "field":
      return { ...expr, base: jsonExpression(expr.base) };
    case "unary":
      return { ...expr, operand: jsonExpression(expr.operand) };
    case "binary":
      return {
        ...expr,
        left: jsonExpression(expr.left),
        right: jsonExpression(expr.right),
      };
    case "call":
    case "intrinsic":
      return { ...expr, arguments: expr.arguments.map(jsonExpression) };
    case "record":
    case "variant":
      return {
        ...expr,
        fields: expr.fields.map((field) => ({
          name: field.name,
          value: jsonExpression(field.value),
        })),
      };
    case "block":
      return {
        ...expr,
        bindings: expr.bindings.map((binding) => ({
          ...binding,
          value: jsonExpression(binding.value),
        })),
        result: jsonExpression(expr.result),
      };
    case "if":
      return Object.fromEntries([
        ["kind", "if"],
        ["condition", jsonExpression(expr.condition)],
        // biome-ignore lint/suspicious/noThenProperty: the public JSONC IR names this branch "then".
        ["then", jsonExpression(expr.whenTrue)],
        ["else", jsonExpression(expr.whenFalse)],
      ]);
    case "match":
      return {
        ...expr,
        value: jsonExpression(expr.value),
        cases: expr.cases.map((item) => ({
          tag: item.tag,
          body: jsonExpression(item.body),
        })),
      };
  }
}
export function emitValueModuleJsonc(
  program: CheckedValueProgram,
): Map<string, string> {
  const output = new Map<string, string>();
  for (const module of program.modules) {
    const imports: ValueModuleSource["imports"] = module.source.imports.map(
      (item) => {
        const target = resolveImportId(module.id, item.from);
        let from = posix.relative(
          posix.dirname(generatedPath(module.id)),
          generatedPath(target),
        );
        if (!from.startsWith(".")) from = `./${from}`;
        return { from, bindings: [...item.bindings] };
      },
    );
    const source = {
      ...module.source,
      imports,
      functions: module.source.functions.map((fn) => ({
        ...fn,
        body: jsonExpression(fn.body),
      })),
    };
    output.set(
      generatedPath(module.id),
      `${JSON.stringify(source, null, 2)}\n`,
    );
  }
  return output;
}
