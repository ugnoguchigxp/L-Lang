import type {
  ValueExpression,
  ValueModuleSource,
} from "./llang-module-value-ir";
import {
  assertFiveValueDifferentialLanes,
  runValueDifferentialLanes,
  sameValueDifferentialOutcome,
  VALUE_DIFFERENTIAL_LANES,
  type ValueDifferentialOutcome,
  type ValueDifferentialOutcomes,
} from "./llang-value-differential-harness";

export {
  sameValueDifferentialOutcome,
  type ValueDifferentialOutcome,
  type ValueDifferentialOutcomes,
};

export const VALUE_DIFFERENTIAL_FORMAT = "llang-value-differential-v1";
export const VALUE_DIFFERENTIAL_DEFAULT_SEED = 20_260_921;

export type I32DifferentialInput = Readonly<{
  left: number;
  right: number;
}>;

export type GeneratedValueDifferentialCase = Readonly<{
  format: typeof VALUE_DIFFERENTIAL_FORMAT;
  version: 1;
  seed: number;
  caseIndex: number;
  expression: ValueExpression;
  source: ValueModuleSource;
  inputs: readonly I32DifferentialInput[];
}>;

export type ValueDifferentialReproduction = Readonly<{
  format: typeof VALUE_DIFFERENTIAL_FORMAT;
  version: 1;
  seed: number;
  caseIndex: number;
  inputIndex: number;
  input: I32DifferentialInput;
  expression: ValueExpression;
  source: ValueModuleSource;
  outcomes: ValueDifferentialOutcomes;
  replay: Readonly<{ seed: number; startCase: number; cases: 1 }>;
}>;

export class ValueDifferentialMismatch extends Error {
  readonly reproduction: ValueDifferentialReproduction;
  constructor(reproduction: ValueDifferentialReproduction) {
    super(
      `VALUE_DIFFERENTIAL_MISMATCH seed=${reproduction.seed} case=${reproduction.caseIndex} input=${reproduction.inputIndex}`,
    );
    this.name = "ValueDifferentialMismatch";
    this.reproduction = reproduction;
  }
}

type Random = () => number;
const I32_MIN = -2_147_483_648;
const I32_MAX = 2_147_483_647;
const LITERALS = [
  I32_MIN,
  I32_MIN + 1,
  -46_341,
  -2,
  -1,
  0,
  1,
  2,
  46_340,
  I32_MAX - 1,
  I32_MAX,
] as const;
const ARITHMETIC = ["+", "-", "*", "/", "%"] as const;
const COMPARISON = ["===", "!==", "<", "<=", ">", ">="] as const;

function mixedSeed(seed: number, caseIndex: number): number {
  let value = (seed ^ Math.imul(caseIndex + 1, 0x9e37_79b9)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x21f0_aaad) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x735a_2d97) >>> 0;
  return (value ^ (value >>> 15)) >>> 0;
}

function randomFor(seed: number, caseIndex: number): Random {
  let state = mixedSeed(seed, caseIndex);
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(random: Random, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)] as T;
}

function terminal(random: Random): ValueExpression {
  if (random() < 0.6)
    return {
      kind: "field",
      base: { kind: "param", name: "input" },
      name: random() < 0.5 ? "left" : "right",
    };
  return {
    kind: "literal",
    type: "i32",
    value: pick(random, LITERALS),
  };
}

function expression(random: Random, depth: number): ValueExpression {
  if (depth <= 0 || random() < 0.22) return terminal(random);
  const shape = Math.floor(random() * 4);
  if (shape === 0)
    return {
      kind: "unary",
      op: "minus",
      operand: expression(random, depth - 1),
    };
  if (shape <= 2)
    return {
      kind: "binary",
      op: pick(random, ARITHMETIC),
      left: expression(random, depth - 1),
      right: expression(random, depth - 1),
    };
  return {
    kind: "if",
    condition: {
      kind: "binary",
      op: pick(random, COMPARISON),
      left: expression(random, depth - 1),
      right: expression(random, depth - 1),
    },
    whenTrue: expression(random, depth - 1),
    whenFalse: expression(random, depth - 1),
  };
}

function randomI32(random: Random): number {
  return (Math.floor(random() * 4_294_967_296) | 0) as number;
}

function generatedInputs(random: Random): readonly I32DifferentialInput[] {
  return Object.freeze([
    { left: I32_MIN, right: -1 },
    { left: I32_MAX, right: 1 },
    { left: 0, right: 0 },
    { left: 1, right: 0 },
    { left: -7, right: 2 },
    { left: 7, right: -2 },
    { left: randomI32(random), right: randomI32(random) },
    { left: randomI32(random), right: randomI32(random) },
  ]);
}

function sourceFor(body: ValueExpression): ValueModuleSource {
  return {
    language: "l-lang",
    version: 3,
    kind: "module",
    profile: "module-value-v1",
    description: "Deterministic generated pure i32 differential case.",
    imports: [],
    types: [
      {
        name: "Input",
        export: true,
        kind: "record",
        fields: [
          { name: "left", type: "i32" },
          { name: "right", type: "i32" },
        ],
      },
    ],
    functions: [
      {
        name: "evaluate",
        export: true,
        parameters: [{ name: "input", type: { ref: "Input" } }],
        returns: "i32",
        body,
      },
    ],
  };
}

