import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ValueExpression } from "./llang-module-value-ir";
import { fingerprintFor } from "./stable-hash";
import {
  parseValueDifferentialOptions,
  runValueDifferentialCli,
} from "./llang-value-differential-cli";
import {
  assertValueDifferentialOutcomes,
  evaluateValueI32Oracle,
  generateValueDifferentialCase,
  runValueDifferential,
  sameValueDifferentialOutcome,
  VALUE_DIFFERENTIAL_DEFAULT_SEED,
  VALUE_DIFFERENTIAL_FORMAT,
  type ValueDifferentialOutcomes,
  ValueDifferentialMismatch,
} from "./llang-value-differential";

const literal = (value: number): ValueExpression => ({
  kind: "literal",
  type: "i32",
  value,
});
const binary = (
  op: string,
  left: ValueExpression,
  right: ValueExpression,
): ValueExpression => ({ kind: "binary", op, left, right });

function collectGeneratedCoverage(
  node: ValueExpression,
  kinds: Set<string>,
  operators: Set<string>,
): void {
  kinds.add(node.kind);
  if (node.kind === "literal" || node.kind === "param") return;
  if (node.kind === "field") {
    collectGeneratedCoverage(node.base, kinds, operators);
    return;
  }
  if (node.kind === "unary") {
    operators.add(node.op);
    collectGeneratedCoverage(node.operand, kinds, operators);
    return;
  }
  if (node.kind === "binary") {
    operators.add(node.op);
    collectGeneratedCoverage(node.left, kinds, operators);
    collectGeneratedCoverage(node.right, kinds, operators);
    return;
  }
  if (node.kind === "if") {
    collectGeneratedCoverage(node.condition, kinds, operators);
    collectGeneratedCoverage(node.whenTrue, kinds, operators);
    collectGeneratedCoverage(node.whenFalse, kinds, operators);
    return;
  }
  throw new Error(`generated subset contains unexpected ${node.kind}`);
}

