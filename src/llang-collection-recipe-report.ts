export type CollectionRecipeSample = Readonly<{
  caseId: string;
  partition: "exploration" | "holdout";
  recipeId: string;
  sample: number;
  buildMs: number;
  loadMs: number;
  emitMs: number;
  optimizerReadMs: number;
  optimizerPreValidationMs: number;
  optimizerCoreMs: number;
  optimizerPostValidationMs: number;
  optimizerEmitMs: number;
  compileMs: number;
  instantiateMs: number;
  encodeMs: number;
  hostValidationMs: number;
  evaluateMs: number;
  decodeMs: number;
  endToEndMs: number;
  artifactBytes: number;
  linearMemoryBytes: number;
  arenaPeakBytes: number;
  allocationCalls: number;
  allocationBytes: number;
  copyCalls: number;
  copyBytes: number;
  peakRssBytes: number;
}>;

export type CollectionRecipeMetric = Readonly<{
  median: number;
  mad: number;
  p95: number;
  bootstrap95: readonly [number, number];
}>;

export type CollectionRecipeSummary = Readonly<{
  caseId: string;
  partition: "exploration" | "holdout";
  recipeId: string;
  buildMs: CollectionRecipeMetric;
  loadMs: CollectionRecipeMetric;
  emitMs: CollectionRecipeMetric;
  optimizerReadMs: CollectionRecipeMetric;
  optimizerPreValidationMs: CollectionRecipeMetric;
  optimizerCoreMs: CollectionRecipeMetric;
  optimizerPostValidationMs: CollectionRecipeMetric;
  optimizerEmitMs: CollectionRecipeMetric;
  compileMs: CollectionRecipeMetric;
  instantiateMs: CollectionRecipeMetric;
  encodeMs: CollectionRecipeMetric;
  hostValidationMs: CollectionRecipeMetric;
  evaluateMs: CollectionRecipeMetric;
  decodeMs: CollectionRecipeMetric;
  endToEndMs: CollectionRecipeMetric;
  artifactBytes: number;
  linearMemoryBytes: number;
  arenaPeakBytes: number;
  allocationCalls: number;
  allocationBytes: number;
  copyCalls: number;
  copyBytes: number;
  peakRssBytes: number;
}>;

export type CollectionRecipeDecisionConfig = Readonly<{
  baselineRecipeId: "baseline-v1";
  maximumRegressionPercent: number;
  requiredImprovementPercent: number;
  maximumArtifactRatio: number;
  maximumMemoryRegressionPercent: number;
}>;

type Verification = Readonly<{
  recipeId: string;
  correctness: boolean;
  rawAbi: boolean;
  reproducible: boolean;
}>;

const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const ID = /^[a-z][a-z0-9-]*$/u;
const atMost = (value: number, limit: number) =>
  value <= limit || Math.abs(value - limit) <= 1e-9;
const atLeast = (value: number, limit: number) =>
  value >= limit || Math.abs(value - limit) <= 1e-9;
const median = (values: readonly number[]) => {
  const sorted = [...values].sort((left, right) => left - right),
    middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};
const percentile = (values: readonly number[], fraction: number) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  ] as number;
};

function summarizeMetric(
  values: readonly number[],
  seed: number,
): CollectionRecipeMetric {
  if (
    !values.length ||
    values.some((value) => !Number.isFinite(value) || value < 0)
  )
    throw new Error("INVALID_COLLECTION_RECIPE_SAMPLES: invalid metric");
  const ordered = [...values].sort((left, right) => left - right),
    center = median(ordered),
    deviations = ordered.map((value) => Math.abs(value - center)),
    bootstrap: number[] = [];
  let state = (seed ^ 0x9e3779b9) >>> 0;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  for (let iteration = 0; iteration < 1_000; iteration++) {
    const resample = Array.from(
      { length: values.length },
      () => ordered[Math.floor(random() * ordered.length)] as number,
    );
    bootstrap.push(median(resample));
  }
  return Object.freeze({
    median: round(center),
    mad: round(median(deviations)),
    p95: round(percentile(values, 0.95)),
    bootstrap95: Object.freeze([
      round(percentile(bootstrap, 0.025)),
      round(percentile(bootstrap, 0.975)),
    ]) as readonly [number, number],
  });
}

