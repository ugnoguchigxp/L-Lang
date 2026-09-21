import {
  BOTTLENECK_CATEGORIES,
  decideCollectionBottleneck,
  type BottleneckCaseDiagnostic,
  type BottleneckCategory,
  type BottleneckDecisionConfig,
  type BottleneckMetric,
  type CollectionBottleneckSummary,
} from "./llang-collection-bottleneck-report";

export type StabilityLane = "cold" | "module-cached";
export type CollectionStabilitySample = Readonly<{
  blockId: number;
  orderId: string;
  orderIndex: number;
  caseId: string;
  programId: string;
  partition: "exploration" | "holdout";
  size: number;
  lane: StabilityLane;
  sample: number;
  clockOverheadNs: number;
  compileNs: number;
  instantiateNs: number;
  encodeNs: number;
  hostValidationNs: number;
  evaluateNs: number;
  decodeNs: number;
  totalNs: number;
  accountedNs: number;
  unattributedNs: number;
  inputBytes: number;
  outputBytes: number;
}>;

export type StabilityDecisionConfig = BottleneckDecisionConfig &
  Readonly<{
    blocks: number;
    samples: number;
    maximumBlockMedianRelativeMad: number;
    maximumOrderDifference: number;
    minimumWinningBlocks: number;
    minimumPreparedReduction: number;
    minimumPreparedIntervalReduction: number;
    maximumPreparedRatioUpper: number;
  }>;

export type CollectionStabilityCaseSummary = Readonly<{
  caseId: string;
  programId: string;
  partition: "exploration" | "holdout";
  size: number;
  coldTotalNs: BottleneckMetric;
  cachedTotalNs: BottleneckMetric;
  unattributedShare: BottleneckMetric;
  pairedRatio: BottleneckMetric;
  pairedReduction: BottleneckMetric;
  blockMedianRelativeMad: number;
  forwardReverseDifference: number;
  orderHalfDifference: number | null;
  shares: Readonly<Record<BottleneckCategory, BottleneckMetric>>;
  blockWinners: readonly (BottleneckCategory | null)[];
  inputBytes: number;
  outputBytes: number;
}>;

const median = (values: readonly number[]) => {
  if (!values.length)
    throw new Error("INVALID_COLLECTION_STABILITY: empty metric");
  const ordered = [...values].sort((a, b) => a - b),
    middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? (ordered[middle] as number)
    : ((ordered[middle - 1] as number) + (ordered[middle] as number)) / 2;
};
const percentile = (values: readonly number[], fraction: number) => {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[
    Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)
  ] as number;
};
const seedFor = (text: string) =>
  [...text].reduce(
    (value, character) => (value * 33 + (character.codePointAt(0) ?? 0)) >>> 0,
    5381,
  );

function metric(
  values: readonly number[],
  seedText: string,
  allowNegative = false,
): BottleneckMetric {
  if (
    !values.length ||
    values.some(
      (value) => !Number.isFinite(value) || (!allowNegative && value < 0),
    )
  )
    throw new Error("INVALID_COLLECTION_STABILITY: invalid metric");
  const center = median(values),
    bootstrap: number[] = [];
  let state = (seedFor(seedText) ^ 0x9e3779b9) >>> 0;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  for (let iteration = 0; iteration < 1000; iteration++)
    bootstrap.push(
      median(
        Array.from(
          { length: values.length },
          () => values[Math.floor(random() * values.length)] as number,
        ),
      ),
    );
  return Object.freeze({
    median: center,
    mad: median(values.map((value) => Math.abs(value - center))),
    p95: percentile(values, 0.95),
    bootstrap95: Object.freeze([
      percentile(bootstrap, 0.025),
      percentile(bootstrap, 0.975),
    ]) as readonly [number, number],
  });
}

function categoryValue(
  row: CollectionStabilitySample,
  category: BottleneckCategory,
) {
  if (category === "startup") return row.compileNs + row.instantiateNs;
  if (category === "host-input") return row.encodeNs + row.hostValidationNs;
  if (category === "wasm-evaluate") return row.evaluateNs;
  return row.decodeNs;
}

