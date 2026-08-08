import type { PredicateExpression } from "./ir";
import { sha256, stableJson } from "./semantic-fingerprint";

export type SemanticTddCandidateEvaluation = {
  id: string;
  semanticSignature: string;
  hardPassed: boolean;
  mutationPassed: boolean;
  mutationScore: number;
  irNodeCount: number;
  irDepth: number;
};

export type SemanticTddSelectionReport = {
  version: 1;
  contractHash: string;
  testPlanHash: string;
  redCertificateHash: string;
  candidates: SemanticTddCandidateEvaluation[];
  selectedCandidate: string | null;
  outcome: "selected" | "unresolved" | "review-required";
};

export function createSingleCandidateSelectionReport(input: {
  contractHash: string;
  testPlanHash: string;
  redCertificateHash: string;
  candidateId: string;
  expression: PredicateExpression;
  hardPassed: boolean;
  mutationScore: number;
  mutationPassed: boolean;
}): SemanticTddSelectionReport {
  const metrics = expressionMetrics(input.expression);
  const candidate: SemanticTddCandidateEvaluation = {
    id: input.candidateId,
    semanticSignature: sha256(stableJson(input.expression)),
    hardPassed: input.hardPassed,
    mutationPassed: input.mutationPassed,
    mutationScore: input.mutationScore,
    irNodeCount: metrics.nodes,
    irDepth: metrics.depth,
  };
  const selected = candidate.hardPassed && candidate.mutationPassed;
  return {
    version: 1,
    contractHash: input.contractHash,
    testPlanHash: input.testPlanHash,
    redCertificateHash: input.redCertificateHash,
    candidates: [candidate],
    selectedCandidate: selected ? candidate.id : null,
    outcome: selected ? "selected" : "unresolved",
  };
}

export function parseSemanticTddSelectionReport(
  input: unknown,
): SemanticTddSelectionReport {
  const value = recordValue(input, "selectionReport");
  exactKeys(
    value,
    [
      "version",
      "contractHash",
      "testPlanHash",
      "redCertificateHash",
      "candidates",
      "selectedCandidate",
      "outcome",
    ],
    "selectionReport",
  );
  if (value.version !== 1) {
    throw new Error("selectionReport.version must be 1");
  }
  if (!Array.isArray(value.candidates) || value.candidates.length === 0) {
    throw new Error("selectionReport.candidates must be non-empty");
  }
  const candidates = value.candidates.map((candidateInput, index) => {
    const path = `selectionReport.candidates[${index}]`;
    const candidate = recordValue(candidateInput, path);
    exactKeys(
      candidate,
      [
        "id",
        "semanticSignature",
        "hardPassed",
        "mutationPassed",
        "mutationScore",
        "irNodeCount",
        "irDepth",
      ],
      path,
    );
    if (
      typeof candidate.hardPassed !== "boolean" ||
      typeof candidate.mutationPassed !== "boolean"
    ) {
      throw new Error(`${path} pass fields must be booleans`);
    }
    return {
      id: stringValue(candidate.id, `${path}.id`),
      semanticSignature: hashValue(
        candidate.semanticSignature,
        `${path}.semanticSignature`,
      ),
      hardPassed: candidate.hardPassed,
      mutationPassed: candidate.mutationPassed,
      mutationScore: unitNumber(
        candidate.mutationScore,
        `${path}.mutationScore`,
      ),
      irNodeCount: positiveInteger(
        candidate.irNodeCount,
        `${path}.irNodeCount`,
      ),
      irDepth: positiveInteger(candidate.irDepth, `${path}.irDepth`),
    };
  });
  if (
    new Set(candidates.map((candidate) => candidate.id)).size !==
    candidates.length
  ) {
    throw new Error("selectionReport candidate IDs must be unique");
  }
  if (
    value.outcome !== "selected" &&
    value.outcome !== "unresolved" &&
    value.outcome !== "review-required"
  ) {
    throw new Error("selectionReport.outcome is invalid");
  }
  const selectedCandidate =
    value.selectedCandidate === null
      ? null
      : stringValue(
          value.selectedCandidate,
          "selectionReport.selectedCandidate",
        );
  const selected =
    selectedCandidate === null
      ? undefined
      : candidates.find((candidate) => candidate.id === selectedCandidate);
  if (
    value.outcome === "selected" &&
    (selected === undefined ||
      !selected.hardPassed ||
      !selected.mutationPassed)
  ) {
    throw new Error(
      "selectionReport selected candidate must exist and pass all hard gates",
    );
  }
  if (value.outcome !== "selected" && selectedCandidate !== null) {
    throw new Error(
      "selectionReport.selectedCandidate must be null unless selected",
    );
  }
  return {
    version: 1,
    contractHash: hashValue(
      value.contractHash,
      "selectionReport.contractHash",
    ),
    testPlanHash: hashValue(
      value.testPlanHash,
      "selectionReport.testPlanHash",
    ),
    redCertificateHash: hashValue(
      value.redCertificateHash,
      "selectionReport.redCertificateHash",
    ),
    candidates,
    selectedCandidate,
    outcome: value.outcome,
  };
}

function expressionMetrics(
  expression: PredicateExpression,
): { nodes: number; depth: number } {
  switch (expression.kind) {
    case "all":
    case "any": {
      const children = expression.conditions.map(expressionMetrics);
      return {
        nodes: 1 + children.reduce((sum, child) => sum + child.nodes, 0),
        depth: 1 + Math.max(...children.map((child) => child.depth)),
      };
    }
    case "not": {
      const child = expressionMetrics(expression.condition);
      return { nodes: 1 + child.nodes, depth: 1 + child.depth };
    }
    case "equals":
    case "present":
      return { nodes: 1, depth: 1 };
  }
}

function exactKeys(
  value: Record<string, unknown>,
  keys: string[],
  path: string,
): void {
  const expected = new Set(keys);
  const unknown = Object.keys(value).find((key) => !expected.has(key));
  if (unknown !== undefined) {
    throw new Error(`${path} contains unknown field ${unknown}`);
  }
  const missing = keys.find((key) => !(key in value));
  if (missing !== undefined) throw new Error(`${path} is missing ${missing}`);
}

function recordValue(
  input: unknown,
  path: string,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${path} must be an object`);
  }
  return input as Record<string, unknown>;
}

function stringValue(input: unknown, path: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return input;
}

function hashValue(input: unknown, path: string): string {
  const value = stringValue(input, path);
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${path} must be a sha256 hash`);
  }
  return value;
}

function unitNumber(input: unknown, path: string): number {
  if (
    typeof input !== "number" ||
    !Number.isFinite(input) ||
    input < 0 ||
    input > 1
  ) {
    throw new Error(`${path} must be between 0 and 1`);
  }
  return input;
}

function positiveInteger(input: unknown, path: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw new Error(`${path} must be a positive safe integer`);
  }
  return input as number;
}