export function summarizeCollectionRecipeSamples(
  samples: readonly CollectionRecipeSample[],
): CollectionRecipeSummary[] {
  const groups = new Map<string, CollectionRecipeSample[]>();
  for (const row of samples) {
    if (
      !ID.test(row.caseId) ||
      !ID.test(row.recipeId) ||
      (row.partition !== "exploration" && row.partition !== "holdout") ||
      !Number.isSafeInteger(row.sample) ||
      row.sample < 0
    )
      throw new Error(
        "INVALID_COLLECTION_RECIPE_SAMPLES: invalid identity or sample index",
      );
    const key = `${row.partition}\0${row.caseId}\0${row.recipeId}`,
      group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((rows) => {
      const first = rows[0];
      if (!first)
        throw new Error("INVALID_COLLECTION_RECIPE_SAMPLES: empty group");
      const invariant = <K extends keyof CollectionRecipeSample>(key: K) => {
        const values = new Set(rows.map((row) => row[key]));
        if (values.size !== 1)
          throw new Error(`INVALID_COLLECTION_RECIPE_SAMPLES: varying ${key}`);
        return first[key];
      };
      if (new Set(rows.map((row) => row.sample)).size !== rows.length)
        throw new Error("INVALID_COLLECTION_RECIPE_SAMPLES: duplicate sample");
      for (const row of rows)
        if (
          !Number.isSafeInteger(row.artifactBytes) ||
          row.artifactBytes <= 0 ||
          !Number.isSafeInteger(row.linearMemoryBytes) ||
          row.linearMemoryBytes <= 0 ||
          !Number.isSafeInteger(row.arenaPeakBytes) ||
          row.arenaPeakBytes < 0 ||
          !Number.isSafeInteger(row.allocationCalls) ||
          row.allocationCalls < 0 ||
          !Number.isSafeInteger(row.allocationBytes) ||
          row.allocationBytes < 0 ||
          !Number.isSafeInteger(row.copyCalls) ||
          row.copyCalls < 0 ||
          !Number.isSafeInteger(row.copyBytes) ||
          row.copyBytes < 0 ||
          !Number.isSafeInteger(row.peakRssBytes) ||
          row.peakRssBytes <= 0
        )
          throw new Error(
            "INVALID_COLLECTION_RECIPE_SAMPLES: invalid count metric",
          );
      for (const expected of Array.from({ length: rows.length }, (_, i) => i))
        if (!rows.some((row) => row.sample === expected))
          throw new Error("INVALID_COLLECTION_RECIPE_SAMPLES: sample gap");
      const groupSeed = [
          ...`${first.partition}/${first.caseId}/${first.recipeId}`,
        ].reduce(
          (value, character) =>
            (value * 33 + (character.codePointAt(0) ?? 0)) >>> 0,
          5381,
        ),
        metric = (
          key:
            | "buildMs"
            | "loadMs"
            | "emitMs"
            | "optimizerReadMs"
            | "optimizerPreValidationMs"
            | "optimizerCoreMs"
            | "optimizerPostValidationMs"
            | "optimizerEmitMs"
            | "compileMs"
            | "instantiateMs"
            | "encodeMs"
            | "hostValidationMs"
            | "evaluateMs"
            | "decodeMs"
            | "endToEndMs",
        ) =>
          summarizeMetric(
            rows.map((row) => row[key]),
            groupSeed + key.length,
          );
      return Object.freeze({
        caseId: invariant("caseId"),
        partition: invariant("partition"),
        recipeId: invariant("recipeId"),
        buildMs: metric("buildMs"),
        loadMs: metric("loadMs"),
        emitMs: metric("emitMs"),
        optimizerReadMs: metric("optimizerReadMs"),
        optimizerPreValidationMs: metric("optimizerPreValidationMs"),
        optimizerCoreMs: metric("optimizerCoreMs"),
        optimizerPostValidationMs: metric("optimizerPostValidationMs"),
        optimizerEmitMs: metric("optimizerEmitMs"),
        compileMs: metric("compileMs"),
        instantiateMs: metric("instantiateMs"),
        encodeMs: metric("encodeMs"),
        hostValidationMs: metric("hostValidationMs"),
        evaluateMs: metric("evaluateMs"),
        decodeMs: metric("decodeMs"),
        endToEndMs: metric("endToEndMs"),
        artifactBytes: invariant("artifactBytes"),
        linearMemoryBytes: invariant("linearMemoryBytes"),
        arenaPeakBytes: invariant("arenaPeakBytes"),
        allocationCalls: invariant("allocationCalls"),
        allocationBytes: invariant("allocationBytes"),
        copyCalls: invariant("copyCalls"),
        copyBytes: invariant("copyBytes"),
        peakRssBytes: Math.max(...rows.map((row) => row.peakRssBytes)),
      });
    })
    .sort((left, right) =>
      `${left.partition}/${left.caseId}/${left.recipeId}`.localeCompare(
        `${right.partition}/${right.caseId}/${right.recipeId}`,
      ),
    );
}

export function decideCollectionBinaryenRecipe(
  summaries: readonly CollectionRecipeSummary[],
  verifications: readonly Verification[],
  recipeIds: readonly string[],
  config: CollectionRecipeDecisionConfig,
): Record<string, unknown> {
  if (
    !Number.isFinite(config.maximumRegressionPercent) ||
    config.maximumRegressionPercent < 0 ||
    !Number.isFinite(config.requiredImprovementPercent) ||
    config.requiredImprovementPercent < 0 ||
    !Number.isFinite(config.maximumArtifactRatio) ||
    config.maximumArtifactRatio < 1 ||
    !Number.isFinite(config.maximumMemoryRegressionPercent) ||
    config.maximumMemoryRegressionPercent < 0
  )
    throw new Error("INVALID_COLLECTION_RECIPE_DECISION: invalid config");
  const recipeSet = new Set(recipeIds);
  if (
    recipeIds.some((recipeId) => !ID.test(recipeId)) ||
    recipeSet.size !== recipeIds.length ||
    !recipeSet.has(config.baselineRecipeId) ||
    recipeIds.length < 2
  )
    throw new Error("INVALID_COLLECTION_RECIPE_DECISION: invalid recipes");
  const verificationIds = new Set(verifications.map((row) => row.recipeId));
  if (
    verifications.some(
      (row) =>
        !ID.test(row.recipeId) ||
        typeof row.correctness !== "boolean" ||
        typeof row.rawAbi !== "boolean" ||
        typeof row.reproducible !== "boolean",
    ) ||
    verificationIds.size !== verifications.length ||
    verificationIds.size !== recipeSet.size ||
    [...recipeSet].some((recipeId) => !verificationIds.has(recipeId))
  )
    throw new Error(
      "INVALID_COLLECTION_RECIPE_DECISION: invalid verifications",
    );
  const holdout = summaries.filter((row) => row.partition === "holdout");
  if (holdout.some((row) => !recipeSet.has(row.recipeId)))
    throw new Error("INVALID_COLLECTION_RECIPE_DECISION: unknown recipe row");
  const rowKeys = holdout.map((row) => `${row.recipeId}\0${row.caseId}`);
  if (new Set(rowKeys).size !== rowKeys.length)
    throw new Error("INVALID_COLLECTION_RECIPE_DECISION: duplicate case row");
  const baselineList = holdout.filter(
      (row) => row.recipeId === config.baselineRecipeId,
    ),
    baselineRows = new Map(baselineList.map((row) => [row.caseId, row]));
  if (!baselineRows.size || baselineRows.size !== baselineList.length)
    throw new Error("INVALID_COLLECTION_RECIPE_DECISION: missing baseline");
  for (const row of holdout)
    if (
      !row.caseId ||
      !Number.isFinite(row.endToEndMs.median) ||
      row.endToEndMs.median <= 0 ||
      !Number.isFinite(row.endToEndMs.bootstrap95[0]) ||
      row.endToEndMs.bootstrap95[0] <= 0 ||
      !Number.isFinite(row.endToEndMs.bootstrap95[1]) ||
      row.endToEndMs.bootstrap95[1] <= 0 ||
      row.endToEndMs.bootstrap95[0] > row.endToEndMs.bootstrap95[1] ||
      !Number.isFinite(row.buildMs.median) ||
      row.buildMs.median < 0 ||
      !Number.isSafeInteger(row.artifactBytes) ||
      row.artifactBytes <= 0 ||
      !Number.isSafeInteger(row.peakRssBytes) ||
      row.peakRssBytes <= 0 ||
      !Number.isSafeInteger(row.arenaPeakBytes) ||
      row.arenaPeakBytes < 0
    )
      throw new Error("INVALID_COLLECTION_RECIPE_DECISION: invalid metric");
  const verificationByRecipe = new Map(
      verifications.map((row) => [row.recipeId, row]),
    ),
    candidates = recipeIds
      .filter((recipeId) => recipeId !== config.baselineRecipeId)
      .map((recipeId) => {
        const verification = verificationByRecipe.get(recipeId),
          rows = holdout.filter((row) => row.recipeId === recipeId);
        if (
          !verification ||
          rows.length !== baselineRows.size ||
          rows.some((row) => !baselineRows.has(row.caseId))
        )
          throw new Error(
            `INVALID_COLLECTION_RECIPE_DECISION: incomplete ${recipeId}`,
          );
        const analysisRows = rows.map((row) => {
            const baseline = baselineRows.get(row.caseId);
            if (!baseline)
              throw new Error(
                `INVALID_COLLECTION_RECIPE_DECISION: unmatched ${row.caseId}`,
              );
            const ratio = row.endToEndMs.median / baseline.endToEndMs.median,
              conservativeRatio =
                row.endToEndMs.bootstrap95[1] /
                baseline.endToEndMs.bootstrap95[0];
            return {
              caseId: row.caseId,
              ratio,
              conservativeRatio,
            };
          }),
          comparisons = analysisRows
            .map((row) => {
              return {
                caseId: row.caseId,
                changePercent: round((row.ratio - 1) * 100),
                conservativeChangePercent: round(
                  (row.conservativeRatio - 1) * 100,
                ),
              };
            })
            .sort((left, right) => left.caseId.localeCompare(right.caseId)),
          artifactRatio = Math.max(
            ...rows.map((row) => {
              const baseline = baselineRows.get(
                row.caseId,
              ) as CollectionRecipeSummary;
              return row.artifactBytes / baseline.artifactBytes;
            }),
          ),
          memoryRegression = Math.max(
            ...rows.flatMap((row) => {
              const baseline = baselineRows.get(
                row.caseId,
              ) as CollectionRecipeSummary;
              return [
                (row.peakRssBytes / Math.max(1, baseline.peakRssBytes) - 1) *
                  100,
                (row.arenaPeakBytes / Math.max(1, baseline.arenaPeakBytes) -
                  1) *
                  100,
              ];
            }),
          ),
          memoryWithinLimit = rows.every((row) => {
            const baseline = baselineRows.get(
                row.caseId,
              ) as CollectionRecipeSummary,
              allowedMultiplier = 100 + config.maximumMemoryRegressionPercent;
            return (
              atMost(
                row.peakRssBytes / baseline.peakRssBytes,
                allowedMultiplier / 100,
              ) &&
              (baseline.arenaPeakBytes === 0
                ? row.arenaPeakBytes === 0
                : atMost(
                    row.arenaPeakBytes / baseline.arenaPeakBytes,
                    allowedMultiplier / 100,
                  ))
            );
          }),
          noRegression = analysisRows.every((row) =>
            atMost(
              (row.conservativeRatio - 1) * 100,
              config.maximumRegressionPercent,
            ),
          ),
          large = analysisRows.filter((row) =>
            /(?:medium|maximum)$/u.test(row.caseId),
          ),
          improvements = large.filter((row) =>
            atLeast(
              (1 - row.conservativeRatio) * 100,
              config.requiredImprovementPercent,
            ),
          ).length,
          clearImprovement =
            large.length > 0 && improvements > large.length / 2,
          safe =
            verification.correctness &&
            verification.rawAbi &&
            verification.reproducible,
          eligible =
            safe &&
            noRegression &&
            clearImprovement &&
            atMost(artifactRatio, config.maximumArtifactRatio) &&
            memoryWithinLimit,
          geometricSpeedup = Math.exp(
            analysisRows.reduce(
              (sum, row) => sum + Math.log(1 / row.ratio),
              0,
            ) / analysisRows.length,
          ),
          buildMs = Math.max(...rows.map((row) => row.buildMs.median));
        return {
          recipeId,
          verification,
          comparisons,
          artifactRatio: round(artifactRatio),
          maximumMemoryRegressionPercent: round(memoryRegression),
          geometricSpeedup: round(geometricSpeedup),
          buildMs: round(buildMs),
          eligible,
          status: !safe
            ? "rejected-safety"
            : !noRegression
              ? "rejected-regression"
              : !clearImprovement
                ? "inconclusive"
                : !atMost(artifactRatio, config.maximumArtifactRatio)
                  ? "rejected-size"
                  : !memoryWithinLimit
                    ? "rejected-memory"
                    : "eligible",
        };
      }),
    selected = [...candidates]
      .filter((candidate) => candidate.eligible)
      .sort(
        (left, right) =>
          right.geometricSpeedup - left.geometricSpeedup ||
          left.artifactRatio - right.artifactRatio ||
          left.buildMs - right.buildMs ||
          left.recipeId.localeCompare(right.recipeId),
      )[0];
  return {
    format: "llang-collection-binaryen-decision",
    version: 1,
    outcome: selected ? "adopt" : "retain-baseline",
    selectedRecipeId: selected?.recipeId ?? null,
    config,
    candidates,
    rationale: selected
      ? "One frozen recipe passed every safety, reproducibility, holdout performance, size, and memory gate."
      : "No frozen recipe passed every safety, reproducibility, holdout performance, size, and memory gate.",
  };
}
