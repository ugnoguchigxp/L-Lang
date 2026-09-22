import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertEffectsTraceOutcomes,
  EFFECTS_TRACE_DIFFERENTIAL_DEFAULT_SEED,
  EFFECTS_TRACE_DIFFERENTIAL_FORMAT,
  EffectsTraceMismatch,
  evaluateEffectsTraceOracle,
  generateEffectsTraceCase,
  runEffectsTraceCase,
  runEffectsTraceDifferential,
} from "./llang-effects-trace-differential";
import {
  parseEffectsTraceOptions,
  runEffectsTraceCli,
} from "./llang-effects-trace-differential-cli";
import {
  assertFiveEffectsTraceLanes,
  type EffectsTraceHashes,
  type EffectsTraceOutcomes,
  normalizeEffectsTrace,
  sameEffectsTrace,
  strictEffectsTraceJson,
} from "./llang-effects-trace-differential-harness";
import type { EffectsTraceEvent } from "./llang-effects-trace-differential-oracle";
import { fingerprintFor } from "./stable-hash";

const HASHES: EffectsTraceHashes = {
  sourceSetHash: "4".repeat(64),
  interfaceHash: "0".repeat(64),
  semanticProjection: "1".repeat(64),
  loweredHash: "2".repeat(64),
  wasmHash: "3".repeat(64),
};

const completed = (result: unknown): readonly EffectsTraceEvent[] =>
  [
    {
      kind: "request",
      sequence: 1,
      operation: "host.x",
      version: 1,
      value: 1,
    },
    {
      kind: "response",
      sequence: 1,
      operation: "host.x",
      version: 1,
      value: result as number,
    },
    { kind: "terminal", status: "completed", result: result as number },
  ] as const;

