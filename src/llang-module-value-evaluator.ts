import { ModuleError } from "./llang-module-ir";
import {
  VALUE_LIMITS,
  type CheckedValueFunction,
  type CheckedValueProgram,
  type ValueExpression,
  type ValueType,
} from "./llang-module-value-ir";

export type ValueRuntime =
  | boolean
  | number
  | string
  | { [name: string]: ValueRuntime };
export type ValueFaultCode =
  | "ARITHMETIC_OVERFLOW"
  | "DIVISION_BY_ZERO"
  | "RESOURCE_LIMIT"
  | "INVALID_INPUT";
export class ValueFault extends Error {
  constructor(
    public readonly code: ValueFaultCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ValueFault";
  }
}
const utf8 = new TextEncoder();
export function assertUnicode(
  value: string,
  code: ValueFaultCode = "INVALID_INPUT",
): void {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new ValueFault(code, "lone surrogate");
    } else if (unit >= 0xdc00 && unit <= 0xdfff)
      throw new ValueFault(code, "lone surrogate");
  }
  if (utf8.encode(value).byteLength > VALUE_LIMITS.stringBytes)
    throw new ValueFault("RESOURCE_LIMIT", "string exceeds 16 KiB");
}
function dataRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
export function validateValue(
  type: ValueType,
  input: unknown,
  path = "input",
): ValueRuntime {
  if (type.kind === "boolean") {
    if (typeof input !== "boolean")
      throw new ValueFault("INVALID_INPUT", `${path} must be boolean`);
    return input;
  }
  if (type.kind === "i32") {
    if (
      typeof input !== "number" ||
      !Number.isInteger(input) ||
      input < -2147483648 ||
      input > 2147483647
    )
      throw new ValueFault("INVALID_INPUT", `${path} must be i32`);
    return Object.is(input, -0) ? 0 : input;
  }
  if (type.kind === "string") {
    if (typeof input !== "string")
      throw new ValueFault("INVALID_INPUT", `${path} must be string`);
    assertUnicode(input);
    return input;
  }
  if (!dataRecord(input) || Object.getOwnPropertySymbols(input).length)
    throw new ValueFault("INVALID_INPUT", `${path} must be a data record`);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.values(descriptors).some((x) => !("value" in x)))
    throw new ValueFault("INVALID_INPUT", `${path} accessors are forbidden`);
  if (type.kind === "record") {
    if (
      Object.keys(descriptors).length !== type.fields.length ||
      type.fields.some((x) => !Object.hasOwn(descriptors, x.name))
    )
      throw new ValueFault("INVALID_INPUT", `${path} fields differ`);
    return Object.fromEntries(
      type.fields.map((f) => [
        f.name,
        validateValue(f.type, descriptors[f.name]!.value, `${path}.${f.name}`),
      ]),
    );
  }
  const tag = descriptors.tag?.value;
  if (typeof tag !== "string")
    throw new ValueFault("INVALID_INPUT", `${path}.tag must be string`);
  const variant = type.variants.find((x) => x.tag === tag);
  if (
    !variant ||
    Object.keys(descriptors).length !== variant.fields.length + 1 ||
    variant.fields.some((x) => !Object.hasOwn(descriptors, x.name))
  )
    throw new ValueFault("INVALID_INPUT", `${path} variant fields differ`);
  return {
    tag,
    ...Object.fromEntries(
      variant.fields.map((f) => [
        f.name,
        validateValue(f.type, descriptors[f.name]!.value, `${path}.${f.name}`),
      ]),
    ),
  };
}
function i32(value: bigint): number {
  if (value < -2147483648n || value > 2147483647n)
    throw new ValueFault("ARITHMETIC_OVERFLOW", "i32 result is out of range");
  return Number(value);
}
function arithmetic(op: string, left: number, right: number): number {
  const a = BigInt(left),
    b = BigInt(right);
  if ((op === "/" || op === "%") && right === 0)
    throw new ValueFault("DIVISION_BY_ZERO", "division by zero");
  if (op === "+") return i32(a + b);
  if (op === "-") return i32(a - b);
  if (op === "*") return i32(a * b);
  if (op === "/") return i32(a / b);
  if (op === "%") return Number(a % b);
  throw new ModuleError("LLV004", `unknown arithmetic ${op}`);
}
export function evaluateValueProgram(
  program: CheckedValueProgram,
  input: unknown,
  stepBudget = VALUE_LIMITS.evaluationSteps,
): ValueRuntime {
  const functions = new Map(program.functions.map((x) => [x.symbol, x]));
  let steps = 0,
    logicalBytes = 0;
  const chargeValue = (value: ValueRuntime): ValueRuntime => {
    logicalBytes +=
      typeof value === "string"
        ? utf8.encode(value).byteLength
        : typeof value === "object"
          ? 4 * Object.keys(value).length
          : 4;
    if (logicalBytes > 1024 * 1024)
      throw new ValueFault("RESOURCE_LIMIT", "arena exhausted");
    return value;
  };
  const invoke = (
    fn: CheckedValueFunction,
    args: ValueRuntime[],
  ): ValueRuntime => {
    const env = new Map(fn.parameters.map((p, i) => [p.name, args[i]!]));
    const evaluate = (expr: ValueExpression, scope = env): ValueRuntime => {
      if (++steps > stepBudget)
        throw new ValueFault("RESOURCE_LIMIT", "evaluation fuel exhausted");
      switch (expr.kind) {
        case "literal":
          if (expr.type === "string")
            assertUnicode(expr.value as string, "INVALID_INPUT");
          return chargeValue(
            Object.is(expr.value, -0) ? 0 : (expr.value as ValueRuntime),
          );
        case "param":
        case "local": {
          if (!scope.has(expr.name))
            throw new ModuleError("LLV004", `unknown binding ${expr.name}`);
          return scope.get(expr.name)!;
        }
        case "field": {
          const base = evaluate(expr.base, scope);
          if (
            !base ||
            typeof base !== "object" ||
            !Object.hasOwn(base, expr.name)
          )
            throw new ModuleError("LLV004", `missing field ${expr.name}`);
          return base[expr.name]!;
        }
        case "unary": {
          const value = evaluate(expr.operand, scope);
          return expr.op === "not" ? !value : i32(-BigInt(value as number));
        }
        case "binary": {
          const left = evaluate(expr.left, scope);
          if (expr.op === "&&" && left === false) return false;
          if (expr.op === "||" && left === true) return true;
          const right = evaluate(expr.right, scope);
          if (["+", "-", "*", "/", "%"].includes(expr.op))
            return chargeValue(
              arithmetic(expr.op, left as number, right as number),
            );
          if (expr.op === "===") return left === right;
          if (expr.op === "!==") return left !== right;
          if (expr.op === "<") return (left as number) < (right as number);
          if (expr.op === "<=") return (left as number) <= (right as number);
          if (expr.op === ">") return (left as number) > (right as number);
          if (expr.op === ">=") return (left as number) >= (right as number);
          if (expr.op === "&&") return Boolean(right);
          if (expr.op === "||") return Boolean(right);
          throw new ModuleError("LLV004", `unknown operator ${expr.op}`);
        }
        case "call": {
          const target = functions.get(fn.callees[expr.callee] ?? "");
          if (!target)
            throw new ModuleError("LLV004", `unknown call ${expr.callee}`);
          const args: ValueRuntime[] = [];
          for (const arg of expr.arguments) args.push(evaluate(arg, scope));
          return invoke(target, args);
        }
        case "intrinsic": {
          if (expr.name === "scalarLength")
            return chargeValue(
              [...(evaluate(expr.arguments[0]!, scope) as string)].length,
            );
          const left = evaluate(expr.arguments[0]!, scope) as string,
            right = evaluate(expr.arguments[1]!, scope) as string,
            result = left + right;
          assertUnicode(result, "RESOURCE_LIMIT");
          return chargeValue(result);
        }
        case "record":
        case "variant": {
          const result: Record<string, ValueRuntime> =
            expr.kind === "variant" ? { tag: expr.tag } : {};
          for (const field of expr.fields)
            result[field.name] = evaluate(field.value, scope);
          return chargeValue(result);
        }
        case "block": {
          const next = new Map(scope);
          for (const binding of expr.bindings)
            next.set(binding.name, evaluate(binding.value, next));
          return evaluate(expr.result, next);
        }
        case "if":
          return evaluate(expr.condition, scope)
            ? evaluate(expr.whenTrue, scope)
            : evaluate(expr.whenFalse, scope);
        case "match": {
          const value = evaluate(expr.value, scope);
          if (
            !value ||
            typeof value !== "object" ||
            typeof value.tag !== "string"
          )
            throw new ModuleError("LLV004", "invalid match value");
          const item = expr.cases.find((x) => x.tag === value.tag);
          if (!item) throw new ModuleError("LLV004", "missing match case");
          const next = new Map(scope);
          for (const [name, field] of Object.entries(value))
            if (name !== "tag") next.set(name, field);
          return evaluate(item.body, next);
        }
      }
    };
    return evaluate(fn.body);
  };
  const entry = functions.get(program.entry);
  if (!entry) throw new ModuleError("LLV004", "entry not found");
  const normalized = validateValue(program.entryInput, input);
  const output = invoke(entry, [normalized]);
  return validateValue(program.entryOutput, output, "output");
}
