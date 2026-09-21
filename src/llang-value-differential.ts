import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { evaluateValueProgram } from "./llang-module-value-evaluator";
import type {
  ValueExpression,
  ValueModuleSource,
} from "./llang-module-value-ir";
import { loadValueModuleProgram } from "./llang-module-value-loader";
import { instantiateValueModule } from "./llang-module-value-runtime";
import {
  emitValueModuleJsonc,
  emitValueModuleTypeScript,
} from "./llang-module-value-source-emitter";
import { emitValueModuleWasm } from "./llang-module-value-wasm";

export const VALUE_DIFFERENTIAL_FORMAT = "llang-value-differential-v1";
export const VALUE_DIFFERENTIAL_DEFAULT_SEED = 20_260_921;

export type I32DifferentialInput = Readonly<{
  left: number;
  right: number;
}>;

export type ValueDifferentialOutcome =
  | Readonly<{ kind: "value"; value: number }>
  | Readonly<{
      kind: "fault";
      code: "ARITHMETIC_OVERFLOW" | "DIVISION_BY_ZERO" | "RESOURCE_LIMIT";
    }>;

export type ValueDifferentialOutcomes = Readonly<{
  oracle: ValueDifferentialOutcome;
  reference: ValueDifferentialOutcome;
  typescript: ValueDifferentialOutcome;
  jsonc: ValueDifferentialOutcome;
  wasm: ValueDifferentialOutcome;
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
const DIFFERENTIAL_LANES = [
  "oracle",
  "reference",
  "typescript",
  "jsonc",
  "wasm",
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

function sourceExpression(node: ValueExpression): unknown {
  if (node.kind === "field")
    return { ...node, base: sourceExpression(node.base) };
  if (node.kind === "unary")
    return { ...node, operand: sourceExpression(node.operand) };
  if (node.kind === "binary")
    return {
      ...node,
      left: sourceExpression(node.left),
      right: sourceExpression(node.right),
    };
  if (node.kind === "if")
    return Object.fromEntries([
      ["kind", "if"],
      ["condition", sourceExpression(node.condition)],
      // biome-ignore lint/suspicious/noThenProperty: The JSONC source grammar names this branch "then".
      ["then", sourceExpression(node.whenTrue)],
      ["else", sourceExpression(node.whenFalse)],
    ]);
  return node;
}

function sourceJson(source: ValueModuleSource): unknown {
  return {
    ...source,
    functions: source.functions.map((fn) => ({
      ...fn,
      body: sourceExpression(fn.body),
    })),
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

const FAULTS = new Set([
  "ARITHMETIC_OVERFLOW",
  "DIVISION_BY_ZERO",
  "RESOURCE_LIMIT",
]);

function outcome(run: () => unknown): ValueDifferentialOutcome {
  try {
    const value = run();
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < I32_MIN ||
      value > I32_MAX
    )
      throw new Error("value differential lane returned a non-i32 result");
    return Object.freeze({
      kind: "value",
      value: Object.is(value, -0) ? 0 : value,
    });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : undefined;
    if (code && FAULTS.has(code))
      return Object.freeze({
        kind: "fault",
        code,
      }) as ValueDifferentialOutcome;
    throw error;
  }
}

function parseTypeScriptOutcomes(
  text: string,
  expectedLength: number,
): readonly ValueDifferentialOutcome[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length !== expectedLength)
    throw new Error("generated TypeScript returned an invalid outcome list");
  return Object.freeze(
    parsed.map((item) => {
      if (!item || typeof item !== "object")
        throw new Error("generated TypeScript returned an invalid outcome");
      const record = item as Record<string, unknown>;
      if (record.kind === "value") return outcome(() => record.value);
      if (
        record.kind === "fault" &&
        typeof record.code === "string" &&
        FAULTS.has(record.code)
      )
        return Object.freeze({
          kind: "fault",
          code: record.code,
        }) as ValueDifferentialOutcome;
      throw new Error("generated TypeScript returned an unknown outcome");
    }),
  );
}

async function runGeneratedTypeScript(
  root: string,
  inputs: readonly I32DifferentialInput[],
): Promise<readonly ValueDifferentialOutcome[]> {
  const inputsPath = join(root, "inputs.json"),
    runnerPath = join(root, "typescript-runner.ts");
  await writeFile(inputsPath, `${JSON.stringify(inputs)}\n`);
  await writeFile(
    runnerPath,
    `import { evaluate } from "./program.generated";
const inputs = await Bun.file(process.argv[2]!).json() as unknown[];
const outcomes = inputs.map((input) => {
  try {
    return { kind: "value", value: evaluate(input) };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "UNKNOWN";
    return { kind: "fault", code };
  }
});
process.stdout.write(JSON.stringify(outcomes));
`,
  );
  const child = Bun.spawn([process.execPath, "run", runnerPath, inputsPath], {
    cwd: root,
    env: {},
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 5_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0)
      throw new Error(
        timedOut
          ? "generated TypeScript execution timed out"
          : `generated TypeScript execution failed: ${stderr.slice(0, 2_000)}`,
      );
    return parseTypeScriptOutcomes(stdout, inputs.length);
  } finally {
    clearTimeout(timeout);
  }
}

export function sameValueDifferentialOutcome(
  left: ValueDifferentialOutcome,
  right: ValueDifferentialOutcome,
): boolean {
  if (left.kind === "value")
    return right.kind === "value" && left.value === right.value;
  return right.kind === "fault" && left.code === right.code;
}

export function assertValueDifferentialOutcomes(
  generated: GeneratedValueDifferentialCase,
  inputIndex: number,
  outcomes: ValueDifferentialOutcomes,
): void {
  const input = generated.inputs[inputIndex];
  if (!input) throw new Error("value differential input index is invalid");
  const keys = Object.keys(outcomes);
  if (
    keys.length !== DIFFERENTIAL_LANES.length ||
    DIFFERENTIAL_LANES.some((lane) => !Object.hasOwn(outcomes, lane))
  )
    throw new Error("value differential outcomes must contain all five lanes");
  const expected = outcomes.oracle;
  if (
    DIFFERENTIAL_LANES.every((lane) =>
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
  const root = await mkdtemp(join(tmpdir(), "llang-value-differential-"));
  try {
    const sourcePath = join(root, "main.llang.jsonc");
    await writeFile(
      sourcePath,
      `${JSON.stringify(sourceJson(generated.source), null, 2)}\n`,
    );
    const program = await loadValueModuleProgram(
        "main.llang.jsonc",
        root,
        "evaluate",
      ),
      generatedTs = join(root, "program.generated.ts");
    await writeFile(generatedTs, emitValueModuleTypeScript(program));
    const typescriptOutcomes = await runGeneratedTypeScript(
      root,
      generated.inputs,
    );
    const jsonRoot = join(root, "round-trip");
    for (const [path, text] of emitValueModuleJsonc(program)) {
      const target = join(jsonRoot, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text);
    }
    const roundTrip = await loadValueModuleProgram(
      "main.llang.jsonc",
      jsonRoot,
      "evaluate",
    );
    if (roundTrip.programHash !== program.programHash)
      throw new Error("value differential JSONC round-trip hash mismatch");
    const emitted = emitValueModuleWasm(program),
      wasm = instantiateValueModule(emitted.contract, emitted.bytes);

    for (const [inputIndex, input] of generated.inputs.entries()) {
      const typescriptOutcome = typescriptOutcomes[inputIndex];
      if (!typescriptOutcome)
        throw new Error("generated TypeScript outcome is missing");
      const outcomes = Object.freeze({
        oracle: outcome(() =>
          evaluateValueI32Oracle(generated.expression, input),
        ),
        reference: outcome(() => evaluateValueProgram(program, input)),
        typescript: typescriptOutcome,
        jsonc: outcome(() => evaluateValueProgram(roundTrip, input)),
        wasm: outcome(() => wasm.evaluate(input)),
      });
      assertValueDifferentialOutcomes(generated, inputIndex, outcomes);
    }
    return Object.freeze({
      programHash: program.programHash,
      inputs: generated.inputs.length,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
