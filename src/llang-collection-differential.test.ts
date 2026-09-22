import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCollectionDifferentialOutcomes,
  COLLECTION_DIFFERENTIAL_DEFAULT_SEED,
  COLLECTION_DIFFERENTIAL_FORMAT,
  CollectionDifferentialMismatch,
  CollectionDifferentialRunnerError,
  evaluateCollectionOracle,
  generateCollectionDifferentialCase,
  runCollectionDifferential,
  runCollectionDifferentialCase,
} from "./llang-collection-differential";
import {
  parseCollectionDifferentialOptions,
  runCollectionDifferentialCli,
} from "./llang-collection-differential-cli";
import {
  CollectionDifferentialHarnessError,
  type CollectionDifferentialOutcomes,
  captureCollectionDifferentialOutcome,
} from "./llang-collection-differential-harness";
import { fingerprintFor } from "./stable-hash";

function valueOutcomes(reference: number): CollectionDifferentialOutcomes {
  const expected = { kind: "value" as const, value: { marker: 1 } };
  return {
    oracle: expected,
    reference: {
      kind: "value",
      value: { marker: reference },
    },
    typescript: expected,
    jsonc: expected,
    wasm: expected,
  };
}

function inputAt(
  generated: ReturnType<typeof generateCollectionDifferentialCase>,
  index: number,
) {
  const input = generated.inputs[index];
  if (!input) throw new Error(`missing generated input ${index}`);
  return input;
}

const TEST_HASHES = {
  programHash: "0".repeat(64),
  interfaceHash: "1".repeat(64),
  wasmHash: "2".repeat(64),
};

