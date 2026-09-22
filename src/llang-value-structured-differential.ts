import type {
  ValueExpression,
  ValueModuleSource,
  ValueTypeUse,
} from "./llang-module-value-ir";
import {
  assertFiveValueDifferentialLanes,
  runValueDifferentialLanes,
  sameValueDifferentialOutcome,
  VALUE_DIFFERENTIAL_LANES,
  type ValueDifferentialOutcomes,
} from "./llang-value-differential-harness";

export const VALUE_STRUCTURED_DIFFERENTIAL_FORMAT =
  "llang-value-structured-differential-v1";
export const VALUE_STRUCTURED_DIFFERENTIAL_DEFAULT_SEED = 20_260_922;

export type StructuredDifferentialInput = Readonly<{
  left: number;
  right: number;
  selector: number;
  choice:
    | Readonly<{ tag: "Alpha"; alphaValue: number }>
    | Readonly<{ tag: "Beta"; betaValue: number }>;
}>;

export type StructuredOracleExpression =
  | Readonly<{ kind: "literal"; value: number | boolean }>
  | Readonly<{ kind: "input"; name: keyof StructuredDifferentialInput }>
  | Readonly<{ kind: "local"; name: string }>
  | Readonly<{
      kind: "unary";
      op: "minus";
      operand: StructuredOracleExpression;
    }>
  | Readonly<{
      kind: "binary";
      op: string;
      left: StructuredOracleExpression;
      right: StructuredOracleExpression;
    }>
  | Readonly<{
      kind: "if";
      condition: StructuredOracleExpression;
      whenTrue: StructuredOracleExpression;
      whenFalse: StructuredOracleExpression;
    }>
  | Readonly<{
      kind: "variant";
      tag: "Alpha" | "Beta";
      fieldName: "alphaValue" | "betaValue";
      value: StructuredOracleExpression;
    }>
  | Readonly<{
      kind: "block";
      bindings: readonly Readonly<{
        name: string;
        type: "i32" | "Choice";
        value: StructuredOracleExpression;
      }>[];
      result: StructuredOracleExpression;
    }>
  | Readonly<{
      kind: "match";
      value: StructuredOracleExpression;
      cases: readonly Readonly<{
        tag: "Alpha" | "Beta";
        payloadName: "alphaValue" | "betaValue";
        body: StructuredOracleExpression;
      }>[];
    }>;

export type StructuredOracleMutation = Readonly<{
  eagerMatch?: boolean;
  ordinalMatch?: boolean;
  swapTag?: boolean;
  wrongPayload?: boolean;
  dropOuterLocals?: boolean;
  independentBindings?: boolean;
}>;

export type GeneratedValueStructuredDifferentialCase = Readonly<{
  format: typeof VALUE_STRUCTURED_DIFFERENTIAL_FORMAT;
  version: 1;
  seed: number;
  caseIndex: number;
  shape: "internal-variant" | "union-input";
  caseOrder: "alpha-first" | "beta-first";
  offsetDelta: number;
  mode:
    | "normal-add"
    | "normal-subtract"
    | "normal-multiply"
    | "inactive-division"
    | "inactive-overflow"
    | "selected-division";
  oracleExpression: StructuredOracleExpression;
  expression: ValueExpression;
  source: ValueModuleSource;
  inputs: readonly StructuredDifferentialInput[];
}>;

export type ValueStructuredDifferentialReproduction = Readonly<{
  format: typeof VALUE_STRUCTURED_DIFFERENTIAL_FORMAT;
  version: 1;
  seed: number;
  caseIndex: number;
  inputIndex: number;
  shape: GeneratedValueStructuredDifferentialCase["shape"];
  mode: GeneratedValueStructuredDifferentialCase["mode"];
  caseOrder: GeneratedValueStructuredDifferentialCase["caseOrder"];
  offsetDelta: number;
  selectedTag: "Alpha" | "Beta";
  input: StructuredDifferentialInput;
  oracleExpression: StructuredOracleExpression;
  source: ValueModuleSource;
  outcomes: ValueDifferentialOutcomes;
  replay: Readonly<{
    seed: number;
    startCase: number;
    cases: 1;
    inputIndex: number;
  }>;
}>;

