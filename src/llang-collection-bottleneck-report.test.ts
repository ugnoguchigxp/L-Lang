import { describe, expect, test } from "bun:test";
import {
  decideCollectionBottleneck,
  summarizeCollectionBottleneckSamples,
  type CollectionBottleneckSample,
} from "./llang-collection-bottleneck-report";

const sample = (
  caseId: string,
  programId: string,
  size: number,
  index: number,
  unattributedNs = 50,
  phases: Partial<
    Pick<
      CollectionBottleneckSample,
      | "compileNs"
      | "instantiateNs"
      | "encodeNs"
      | "hostValidationNs"
      | "evaluateNs"
      | "decodeNs"
    >
  > = {},
): CollectionBottleneckSample => {
  const timing = {
      compileNs: 600,
      instantiateNs: 100,
      encodeNs: 80,
      hostValidationNs: 40,
      evaluateNs: 80,
      decodeNs: 50,
      ...phases,
    },
    accountedNs = Object.values(timing).reduce((sum, value) => sum + value, 0);
  return {
    caseId,
    programId,
    partition: "holdout",
    size,
    sample: index,
    clockOverheadNs: 10,
    ...timing,
    totalNs: accountedNs + unattributedNs,
    accountedNs,
    unattributedNs,
    cachedInstantiateNs: 100,
    cachedEncodeNs: 80,
    cachedHostValidationNs: 40,
    cachedEvaluateNs: 80,
    cachedDecodeNs: 50,
    cachedTotalNs: 400,
    cachedUnattributedNs: 50,
    inputBytes: size * 4 + 8,
    outputBytes: 4,
  };
};