function winner(
  rows: readonly CollectionStabilitySample[],
): BottleneckCategory | null {
  const values = Object.fromEntries(
    BOTTLENECK_CATEGORIES.map((category) => [
      category,
      median(rows.map((row) => categoryValue(row, category) / row.totalNs)),
    ]),
  ) as Record<BottleneckCategory, number>;
  const ordered = [...BOTTLENECK_CATEGORIES].sort(
    (a, b) => values[b] - values[a] || a.localeCompare(b),
  );
  return values[ordered[0] as BottleneckCategory] ===
    values[ordered[1] as BottleneckCategory]
    ? null
    : (ordered[0] as BottleneckCategory);
}

export function validateCollectionStabilityMatrix(
  samples: readonly CollectionStabilitySample[],
  caseIds: readonly string[],
  blocks: number,
  samplesPerLane: number,
): void {
  const expected = new Set(caseIds),
    identities = new Set<string>();
  if (samples.length !== blocks * caseIds.length * 2 * samplesPerLane)
    throw new Error("INVALID_COLLECTION_STABILITY: incomplete matrix");
  for (const row of samples) {
    const identity = `${row.blockId}/${row.orderId}/${row.orderIndex}/${row.caseId}/${row.lane}/${row.sample}`,
      accounted =
        row.compileNs +
        row.instantiateNs +
        row.encodeNs +
        row.hostValidationNs +
        row.evaluateNs +
        row.decodeNs;
    if (identities.has(identity))
      throw new Error("INVALID_COLLECTION_STABILITY: duplicate identity");
    identities.add(identity);
    const numeric = Object.entries(row).filter(
      ([key]) =>
        !["orderId", "caseId", "programId", "partition", "lane"].includes(key),
    );
    if (
      !expected.has(row.caseId) ||
      row.blockId < 0 ||
      row.blockId >= blocks ||
      row.orderIndex < 0 ||
      row.orderIndex >= caseIds.length ||
      row.sample < 0 ||
      row.sample >= samplesPerLane ||
      !["cold", "module-cached"].includes(row.lane) ||
      numeric.some(
        ([, value]) =>
          typeof value !== "number" ||
          !Number.isSafeInteger(value) ||
          value < 0,
      ) ||
      row.accountedNs !== accounted ||
      row.unattributedNs !== row.totalNs - accounted ||
      row.totalNs <= 0 ||
      (row.lane === "module-cached" && row.compileNs !== 0)
    )
      throw new Error("INVALID_COLLECTION_STABILITY: invalid row");
  }
  for (let block = 0; block < blocks; block++) {
    const rows = samples.filter((row) => row.blockId === block),
      order = [
        ...new Map(rows.map((row) => [row.orderIndex, row.caseId])).entries(),
      ]
        .sort((a, b) => a[0] - b[0])
        .map((entry) => entry[1]);
    if (
      rows.some((row) => row.orderId !== `order-${block}`) ||
      order.length !== caseIds.length ||
      new Set(order).size !== caseIds.length
    )
      throw new Error("INVALID_COLLECTION_STABILITY: invalid block order");
    for (const caseId of caseIds)
      for (const lane of ["cold", "module-cached"] as const) {
        const laneRows = rows.filter(
          (row) => row.caseId === caseId && row.lane === lane,
        );
        if (
          laneRows.length !== samplesPerLane ||
          new Set(laneRows.map((row) => row.orderIndex)).size !== 1
        )
          throw new Error("INVALID_COLLECTION_STABILITY: invalid matrix case");
      }
    for (const caseId of caseIds)
      if (
        new Set(
          rows
            .filter((row) => row.caseId === caseId)
            .map((row) => row.orderIndex),
        ).size !== 1
      )
        throw new Error("INVALID_COLLECTION_STABILITY: inconsistent order");
  }
}