describe("module-collection-v1 generated differential", () => {
  test("independent oracle module has no compiler or runtime imports", async () => {
    const source = await readFile(
      new URL("./llang-collection-differential-oracle.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/^\s*import\b/m);
  });

  test("case generation is deterministic and schedules every program family", () => {
    const first = generateCollectionDifferentialCase(123, 0),
      repeated = generateCollectionDifferentialCase(123, 0),
      generated = Array.from({ length: 10 }, (_, index) =>
        generateCollectionDifferentialCase(123, index),
      );
    expect(repeated).toEqual(first);
    expect(first.inputs).toHaveLength(8);
    expect(new Set(generated.map((item) => item.family))).toEqual(
      new Set([
        "transform-reduce",
        "stable-record-sort",
        "persistent-update",
        "snapshot-iteration",
        "returned-closure",
      ]),
    );
    expect(
      generated
        .filter((item) => item.family === "stable-record-sort")
        .map((item) => item.mode),
    ).toEqual(["ascending", "descending"]);
    expect(() => generateCollectionDifferentialCase(0x1_0000_0000, 0)).toThrow(
      "seed must be a uint32",
    );
    expect(() =>
      generateCollectionDifferentialCase(123, 0x1_0000_0000),
    ).toThrow("case index must be a uint32");
  });

  test("independent oracle distinguishes persistence, order, stability, capture and snapshot mutations", () => {
    const transform = generateCollectionDifferentialCase(7, 0),
      transformInput = inputAt(transform, 1),
      transformModel = { ...transform.model, bias: 2 },
      normalTransform = evaluateCollectionOracle(
        transformModel,
        transformInput,
      );
    expect(
      evaluateCollectionOracle(transformModel, transformInput, {
        reverseCallbacks: true,
      }),
    ).not.toEqual(normalTransform);
    expect(
      evaluateCollectionOracle(transformModel, transformInput, {
        duplicateCallbacks: true,
      }),
    ).not.toEqual(normalTransform);
    expect(
      evaluateCollectionOracle(transformModel, transformInput, {
        dropLastCallback: true,
      }),
    ).not.toEqual(normalTransform);
    expect(
      evaluateCollectionOracle(transformModel, transformInput, {
        rightFold: true,
      }),
    ).not.toEqual(normalTransform);
    expect(
      evaluateCollectionOracle(transformModel, transformInput, {
        ignoreFoldInitial: true,
      }),
    ).not.toEqual(normalTransform);
    expect(
      evaluateCollectionOracle(transformModel, transformInput, {
        wrongCapture: true,
      }),
    ).not.toEqual(normalTransform);
    expect(() =>
      evaluateCollectionOracle(
        transformModel,
        { ...transformInput, divisor: 0 },
        { eagerInactive: true },
      ),
    ).toThrow("DIVISION_BY_ZERO");

    const sort = generateCollectionDifferentialCase(7, 1),
      sortInput = inputAt(sort, 2),
      normalSort = evaluateCollectionOracle(sort.model, sortInput);
    expect(
      evaluateCollectionOracle(sort.model, sortInput, { unstableSort: true }),
    ).not.toEqual(normalSort);
    expect(
      evaluateCollectionOracle(sort.model, sortInput, {
        reverseComparator: true,
      }),
    ).not.toEqual(normalSort);

    const persistent = generateCollectionDifferentialCase(7, 2),
      persistentInput = inputAt(persistent, 0),
      normalPersistent = evaluateCollectionOracle(
        persistent.model,
        persistentInput,
      );
    expect(
      evaluateCollectionOracle(persistent.model, persistentInput, {
        mutateSetInput: true,
      }),
    ).not.toEqual(normalPersistent);
    expect(
      evaluateCollectionOracle(persistent.model, persistentInput, {
        mutateAppendInput: true,
      }),
    ).not.toEqual(normalPersistent);
    expect(() =>
      evaluateCollectionOracle(persistent.model, inputAt(persistent, 4)),
    ).toThrow("INDEX_OUT_OF_BOUNDS");
    expect(
      evaluateCollectionOracle(persistent.model, inputAt(persistent, 4), {
        looseAt: true,
      }),
    ).toMatchObject({ selected: 0 });

    const snapshot = generateCollectionDifferentialCase(7, 3),
      snapshotInput = inputAt(snapshot, 2);
    expect(
      evaluateCollectionOracle(snapshot.model, snapshotInput, {
        liveIteration: true,
      }),
    ).not.toEqual(evaluateCollectionOracle(snapshot.model, snapshotInput));

    const closure = generateCollectionDifferentialCase(7, 4),
      closureInput = inputAt(closure, 1);
    expect(
      evaluateCollectionOracle(closure.model, closureInput, {
        wrongCapture: true,
      }),
    ).not.toEqual(evaluateCollectionOracle(closure.model, closureInput));
  });

  test("comparison requires five lanes and preserves replay context", () => {
    const generated = generateCollectionDifferentialCase(91, 0);
    expect(() =>
      assertCollectionDifferentialOutcomes(
        generated,
        0,
        valueOutcomes(2),
        TEST_HASHES,
      ),
    ).toThrow(CollectionDifferentialMismatch);
    try {
      assertCollectionDifferentialOutcomes(
        generated,
        0,
        valueOutcomes(2),
        TEST_HASHES,
      );
    } catch (error) {
      const mismatch = error as CollectionDifferentialMismatch;
      expect(mismatch.reproduction).toMatchObject({
        seed: 91,
        caseIndex: 0,
        inputIndex: 0,
        family: "transform-reduce",
        hashes: TEST_HASHES,
        replay: { seed: 91, startCase: 0, cases: 1, inputIndex: 0 },
      });
    }
    expect(() =>
      assertCollectionDifferentialOutcomes(
        generated,
        0,
        {
          oracle: { kind: "value", value: null },
        } as never,
        TEST_HASHES,
      ),
    ).toThrow("must contain all five lanes");
    expect(() =>
      assertCollectionDifferentialOutcomes(
        generated,
        0,
        {
          oracle: { kind: "value", value: { a: 1, b: [2] } },
          reference: { kind: "value", value: { b: [2], a: 1 } },
          typescript: { kind: "value", value: { a: 1, b: [2] } },
          jsonc: { kind: "value", value: { b: [2], a: 1 } },
          wasm: { kind: "value", value: { a: 1, b: [2] } },
        },
        TEST_HASHES,
      ),
    ).not.toThrow();
    expect(() =>
      captureCollectionDifferentialOutcome(() => {
        throw new Error("wrapped ARITHMETIC_OVERFLOW detail");
      }),
    ).toThrow("wrapped ARITHMETIC_OVERFLOW detail");
    const sparse = Array(1),
      accessor = Object.defineProperty({}, "value", {
        enumerable: true,
        get: () => {
          throw new Error("accessor must not run");
        },
      });
    expect(() => captureCollectionDifferentialOutcome(() => sparse)).toThrow(
      "non-JSON array",
    );
    expect(() => captureCollectionDifferentialOutcome(() => accessor)).toThrow(
      "non-JSON record",
    );
    const special = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(special, "__proto__", {
      enumerable: true,
      value: 1,
    });
    const specialOutcome = captureCollectionDifferentialOutcome(() => special);
    expect(specialOutcome.kind).toBe("value");
    if (specialOutcome.kind === "value")
      expect(Object.hasOwn(specialOutcome.value as object, "__proto__")).toBe(
        true,
      );
  });

  test("CLI validates ranges and atomically records mismatch and runner errors", async () => {
    expect(() =>
      parseCollectionDifferentialOptions([
        "--input-index",
        "0",
        "--cases",
        "2",
      ]),
    ).toThrow("requires --cases 1");
    expect(() =>
      parseCollectionDifferentialOptions(["--input-index", "8"]),
    ).toThrow("must be between 0 and 7");
    expect(() =>
      parseCollectionDifferentialOptions(["--seed", "1", "--seed", "2"]),
    ).toThrow("duplicate option --seed");
    expect(() =>
      parseCollectionDifferentialOptions(["--unknown", "1"]),
    ).toThrow("unknown option --unknown");
    expect(() =>
      parseCollectionDifferentialOptions([
        "--start-case",
        String(0xffff_ffff),
        "--cases",
        "2",
      ]),
    ).toThrow("range must fit uint32");
    expect(() =>
      parseCollectionDifferentialOptions(["--cases", "--seed"]),
    ).toThrow("--cases requires a value");
    expect(() => parseCollectionDifferentialOptions(["unexpected"])).toThrow(
      "unexpected positional argument",
    );

    const generated = generateCollectionDifferentialCase(19, 0),
      mismatch = new CollectionDifferentialMismatch({
        format: COLLECTION_DIFFERENTIAL_FORMAT,
        version: 1,
        seed: generated.seed,
        caseIndex: generated.caseIndex,
        inputIndex: 0,
        family: generated.family,
        mode: generated.mode,
        model: generated.model,
        source: generated.source,
        input: inputAt(generated, 0),
        hashes: TEST_HASHES,
        outcomes: valueOutcomes(2),
        replay: { seed: 19, startCase: 0, cases: 1, inputIndex: 0 },
      }),
      root = await mkdtemp(join(tmpdir(), "llang-collection-cli-")),
      mismatchPath = join(root, "mismatch", "failure.json");
    try {
      const mismatchResult = await runCollectionDifferentialCli(
        ["--cases", "1", "--input-index", "0", "--failure-out", mismatchPath],
        async () => {
          throw mismatch;
        },
      );
      expect(mismatchResult).toMatchObject({
        exitCode: 1,
        stream: "stderr",
        value: { status: "mismatch", failureOut: mismatchPath },
      });
      expect(JSON.parse(await readFile(mismatchPath, "utf8"))).toEqual(
        mismatch.reproduction,
      );

      const runnerError = new CollectionDifferentialRunnerError({
          format: COLLECTION_DIFFERENTIAL_FORMAT,
          version: 1,
          kind: "runner-error",
          seed: generated.seed,
          caseIndex: generated.caseIndex,
          inputIndex: 0,
          family: generated.family,
          mode: generated.mode,
          model: generated.model,
          source: generated.source,
          inputs: generated.inputs,
          stage: "source-load",
          error: "generated checker rejected the case",
        }),
        runnerPath = join(root, "runner", "failure.json"),
        runnerResult = await runCollectionDifferentialCli(
          ["--cases", "1", "--input-index", "0", "--failure-out", runnerPath],
          async () => {
            throw runnerError;
          },
        );
      expect(runnerResult).toMatchObject({
        exitCode: 2,
        stream: "stderr",
        value: {
          status: "error",
          error: expect.stringContaining("RUNNER_ERROR"),
          failureOut: runnerPath,
        },
      });
      expect(JSON.parse(await readFile(runnerPath, "utf8"))).toEqual(
        runnerError.reproduction,
      );

      const writeFailure = await runCollectionDifferentialCli(
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fixed corpus covers all families and agrees across five lanes", async () => {
    const generated = Array.from({ length: 24 }, (_, caseIndex) =>
        generateCollectionDifferentialCase(
          COLLECTION_DIFFERENTIAL_DEFAULT_SEED,
          caseIndex,
        ),
      ),
      families = new Set(generated.map((item) => item.family)),
      modes = new Set(generated.map((item) => item.mode));
    expect(families.size).toBe(5);
    expect(modes).toEqual(
      new Set(["ascending", "descending", "mixed-value-fault"]),
    );
    expect(fingerprintFor(generated)).toBe(
      "3633dcc4dd95a65b55a4848084912a0e5a5f5dfbc745630f8d13daf5008ed22f",
    );

    const result = await runCollectionDifferential({
      seed: COLLECTION_DIFFERENTIAL_DEFAULT_SEED,
      cases: 24,
    });
    expect(result).toMatchObject({
      seed: COLLECTION_DIFFERENTIAL_DEFAULT_SEED,
      startCase: 0,
      cases: 24,
      inputs: 192,
    });
    expect(new Set(result.programHashes).size).toBe(24);
    expect(fingerprintFor(result.programHashes)).toBe(
      "135f31f0ba840a78a09b8d79308bf211a090e1147281fc90a78e13a01baaba0b",
    );
    expect(fingerprintFor(result.interfaceHashes)).toBe(
      "e81c8ead559c8a2eed3a701764a930e3e65fbfc6622857672d10eb5fd505f94b",
    );
    expect(fingerprintFor(result.wasmHashes)).toBe(
      "97063baa87fb81bc973d68757d2daf6e78e87c7fc4bc8171fcf7029851eee837",
    );
  }, 30_000);

  test("one case and input can be replayed", async () => {
    const options = { seed: 77, startCase: 13, cases: 1, inputIndex: 6 },
      first = await runCollectionDifferential(options),
      replay = await runCollectionDifferential(options);
    expect(replay).toEqual(first);
    expect(first.inputs).toBe(1);
  });

  test("runner errors retain the complete generated case", async () => {
    try {
      await runCollectionDifferential({
        seed: 77,
        startCase: 13,
        cases: 1,
        inputIndex: 8,
      });
      throw new Error("expected a Collection runner error");
    } catch (error) {
      expect(error).toBeInstanceOf(CollectionDifferentialRunnerError);
      const runner = error as CollectionDifferentialRunnerError;
      expect(runner.reproduction).toMatchObject({
        kind: "runner-error",
        seed: 77,
        caseIndex: 13,
        inputIndex: 8,
        family: "snapshot-iteration",
        stage: "case-runner",
      });
      expect(runner.reproduction.inputs).toHaveLength(8);
    }
  });

  test("harness errors identify the failing stage and input", async () => {
    const generated = generateCollectionDifferentialCase(77, 0);
    try {
      await runCollectionDifferentialCase({
        ...generated,
        model: { ...generated.model, family: "persistent-update" },
      });
      throw new Error("expected a Collection harness error");
    } catch (error) {
      expect(error).toBeInstanceOf(CollectionDifferentialHarnessError);
      expect(error).toMatchObject({ stage: "input-lanes", inputIndex: 0 });
    }
  });
});
