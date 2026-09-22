import {
  assertFiveEffectsTraceLanes,
  EFFECTS_TRACE_LANES,
  EffectsTraceHarnessError,
  type EffectsTraceHashes,
  type EffectsTraceOutcomes,
  runEffectsTraceHarness,
  sameEffectsTrace,
} from "./llang-effects-trace-differential-harness";
import {
  type EffectsTraceCaseModel,
  type EffectsTraceFamily,
  type EffectsTraceJson,
  type EffectsTraceScenario,
  evaluateEffectsTraceOracle,
} from "./llang-effects-trace-differential-oracle";

export {
  type EffectsTraceOracleMutation,
  evaluateEffectsTraceOracle,
} from "./llang-effects-trace-differential-oracle";

export const EFFECTS_TRACE_DIFFERENTIAL_FORMAT =
  "llang-effects-trace-differential-v1" as const;
export const EFFECTS_TRACE_DIFFERENTIAL_DEFAULT_SEED = 20260924;

export type GeneratedEffectsTraceCase = Readonly<{
  format: typeof EFFECTS_TRACE_DIFFERENTIAL_FORMAT;
  seed: number;
  caseIndex: number;
  family: EffectsTraceFamily;
  model: EffectsTraceCaseModel;
  scenarios: readonly EffectsTraceScenario[];
  source: string;
}>;

const FAMILIES: readonly EffectsTraceFamily[] = [
  "scalar-chain",
  "wide-number-chain",
  "bytes-chain",
  "record-chain",
  "list-chain",
  "mixed-chain",
];

function uint32(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff)
    throw new Error(`${label} must be a uint32`);
  return value >>> 0;
}

function random(seed: number, caseIndex: number) {
  let state = (seed ^ Math.imul(caseIndex + 1, 0x9e37_79b9)) >>> 0;
  return () => {
    state += 0x6d2b_79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  };
}

const recordType = Object.freeze({
  kind: "record",
  fields: Object.freeze({ count: "i32", label: "string" }),
}) as EffectsTraceJson;
const listType = Object.freeze({
  kind: "list",
  element: "i32",
}) as EffectsTraceJson;
const decimalType = Object.freeze({
  kind: "decimal",
  scale: 2,
}) as EffectsTraceJson;

function familyTypes(family: EffectsTraceFamily): readonly EffectsTraceJson[] {
  switch (family) {
    case "scalar-chain":
      return ["i32", "bool", "string"];
    case "wide-number-chain":
      return ["i64", "f64", decimalType];
    case "bytes-chain":
      return ["bytes"];
    case "record-chain":
      return [recordType];
    case "list-chain":
      return [listType];
    case "mixed-chain":
      return ["i32", "i64", "bytes", recordType, listType];
  }
}

function valueFor(type: EffectsTraceJson, marker: number): EffectsTraceJson {
  const kind =
    type && typeof type === "object" && !Array.isArray(type)
      ? (type as Readonly<Record<string, EffectsTraceJson>>).kind
      : undefined;
  if (type === "i32")
    return Number((BigInt(marker) * 104_729n) % 2_000_001n) - 1_000_000;
  if (type === "i64")
    return { i64: String(BigInt(marker + 1) * 1_000_003n - 4_000_000_007n) };
  if (type === "f64") return marker % 2 ? marker + 0.25 : -marker - 0.5;
  if (type === "bool") return marker % 2 === 0;
  if (type === "string") return `trace-${marker}-\u2603`;
  if (type === "bytes") {
    if (marker % 5 === 0) return { bytes: "" };
    if (marker % 5 === 1)
      return { bytes: Buffer.from([marker & 255]).toString("base64") };
    const bytes = Uint8Array.from([0, marker & 255, 255, (marker * 17) & 255]);
    return { bytes: Buffer.from(bytes).toString("base64") };
  }
  if (kind === "decimal")
    return { decimal: { coefficient: String(marker * 101 - 303), scale: 2 } };
  const i32 = (value: number) => Number(BigInt.asIntN(32, BigInt(value)));
  if (kind === "record")
    return { label: `item-${marker}`, count: i32(marker - 17) };
  if (marker % 5 === 0) return [];
  if (marker % 5 === 1) return [i32(marker)];
  if (marker % 5 === 2) return [-0x8000_0000, 0x7fff_ffff];
  return [i32(marker - 1), i32(marker - 1), i32(-marker)];
}