describe("Collection bottleneck report", () => {
  test("selects the only robust dominant category", () => {
    const samples: CollectionBottleneckSample[] = [];
    for (const [caseId, programId, size] of [
      ["fold-medium", "fold", 1024],
      ["fold-maximum", "fold", 4096],
      ["map-medium", "map", 1024],
      ["map-maximum", "map", 4096],
    ] as const)
      for (let index = 0; index < 5; index++)
        samples.push(sample(caseId, programId, size, index));
    const summary = summarizeCollectionBottleneckSamples(samples),
      diagnostics = summary.map((row) => ({
        caseId: row.caseId,
        programId: row.programId,
        size: row.size,
        arenaPeakBytes: 0,
        allocationCalls: 0,
        allocationBytes: 0,
        copyCalls: 0,
        copyBytes: 0,
        metricsHash: "a".repeat(64),
      })),
      decision = decideCollectionBottleneck(
        summary,
        diagnostics,
        summary.map((row) => row.caseId),
        {
          maximumUnattributedShare: 0.2,
          maximumRelativeMad: 0.25,
          minimumMedianShare: 0.3,
          minimumIntervalShare: 0.2,
          minimumRobustCases: 3,
        },
      );
    expect(decision.outcome).toBe("prioritize");
    expect(decision.selectedTarget).toBe("startup");
    expect(decision.diagnosticLabel).toBe("compile");
    expect(decision.caseVoteWinner).toBe("startup");
    expect(decision.mixRankConsistent).toBe(true);
    expect(() =>
      decideCollectionBottleneck(
        summary,
        diagnostics.slice(1),
        summary.map((row) => row.caseId),
        {
          maximumUnattributedShare: 0.2,
          maximumRelativeMad: 0.25,
          minimumMedianShare: 0.3,
          minimumIntervalShare: 0.2,
          minimumRobustCases: 3,
        },
      ),
    ).toThrow("incomplete matrix");
  });

  test("uses unrounded evidence to rank multiple eligible categories", () => {
    const samples: CollectionBottleneckSample[] = [],
      phases = {
        compileNs: 3_500_004,
        instantiateNs: 0,
        encodeNs: 2_000_000,
        hostValidationNs: 0,
        evaluateNs: 3_500_003,
        decodeNs: 999_993,
      };
    for (const [caseId, programId, size] of [
      ["fold-medium", "fold", 1024],
      ["fold-maximum", "fold", 4096],
      ["map-medium", "map", 1024],
      ["map-maximum", "map", 4096],
    ] as const)
      for (let index = 0; index < 5; index++)
        samples.push(sample(caseId, programId, size, index, 0, phases));
    const summary = summarizeCollectionBottleneckSamples(samples),
      decision = decideCollectionBottleneck(
        summary,
        summary.map((row) => ({
          caseId: row.caseId,
          programId: row.programId,
          size: row.size,
          arenaPeakBytes: 0,
          allocationCalls: 0,
          allocationBytes: 0,
          copyCalls: 0,
          copyBytes: 0,
          metricsHash: "a".repeat(64),
        })),
        summary.map((row) => row.caseId),
        {
          maximumUnattributedShare: 0.2,
          maximumRelativeMad: 0.25,
          minimumMedianShare: 0.3,
          minimumIntervalShare: 0.2,
          minimumRobustCases: 3,
        },
      ),
      candidates = decision.candidates as Array<{
        category: string;
        medianShare: number;
        eligible: boolean;
      }>,
      startup = candidates.find((row) => row.category === "startup"),
      evaluate = candidates.find((row) => row.category === "wasm-evaluate");
    expect(startup?.eligible).toBe(true);
    expect(evaluate?.eligible).toBe(true);
    expect(startup?.medianShare).toBe(evaluate?.medianShare);
    expect(decision.selectedTarget).toBe("startup");

    const tiedSummary = summarizeCollectionBottleneckSamples(
        samples.map((row) => ({
          ...row,
          compileNs: 3_500_000,
          evaluateNs: 3_500_000,
          decodeNs: 1_000_000,
        })),
      ),
      tiedDecision = decideCollectionBottleneck(
        tiedSummary,
        tiedSummary.map((row) => ({
          caseId: row.caseId,
          programId: row.programId,
          size: row.size,
          arenaPeakBytes: 0,
          allocationCalls: 0,
          allocationBytes: 0,
          copyCalls: 0,
          copyBytes: 0,
          metricsHash: "a".repeat(64),
        })),
        tiedSummary.map((row) => row.caseId),
        {
          maximumUnattributedShare: 0.2,
          maximumRelativeMad: 0.25,
          minimumMedianShare: 0.3,
          minimumIntervalShare: 0.2,
          minimumRobustCases: 3,
        },
      );
    expect(tiedDecision.mixWinner).toBeNull();
    expect(tiedDecision.caseVoteWinner).toBeNull();
    expect(tiedDecision.mixRankConsistent).toBe(false);
    expect(tiedDecision.outcome).toBe("inconclusive");
  });

  test("fails closed on poor attribution and duplicate samples", () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      sample("fold-medium", "fold", 1024, index, 500),
    );
    const summary = summarizeCollectionBottleneckSamples(rows),
      decision = decideCollectionBottleneck(
        summary,
        [
          {
            caseId: "fold-medium",
            programId: "fold",
            size: 1024,
            arenaPeakBytes: 0,
            allocationCalls: 0,
            allocationBytes: 0,
            copyCalls: 0,
            copyBytes: 0,
            metricsHash: "a".repeat(64),
          },
        ],
        ["fold-medium"],
        {
          maximumUnattributedShare: 0.2,
          maximumRelativeMad: 0.25,
          minimumMedianShare: 0.3,
          minimumIntervalShare: 0.2,
          minimumRobustCases: 1,
        },
      );
    expect(decision.outcome).toBe("inconclusive");
    expect(decision.qualityReasons).toContain("unattributed-share");
    expect(() =>
      summarizeCollectionBottleneckSamples([
        rows[0] as CollectionBottleneckSample,
        rows[0] as CollectionBottleneckSample,
      ]),
    ).toThrow("duplicate sample");
    expect(() =>
      summarizeCollectionBottleneckSamples([
        { ...(rows[0] as CollectionBottleneckSample), accountedNs: 949 },
      ]),
    ).toThrow("invalid timing");
    expect(() =>
      summarizeCollectionBottleneckSamples([
        {
          ...(rows[0] as CollectionBottleneckSample),
          cachedUnattributedNs: 49,
        },
      ]),
    ).toThrow("invalid timing");
  });
});