export type ValueStructuredDifferentialRunnerReproduction = Readonly<{
  format: typeof VALUE_STRUCTURED_DIFFERENTIAL_FORMAT;
  version: 1;
  kind: "runner-error";
  seed: number;
  caseIndex: number;
  inputIndex?: number;
  shape: GeneratedValueStructuredDifferentialCase["shape"];
  mode: GeneratedValueStructuredDifferentialCase["mode"];
  caseOrder: GeneratedValueStructuredDifferentialCase["caseOrder"];
  offsetDelta: number;
  oracleExpression: StructuredOracleExpression;
  source: ValueModuleSource;
  inputs: readonly StructuredDifferentialInput[];
  error: string;
}>;

export class ValueStructuredDifferentialMismatch extends Error {
  readonly reproduction: ValueStructuredDifferentialReproduction;
  constructor(reproduction: ValueStructuredDifferentialReproduction) {
    super(
      `VALUE_STRUCTURED_DIFFERENTIAL_MISMATCH seed=${reproduction.seed} case=${reproduction.caseIndex} input=${reproduction.inputIndex}`,
    );
    this.name = "ValueStructuredDifferentialMismatch";
    this.reproduction = reproduction;
  }
}

export class ValueStructuredDifferentialRunnerError extends Error {
  readonly reproduction: ValueStructuredDifferentialRunnerReproduction;
  constructor(reproduction: ValueStructuredDifferentialRunnerReproduction) {
    super(
      `VALUE_STRUCTURED_DIFFERENTIAL_RUNNER_ERROR seed=${reproduction.seed} case=${reproduction.caseIndex}${reproduction.inputIndex === undefined ? "" : ` input=${reproduction.inputIndex}`}: ${reproduction.error}`,
    );
    this.name = "ValueStructuredDifferentialRunnerError";
    this.reproduction = reproduction;
  }
}

type OracleTaggedValue = Readonly<{
  tag: "Alpha" | "Beta";
}> &
  Readonly<Record<string, number | string>>;
type OracleValue = number | boolean | OracleTaggedValue;
type Random = () => number;

const I32_MIN = -2_147_483_648;
const I32_MAX = 2_147_483_647;
const MODES = [
  "normal-add",
  "normal-subtract",
  "normal-multiply",
  "inactive-division",
  "inactive-overflow",
  "selected-division",
] as const;

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

function randomI32(random: Random): number {
  return Math.floor(random() * 4_294_967_296) | 0;
}

const literal = (value: number | boolean): StructuredOracleExpression => ({
  kind: "literal",
  value,
});
const input = (
  name: keyof StructuredDifferentialInput,
): StructuredOracleExpression => ({ kind: "input", name });
const local = (name: string): StructuredOracleExpression => ({
  kind: "local",
  name,
});
const binary = (
  op: string,
  left: StructuredOracleExpression,
  right: StructuredOracleExpression,
): StructuredOracleExpression => ({ kind: "binary", op, left, right });

function resultCases(
  mode: GeneratedValueStructuredDifferentialCase["mode"],
): readonly Readonly<{
  tag: "Alpha" | "Beta";
  payloadName: "alphaValue" | "betaValue";
  body: StructuredOracleExpression;
}>[] {
  const alphaValue = local("alphaValue"),
    betaValue = local("betaValue"),
    adjusted = local("adjusted"),
    divideByZero = binary("/", literal(1), literal(0)),
    overflow = binary("+", literal(I32_MAX), literal(1));
  if (mode === "inactive-division")
    return [
      {
        tag: "Alpha",
        payloadName: "alphaValue",
        body: binary("+", alphaValue, adjusted),
      },
      { tag: "Beta", payloadName: "betaValue", body: divideByZero },
    ];
  if (mode === "inactive-overflow")
    return [
      { tag: "Alpha", payloadName: "alphaValue", body: overflow },
      {
        tag: "Beta",
        payloadName: "betaValue",
        body: binary("-", betaValue, adjusted),
      },
    ];
  if (mode === "selected-division")
    return [
      {
        tag: "Alpha",
        payloadName: "alphaValue",
        body: binary("/", alphaValue, input("right")),
      },
      {
        tag: "Beta",
        payloadName: "betaValue",
        body: binary("+", betaValue, adjusted),
      },
    ];
  const operator =
    mode === "normal-add" ? "+" : mode === "normal-subtract" ? "-" : "*";
  return [
    {
      tag: "Alpha",
      payloadName: "alphaValue",
      body: binary(operator, alphaValue, adjusted),
    },
    {
      tag: "Beta",
      payloadName: "betaValue",
      body: binary(operator, adjusted, betaValue),
    },
  ];
}

