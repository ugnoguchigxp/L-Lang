import { describe, expect, test } from "bun:test";

import { parseSemanticEvolutionCandidate } from "./semantic-evolution-candidate";

describe("Semantic Evolution candidate parser", () => {
  test("strictly parses a complete ready candidate", () => {
    expect(parseSemanticEvolutionCandidate(validCandidate())).toMatchObject({
      version: 1,
      id: "20260808010101-abcdef12",
      status: "ready",
      source: "examples/customer/semantic.ts",
      output: "examples/customer/is-customer.generated.ts",
      validation: { passed: true, error: null },
    });
  });

  test("rejects unknown, missing, malformed, and inconsistent fields", () => {
    const cases: Array<{ mutate: (candidate: Candidate) => void; message: string }> = [
      {
        mutate: (candidate) => {
          candidate.unexpected = true;
        },
        message: "unknown field unexpected",
      },
      {
        mutate: (candidate) => {
          delete candidate.output;
        },
        message: "is missing output",
      },
      {
        mutate: (candidate) => {
          (candidate.hashes as Candidate).unexpected = true;
        },
        message: "hashes contains unknown field unexpected",
      },
      {
        mutate: (candidate) => {
          candidate.source = "../outside.ts";
        },
        message: "source must be a normalized workspace-relative path",
      },
      {
        mutate: (candidate) => {
          candidate.output = "C:\\outside.ts";
        },
        message: "output must be a normalized workspace-relative path",
      },
      {
        mutate: (candidate) => {
          candidate.generatedCodeHash = "invalid";
        },
        message: "generatedCodeHash must be a lowercase SHA-256 hash",
      },
      {
        mutate: (candidate) => {
          candidate.candidateIr = null;
        },
        message: "diff.candidateIr must match candidateIr",
      },
      {
        mutate: (candidate) => {
          candidate.createdAt = "not-a-date";
        },
        message: "createdAt must be a canonical ISO-8601 UTC timestamp",
      },
      {
        mutate: (candidate) => {
          (candidate.response as Candidate).usage = {
            inputTokens: -1,
            outputTokens: 1,
            totalTokens: 0,
          };
        },
        message: "inputTokens must be a non-negative safe integer",
      },
    ];

    for (const testCase of cases) {
      const candidate = validCandidate();
      testCase.mutate(candidate);
      expect(() => parseSemanticEvolutionCandidate(candidate)).toThrow(
        testCase.message,
      );
    }
  });

  test("validates approval and unresolved state transitions", () => {
    const approved = validCandidate();
    approved.status = "approved";
    approved.approvedAt = "2026-08-08T01:02:03.000Z";
    expect(parseSemanticEvolutionCandidate(approved).status).toBe("approved");

    const unresolved = validCandidate();
    unresolved.status = "unresolved";
    unresolved.candidateIr = null;
    unresolved.generatedCodeHash = null;
    unresolved.validation = { passed: false, error: null };
    unresolved.diff = {
      ...(unresolved.diff as Candidate),
      classification: "unresolved",
      candidateIr: null,
      logicalShapeChanged: true,
      leafChanges: [
        {
          before: { kind: "present", property: ["email"] },
          after: null,
          changes: ["removed"],
        },
      ],
    };
    expect(parseSemanticEvolutionCandidate(unresolved).status).toBe(
      "unresolved",
    );
  });
});

type Candidate = Record<string, unknown>;

function validCandidate(): Candidate {
  const expression = { kind: "present", property: ["email"] };
  return {
    version: 1,
    id: "20260808010101-abcdef12",
    status: "ready",
    source: "examples/customer/semantic.ts",
    output: "examples/customer/is-customer.generated.ts",
    predicate: "isCustomer",
    concept: "Customer",
    conceptId: "customer.active",
    conceptSource: "concepts/customer.ts",
    provider: "fixture:evolution",
    model: "gpt-5.4-mini",
    baselineFingerprint: "a".repeat(64),
    proposedFingerprint: "b".repeat(64),
    hashes: {
      conceptHash: "c".repeat(64),
      sourceHash: "d".repeat(64),
      typeHash: "e".repeat(64),
      testHash: "f".repeat(64),
      promptHash: "1".repeat(64),
      contextVersion: 1,
      contextHash: "2".repeat(64),
    },
    targetTypeName: "CustomerRecord",
    contextSummary: {
      version: 1,
      targetSource: "examples/customer/semantic.ts",
      relatedTypeSources: [],
      verifiedBindingSources: [],
    },
    previousIr: structuredClone(expression),
    candidateIr: structuredClone(expression),
    generatedCodeHash: "3".repeat(64),
    response: {
      id: "response-1",
      model: "gpt-5.4-mini",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    },
    consensus: null,
    validation: { passed: true, error: null },
    diff: {
      classification: "compatible",
      summary: "The Predicate IR is unchanged.",
      previousIr: structuredClone(expression),
      candidateIr: structuredClone(expression),
      logicalShapeChanged: false,
      leafChanges: [
        {
          before: structuredClone(expression),
          after: structuredClone(expression),
          changes: [],
        },
      ],
      diagnostics: [],
    },
    createdAt: "2026-08-08T01:01:01.000Z",
    approvedAt: null,
  };
}
