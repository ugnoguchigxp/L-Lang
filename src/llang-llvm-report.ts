import type { LlvmOptimization } from "./llang-llvm-toolchain";

export type LlvmExperimentLane =
  | "reference"
  | "product-wasm"
  | "direct-wasm"
  | `llvm-wasm-${LlvmOptimization}`
  | `llvm-native-${LlvmOptimization}`;

export type LlvmExperimentSample = {
  caseId: string;
  partition: "exploration" | "holdout";
  lane: LlvmExperimentLane;
  sample: number;
  scope: "kernel" | "end-to-end";
  nsPerIteration: number;
  processNs?: number;
  linearMemoryBytes?: number;
  nativeBufferBytes?: number;
  peakRssBytes?: number;
};

export type LlvmExperimentSummary = {
  caseId: string;
  partition: "exploration" | "holdout";
  lane: LlvmExperimentLane;
  scope: "kernel" | "end-to-end";
  medianNs: number;
  madNs: number;
  p95Ns: number;
};

type ArtifactRow = Readonly<{ lane: string; bytes: number }>;
type DecisionConfig = Readonly<{
  optimizations: LlvmOptimization[];
  decision: {
    maximumMedianRegressionPercent: number;
    requiredImprovementPercent: number;
    maximumArtifactRatio: number;
  };
}>;
type MeasuredCase = Readonly<{
  id: string;
  partition: "exploration" | "holdout";
}>;

const round = (value: number) => Math.round(value * 1000) / 1000;

export function decideLlvmExperiment(
  summary: LlvmExperimentSummary[],
  artifacts: ArtifactRow[],
  config: DecisionConfig,
): Record<string, unknown> {
  assertArtifactMatrix(artifacts, config.optimizations);
  const holdout = summary.filter((item) => item.partition === "holdout"),
    directRows = holdout.filter(
      (item) => item.lane === "direct-wasm" && item.scope === "kernel",
    ),
    direct = uniqueMedians(directRows, "direct-wasm"),
    baseline = uniqueArtifact(artifacts, "direct-wasm"),
    wasmCandidates = config.optimizations.map((optimization) => {
      const lane = `llvm-wasm-${optimization}` as LlvmExperimentLane,
        candidateRows = holdout.filter(
          (item) => item.lane === lane && item.scope === "kernel",
        ),
        candidate = uniqueMedians(candidateRows, lane);
      if (
        candidate.size !== direct.size ||
        [...direct.keys()].some((caseId) => !candidate.has(caseId))
      )
        throw new Error(
          `INVALID_LLVM_EXPERIMENT_DECISION_INPUT: incomplete ${lane} holdout cases`,
        );
      const evaluated = candidateRows
          .map((item) => ({
            caseId: item.caseId,
            rawChangePercent:
              (item.medianNs / (direct.get(item.caseId) as number) - 1) * 100,
          }))
          .sort((left, right) => left.caseId.localeCompare(right.caseId)),
        comparisons = evaluated.map(({ caseId, rawChangePercent }) => ({
          caseId,
          changePercent: round(rawChangePercent),
        })),
        artifact = uniqueArtifact(artifacts, lane),
        ratio = artifact.bytes / baseline.bytes,
        qualifies =
          evaluated.every(
            (item) =>
              item.rawChangePercent <=
              config.decision.maximumMedianRegressionPercent,
          ) &&
          evaluated.some(
            (item) =>
              ["holdout-medium", "holdout-maximum"].includes(item.caseId) &&
              item.rawChangePercent <=
                -config.decision.requiredImprovementPercent,
          ) &&
          ratio <= config.decision.maximumArtifactRatio;
      return {
        optimization,
        comparisons,
        artifactRatio: round(ratio),
        qualifies,
      };
    }),
    selected = wasmCandidates.find((item) => item.qualifies);
  return {
    format: "llang-llvm-experiment-decision",
    version: 1,
    createdOn: "2026-09-21",
    outcome: selected ? "expand-llvm-wasm" : "maintain-current-backend",
    selectedOptimization: selected?.optimization ?? null,
    wasmCandidates,
    nativeOutcome: "limited-experiment-only",
    rationale: selected
      ? "The frozen LLVM Wasm gate passed for the selected optimization."
      : "No LLVM Wasm candidate passed every frozen correctness, regression, improvement, and artifact-size gate.",
  };
}