function structuredExpression(
  shape: GeneratedValueStructuredDifferentialCase["shape"],
  mode: GeneratedValueStructuredDifferentialCase["mode"],
  caseOrder: GeneratedValueStructuredDifferentialCase["caseOrder"],
  offsetDelta: number,
): StructuredOracleExpression {
  const choice: StructuredOracleExpression =
    shape === "union-input"
      ? input("choice")
      : {
          kind: "if",
          condition: binary(">=", input("selector"), literal(0)),
          whenTrue: {
            kind: "variant",
            tag: "Alpha",
            fieldName: "alphaValue",
            value: input("right"),
          },
          whenFalse: {
            kind: "variant",
            tag: "Beta",
            fieldName: "betaValue",
            value: input("right"),
          },
        };
  const cases = resultCases(mode);
  return {
    kind: "block",
    bindings: [
      { name: "offset", type: "i32", value: input("left") },
      {
        name: "adjusted",
        type: "i32",
        value: binary("+", local("offset"), literal(offsetDelta)),
      },
      { name: "selected", type: "Choice", value: choice },
    ],
    result: {
      kind: "match",
      value: local("selected"),
      cases: caseOrder === "alpha-first" ? cases : [...cases].reverse(),
    },
  };
}

function valueExpression(
  expression: StructuredOracleExpression,
): ValueExpression {
  switch (expression.kind) {
    case "literal":
      return {
        kind: "literal",
        type: typeof expression.value === "boolean" ? "boolean" : "i32",
        value: expression.value,
      };
    case "input":
      return {
        kind: "field",
        base: { kind: "param", name: "input" },
        name: expression.name,
      };
    case "local":
      return { kind: "local", name: expression.name };
    case "unary":
      return {
        kind: "unary",
        op: expression.op,
        operand: valueExpression(expression.operand),
      };
    case "binary":
      return {
        kind: "binary",
        op: expression.op,
        left: valueExpression(expression.left),
        right: valueExpression(expression.right),
      };
    case "if":
      return {
        kind: "if",
        condition: valueExpression(expression.condition),
        whenTrue: valueExpression(expression.whenTrue),
        whenFalse: valueExpression(expression.whenFalse),
      };
    case "variant":
      return {
        kind: "variant",
        type: "Choice",
        tag: expression.tag,
        fields: [
          {
            name: expression.fieldName,
            value: valueExpression(expression.value),
          },
        ],
      };
    case "block":
      return {
        kind: "block",
        bindings: expression.bindings.map((binding) => ({
          name: binding.name,
          type:
            binding.type === "i32"
              ? "i32"
              : ({ ref: "Choice" } satisfies ValueTypeUse),
          value: valueExpression(binding.value),
        })),
        result: valueExpression(expression.result),
      };
    case "match":
      return {
        kind: "match",
        value: valueExpression(expression.value),
        cases: expression.cases.map((item) => ({
          tag: item.tag,
          body: valueExpression(item.body),
        })),
      };
  }
}

