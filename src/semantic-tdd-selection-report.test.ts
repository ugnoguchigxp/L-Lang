import { describe, expect, test } from "bun:test";

import {
  createSingleCandidateSelectionReport,
  parseSemanticTddSelectionReport,
} from "./semantic-tdd-selection-report";

const hash = "a".repeat(64);

describe("Semantic TDD Selection Report", () => {
  test("creates and strictly parses a selected single-candidate report", () => {
    const report = createSingleCandidateSelectionReport({
      contractHash: hash,
      testPlanHash: hash,
      redCertificateHash: hash,
      candidateId: "candidate-1",
      expression: {
        kind: "all",
        conditions: [
          { kind: "equals", property: ["status"], value: "active" },
          { kind: "present", property: ["email"] },
        ],
      },
      hardPassed: true,
      mutationScore: 1,
      mutationPassed: true,
    });
    expect(parseSemanticTddSelectionReport(report)).toEqual(report);
    expect(report).toMatchObject({
      outcome: "selected",
      selectedCandidate: "candidate-1",
      candidates: [{ irNodeCount: 3, irDepth: 2 }],
    });
  });

  test("rejects unknown fields and a failing selected candidate", () => {
    const report = createSingleCandidateSelectionReport({
      contractHash: hash,
      testPlanHash: hash,
      redCertificateHash: hash,
      candidateId: "candidate-1",
      expression: { kind: "present", property: ["email"] },
      hardPassed: true,
      mutationScore: 1,
      mutationPassed: true,
    });
    expect(() =>
      parseSemanticTddSelectionReport({ ...report, extra: true }),
    ).toThrow("unknown field");
    const candidate = report.candidates[0];
    if (candidate === undefined) {
      throw new Error("expected a selection candidate");
    }
    expect(() =>
      parseSemanticTddSelectionReport({
        ...report,
        candidates: [{ ...candidate, hardPassed: false }],
      }),
    ).toThrow("pass all hard gates");
    expect(() =>
      parseSemanticTddSelectionReport({
        ...report,
        candidates: [{ ...candidate, mutationScore: Number.NaN }],
      }),
    ).toThrow("between 0 and 1");
    expect(() =>
      parseSemanticTddSelectionReport({
        ...report,
        candidates: [
          {
            ...candidate,
            irNodeCount: Number.MAX_SAFE_INTEGER + 1,
          },
        ],
      }),
    ).toThrow("positive safe integer");
  });
});
