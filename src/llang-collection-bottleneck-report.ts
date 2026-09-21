export const BOTTLENECK_CATEGORIES = [
  "startup",
  "host-input",
  "wasm-evaluate",
  "host-output",
] as const;
export type BottleneckCategory = (typeof BOTTLENECK_CATEGORIES)[number];

export type CollectionBottleneckSample = Readonly<{
  caseId: string;
  programId: string;
  partition: "exploration" | "holdout";
  size: number;
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
  cachedInstantiateNs: number;
  cachedEncodeNs: number;
  cachedHostValidationNs: number;
  cachedEvaluateNs: number;
  cachedDecodeNs: number;
  cachedTotalNs: number;
  cachedUnattributedNs: number;
  inputBytes: number;
  outputBytes: number;
}>;

export type BottleneckMetric = Readonly<{
  median: number;
  mad: number;
  p95: number;
  bootstrap95: readonly [number, number];
}>;

export type CollectionBottleneckSummary = Readonly<{
  caseId: string;
  programId: string;
  partition: "exploration" | "holdout";
  size: number;
  totalNs: BottleneckMetric;
  cachedTotalNs: BottleneckMetric;
  compileNs: BottleneckMetric;
  instantiateNs: BottleneckMetric;
  encodeNs: BottleneckMetric;
  hostValidationNs: BottleneckMetric;
  evaluateNs: BottleneckMetric;
  decodeNs: BottleneckMetric;
  unattributedShare: BottleneckMetric;
  shares: Readonly<Record<BottleneckCategory, BottleneckMetric>>;
  inputBytes: number;
  outputBytes: number;
}>;

export type BottleneckCaseDiagnostic = Readonly<{
  caseId: string;
  programId: string;
  size: number;
  arenaPeakBytes: number;
  allocationCalls: number;
  allocationBytes: number;
  copyCalls: number;
  copyBytes: number;
  metricsHash: string;
}>;

export type BottleneckDecisionConfig = Readonly<{
  maximumUnattributedShare: number;
  maximumRelativeMad: number;
  minimumMedianShare: number;
  minimumIntervalShare: number;
  minimumRobustCases: number;
}>;

const ID = /^[a-z][a-z0-9-]*$/u;
const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const median = (values: readonly number[]) => {
  const ordered = [...values].sort((left, right) => left - right),
    middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? (ordered[middle] as number)
    : ((ordered[middle - 1] as number) + (ordered[middle] as number)) / 2;
};
const percentile = (values: readonly number[], fraction: number) => {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[
    Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)
  ] as number;
};

function uniqueWinner(
  values: Readonly<Record<BottleneckCategory, number>>,
): BottleneckCategory | null {
  const ordered = [...BOTTLENECK_CATEGORIES].sort(
    (left, right) => values[right] - values[left] || left.localeCompare(right),
  );
  return values[ordered[0] as BottleneckCategory] ===
    values[ordered[1] as BottleneckCategory]
    ? null
    : (ordered[0] as BottleneckCategory);
}

function metric(values: readonly number[], seed: number): BottleneckMetric {
  if (
    !values.length ||
    values.some((value) => !Number.isFinite(value) || value < 0)
  )
    throw new Error("INVALID_COLLECTION_BOTTLENECK_SAMPLES: invalid metric");
  const center = median(values),
    bootstrap: number[] = [];
  let state = (seed ^ 0x9e3779b9) >>> 0;
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
  row: CollectionBottleneckSample,
  category: BottleneckCategory,
): number {
  switch (category) {
    case "startup":
      return row.compileNs + row.instantiateNs;
    case "host-input":
      return row.encodeNs + row.hostValidationNs;
    case "wasm-evaluate":
      return row.evaluateNs;
    case "host-output":
      return row.decodeNs;
  }
}

