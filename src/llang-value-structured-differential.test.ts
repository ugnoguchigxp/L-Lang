import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ValueExpression } from "./llang-module-value-ir";
import { fingerprintFor } from "./stable-hash";
import {
  parseValueStructuredDifferentialOptions,
  runValueStructuredDifferentialCli,
} from "./llang-value-structured-differential-cli";
import {
  assertValueStructuredDifferentialOutcomes,
  evaluateValueStructuredOracle,
  generateValueStructuredDifferentialCase,
  runValueStructuredDifferential,
  VALUE_STRUCTURED_DIFFERENTIAL_DEFAULT_SEED,
  VALUE_STRUCTURED_DIFFERENTIAL_FORMAT,
  type StructuredOracleExpression,
  ValueStructuredDifferentialMismatch,
  ValueStructuredDifferentialRunnerError,
} from "./llang-value-structured-differential";

function collectModelCoverage(
  expression: StructuredOracleExpression,
  kinds: Set<string>,
  tags: Set<string>,
): void {
  kinds.add(expression.kind);
  switch (expression.kind) {
    case "literal":
    case "input":
    case "local":
      return;
    case "unary":
      collectModelCoverage(expression.operand, kinds, tags);
      return;
    case "binary":
      collectModelCoverage(expression.left, kinds, tags);
      collectModelCoverage(expression.right, kinds, tags);
      return;
    case "if":
      collectModelCoverage(expression.condition, kinds, tags);
      collectModelCoverage(expression.whenTrue, kinds, tags);
      collectModelCoverage(expression.whenFalse, kinds, tags);
      return;
    case "variant":
      tags.add(expression.tag);
      collectModelCoverage(expression.value, kinds, tags);
      return;
    case "block":
      expression.bindings.forEach((binding) => {
        collectModelCoverage(binding.value, kinds, tags);
      });
      collectModelCoverage(expression.result, kinds, tags);
      return;
    case "match":
      collectModelCoverage(expression.value, kinds, tags);
      expression.cases.forEach((item) => {
        tags.add(item.tag);
        collectModelCoverage(item.body, kinds, tags);
      });
  }
}

function collectValueCoverage(
  expression: ValueExpression,
  kinds: Set<string>,
): void {
  kinds.add(expression.kind);
  switch (expression.kind) {
    case "literal":
    case "param":
    case "local":
      return;
    case "field":
      collectValueCoverage(expression.base, kinds);
      return;
    case "unary":
      collectValueCoverage(expression.operand, kinds);
      return;
    case "binary":
      collectValueCoverage(expression.left, kinds);
      collectValueCoverage(expression.right, kinds);
      return;
    case "call":
    case "intrinsic":
      expression.arguments.forEach((item) => {
        collectValueCoverage(item, kinds);
      });
      return;
    case "record":
    case "variant":
      expression.fields.forEach((field) => {
        collectValueCoverage(field.value, kinds);
      });
      return;
    case "block":
      expression.bindings.forEach((binding) => {
        collectValueCoverage(binding.value, kinds);
      });
      collectValueCoverage(expression.result, kinds);
      return;
    case "if":
      collectValueCoverage(expression.condition, kinds);
      collectValueCoverage(expression.whenTrue, kinds);
      collectValueCoverage(expression.whenFalse, kinds);
      return;
    case "match":
      collectValueCoverage(expression.value, kinds);
      expression.cases.forEach((item) => {
        collectValueCoverage(item.body, kinds);
      });
  }
}

function outcomesWith(referenceValue: number) {
  return {
    oracle: { kind: "value" as const, value: 5 },
    reference: { kind: "value" as const, value: referenceValue },
    typescript: { kind: "value" as const, value: 5 },
    jsonc: { kind: "value" as const, value: 5 },
    wasm: { kind: "value" as const, value: 5 },
  };
}

function requiredInput(
  generated: ReturnType<typeof generateValueStructuredDifferentialCase>,
  index: number,
) {
  const input = generated.inputs[index];
  if (!input) throw new Error(`missing generated input ${index}`);
  return input;
}