export function generateValueDifferentialCase(
  seed: number,
  caseIndex: number,
): GeneratedValueDifferentialCase {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff)
    throw new Error("value differential seed must be a uint32");
  if (!Number.isInteger(caseIndex) || caseIndex < 0 || caseIndex > 0xffff_ffff)
    throw new Error("value differential case index must be a uint32");
  const random = randomFor(seed, caseIndex);
  const body = expression(random, 4);
  return Object.freeze({
    format: VALUE_DIFFERENTIAL_FORMAT,
    version: 1,
    seed,
    caseIndex,
    expression: body,
    source: sourceFor(body),
    inputs: generatedInputs(random),
  });
}

function i32(value: bigint): number {
  if (value < BigInt(I32_MIN) || value > BigInt(I32_MAX))
    throw Object.assign(new Error("i32 overflow"), {
      code: "ARITHMETIC_OVERFLOW",
    });
  return Number(value);
}

export function evaluateValueI32Oracle(
  node: ValueExpression,
  input: I32DifferentialInput,
): number {
  const evaluate = (item: ValueExpression): number | boolean => {
    if (item.kind === "literal") return item.value as number;
    if (item.kind === "param")
      throw new Error("oracle cannot evaluate a record directly");
    if (item.kind === "field") {
      if (item.base.kind !== "param" || item.base.name !== "input")
        throw new Error("oracle received an unsupported field expression");
      if (item.name !== "left" && item.name !== "right")
        throw new Error("oracle received an unsupported input field");
      return input[item.name];
    }
    if (item.kind === "unary")
      return i32(-BigInt(evaluate(item.operand) as number));
    if (item.kind === "binary") {
      const left = evaluate(item.left) as number;
      const right = evaluate(item.right) as number;
      if (item.op === "===") return left === right;
      if (item.op === "!==") return left !== right;
      if (item.op === "<") return left < right;
      if (item.op === "<=") return left <= right;
      if (item.op === ">") return left > right;
      if (item.op === ">=") return left >= right;
      if ((item.op === "/" || item.op === "%") && right === 0)
        throw Object.assign(new Error("division by zero"), {
          code: "DIVISION_BY_ZERO",
        });
      const a = BigInt(left);
      const b = BigInt(right);
      if (item.op === "+") return i32(a + b);
      if (item.op === "-") return i32(a - b);
      if (item.op === "*") return i32(a * b);
      if (item.op === "/") return i32(a / b);
      if (item.op === "%") return Number(a % b);
      throw new Error(`oracle received unsupported operator ${item.op}`);
    }
    if (item.kind === "if")
      return evaluate(item.condition)
        ? evaluate(item.whenTrue)
        : evaluate(item.whenFalse);
    throw new Error(`oracle received unsupported expression ${item.kind}`);
  };
  const value = evaluate(node);
  if (typeof value !== "number")
    throw new Error("oracle expression did not return i32");
  return Object.is(value, -0) ? 0 : value;
}

export function assertValueDifferentialOutcomes(
  generated: GeneratedValueDifferentialCase,
  inputIndex: number,
  outcomes: ValueDifferentialOutcomes,
): void {
  const input = generated.inputs[inputIndex];
  if (!input) throw new Error("value differential input index is invalid");
  assertFiveValueDifferentialLanes(outcomes);
  const expected = outcomes.oracle;
  if (
    VALUE_DIFFERENTIAL_LANES.every((lane) =>
      sameValueDifferentialOutcome(expected, outcomes[lane]),
    )
  )
    return;
  throw new ValueDifferentialMismatch({
    format: VALUE_DIFFERENTIAL_FORMAT,
    version: 1,
    seed: generated.seed,
    caseIndex: generated.caseIndex,
    inputIndex,
    input,
    expression: generated.expression,
    source: generated.source,
    outcomes,
    replay: { seed: generated.seed, startCase: generated.caseIndex, cases: 1 },
  });
}

export async function runValueDifferentialCase(
  generated: GeneratedValueDifferentialCase,
): Promise<Readonly<{ programHash: string; inputs: number }>> {
  return runValueDifferentialLanes({
    source: generated.source,
    inputs: generated.inputs,
    oracle: (input) =>
      evaluateValueI32Oracle(
        generated.expression,
        input as I32DifferentialInput,
      ),
    assertOutcomes: (inputIndex, outcomes) =>
      assertValueDifferentialOutcomes(generated, inputIndex, outcomes),
    temporaryPrefix: "llang-value-differential-",
  });
}

export async function runValueDifferential(options: {
  seed: number;
  cases: number;
  startCase?: number;
}): Promise<
  Readonly<{
    format: typeof VALUE_DIFFERENTIAL_FORMAT;
    version: 1;
    seed: number;
    startCase: number;
    cases: number;
    inputs: number;
    programHashes: readonly string[];
  }>
> {
  const startCase = options.startCase ?? 0;
  if (
    !Number.isSafeInteger(options.cases) ||
    options.cases < 1 ||
    options.cases > 512
  )
    throw new Error("value differential cases must be between 1 and 512");
  if (
    !Number.isInteger(startCase) ||
    startCase < 0 ||
    startCase > 0xffff_ffff ||
    startCase + options.cases - 1 > 0xffff_ffff
  )
    throw new Error("value differential case range must fit uint32");
  const programHashes: string[] = [];
  let inputs = 0;
  for (let offset = 0; offset < options.cases; offset++) {
    const generated = generateValueDifferentialCase(
        options.seed,
        startCase + offset,
      ),
      result = await runValueDifferentialCase(generated);
    programHashes.push(result.programHash);
    inputs += result.inputs;
  }
  return Object.freeze({
    format: VALUE_DIFFERENTIAL_FORMAT,
    version: 1,
    seed: options.seed,
    startCase,
    cases: options.cases,
    inputs,
    programHashes: Object.freeze(programHashes),
  });
}
