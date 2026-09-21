import { describe, expect, test } from "bun:test";
import {
  decideCollectionStability,
  summarizeCollectionStability,
  validateCollectionStabilityMatrix,
  type CollectionStabilitySample,
} from "./llang-collection-stability-report";

const cases = [
  ["fold-medium", "fold", 1024],
  ["fold-maximum", "fold", 4096],
  ["map-medium", "map", 1024],
  ["map-maximum", "map", 4096],
] as const;

function matrix(orderBias = false): CollectionStabilitySample[] {
  const rows: CollectionStabilitySample[] = [];
  for (let blockId = 0; blockId < 6; blockId++)
    for (const [baseIndex, [caseId, programId, size]] of cases.entries())
      for (const lane of ["cold", "module-cached"] as const)
        for (let sample = 0; sample < 5; sample++) {
          const orderIndex = (baseIndex + blockId) % cases.length,
            coldTotal = orderBias && blockId % 2 === 1 ? 1400 : 1000,
            timing =
              lane === "cold"
                ? {
                    compileNs: 600,
                    instantiateNs: 100,
                    encodeNs: 80,
                    hostValidationNs: 40,
                    evaluateNs: 80,
                    decodeNs: 50,
                    totalNs: coldTotal,
                  }
                : {
                    compileNs: 0,
                    instantiateNs: 80,
                    encodeNs: 50,
                    hostValidationNs: 30,
                    evaluateNs: 80,
                    decodeNs: 40,
                    totalNs: 400,
                  },
            accountedNs =
              timing.compileNs +
              timing.instantiateNs +
              timing.encodeNs +
              timing.hostValidationNs +
              timing.evaluateNs +
              timing.decodeNs;
          rows.push({
            blockId,
            orderId: `order-${blockId}`,
            orderIndex,
            caseId,
            programId,
            partition: "holdout",
            size,
            lane,
            sample,
            clockOverheadNs: 10,
            ...timing,
            accountedNs,
            unattributedNs: timing.totalNs - accountedNs,
            inputBytes: size * 4 + 8,
            outputBytes: 4,
          });
        }
  return rows;
}

const config = {
  blocks: 6,
  samples: 5,
  maximumUnattributedShare: 0.2,
  maximumRelativeMad: 0.25,
  minimumMedianShare: 0.3,
  minimumIntervalShare: 0.2,
  minimumRobustCases: 3,
  maximumBlockMedianRelativeMad: 0.15,
  maximumOrderDifference: 0.2,
  minimumWinningBlocks: 5,
  minimumPreparedReduction: 0.3,
  minimumPreparedIntervalReduction: 0.2,
  maximumPreparedRatioUpper: 1.05,
} as const;

describe("Collection runtime stability report", () => {
  test("adopts the prepared lifecycle only after every frozen gate passes", () => {
    const samples = matrix();
    validateCollectionStabilityMatrix(
      samples,
      cases.map(([id]) => id),
      6,
      5,
    );
    const summary = summarizeCollectionStability(samples),
      diagnostics = cases.map(([caseId, programId, size]) => ({
        caseId,
        programId,
        size,
        arenaPeakBytes: 0,
        allocationCalls: 0,
        allocationBytes: 0,
        copyCalls: 0,
        copyBytes: 0,
        metricsHash: "a".repeat(64),
      })),
      decision = decideCollectionStability(
        samples,
        summary,
        diagnostics,
        cases.map(([id]) => id),
        config,
      );
    expect(decision.outcome).toBe("adopt-prepared-lifecycle");
    expect(decision.selectedTarget).toBe("startup");
  });

  test("fails closed on order bias and duplicate identities", () => {
    const samples = matrix(true),
      summary = summarizeCollectionStability(samples),
      decision = decideCollectionStability(
        samples,
        summary,
        cases.map(([caseId, programId, size]) => ({
          caseId,
          programId,
          size,
          arenaPeakBytes: 0,
          allocationCalls: 0,
          allocationBytes: 0,
          copyCalls: 0,
          copyBytes: 0,
          metricsHash: "a".repeat(64),
        })),
        cases.map(([id]) => id),
        config,
      );
    expect(decision.outcome).toBe("retain-baseline");
    expect(decision.qualityReasons).toContain("order-bias");
    expect(() =>
      validateCollectionStabilityMatrix(
        [...samples.slice(0, -1), samples[0] as CollectionStabilitySample],
        cases.map(([id]) => id),
        6,
        5,
      ),
    ).toThrow("duplicate identity");
  });
});