export function generateEffectsTraceCase(
  seedInput: number,
  caseIndexInput: number,
): GeneratedEffectsTraceCase {
  const seed = uint32(seedInput, "seed"),
    caseIndex = uint32(caseIndexInput, "case index"),
    next = random(seed, caseIndex),
    family = FAMILIES[caseIndex % FAMILIES.length] as EffectsTraceFamily,
    types = familyTypes(family),
    count = 2 + (next() % 3),
    operations = Object.freeze(
      Array.from({ length: count }, (_, index) => {
        const type = types[index % types.length] as EffectsTraceJson;
        return Object.freeze({
          id: `host.diff${caseIndex}.${index}`,
          version: 1 + (next() % 3),
          requestType: type,
          responseType: type,
          request: valueFor(type, caseIndex * 31 + index + 1),
          cancellable: next() % 2 === 0,
          idempotent: next() % 2 === 0,
        });
      }),
    ),
    allGranted = operations.map(
      (operation) => `${operation.id}@${operation.version}`,
    ),
    deniedIndex = 1 + (next() % (count - 1)),
    laterFailure = 1 + (next() % (count - 1)),
    scenarios = Object.freeze(
      Array.from({ length: 8 }, (_, scenarioIndex) => {
        const responses = Object.freeze(
          operations.map((operation, operationIndex) =>
            valueFor(
              operation.responseType,
              caseIndex * 257 + scenarioIndex * 19 + operationIndex + 1,
            ),
          ),
        );
        if (scenarioIndex === 5)
          return Object.freeze({
            id: "host-failure-first",
            responses,
            granted: Object.freeze([...allGranted]),
            failureIndex: 0,
          });
        if (scenarioIndex === 6)
          return Object.freeze({
            id: "host-failure-later",
            responses,
            granted: Object.freeze([...allGranted]),
            failureIndex: laterFailure,
          });
        if (scenarioIndex === 7)
          return Object.freeze({
            id: "permission-denied-later",
            responses,
            granted: Object.freeze(
              allGranted.filter((_key, index) => index !== deniedIndex),
            ),
          });
        return Object.freeze({
          id: `success-${scenarioIndex}`,
          responses,
          granted: Object.freeze([...allGranted]),
        });
      }),
    ),
    resultType = operations.at(-1)?.responseType;
  if (!resultType) throw new Error("generated Effects trace has no operation");
  const model: EffectsTraceCaseModel = Object.freeze({
      family,
      operations,
      resultType,
    }),
    sourceValue = {
      language: "l-lang",
      version: 5,
      kind: "module",
      profile: "module-effects-v1",
      module: `generated/case-${caseIndex}`,
      entry: "main",
      imports: [],
      operations: operations.map((operation) => ({
        id: operation.id,
        version: operation.version,
        requestType: operation.requestType,
        responseType: operation.responseType,
        errorType: { code: "string" },
        effect: "host",
        resource: "none",
        cancellable: operation.cancellable,
        idempotent: operation.idempotent,
      })),
      resultType,
      nodes: operations.map((operation) => ({
        kind: "await",
        operation: operation.id,
        version: operation.version,
        request: operation.request,
      })),
    };
  return Object.freeze({
    format: EFFECTS_TRACE_DIFFERENTIAL_FORMAT,
    seed,
    caseIndex,
    family,
    model,
    scenarios,
    source: `${JSON.stringify(sourceValue, null, 2)}\n`,
  });
}

export type EffectsTraceReproduction = Readonly<{
  format: typeof EFFECTS_TRACE_DIFFERENTIAL_FORMAT;
  seed: number;
  caseIndex: number;
  scenarioIndex?: number;
  family: EffectsTraceFamily;
  source: string;
  flattenedJsonc?: string;
  model: EffectsTraceCaseModel;
  scenarios: readonly EffectsTraceScenario[];
  hashes?: EffectsTraceHashes;
  outcomes?: EffectsTraceOutcomes;
  stage?: string;
  message?: string;
  replay: Readonly<{
    seed: number;
    startCase: number;
    cases: 1;
    scenarioIndex?: number;
  }>;
}>;

export class EffectsTraceMismatch extends Error {
  constructor(readonly reproduction: EffectsTraceReproduction) {
    super("Effects trace differential mismatch");
    this.name = "EffectsTraceMismatch";
  }
}

export class EffectsTraceRunnerError extends Error {
  constructor(readonly reproduction: EffectsTraceReproduction) {
    super(reproduction.message ?? "Effects trace differential runner error");
    this.name = "EffectsTraceRunnerError";
  }
}