export function summarizeCollectionStability(
  samples: readonly CollectionStabilitySample[],
): CollectionStabilityCaseSummary[] {
  const groups = new Map<string, CollectionStabilitySample[]>(),
    orderSplit = Math.ceil(
      (Math.max(...samples.map((row) => row.orderIndex)) + 1) / 2,
    );
  for (const row of samples) {
    const group = groups.get(row.caseId) ?? [];
    group.push(row);
    groups.set(row.caseId, group);
  }
  return [...groups.entries()]
    .map(([caseId, rows]) => {
      const first = rows[0] as CollectionStabilitySample,
        cold = rows.filter((row) => row.lane === "cold"),
        cached = rows.filter((row) => row.lane === "module-cached"),
        paired = cold.map((row) => {
          const match = cached.find(
            (candidate) =>
              candidate.blockId === row.blockId &&
              candidate.sample === row.sample,
          );
          if (
            !match ||
            match.inputBytes !== row.inputBytes ||
            match.outputBytes !== row.outputBytes
          )
            throw new Error("INVALID_COLLECTION_STABILITY: unpaired sample");
          return match.totalNs / row.totalNs;
        }),
        blockMedians = [...new Set(cold.map((row) => row.blockId))]
          .sort((a, b) => a - b)
          .map((block) =>
            median(
              cold
                .filter((row) => row.blockId === block)
                .map((row) => row.totalNs),
            ),
          ),
        blockCenter = median(blockMedians),
        forward = median(
          cold.filter((row) => row.blockId % 2 === 0).map((row) => row.totalNs),
        ),
        reverse = median(
          cold.filter((row) => row.blockId % 2 === 1).map((row) => row.totalNs),
        ),
        firstHalfValues = cold
          .filter((row) => row.orderIndex < orderSplit)
          .map((row) => row.totalNs),
        secondHalfValues = cold
          .filter((row) => row.orderIndex >= orderSplit)
          .map((row) => row.totalNs),
        shares = Object.fromEntries(
          BOTTLENECK_CATEGORIES.map((category) => [
            category,
            metric(
              cold.map((row) => categoryValue(row, category) / row.totalNs),
              `${caseId}/${category}`,
            ),
          ]),
        ) as Record<BottleneckCategory, BottleneckMetric>;
      return Object.freeze({
        caseId,
        programId: first.programId,
        partition: first.partition,
        size: first.size,
        coldTotalNs: metric(
          cold.map((row) => row.totalNs),
          `${caseId}/cold`,
        ),
        cachedTotalNs: metric(
          cached.map((row) => row.totalNs),
          `${caseId}/cached`,
        ),
        unattributedShare: metric(
          cold.map((row) => row.unattributedNs / row.totalNs),
          `${caseId}/unattributed`,
        ),
        pairedRatio: metric(paired, `${caseId}/ratio`),
        pairedReduction: metric(
          paired.map((value) => 1 - value),
          `${caseId}/reduction`,
          true,
        ),
        blockMedianRelativeMad:
          blockCenter === 0
            ? Number.POSITIVE_INFINITY
            : median(
                blockMedians.map((value) => Math.abs(value - blockCenter)),
              ) / blockCenter,
        forwardReverseDifference:
          Math.abs(forward - reverse) / Math.min(forward, reverse),
        orderHalfDifference:
          firstHalfValues.length && secondHalfValues.length
            ? Math.abs(median(firstHalfValues) - median(secondHalfValues)) /
              Math.min(median(firstHalfValues), median(secondHalfValues))
            : null,
        shares: Object.freeze(shares),
        blockWinners: Object.freeze(
          blockMedians.map((_, block) =>
            winner(cold.filter((row) => row.blockId === block)),
          ),
        ),
        inputBytes: first.inputBytes,
        outputBytes: first.outputBytes,
      });
    })
    .sort((a, b) => a.caseId.localeCompare(b.caseId));
}

function asBottleneckSummary(
  summary: readonly CollectionStabilityCaseSummary[],
  samples: readonly CollectionStabilitySample[],
): CollectionBottleneckSummary[] {
  return summary.map((row) => {
    const cold = samples.filter(
        (sample) => sample.caseId === row.caseId && sample.lane === "cold",
      ),
      timing = (key: keyof CollectionStabilitySample) =>
        metric(
          cold.map((sample) => sample[key] as number),
          `${row.caseId}/${String(key)}`,
        );
    return {
      caseId: row.caseId,
      programId: row.programId,
      partition: row.partition,
      size: row.size,
      totalNs: row.coldTotalNs,
      cachedTotalNs: row.cachedTotalNs,
      compileNs: timing("compileNs"),
      instantiateNs: timing("instantiateNs"),
      encodeNs: timing("encodeNs"),
      hostValidationNs: timing("hostValidationNs"),
      evaluateNs: timing("evaluateNs"),
      decodeNs: timing("decodeNs"),
      unattributedShare: row.unattributedShare,
      shares: row.shares,
      inputBytes: row.inputBytes,
      outputBytes: row.outputBytes,
    };
  });
}