describe("module-value-v1 structured generated differential", () => {
  test("case generation is deterministic and keeps both program shapes", () => {
    const internal = generateValueStructuredDifferentialCase(123, 0),
      repeated = generateValueStructuredDifferentialCase(123, 0),
      unionInput = generateValueStructuredDifferentialCase(123, 1);
    expect(repeated).toEqual(internal);
    expect(internal.shape).toBe("internal-variant");
    expect(unionInput.shape).toBe("union-input");
    expect(internal.inputs).toHaveLength(8);
    expect(internal.inputs.map((item) => item.choice.tag)).toContain("Alpha");
    expect(internal.inputs.map((item) => item.choice.tag)).toContain("Beta");
    const choice = internal.source.types.find((item) => item.name === "Choice");
    expect(choice?.kind).toBe("union");
    if (choice?.kind !== "union")
      throw new Error("generated Choice union is missing");
    expect(
      choice.variants.map((variant) => ({
        tag: variant.tag,
        fields: variant.fields.map((field) => field.name),
      })),
    ).toEqual([
      { tag: "Alpha", fields: ["alphaValue"] },
      { tag: "Beta", fields: ["betaValue"] },
    ]);
    expect(() =>
      generateValueStructuredDifferentialCase(123, 0x1_0000_0000),
    ).toThrow("case index must be a uint32");
    expect(() =>
      generateValueStructuredDifferentialCase(0x1_0000_0000, 0),
    ).toThrow("seed must be a uint32");
  });

  test("oracle fixes sequential bindings, payload scope and selected-case evaluation", () => {
    const normal = generateValueStructuredDifferentialCase(7, 0),
      normalInput = requiredInput(normal, 0);
    expect(
      evaluateValueStructuredOracle(normal.oracleExpression, normalInput),
    ).toBe(5 + normal.offsetDelta);
    expect(() =>
      evaluateValueStructuredOracle(normal.oracleExpression, normalInput, {
        independentBindings: true,
      }),
    ).toThrow("unknown local offset");
    expect(() =>
      evaluateValueStructuredOracle(normal.oracleExpression, normalInput, {
        dropOuterLocals: true,
      }),
    ).toThrow("unknown local adjusted");
    expect(
      evaluateValueStructuredOracle(normal.oracleExpression, normalInput, {
        wrongPayload: true,
      }),
    ).toBe(6 + normal.offsetDelta);

    const inactiveDivision = generateValueStructuredDifferentialCase(7, 7),
      alphaInput = requiredInput(inactiveDivision, 0);
    expect(
      evaluateValueStructuredOracle(
        inactiveDivision.oracleExpression,
        alphaInput,
      ),
    ).toBe(7 + inactiveDivision.offsetDelta);
    expect(() =>
      evaluateValueStructuredOracle(
        inactiveDivision.oracleExpression,
        alphaInput,
        { eagerMatch: true },
      ),
    ).toThrow("division by zero");
    expect(() =>
      evaluateValueStructuredOracle(
        inactiveDivision.oracleExpression,
        alphaInput,
        { swapTag: true },
      ),
    ).toThrow("division by zero");

    const inactiveOverflow = generateValueStructuredDifferentialCase(7, 8),
      betaInput = requiredInput(inactiveOverflow, 1);
    expect(
      evaluateValueStructuredOracle(
        inactiveOverflow.oracleExpression,
        betaInput,
      ),
    ).toBe(-5 - inactiveOverflow.offsetDelta);
    expect(() =>
      evaluateValueStructuredOracle(
        inactiveOverflow.oracleExpression,
        betaInput,
        { eagerMatch: true },
      ),
    ).toThrow("i32 overflow");

    const reversed = generateValueStructuredDifferentialCase(7, 14),
      reversedInput = requiredInput(reversed, 0),
      tagSelected = evaluateValueStructuredOracle(
        reversed.oracleExpression,
        reversedInput,
      ),
      ordinalSelected = evaluateValueStructuredOracle(
        reversed.oracleExpression,
        reversedInput,
        { ordinalMatch: true },
      );
    expect(reversed.caseOrder).toBe("beta-first");
    expect(ordinalSelected).not.toBe(tagSelected);
  });

  test("comparison requires five lanes and records tag and replay input", () => {
    const generated = generateValueStructuredDifferentialCase(91, 0);
    expect(() =>
      assertValueStructuredDifferentialOutcomes(generated, 0, outcomesWith(6)),
    ).toThrow(ValueStructuredDifferentialMismatch);
    try {
      assertValueStructuredDifferentialOutcomes(generated, 0, outcomesWith(6));
    } catch (error) {
      const mismatch = error as ValueStructuredDifferentialMismatch;
      expect(mismatch.reproduction).toMatchObject({
        seed: 91,
        caseIndex: 0,
        inputIndex: 0,
        selectedTag: "Alpha",
        replay: { seed: 91, startCase: 0, cases: 1, inputIndex: 0 },
      });
    }
    expect(() =>
      assertValueStructuredDifferentialOutcomes(generated, 0, {
        oracle: { kind: "value", value: 5 },
      } as never),
    ).toThrow("must contain all five lanes");
  });

  test("CLI validates replay arguments and atomically records mismatches", async () => {
    expect(() =>
      parseValueStructuredDifferentialOptions([
        "--input-index",
        "0",
        "--cases",
        "2",
      ]),
    ).toThrow("requires --cases 1");
    expect(() =>
      parseValueStructuredDifferentialOptions(["--input-index", "8"]),
    ).toThrow("must be between 0 and 7");
    expect(() =>
      parseValueStructuredDifferentialOptions(["--seed", "1", "--seed", "2"]),
    ).toThrow("duplicate option --seed");
    expect(() =>
      parseValueStructuredDifferentialOptions(["--unknown", "1"]),
    ).toThrow("unknown option --unknown");
    expect(() =>
      parseValueStructuredDifferentialOptions([
        "--start-case",
        String(0xffff_ffff),
        "--cases",
        "2",
      ]),
    ).toThrow("range must fit uint32");
    expect(() =>
      parseValueStructuredDifferentialOptions(["--cases", "--seed"]),
    ).toThrow("--cases requires a value");
    expect(() =>
      parseValueStructuredDifferentialOptions(["unexpected"]),
    ).toThrow("unexpected positional argument");

    const generated = generateValueStructuredDifferentialCase(19, 0),
      input = requiredInput(generated, 0);
    const mismatch = new ValueStructuredDifferentialMismatch({
        format: VALUE_STRUCTURED_DIFFERENTIAL_FORMAT,
        version: 1,
        seed: generated.seed,
        caseIndex: generated.caseIndex,
        inputIndex: 0,
        shape: generated.shape,
        mode: generated.mode,
        caseOrder: generated.caseOrder,
        offsetDelta: generated.offsetDelta,
        selectedTag: "Alpha",
        input,
        oracleExpression: generated.oracleExpression,
        source: generated.source,
        outcomes: outcomesWith(6),
        replay: { seed: 19, startCase: 0, cases: 1, inputIndex: 0 },
      }),
      root = await mkdtemp(join(tmpdir(), "llang-value-structured-cli-")),
      failureOut = join(root, "nested", "failure.json");
    try {
      const result = await runValueStructuredDifferentialCli(
        [
          "--seed",
          "19",
          "--cases",
          "1",
          "--input-index",
          "0",
          "--failure-out",
          failureOut,
        ],
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
      const writeFailure = await runValueStructuredDifferentialCli(
        ["--cases", "1", "--failure-out", root],
        async () => {
          throw mismatch;
        },
      );
      expect(writeFailure).toMatchObject({
        exitCode: 2,
        value: {
          status: "error",
          error: expect.stringContaining("failed to write reproduction"),
        },
      });
      const runnerFailureOut = join(root, "runner", "failure.json"),
        runnerError = new ValueStructuredDifferentialRunnerError({
          format: VALUE_STRUCTURED_DIFFERENTIAL_FORMAT,
          version: 1,
          kind: "runner-error",
          seed: generated.seed,
          caseIndex: generated.caseIndex,
          inputIndex: 0,
          shape: generated.shape,
          mode: generated.mode,
          caseOrder: generated.caseOrder,
          offsetDelta: generated.offsetDelta,
          oracleExpression: generated.oracleExpression,
          source: generated.source,
          inputs: generated.inputs,
          error: "generated checker rejected the case",
        }),
        runnerFailure = await runValueStructuredDifferentialCli(
          [
            "--cases",
            "1",
            "--input-index",
            "0",
            "--failure-out",
            runnerFailureOut,
          ],
          async () => {
            throw runnerError;
          },
        );
      expect(runnerFailure).toMatchObject({
        exitCode: 2,
        stream: "stderr",
        value: {
          status: "error",
          error: expect.stringContaining("RUNNER_ERROR"),
          failureOut: runnerFailureOut,
        },
      });
      expect(JSON.parse(await readFile(runnerFailureOut, "utf8"))).toEqual(
        runnerError.reproduction,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fixed corpus covers the structured grammar and agrees in all five lanes", async () => {
    const modelKinds = new Set<string>(),
      valueKinds = new Set<string>(),
      tags = new Set<string>(),
      shapes = new Set<string>(),
      modes = new Set<string>(),
      caseOrders = new Set<string>(),
      shapeModes = new Set<string>(),
      generatedCases = Array.from({ length: 24 }, (_, caseIndex) =>
        generateValueStructuredDifferentialCase(
          VALUE_STRUCTURED_DIFFERENTIAL_DEFAULT_SEED,
          caseIndex,
        ),
      );
    for (const generated of generatedCases) {
      shapes.add(generated.shape);
      modes.add(generated.mode);
      caseOrders.add(generated.caseOrder);
      shapeModes.add(`${generated.shape}:${generated.mode}`);
      collectModelCoverage(generated.oracleExpression, modelKinds, tags);
      collectValueCoverage(generated.expression, valueKinds);
    }
    expect([...shapes].sort()).toEqual(["internal-variant", "union-input"]);
    expect([...modes].sort()).toEqual([
      "inactive-division",
      "inactive-overflow",
      "normal-add",
      "normal-multiply",
      "normal-subtract",
      "selected-division",
    ]);
    expect(shapeModes.size).toBe(12);
    expect([...caseOrders].sort()).toEqual(["alpha-first", "beta-first"]);
    expect([...tags].sort()).toEqual(["Alpha", "Beta"]);
    expect(fingerprintFor(generatedCases)).toBe(
      "53b1d32eb49fea480c1ab543282b17c893d4e179a39a771422bacbc7a0e05e44",
    );
    expect(modelKinds).toEqual(
      new Set([
        "binary",
        "block",
        "if",
        "input",
        "literal",
        "local",
        "match",
        "variant",
      ]),
    );
    for (const kind of ["block", "match", "variant"])
      expect(valueKinds).toContain(kind);

    const result = await runValueStructuredDifferential({
      seed: VALUE_STRUCTURED_DIFFERENTIAL_DEFAULT_SEED,
      cases: 24,
    });
    expect(result).toMatchObject({
      seed: VALUE_STRUCTURED_DIFFERENTIAL_DEFAULT_SEED,
      startCase: 0,
      cases: 24,
      inputs: 192,
    });
    expect(new Set(result.programHashes).size).toBeGreaterThan(16);
    expect(fingerprintFor(result.programHashes)).toBe(
      "287009d622401c7cda79854e563f1dc8661feda63fe27e8404591214da3be176",
    );
  }, 30_000);

  test("a single case and input can be replayed", async () => {
    const options = { seed: 77, startCase: 11, cases: 1, inputIndex: 6 },
      first = await runValueStructuredDifferential(options),
      replay = await runValueStructuredDifferential(options);
    expect(replay).toEqual(first);
    expect(first.inputs).toBe(1);
  });

  test("runner failures retain generated case context", async () => {
    try {
      await runValueStructuredDifferential({
        seed: 77,
        startCase: 11,
        cases: 1,
        inputIndex: 8,
      });
      throw new Error("expected a structured runner error");
    } catch (error) {
      expect(error).toBeInstanceOf(ValueStructuredDifferentialRunnerError);
      const runnerError = error as ValueStructuredDifferentialRunnerError;
      expect(runnerError.reproduction).toMatchObject({
        kind: "runner-error",
        seed: 77,
        caseIndex: 11,
        inputIndex: 8,
        shape: "union-input",
      });
      expect(runnerError.reproduction.source.functions[0]?.body.kind).toBe(
        "block",
      );
    }
  });
});