describe("module-effects-v1 generated trace differential", () => {
  test("oracle is import-free and reference does not use Wasm or the runtime", async () => {
    const oracle = await readFile(
        new URL(
          "./llang-effects-trace-differential-oracle.ts",
          import.meta.url,
        ),
        "utf8",
      ),
      reference = await readFile(
        new URL(
          "./llang-effects-trace-differential-reference.ts",
          import.meta.url,
        ),
        "utf8",
      );
    expect(oracle).not.toMatch(/^\s*import\b/m);
    expect(reference).not.toContain("llang-effects-state-machine");
    expect(reference).not.toContain("llang-effects-typed-runtime");
    expect(reference).not.toContain("emitTypedEffectsWasm");
  });

  test("generation is deterministic and schedules all six families and eight scenarios", () => {
    const first = generateEffectsTraceCase(41, 0),
      repeated = generateEffectsTraceCase(41, 0),
      generated = Array.from({ length: 6 }, (_, index) =>
        generateEffectsTraceCase(41, index),
      );
    expect(repeated).toEqual(first);
    expect(first.scenarios).toHaveLength(8);
    expect(new Set(generated.map((item) => item.family))).toEqual(
      new Set([
        "scalar-chain",
        "wide-number-chain",
        "bytes-chain",
        "record-chain",
        "list-chain",
        "mixed-chain",
      ]),
    );
    expect(
      generated.every(
        (item) =>
          item.model.operations.length >= 2 &&
          item.model.operations.length <= 4,
      ),
    ).toBe(true);
    expect(() => generateEffectsTraceCase(0x1_0000_0000, 0)).toThrow(
      "seed must be a uint32",
    );
  });

  test("generation keeps typed i32 values valid across the full case-id range", async () => {
    for (const caseIndex of [0xffff_fffa, 0xffff_ffff])
      expect(
        (
          await runEffectsTraceCase(
            generateEffectsTraceCase(
              EFFECTS_TRACE_DIFFERENTIAL_DEFAULT_SEED,
              caseIndex,
            ),
          )
        ).scenarios,
      ).toBe(8);
  });

  test("oracle detects ordering, count, grant, failure, result and tagged-value mutations", () => {
    const mixed = generateEffectsTraceCase(77, 5),
      success = mixed.scenarios[0],
      denied = mixed.scenarios[7],
      failure = mixed.scenarios[6];
    if (!success || !denied || !failure) throw new Error("missing scenario");
    const expected = evaluateEffectsTraceOracle(mixed.model, success);
    for (const mutation of [
      { reverseRequests: true },
      { duplicateFirst: true },
      { dropMiddle: true },
      { firstResult: true },
      { coerceTagged: true },
    ])
      expect(
        sameEffectsTrace(
          evaluateEffectsTraceOracle(mixed.model, success, mutation),
          expected,
        ),
      ).toBe(false);
    expect(
      sameEffectsTrace(
        evaluateEffectsTraceOracle(mixed.model, denied, { ignoreGrant: true }),
        evaluateEffectsTraceOracle(mixed.model, denied),
      ),
    ).toBe(false);
    expect(
      sameEffectsTrace(
        evaluateEffectsTraceOracle(mixed.model, failure, {
          continueAfterFailure: true,
        }),
        evaluateEffectsTraceOracle(mixed.model, failure),
      ),
    ).toBe(false);
  });

  test("strict trace values reject holes, accessors, symbols and non-finite numbers", () => {
    const sparse = Array(1),
      accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get: () => 1,
    });
    expect(() => strictEffectsTraceJson(sparse)).toThrow(
      "non-JSON trace array",
    );
    expect(() => strictEffectsTraceJson(accessor)).toThrow(
      "non-JSON trace record",
    );
    expect(() => strictEffectsTraceJson({ [Symbol("x")]: 1 })).toThrow(
      "non-JSON trace record",
    );
    expect(() => strictEffectsTraceJson(Number.POSITIVE_INFINITY)).toThrow(
      "non-finite trace number",
    );
    expect(strictEffectsTraceJson({ b: 1, a: [true, null] })).toEqual({
      a: [true, null],
      b: 1,
    });
  });

  test("comparison requires all five lanes and preserves mismatch replay", () => {
    const generated = generateEffectsTraceCase(91, 0),
      expected = completed(1),
      outcomes: EffectsTraceOutcomes = {
        oracle: expected,
        reference: completed(2),
        typescript: expected,
        jsonc: expected,
        wasm: expected,
      };
    expect(() =>
      assertEffectsTraceOutcomes(generated, 0, outcomes, HASHES, "{}\n"),
    ).toThrow(EffectsTraceMismatch);
    try {
      assertEffectsTraceOutcomes(generated, 0, outcomes, HASHES, "{}\n");
    } catch (error) {
      const mismatch = error as EffectsTraceMismatch;
      expect(mismatch.reproduction).toMatchObject({
        seed: 91,
        caseIndex: 0,
        scenarioIndex: 0,
        hashes: HASHES,
        flattenedJsonc: "{}\n",
        replay: { seed: 91, startCase: 0, cases: 1, scenarioIndex: 0 },
      });
    }
    expect(() =>
      assertFiveEffectsTraceLanes({
        oracle: expected,
      } as EffectsTraceOutcomes),
    ).toThrow("all five lanes");
  });

  test("trace comparison detects version, response, order and list mutations", () => {
    const original = [
        {
          kind: "request",
          sequence: 1,
          operation: "host.x",
          version: 1,
          value: { b: 2, a: [1, 2] },
        },
        {
          kind: "response",
          sequence: 1,
          operation: "host.x",
          version: 1,
          value: [1, 2],
        },
        { kind: "terminal", status: "completed", result: [1, 2] },
      ] as const,
      propertyOrder = [
        {
          kind: "request",
          sequence: 1,
          operation: "host.x",
          version: 1,
          value: { a: [1, 2], b: 2 },
        },
        original[1],
        original[2],
      ] as const;
    expect(sameEffectsTrace(original, propertyOrder)).toBe(true);
    expect(
      sameEffectsTrace(original, [
        { ...original[0], version: 2 },
        original[1],
        original[2],
      ]),
    ).toBe(false);
    expect(sameEffectsTrace(original, [original[0], original[2]])).toBe(false);
    expect(
      sameEffectsTrace(original, [original[1], original[0], original[2]]),
    ).toBe(false);
    expect(
      sameEffectsTrace(original, [
        original[0],
        { ...original[1], value: [2, 1] },
        { ...original[2], result: [2, 1] },
      ]),
    ).toBe(false);
    expect(() =>
      normalizeEffectsTrace([
        { ...original[0], extra: true },
        original[1],
        original[2],
      ]),
    ).toThrow("invalid effects value event");
    expect(() =>
      normalizeEffectsTrace([original[2], original[0], original[1]]),
    ).toThrow("terminal must be the final trace event");
    expect(() =>
      normalizeEffectsTrace([
        original[0],
        { ...original[1], operation: "host.other" },
        original[2],
      ]),
    ).toThrow("unmatched effects trace outcome");
    expect(() =>
      normalizeEffectsTrace([
        { ...original[0], sequence: 2 },
        { ...original[1], sequence: 2 },
        original[2],
      ]),
    ).toThrow("non-contiguous effects trace sequence");
    expect(() =>
      normalizeEffectsTrace([
        { ...original[0], sequence: Number.MAX_SAFE_INTEGER + 1 },
        original[1],
        original[2],
      ]),
    ).toThrow("invalid effects trace event identity");
    expect(() =>
      normalizeEffectsTrace([
        original[0],
        original[1],
        { ...original[2], result: [2, 1] },
      ]),
    ).toThrow("invalid completed effects trace");
    expect(() =>
      normalizeEffectsTrace([
        original[0],
        {
          kind: "host-failure",
          sequence: 1,
          operation: "host.x",
          version: 1,
          code: "HOST_FAILURE",
        },
        { kind: "terminal", status: "completed", result: 1 },
      ]),
    ).toThrow("invalid completed effects trace");
  });

  test("all five execution lanes agree for every family", async () => {
    for (let caseIndex = 0; caseIndex < 6; caseIndex++)
      expect(
        (
          await runEffectsTraceCase(
            generateEffectsTraceCase(
              EFFECTS_TRACE_DIFFERENTIAL_DEFAULT_SEED,
              caseIndex,
            ),
          )
        ).scenarios,
      ).toBe(8);
  });

  test("fixed 24-program corpus covers 192 scenarios and preserves digests", async () => {
    const generated = Array.from({ length: 24 }, (_, caseIndex) =>
        generateEffectsTraceCase(
          EFFECTS_TRACE_DIFFERENTIAL_DEFAULT_SEED,
          caseIndex,
        ),
      ),
      result = await runEffectsTraceDifferential({
        seed: EFFECTS_TRACE_DIFFERENTIAL_DEFAULT_SEED,
        cases: 24,
      }),
      values = generated.flatMap((item) =>
        item.scenarios.flatMap((scenario) => scenario.responses),
      );
    expect(result).toMatchObject({
      format: EFFECTS_TRACE_DIFFERENTIAL_FORMAT,
      cases: 24,
      scenarios: 192,
      uniqueSemanticProjections: 24,
      uniqueWasmHashes: 24,
    });
    expect(fingerprintFor({ cases: generated })).toBe(
      "667eb5b43bc2582ee0cdcf8b365976fae6bdb394cbee95b8b719a8e9702f805b",
    );
    expect(
      values.some(
        (value) =>
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          "bytes" in value &&
          value.bytes === "",
      ),
    ).toBe(true);
    expect(values.some((value) => Array.isArray(value) && !value.length)).toBe(
      true,
    );
    expect(
      values.some((value) => Array.isArray(value) && value.length === 1),
    ).toBe(true);
    expect(
      values.some(
        (value) =>
          Array.isArray(value) &&
          value.includes(-0x8000_0000) &&
          value.includes(0x7fff_ffff),
      ),
    ).toBe(true);
    expect(
      fingerprintFor({
        values: result.hashes.map((item) => item.sourceSetHash),
      }),
    ).toBe("6a5403ea7ee15b1e8d93d1bd4241eb66f2d724b32d5619e1edeb827db1a2f8d0");
    expect(
      fingerprintFor({
        values: result.hashes.map((item) => item.interfaceHash),
      }),
    ).toBe("1f9172dd364ffa9dd375442c295317e3c77398d50fa707642d549deacdcf980b");
    expect(
      fingerprintFor({
        values: result.hashes.map((item) => item.semanticProjection),
      }),
    ).toBe("39d62b1d323c0d949e394a54f2da6bd5a1c8a534c1f36e00e18abd9373f0a121");
    expect(
      fingerprintFor({ values: result.hashes.map((item) => item.loweredHash) }),
    ).toBe("832e07960db34a9c3bf276c1f7821ce9341cfd5948edbe86f02cd67dac046af6");
    expect(
      fingerprintFor({ values: result.hashes.map((item) => item.wasmHash) }),
    ).toBe("7f76b0dd34639e22e0d8bee539556ed453ecebfd06ca4982dc61d5472b52d101");
  });

  test("CLI parsing is strict and supports single-scenario replay", async () => {
    expect(
      parseEffectsTraceOptions([
        "--seed",
        "9",
        "--start-case",
        "3",
        "--cases",
        "1",
        "--scenario-index",
        "7",
      ]),
    ).toMatchObject({ seed: 9, startCase: 3, cases: 1, scenarioIndex: 7 });
    for (const args of [
      ["--unknown", "1"],
      ["--seed", "1", "--seed", "2"],
      ["--cases", "2", "--scenario-index", "0"],
      ["--scenario-index", "8", "--cases", "1"],
    ])
      expect(() => parseEffectsTraceOptions(args)).toThrow();
    const result = await runEffectsTraceCli(
      ["--cases", "1", "--scenario-index", "0"],
      async () =>
        ({
          format: EFFECTS_TRACE_DIFFERENTIAL_FORMAT,
          cases: 1,
          scenarios: 1,
        }) as Awaited<ReturnType<typeof runEffectsTraceDifferential>>,
    );
    expect(result).toMatchObject({
      exitCode: 0,
      stream: "stdout",
      value: { status: "pass", cases: 1, scenarios: 1 },
    });
  });

  test("CLI atomically records semantic mismatches", async () => {
    const root = await mkdtemp(join(tmpdir(), "llang-effects-trace-cli-")),
      failureOut = join(root, "failure.json"),
      generated = generateEffectsTraceCase(93, 0),
      trace = completed(1),
      outcomes: EffectsTraceOutcomes = {
        oracle: trace,
        reference: completed(2),
        typescript: trace,
        jsonc: trace,
        wasm: trace,
      },
      mismatch = new EffectsTraceMismatch({
        format: EFFECTS_TRACE_DIFFERENTIAL_FORMAT,
        seed: generated.seed,
        caseIndex: generated.caseIndex,
        scenarioIndex: 0,
        family: generated.family,
        source: generated.source,
        model: generated.model,
        scenarios: generated.scenarios,
        hashes: HASHES,
        outcomes,
        replay: { seed: 93, startCase: 0, cases: 1, scenarioIndex: 0 },
      });
    try {
      const result = await runEffectsTraceCli(
        ["--cases", "1", "--failure-out", failureOut],
        async () => {
          throw mismatch;
        },
      );
      expect(result).toMatchObject({ exitCode: 1, stream: "stderr" });
      expect(JSON.parse(await readFile(failureOut, "utf8"))).toMatchObject({
        seed: 93,
        caseIndex: 0,
        scenarioIndex: 0,
      });
      const writeFailure = await runEffectsTraceCli(
        ["--cases", "1", "--failure-out", root],
        async () => {
          throw mismatch;
        },
      );
      expect(writeFailure).toMatchObject({
        exitCode: 2,
        stream: "stderr",
        value: { status: "error", stage: "artifact-write" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