export function decideCollectionStability(
  samples: readonly CollectionStabilitySample[],
  summary: readonly CollectionStabilityCaseSummary[],
  diagnostics: readonly BottleneckCaseDiagnostic[],
  mix: readonly string[],
  config: StabilityDecisionConfig,
): Record<string, unknown> {
  const holdout = summary.filter((row) => row.partition === "holdout"),
    qualityReasons: string[] = [];
  if (
    summary.some(
      (row) => row.unattributedShare.p95 > config.maximumUnattributedShare,
    )
  )
    qualityReasons.push("unattributed-share");
  if (
    holdout.some(
      (row) =>
        row.coldTotalNs.mad / row.coldTotalNs.median >
        config.maximumRelativeMad,
    )
  )
    qualityReasons.push("overall-variation");
  if (
    holdout.some(
      (row) =>
        row.blockMedianRelativeMad > config.maximumBlockMedianRelativeMad,
    )
  )
    qualityReasons.push("block-variation");
  if (
    holdout.some(
      (row) => row.forwardReverseDifference > config.maximumOrderDifference,
    )
  )
    qualityReasons.push("order-bias");
  const base = decideCollectionBottleneck(
      asBottleneckSummary(summary, samples),
      diagnostics,
      mix,
      config,
    ),
    candidate = base.selectedTarget as BottleneckCategory | null,
    blockVotes = Object.fromEntries(
      BOTTLENECK_CATEGORIES.map((category) => [
        category,
        Array.from({ length: config.blocks }, (_, block) =>
          winner(
            samples.filter(
              (row) =>
                row.partition === "holdout" &&
                row.lane === "cold" &&
                row.blockId === block,
            ),
          ),
        ).filter((value) => value === category).length,
      ]),
    ) as Record<BottleneckCategory, number>,
    blockStable =
      candidate !== null &&
      blockVotes[candidate] >= config.minimumWinningBlocks,
    selectedTarget =
      qualityReasons.length === 0 && candidate && blockStable
        ? candidate
        : null;
  const prepared = {
    evaluated: selectedTarget === "startup",
    majorityReduction:
      holdout.filter(
        (row) => 1 - row.pairedRatio.median >= config.minimumPreparedReduction,
      ).length >
      holdout.length / 2,
    robustCases: holdout
      .filter(
        (row) =>
          row.pairedReduction.bootstrap95[0] >=
          config.minimumPreparedIntervalReduction,
      )
      .map((row) => row.caseId),
    noRegression: holdout.every(
      (row) =>
        row.pairedRatio.bootstrap95[1] <= config.maximumPreparedRatioUpper,
    ),
  };
  const preparedPassed =
      prepared.evaluated &&
      prepared.majorityReduction &&
      prepared.robustCases.length >= config.minimumRobustCases &&
      prepared.noRegression,
    outcome = preparedPassed ? "adopt-prepared-lifecycle" : "retain-baseline";
  return Object.freeze({
    format: "llang-collection-runtime-stability-decision",
    version: 1,
    outcome,
    reason: qualityReasons.length
      ? "insufficient-stability"
      : selectedTarget !== "startup"
        ? "dominance-gate"
        : preparedPassed
          ? "prepared-lifecycle-passed"
          : "prepared-lifecycle-gate",
    dataQuality: qualityReasons.length === 0,
    qualityReasons,
    selectedTarget,
    blockVotes,
    blockStable,
    candidates: base.candidates,
    mixWinner: base.mixWinner,
    caseVoteWinner: base.caseVoteWinner,
    prepared,
    rationale:
      outcome === "adopt-prepared-lifecycle"
        ? "Stable startup evidence and every prepared lifecycle gate passed."
        : "The frozen final gates require retaining the product baseline.",
  });
}