export function assertLlvmSampleMatrix(
  samples: LlvmExperimentSample[],
  cases: readonly MeasuredCase[],
  sampleCount: number,
  optimizations: readonly LlvmOptimization[],
): void {
  if (
    !Number.isSafeInteger(sampleCount) ||
    sampleCount < 1 ||
    new Set(cases.map((item) => item.id)).size !== cases.length ||
    new Set(optimizations).size !== optimizations.length ||
    optimizations.length === 0
  )
    throw new Error("INVALID_LLVM_EXPERIMENT_SAMPLE_MATRIX: invalid shape");
  const lanes: LlvmExperimentLane[] = [
      "reference",
      "product-wasm",
      "direct-wasm",
      ...optimizations.map(
        (optimization) => `llvm-wasm-${optimization}` as const,
      ),
      ...optimizations.map(
        (optimization) => `llvm-native-${optimization}` as const,
      ),
    ],
    caseById = new Map(cases.map((item) => [item.id, item.partition])),
    laneSet = new Set(lanes),
    keys = new Set<string>();
  for (const sample of samples) {
    const expectedPartition = caseById.get(sample.caseId),
      native = sample.lane.startsWith("llvm-native-"),
      wasm =
        sample.lane === "direct-wasm" || sample.lane.startsWith("llvm-wasm-");
    if (
      expectedPartition !== sample.partition ||
      !laneSet.has(sample.lane) ||
      !Number.isSafeInteger(sample.sample) ||
      sample.sample < 0 ||
      sample.sample >= sampleCount ||
      (native &&
        (sample.nativeBufferBytes === undefined ||
          sample.peakRssBytes === undefined ||
          sample.processNs === undefined ||
          sample.linearMemoryBytes !== undefined)) ||
      (wasm &&
        (sample.linearMemoryBytes === undefined ||
          sample.nativeBufferBytes !== undefined ||
          sample.peakRssBytes !== undefined ||
          sample.processNs !== undefined)) ||
      (!native &&
        !wasm &&
        (sample.linearMemoryBytes !== undefined ||
          sample.nativeBufferBytes !== undefined ||
          sample.peakRssBytes !== undefined ||
          sample.processNs !== undefined))
    )
      throw new Error("INVALID_LLVM_EXPERIMENT_SAMPLE_MATRIX: invalid sample");
    const key = `${sample.caseId}\0${sample.lane}\0${sample.sample}`;
    if (keys.has(key))
      throw new Error(
        "INVALID_LLVM_EXPERIMENT_SAMPLE_MATRIX: duplicate sample",
      );
    keys.add(key);
  }
  if (keys.size !== cases.length * lanes.length * sampleCount)
    throw new Error("INVALID_LLVM_EXPERIMENT_SAMPLE_MATRIX: incomplete matrix");
}

export function summarizeLlvmSamples(
  samples: LlvmExperimentSample[],
): LlvmExperimentSummary[] {
  const groups = new Map<string, LlvmExperimentSample[]>();
  for (const sample of samples) {
    const expectedScope =
      sample.lane === "reference" || sample.lane === "product-wasm"
        ? "end-to-end"
        : "kernel";
    if (sample.scope !== expectedScope)
      throw new Error(
        `INVALID_LLVM_EXPERIMENT_SAMPLE: ${sample.lane} must use ${expectedScope} scope`,
      );
    if (!Number.isFinite(sample.nsPerIteration) || sample.nsPerIteration < 0)
      throw new Error("INVALID_LLVM_EXPERIMENT_SAMPLE: invalid duration");
    const key = `${sample.caseId}\0${sample.partition}\0${sample.lane}\0${sample.scope}`;
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  return [...groups.values()]
    .map((group) => {
      const values = group
          .map((item) => item.nsPerIteration)
          .sort((a, b) => a - b),
        middle = median(values),
        deviations = values.map((value) => Math.abs(value - middle));
      return {
        caseId: group[0]?.caseId as string,
        partition: group[0]?.partition as "exploration" | "holdout",
        lane: group[0]?.lane as LlvmExperimentLane,
        scope: group[0]?.scope as "kernel" | "end-to-end",
        medianNs: round(middle),
        madNs: round(median(deviations)),
        p95Ns: round(values[Math.ceil(values.length * 0.95) - 1] as number),
      };
    })
    .sort((a, b) =>
      `${a.partition}/${a.caseId}/${a.lane}`.localeCompare(
        `${b.partition}/${b.caseId}/${b.lane}`,
      ),
    );
}

function uniqueMedians(
  rows: LlvmExperimentSummary[],
  lane: string,
): Map<string, number> {
  if (rows.length === 0)
    throw new Error(
      `INVALID_LLVM_EXPERIMENT_DECISION_INPUT: missing ${lane} holdout cases`,
    );
  const values = new Map<string, number>();
  for (const row of rows) {
    if (
      values.has(row.caseId) ||
      !Number.isFinite(row.medianNs) ||
      row.medianNs <= 0
    )
      throw new Error(
        `INVALID_LLVM_EXPERIMENT_DECISION_INPUT: invalid ${lane}/${row.caseId}`,
      );
    values.set(row.caseId, row.medianNs);
  }
  return values;
}

function uniqueArtifact(artifacts: ArtifactRow[], lane: string): ArtifactRow {
  const matches = artifacts.filter((item) => item.lane === lane);
  if (
    matches.length !== 1 ||
    !Number.isSafeInteger(matches[0]?.bytes) ||
    (matches[0]?.bytes ?? 0) <= 0
  )
    throw new Error(
      `INVALID_LLVM_EXPERIMENT_DECISION_INPUT: expected one ${lane} artifact`,
    );
  return matches[0] as ArtifactRow;
}

function assertArtifactMatrix(
  artifacts: ArtifactRow[],
  optimizations: readonly LlvmOptimization[],
): void {
  if (new Set(optimizations).size !== optimizations.length)
    throw new Error(
      "INVALID_LLVM_EXPERIMENT_DECISION_INPUT: duplicate optimization",
    );
  const expected = [
      "product-wasm",
      "direct-wasm",
      ...optimizations.map((item) => `llvm-wasm-${item}`),
      ...optimizations.map((item) => `llvm-native-${item}`),
    ].sort(),
    actual = artifacts.map((item) => item.lane).sort();
  if (
    expected.length !== actual.length ||
    expected.some((lane, index) => actual[index] !== lane)
  )
    throw new Error(
      "INVALID_LLVM_EXPERIMENT_DECISION_INPUT: incomplete artifact matrix",
    );
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}