function sourceFor(body: ValueExpression): ValueModuleSource {
  return {
    language: "l-lang",
    version: 3,
    kind: "module",
    profile: "module-value-v1",
    description:
      "Deterministic generated block, match, and tagged union differential case.",
    imports: [],
    types: [
      {
        name: "Choice",
        export: true,
        kind: "union",
        variants: [
          { tag: "Alpha", fields: [{ name: "alphaValue", type: "i32" }] },
          { tag: "Beta", fields: [{ name: "betaValue", type: "i32" }] },
        ],
      },
      {
        name: "Input",
        export: true,
        kind: "record",
        fields: [
          { name: "left", type: "i32" },
          { name: "right", type: "i32" },
          { name: "selector", type: "i32" },
          { name: "choice", type: { ref: "Choice" } },
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

function generatedInputs(
  random: Random,
): readonly StructuredDifferentialInput[] {
  return Object.freeze([
    {
      left: 0,
      right: 5,
      selector: 1,
      choice: { tag: "Alpha", alphaValue: 7 },
    },
    {
      left: 3,
      right: -2,
      selector: -1,
      choice: { tag: "Beta", betaValue: 4 },
    },
    {
      left: I32_MAX,
      right: 1,
      selector: 1,
      choice: { tag: "Alpha", alphaValue: I32_MAX },
    },
    {
      left: I32_MIN,
      right: -1,
      selector: -1,
      choice: { tag: "Beta", betaValue: I32_MIN },
    },
    {
      left: 0,
      right: 0,
      selector: 1,
      choice: { tag: "Alpha", alphaValue: 0 },
    },
    {
      left: 1,
      right: 0,
      selector: -1,
      choice: { tag: "Beta", betaValue: 0 },
    },
    {
      left: randomI32(random),
      right: randomI32(random),
      selector: 1,
      choice: { tag: "Alpha", alphaValue: randomI32(random) },
    },
    {
      left: randomI32(random),
      right: randomI32(random),
      selector: -1,
      choice: { tag: "Beta", betaValue: randomI32(random) },
    },
  ]);
}

export function generateValueStructuredDifferentialCase(
  seed: number,
  caseIndex: number,
): GeneratedValueStructuredDifferentialCase {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff)
    throw new Error("value structured differential seed must be a uint32");
  if (!Number.isInteger(caseIndex) || caseIndex < 0 || caseIndex > 0xffff_ffff)
    throw new Error(
      "value structured differential case index must be a uint32",
    );
  const random = randomFor(seed, caseIndex),
    shape = caseIndex % 2 === 0 ? "internal-variant" : "union-input",
    mode = MODES[Math.floor(caseIndex / 2) % MODES.length],
    caseOrder =
      Math.floor(caseIndex / (MODES.length * 2)) % 2 === 0
        ? "alpha-first"
        : "beta-first",
    offsetDelta = Math.floor(random() * 33) - 16;
  if (!mode) throw new Error("value structured differential mode is invalid");
  const oracleExpression = structuredExpression(
      shape,
      mode,
      caseOrder,
      offsetDelta,
    ),
    expression = valueExpression(oracleExpression);
  return Object.freeze({
    format: VALUE_STRUCTURED_DIFFERENTIAL_FORMAT,
    version: 1,
    seed,
    caseIndex,
    shape,
    caseOrder,
    offsetDelta,
    mode,
    oracleExpression,
    expression,
    source: sourceFor(expression),
    inputs: generatedInputs(random),
  });
}

function checkedI32(value: bigint): number {
  if (value < BigInt(I32_MIN) || value > BigInt(I32_MAX))
    throw Object.assign(new Error("i32 overflow"), {
      code: "ARITHMETIC_OVERFLOW",
    });
  return Number(value);
}

function selectedTag(
  generated: GeneratedValueStructuredDifferentialCase,
  inputValue: StructuredDifferentialInput,
): "Alpha" | "Beta" {
  return generated.shape === "union-input"
    ? inputValue.choice.tag
    : inputValue.selector >= 0
      ? "Alpha"
      : "Beta";
}

export function evaluateValueStructuredOracle(
  expression: StructuredOracleExpression,
  inputValue: StructuredDifferentialInput,
  mutation: StructuredOracleMutation = {},
): number {
  const evaluate = (
    node: StructuredOracleExpression,
    environment: ReadonlyMap<string, OracleValue>,
  ): OracleValue => {
    switch (node.kind) {
      case "literal":
        return node.value;
      case "input":
        return inputValue[node.name];
      case "local": {
        const value = environment.get(node.name);
        if (value === undefined)
          throw new Error(`structured oracle unknown local ${node.name}`);
        return value;
      }
      case "unary":
        return checkedI32(
          -BigInt(evaluate(node.operand, environment) as number),
        );
      case "binary": {
        const left = evaluate(node.left, environment) as number,
          right = evaluate(node.right, environment) as number;
        if (node.op === "===") return left === right;
        if (node.op === "!==") return left !== right;
        if (node.op === "<") return left < right;
        if (node.op === "<=") return left <= right;
        if (node.op === ">") return left > right;
        if (node.op === ">=") return left >= right;
        if ((node.op === "/" || node.op === "%") && right === 0)
          throw Object.assign(new Error("division by zero"), {
            code: "DIVISION_BY_ZERO",
          });
        const a = BigInt(left),
          b = BigInt(right);
        if (node.op === "+") return checkedI32(a + b);
        if (node.op === "-") return checkedI32(a - b);
        if (node.op === "*") return checkedI32(a * b);
        if (node.op === "/") return checkedI32(a / b);
        if (node.op === "%") return Number(a % b);
        throw new Error(`structured oracle unsupported operator ${node.op}`);
      }
      case "if":
        return evaluate(node.condition, environment)
          ? evaluate(node.whenTrue, environment)
          : evaluate(node.whenFalse, environment);
      case "variant":
        return {
          tag: node.tag,
          [node.fieldName]: evaluate(node.value, environment) as number,
        };
      case "block": {
        const next = new Map(environment);
        for (const binding of node.bindings) {
          const scope = mutation.independentBindings ? environment : next;
          next.set(binding.name, evaluate(binding.value, scope));
        }
        return evaluate(node.result, next);
      }
      case "match": {
        const tagged = evaluate(node.value, environment) as OracleTaggedValue,
          effectiveTag = mutation.swapTag
            ? tagged.tag === "Alpha"
              ? "Beta"
              : "Alpha"
            : tagged.tag,
          fieldName = tagged.tag === "Alpha" ? "alphaValue" : "betaValue",
          originalPayload = tagged[fieldName];
        if (typeof originalPayload !== "number")
          throw new Error(`structured oracle missing payload ${fieldName}`);
        const payload = mutation.wrongPayload
          ? checkedI32(BigInt(originalPayload) + 1n)
          : originalPayload;
        if (mutation.eagerMatch)
          for (const item of node.cases) {
            const eager = new Map(environment);
            eager.set(item.payloadName, payload);
            evaluate(item.body, eager);
          }
        const item = mutation.ordinalMatch
          ? node.cases[0]
          : node.cases.find((candidate) => candidate.tag === effectiveTag);
        if (!item)
          throw new Error(`structured oracle missing case ${effectiveTag}`);
        const next = mutation.dropOuterLocals
          ? new Map<string, OracleValue>()
          : new Map(environment);
        next.set(item.payloadName, payload);
        return evaluate(item.body, next);
      }
    }
  };
  const value = evaluate(expression, new Map());
  if (typeof value !== "number")
    throw new Error("structured oracle expression did not return i32");
  return Object.is(value, -0) ? 0 : value;
}

export function assertValueStructuredDifferentialOutcomes(
  generated: GeneratedValueStructuredDifferentialCase,
  inputIndex: number,
  outcomes: ValueDifferentialOutcomes,
): void {
  const inputValue = generated.inputs[inputIndex];
  if (!inputValue)
    throw new Error("value structured differential input index is invalid");
  assertFiveValueDifferentialLanes(outcomes);
  if (
    VALUE_DIFFERENTIAL_LANES.every((lane) =>
      sameValueDifferentialOutcome(outcomes.oracle, outcomes[lane]),
    )
  )
    return;
  throw new ValueStructuredDifferentialMismatch({
    format: VALUE_STRUCTURED_DIFFERENTIAL_FORMAT,
    version: 1,
    seed: generated.seed,
    caseIndex: generated.caseIndex,
    inputIndex,
    shape: generated.shape,
    mode: generated.mode,
    caseOrder: generated.caseOrder,
    offsetDelta: generated.offsetDelta,
    selectedTag: selectedTag(generated, inputValue),
    input: inputValue,
    oracleExpression: generated.oracleExpression,
    source: generated.source,
    outcomes,
    replay: {
      seed: generated.seed,
      startCase: generated.caseIndex,
      cases: 1,
      inputIndex,
    },
  });
}

export async function runValueStructuredDifferentialCase(
  generated: GeneratedValueStructuredDifferentialCase,
  inputIndex?: number,
): Promise<Readonly<{ programHash: string; inputs: number }>> {
  if (
    inputIndex !== undefined &&
    (!Number.isInteger(inputIndex) ||
      inputIndex < 0 ||
      inputIndex >= generated.inputs.length)
  )
    throw new Error("value structured differential input index is invalid");
  const indexes =
      inputIndex === undefined
        ? generated.inputs.map((_, index) => index)
        : [inputIndex],
    inputs = indexes.map((index) => {
      const value = generated.inputs[index];
      if (!value)
        throw new Error("value structured differential input index is invalid");
      return value;
    });
  return runValueDifferentialLanes({
    source: generated.source,
    inputs,
    oracle: (inputValue) =>
      evaluateValueStructuredOracle(
        generated.oracleExpression,
        inputValue as StructuredDifferentialInput,
      ),
    assertOutcomes: (localIndex, outcomes) => {
      const originalIndex = indexes[localIndex];
      if (originalIndex === undefined)
        throw new Error("value structured differential input index is invalid");
      assertValueStructuredDifferentialOutcomes(
        generated,
        originalIndex,
        outcomes,
      );
    },
    temporaryPrefix: "llang-value-structured-differential-",
  });
}

export async function runValueStructuredDifferential(options: {
  seed: number;
  cases: number;
  startCase?: number;
  inputIndex?: number;
}): Promise<
  Readonly<{
    format: typeof VALUE_STRUCTURED_DIFFERENTIAL_FORMAT;
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
    throw new Error(
      "value structured differential cases must be between 1 and 512",
    );
  if (
    !Number.isInteger(options.seed) ||
    options.seed < 0 ||
    options.seed > 0xffff_ffff
  )
    throw new Error("value structured differential seed must be a uint32");
  if (
    !Number.isInteger(startCase) ||
    startCase < 0 ||
    startCase > 0xffff_ffff ||
    startCase + options.cases - 1 > 0xffff_ffff
  )
    throw new Error("value structured differential case range must fit uint32");
  if (options.inputIndex !== undefined && options.cases !== 1)
    throw new Error(
      "value structured differential input index requires exactly one case",
    );
  const programHashes: string[] = [];
  let inputs = 0;
  for (let offset = 0; offset < options.cases; offset++) {
    const generated = generateValueStructuredDifferentialCase(
      options.seed,
      startCase + offset,
    );
    let result: Readonly<{ programHash: string; inputs: number }>;
    try {
      result = await runValueStructuredDifferentialCase(
        generated,
        options.inputIndex,
      );
    } catch (error) {
      if (
        error instanceof ValueStructuredDifferentialMismatch ||
        error instanceof ValueStructuredDifferentialRunnerError
      )
        throw error;
      throw new ValueStructuredDifferentialRunnerError({
        format: VALUE_STRUCTURED_DIFFERENTIAL_FORMAT,
        version: 1,
        kind: "runner-error",
        seed: generated.seed,
        caseIndex: generated.caseIndex,
        ...(options.inputIndex === undefined
          ? {}
          : { inputIndex: options.inputIndex }),
        shape: generated.shape,
        mode: generated.mode,
        caseOrder: generated.caseOrder,
        offsetDelta: generated.offsetDelta,
        oracleExpression: generated.oracleExpression,
        source: generated.source,
        inputs: generated.inputs,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    programHashes.push(result.programHash);
    inputs += result.inputs;
  }
  return Object.freeze({
    format: VALUE_STRUCTURED_DIFFERENTIAL_FORMAT,
    version: 1,
    seed: options.seed,
    startCase,
    cases: options.cases,
    inputs,
    programHashes: Object.freeze(programHashes),
  });
}