export function assertEffectsTraceOutcomes(
  generated: GeneratedEffectsTraceCase,
  scenarioIndex: number,
  outcomes: EffectsTraceOutcomes,
  hashes: EffectsTraceHashes,
  flattenedJsonc: string,
) {
  assertFiveEffectsTraceLanes(outcomes);
  const expected = outcomes.oracle;
  if (
    EFFECTS_TRACE_LANES.some(
      (lane) =>
        lane !== "oracle" && !sameEffectsTrace(expected, outcomes[lane]),
    )
  )
    throw new EffectsTraceMismatch({
      format: EFFECTS_TRACE_DIFFERENTIAL_FORMAT,
      seed: generated.seed,
      caseIndex: generated.caseIndex,
      scenarioIndex,
      family: generated.family,
      source: generated.source,
      flattenedJsonc,
      model: generated.model,
      scenarios: generated.scenarios,
      hashes,
      outcomes,
      replay: {
        seed: generated.seed,
        startCase: generated.caseIndex,
        cases: 1,
        scenarioIndex,
      },
    });
}

export async function runEffectsTraceCase(
  generated: GeneratedEffectsTraceCase,
  scenarioIndex?: number,
): Promise<Readonly<{ hashes: EffectsTraceHashes; scenarios: number }>> {
  const oracle = generated.scenarios.map((scenario) =>
    evaluateEffectsTraceOracle(generated.model, scenario),
  );
  try {
    const result = await runEffectsTraceHarness({
      source: generated.source,
      model: generated.model,
      scenarios: generated.scenarios,
      oracle,
    });
    const indexes =
      scenarioIndex === undefined
        ? generated.scenarios.map((_scenario, index) => index)
        : [scenarioIndex];
    for (const index of indexes) {
      const outcomes = result.outcomes[index];
      if (!outcomes) throw new Error(`missing scenario ${index}`);
      assertEffectsTraceOutcomes(
        generated,
        index,
        outcomes,
        result.hashes,
        result.flattenedJsonc,
      );
    }
    return Object.freeze({ hashes: result.hashes, scenarios: indexes.length });
  } catch (error) {
    if (error instanceof EffectsTraceMismatch) throw error;
    const harness =
      error instanceof EffectsTraceHarnessError ? error : undefined;
    throw new EffectsTraceRunnerError({
      format: EFFECTS_TRACE_DIFFERENTIAL_FORMAT,
      seed: generated.seed,
      caseIndex: generated.caseIndex,
      ...(harness?.scenarioIndex === undefined
        ? {}
        : { scenarioIndex: harness.scenarioIndex }),
      family: generated.family,
      source: generated.source,
      model: generated.model,
      scenarios: generated.scenarios,
      stage: harness?.stage ?? "runner",
      message: error instanceof Error ? error.message : String(error),
      replay: {
        seed: generated.seed,
        startCase: generated.caseIndex,
        cases: 1,
        ...(harness?.scenarioIndex === undefined
          ? {}
          : { scenarioIndex: harness.scenarioIndex }),
      },
    });
  }
}

export async function runEffectsTraceDifferential(
  options: {
    seed?: number;
    cases?: number;
    startCase?: number;
    scenarioIndex?: number;
  } = {},
) {
  const seed = uint32(
      options.seed ?? EFFECTS_TRACE_DIFFERENTIAL_DEFAULT_SEED,
      "seed",
    ),
    cases = options.cases ?? 24,
    startCase = uint32(options.startCase ?? 0, "start case");
  if (!Number.isInteger(cases) || cases < 1 || cases > 512)
    throw new Error("cases must be between 1 and 512");
  if (startCase + cases - 1 > 0xffff_ffff)
    throw new Error("case range must fit uint32");
  if (
    options.scenarioIndex !== undefined &&
    (!Number.isInteger(options.scenarioIndex) ||
      options.scenarioIndex < 0 ||
      options.scenarioIndex > 7 ||
      cases !== 1)
  )
    throw new Error("scenario index requires one case and must be 0..7");
  const hashes: EffectsTraceHashes[] = [];
  let scenarioCount = 0;
  for (let offset = 0; offset < cases; offset++) {
    const result = await runEffectsTraceCase(
      generateEffectsTraceCase(seed, startCase + offset),
      options.scenarioIndex,
    );
    hashes.push(result.hashes);
    scenarioCount += result.scenarios;
  }
  return Object.freeze({
    format: EFFECTS_TRACE_DIFFERENTIAL_FORMAT,
    seed,
    startCase,
    cases,
    scenarios: scenarioCount,
    uniqueSemanticProjections: new Set(
      hashes.map((item) => item.semanticProjection),
    ).size,
    uniqueWasmHashes: new Set(hashes.map((item) => item.wasmHash)).size,
    hashes: Object.freeze(hashes),
  });
}