describe("module-value-v1 generated differential", () => {
  test("case generation is deterministic and independently addressable", () => {
    const first = generateValueDifferentialCase(123, 7),
      repeated = generateValueDifferentialCase(123, 7),
      prior = generateValueDifferentialCase(123, 6),
      next = generateValueDifferentialCase(123, 8);
    expect(repeated).toEqual(first);
    expect(prior.expression).not.toEqual(first.expression);
    expect(next.expression).not.toEqual(first.expression);
    expect(first.inputs).toHaveLength(8);
    expect(first.inputs.slice(0, 6)).toEqual([
      { left: -2_147_483_648, right: -1 },
      { left: 2_147_483_647, right: 1 },
      { left: 0, right: 0 },
      { left: 1, right: 0 },
      { left: -7, right: 2 },
      { left: 7, right: -2 },
    ]);
    expect(() => generateValueDifferentialCase(123, 0x1_0000_0000)).toThrow(
      "case index must be a uint32",
    );
  });

  test("independent oracle fixes i32 boundaries and selected-branch behavior", () => {
    expect(
      evaluateValueI32Oracle(binary("/", literal(7), literal(-2)), {
        left: 0,
        right: 0,
      }),
    ).toBe(-3);
    expect(
      evaluateValueI32Oracle(binary("%", literal(-7), literal(2)), {
        left: 0,
        right: 0,
      }),
    ).toBe(-1);
    expect(() =>
      evaluateValueI32Oracle(binary("+", literal(2_147_483_647), literal(1)), {
        left: 0,
        right: 0,
      }),
    ).toThrow("i32 overflow");
    expect(() =>
      evaluateValueI32Oracle(
        binary("/", literal(-2_147_483_648), literal(-1)),
        { left: 0, right: 0 },
      ),
    ).toThrow("i32 overflow");
    const selected: ValueExpression = {
      kind: "if",
      condition: binary("===", literal(1), literal(1)),
      whenTrue: literal(9),
      whenFalse: binary("/", literal(1), literal(0)),
    };
    expect(evaluateValueI32Oracle(selected, { left: 0, right: 0 })).toBe(9);
  });

  test("outcome comparison detects a mutated lane", () => {
    expect(
      sameValueDifferentialOutcome(
        { kind: "value", value: 4 },
        { kind: "value", value: 5 },
      ),
    ).toBe(false);
    expect(
      sameValueDifferentialOutcome(
        { kind: "fault", code: "ARITHMETIC_OVERFLOW" },
        { kind: "fault", code: "ARITHMETIC_OVERFLOW" },
      ),
    ).toBe(true);
    expect(
      sameValueDifferentialOutcome(
        { value: 4, kind: "value" },
        { kind: "value", value: 4 },
      ),
    ).toBe(true);
    const generated = generateValueDifferentialCase(91, 3);
    const outcomes: ValueDifferentialOutcomes = {
      oracle: { kind: "value", value: 4 },
      reference: { kind: "value", value: 5 },
      typescript: { kind: "value", value: 4 },
      jsonc: { kind: "value", value: 4 },
      wasm: { kind: "value", value: 4 },
    };
    try {
      assertValueDifferentialOutcomes(generated, 0, outcomes);
      throw new Error("expected a differential mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(ValueDifferentialMismatch);
      const mismatch = error as ValueDifferentialMismatch;
      expect(mismatch.reproduction).toMatchObject({
        seed: 91,
        caseIndex: 3,
        inputIndex: 0,
        replay: { seed: 91, startCase: 3, cases: 1 },
      });
      expect(mismatch.reproduction.source).toEqual(generated.source);
    }
    expect(() =>
      assertValueDifferentialOutcomes(generated, 0, {
        oracle: { kind: "value", value: 4 },
      } as unknown as ValueDifferentialOutcomes),
    ).toThrow("must contain all five lanes");
  });

  test("CLI rejects ambiguous ranges and atomically records a mismatch", async () => {
    expect(() =>
      parseValueDifferentialOptions(["--seed", "1", "--seed", "2"]),
    ).toThrow("duplicate option --seed");
    expect(() =>
      parseValueDifferentialOptions([
        "--start-case",
        String(0xffff_ffff),
        "--cases",
        "2",
      ]),
    ).toThrow("range must fit uint32");
    expect(() => parseValueDifferentialOptions(["--cases", "--seed"])).toThrow(
      "--cases requires a value",
    );
    expect(() => parseValueDifferentialOptions(["--unknown"])).toThrow(
      "unknown option --unknown",
    );

    const generated = generateValueDifferentialCase(19, 2),
      firstInput = generated.inputs[0];
    if (!firstInput) throw new Error("generated case has no input");
    const mismatch = new ValueDifferentialMismatch({
        format: VALUE_DIFFERENTIAL_FORMAT,
        version: 1,
        seed: generated.seed,
        caseIndex: generated.caseIndex,
        inputIndex: 0,
        input: firstInput,
        expression: generated.expression,
        source: generated.source,
        outcomes: {
          oracle: { kind: "value", value: 1 },
          reference: { kind: "value", value: 2 },
          typescript: { kind: "value", value: 1 },
          jsonc: { kind: "value", value: 1 },
          wasm: { kind: "value", value: 1 },
        },
        replay: {
          seed: generated.seed,
          startCase: generated.caseIndex,
          cases: 1,
        },
      }),
      root = await mkdtemp(join(tmpdir(), "llang-value-differential-cli-")),
      failureOut = join(root, "nested", "failure.json");
    try {
      const result = await runValueDifferentialCli(
        ["--seed", "19", "--cases", "1", "--failure-out", failureOut],
        async () => {
          throw mismatch;
        },
      );
      expect(result).toMatchObject({
        exitCode: 1,
        stream: "stderr",
        value: { status: "mismatch", failureOut },
      });
      expect(JSON.parse(await readFile(failureOut, "utf8"))).toEqual(
        mismatch.reproduction,
      );
      const writeFailure = await runValueDifferentialCli(
        ["--cases", "1", "--failure-out", root],
        async () => {
          throw mismatch;
        },
      );
      expect(writeFailure).toMatchObject({
        exitCode: 2,
        stream: "stderr",
        value: {
          status: "error",
          error: expect.stringContaining("failed to write reproduction"),
          reproduction: mismatch.reproduction,
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fixed corpus agrees across oracle, reference, TS, JSONC and Wasm", async () => {
    const kinds = new Set<string>(),
      operators = new Set<string>(),
      generatedCases = Array.from({ length: 24 }, (_, caseIndex) =>
        generateValueDifferentialCase(
          VALUE_DIFFERENTIAL_DEFAULT_SEED,
          caseIndex,
        ),
      );
    for (const generated of generatedCases)
      collectGeneratedCoverage(generated.expression, kinds, operators);
    expect([...kinds].sort()).toEqual([
      "binary",
      "field",
      "if",
      "literal",
      "param",
      "unary",
    ]);
    expect([...operators].sort()).toEqual([
      "!==",
      "%",
      "*",
      "+",
      "-",
      "/",
      "<",
      "<=",
      "===",
      ">",
      ">=",
      "minus",
    ]);
    expect(fingerprintFor(generatedCases)).toBe(
      "02475040087d4b32bd8a2bb6f031694b0a326ed1a59e1b3b570c060699b2a5ec",
    );
    const result = await runValueDifferential({
      seed: VALUE_DIFFERENTIAL_DEFAULT_SEED,
      cases: 24,
    });
    expect(result).toMatchObject({
      seed: VALUE_DIFFERENTIAL_DEFAULT_SEED,
      startCase: 0,
      cases: 24,
      inputs: 192,
    });
    expect(new Set(result.programHashes).size).toBeGreaterThan(16);
    expect(fingerprintFor(result.programHashes)).toBe(
      "580b200027acbad3fd8c5d7593fb30ec46e000ecfe1fc0733c8fd457bb7c8412",
    );
  }, 30_000);

  test("a single recorded case can be replayed by seed and case index", async () => {
    const first = await runValueDifferential({
        seed: 77,
        startCase: 11,
        cases: 1,
      }),
      replay = await runValueDifferential({
        seed: 77,
        startCase: 11,
        cases: 1,
      });
    expect(replay).toEqual(first);
  });
});