export function summarizeCollectionBottleneckSamples(
  samples: readonly CollectionBottleneckSample[],
): CollectionBottleneckSummary[] {
  const groups = new Map<string, CollectionBottleneckSample[]>();
  for (const row of samples) {
    if (
      !ID.test(row.caseId) ||
      !ID.test(row.programId) ||
      !["exploration", "holdout"].includes(row.partition) ||
      !Number.isSafeInteger(row.size) ||
      row.size < 1 ||
      !Number.isSafeInteger(row.sample) ||
      row.sample < 0
    )
      throw new Error(
        "INVALID_COLLECTION_BOTTLENECK_SAMPLES: invalid identity",
      );
    const numeric = Object.entries(row).filter(
        ([key]) => !["caseId", "programId", "partition"].includes(key),
      ),
      accountedNs =
        row.compileNs +
        row.instantiateNs +
        row.encodeNs +
        row.hostValidationNs +
        row.evaluateNs +
        row.decodeNs,
      cachedAccountedNs =
        row.cachedInstantiateNs +
        row.cachedEncodeNs +
        row.cachedHostValidationNs +
        row.cachedEvaluateNs +
        row.cachedDecodeNs;
    if (
      numeric.some(
        ([, value]) =>
          typeof value !== "number" ||
          !Number.isSafeInteger(value) ||
          value < 0,
      ) ||
      row.totalNs <= 0 ||
      row.cachedTotalNs <= 0 ||
      row.accountedNs !== accountedNs ||
      row.unattributedNs !== row.totalNs - accountedNs ||
      row.cachedUnattributedNs !== row.cachedTotalNs - cachedAccountedNs
    )
      throw new Error("INVALID_COLLECTION_BOTTLENECK_SAMPLES: invalid timing");
    const key = `${row.partition}\0${row.caseId}`,
      group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((rows) => {
      const first = rows[0] as CollectionBottleneckSample;
      if (new Set(rows.map((row) => row.sample)).size !== rows.length)
        throw new Error(
          "INVALID_COLLECTION_BOTTLENECK_SAMPLES: duplicate sample",
        );
      for (const expected of Array.from({ length: rows.length }, (_, i) => i))
        if (!rows.some((row) => row.sample === expected))
          throw new Error("INVALID_COLLECTION_BOTTLENECK_SAMPLES: sample gap");
      for (const key of [
        "caseId",
        "programId",
        "partition",
        "size",
        "inputBytes",
        "outputBytes",
      ] as const)
        if (new Set(rows.map((row) => row[key])).size !== 1)
          throw new Error(
            `INVALID_COLLECTION_BOTTLENECK_SAMPLES: varying ${key}`,
          );
      const seed = [...first.caseId].reduce(
          (value, character) =>
            (value * 33 + (character.codePointAt(0) ?? 0)) >>> 0,
          5381,
        ),
        timing = (key: keyof CollectionBottleneckSample) =>
          metric(
            rows.map((row) => row[key] as number),
            seed + key.length,
          ),
        shares = Object.fromEntries(
          BOTTLENECK_CATEGORIES.map((category) => [
            category,
            metric(
              rows.map((row) => categoryValue(row, category) / row.totalNs),
              seed + category.length,
            ),
          ]),
        ) as Record<BottleneckCategory, BottleneckMetric>;
      return Object.freeze({
        caseId: first.caseId,
        programId: first.programId,
        partition: first.partition,
        size: first.size,
        totalNs: timing("totalNs"),
        cachedTotalNs: timing("cachedTotalNs"),
        compileNs: timing("compileNs"),
        instantiateNs: timing("instantiateNs"),
        encodeNs: timing("encodeNs"),
        hostValidationNs: timing("hostValidationNs"),
        evaluateNs: timing("evaluateNs"),
        decodeNs: timing("decodeNs"),
        unattributedShare: metric(
          rows.map((row) => row.unattributedNs / row.totalNs),
          seed + 101,
        ),
        shares: Object.freeze(shares),
        inputBytes: first.inputBytes,
        outputBytes: first.outputBytes,
      });
    })
    .sort((left, right) =>
      `${left.partition}/${left.caseId}`.localeCompare(
        `${right.partition}/${right.caseId}`,
      ),
    );
}

export function decideCollectionBottleneck(
  summary: readonly CollectionBottleneckSummary[],
  diagnostics: readonly BottleneckCaseDiagnostic[],
  mix: readonly string[],
  config: BottleneckDecisionConfig,
): Record<string, unknown> {
  const holdout = summary.filter((row) => row.partition === "holdout"),
    identities = new Set(summary.map((row) => row.caseId)),
    diagnosticByCase = new Map(diagnostics.map((row) => [row.caseId, row]));
  if (
    !holdout.length ||
    identities.size !== summary.length ||
    diagnosticByCase.size !== diagnostics.length ||
    diagnosticByCase.size !== identities.size ||
    diagnostics.some((row) => !identities.has(row.caseId)) ||
    mix.some((caseId) => !identities.has(caseId))
  )
    throw new Error(
      "INVALID_COLLECTION_BOTTLENECK_DECISION: incomplete matrix",
    );
  const qualityReasons: string[] = [];
  if (
    summary.some(
      (row) => row.unattributedShare.p95 > config.maximumUnattributedShare,
    )
  )
    qualityReasons.push("unattributed-share");
  if (
    holdout.some(
      (row) =>
        row.totalNs.median <= 0 ||
        row.totalNs.mad / row.totalNs.median > config.maximumRelativeMad,
    )
  )
    qualityReasons.push("timing-variation");

  const mixRows = mix.map((caseId) => {
      const row = summary.find((candidate) => candidate.caseId === caseId);
      if (!row) throw new Error("INVALID_COLLECTION_BOTTLENECK_DECISION: mix");
      return row;
    }),
    mixShares = Object.fromEntries(
      BOTTLENECK_CATEGORIES.map((category) => [
        category,
        mixRows.reduce(
          (sum, row) => sum + row.shares[category].median * row.totalNs.median,
          0,
        ) / mixRows.reduce((sum, row) => sum + row.totalNs.median, 0),
      ]),
    ) as Record<BottleneckCategory, number>,
    mixWinner = uniqueWinner(mixShares),
    caseVotes = Object.fromEntries(
      BOTTLENECK_CATEGORIES.map((category) => [category, 0]),
    ) as Record<BottleneckCategory, number>;
  for (const row of holdout) {
    const winner = uniqueWinner(
      Object.fromEntries(
        BOTTLENECK_CATEGORIES.map((category) => [
          category,
          row.shares[category].median,
        ]),
      ) as Record<BottleneckCategory, number>,
    );
    if (winner) caseVotes[winner]++;
  }
  const caseVoteWinner = uniqueWinner(caseVotes),
    mixRankConsistent =
      mixWinner !== null &&
      caseVoteWinner !== null &&
      mixWinner === caseVoteWinner,
    scalablePrograms = [...new Set(holdout.map((row) => row.programId))].filter(
      (programId) =>
        holdout.filter((row) => row.programId === programId).length >= 2,
    );
  const candidateInternals = BOTTLENECK_CATEGORIES.map((category) => {
      const qualifyingCaseIds = holdout
          .filter(
            (row) => row.shares[category].median >= config.minimumMedianShare,
          )
          .map((row) => row.caseId),
        robustCaseIds = holdout
          .filter(
            (row) =>
              row.shares[category].median >= config.minimumMedianShare &&
              row.shares[category].bootstrap95[0] >=
                config.minimumIntervalShare,
          )
          .map((row) => row.caseId),
        scalingFailures = scalablePrograms.filter((programId) => {
          const rows = holdout
              .filter((row) => row.programId === programId)
              .sort((left, right) => left.size - right.size),
            first = rows[0] as CollectionBottleneckSummary,
            last = rows.at(-1) as CollectionBottleneckSummary;
          return !(
            (last.shares[category].median * last.totalNs.median -
              first.shares[category].median * first.totalNs.median) *
              (last.totalNs.median - first.totalNs.median) >=
            0
          );
        }),
        qualifyingCases = qualifyingCaseIds.length,
        robustCases = robustCaseIds.length,
        scalingConsistent = scalingFailures.length === 0,
        medianShare = median(holdout.map((row) => row.shares[category].median)),
        intervalFloor = median(
          holdout.map((row) => row.shares[category].bootstrap95[0]),
        ),
        absoluteNs = median(
          holdout.map(
            (row) => row.shares[category].median * row.totalNs.median,
          ),
        ),
        eligible =
          qualifyingCases > holdout.length / 2 &&
          robustCases >= config.minimumRobustCases &&
          scalingConsistent &&
          mixRankConsistent,
        rejectionReasons = [
          ...(qualifyingCases <= holdout.length / 2
            ? ["insufficient-majority"]
            : []),
          ...(robustCases < config.minimumRobustCases
            ? ["insufficient-robust-cases"]
            : []),
          ...(!scalingConsistent ? ["scaling-inconsistent"] : []),
          ...(!mixRankConsistent ? ["mix-rank"] : []),
        ];
      return {
        category,
        qualifyingCases,
        qualifyingCaseIds,
        robustCases,
        robustCaseIds,
        scalingConsistent,
        scalingFailures,
        mixShare: mixShares[category],
        medianShare,
        intervalFloor,
        absoluteNs,
        eligible,
        rejectionReasons,
      };
    }),
    eligible = candidateInternals
      .filter((row) => row.eligible)
      .sort(
        (left, right) =>
          right.medianShare - left.medianShare ||
          right.intervalFloor - left.intervalFloor ||
          right.absoluteNs - left.absoluteNs ||
          left.category.localeCompare(right.category),
      );
  const candidates = candidateInternals.map((candidate) => ({
    ...candidate,
    mixShare: round(candidate.mixShare),
    medianShare: round(candidate.medianShare),
    intervalFloor: round(candidate.intervalFloor),
    absoluteNs: round(candidate.absoluteNs),
  }));
  let selectedTarget: BottleneckCategory | null = null;
  if (!qualityReasons.length && eligible.length) {
    const [first, second] = eligible;
    if (
      !second ||
      first?.medianShare !== second.medianShare ||
      first.intervalFloor !== second.intervalFloor ||
      first.absoluteNs !== second.absoluteNs
    )
      selectedTarget = first?.category ?? null;
  }
  const selectedRows = selectedTarget
      ? holdout.filter(
          (row) =>
            row.shares[selectedTarget].median >= config.minimumMedianShare,
        )
      : [],
    phaseMedian = (key: keyof CollectionBottleneckSummary) =>
      median(selectedRows.map((row) => (row[key] as BottleneckMetric).median));
  let diagnosticLabel: string | null = null;
  if (selectedTarget === "startup")
    diagnosticLabel =
      phaseMedian("compileNs") >= phaseMedian("instantiateNs")
        ? "compile"
        : "instantiate";
  else if (selectedTarget === "host-input")
    diagnosticLabel =
      phaseMedian("encodeNs") >= phaseMedian("hostValidationNs")
        ? "encode"
        : "validation";
  else if (selectedTarget === "host-output") diagnosticLabel = "decode";
  else if (selectedTarget === "wasm-evaluate") {
    const movement = selectedRows.map((row) => {
      const item = diagnosticByCase.get(row.caseId);
      return Boolean(
        item && item.copyBytes + item.allocationBytes > row.inputBytes,
      );
    });
    diagnosticLabel = movement.every(Boolean)
      ? "allocation-copy"
      : movement.some(Boolean)
        ? "mixed"
        : "kernel-ir";
  }
  return Object.freeze({
    format: "llang-collection-bottleneck-decision",
    version: 1,
    outcome: selectedTarget ? "prioritize" : "inconclusive",
    selectedTarget,
    diagnosticLabel,
    dataQuality: qualityReasons.length === 0,
    qualityReasons,
    mixWinner,
    caseVoteWinner,
    mixRankConsistent,
    candidates,
    rationale: selectedTarget
      ? `${selectedTarget} is the highest-ranked category that passes every frozen attribution gate.`
      : "No single category passed every frozen data-quality and attribution gate.",
  });
}
