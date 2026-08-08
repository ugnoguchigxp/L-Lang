import { type PredicateExpression, parsePredicateExpression } from "./ir";
import type { OpenAIResult } from "./openai";
import type { ProjectContextSummary } from "./project-context";
import type {
  PredicateSemanticHashes,
  StaticJudgmentSemanticHashes,
} from "./semantic-fingerprint";
import type {
  SemanticLockEntry,
  StaticJudgmentLockEntry,
} from "./semantic-lock";

export type ReviewValidation = {
  candidateTypecheck: "passed";
  projectTypecheck: "passed";
  semanticTest: "passed" | "not-applicable";
};

type ReviewCandidateBase = {
  version: 1;
  id: string;
  status: "ready" | "approved";
  source: string;
  output: string;
  symbol: string;
  conceptId: string;
  provider: string;
  model: string;
  fingerprint: string;
  generatedCodeHash: string;
  validation: ReviewValidation;
  createdAt: string;
  approvedAt: string | null;
  reviewer: string | null;
};

export type PredicateReviewCandidate = ReviewCandidateBase & {
  kind: "predicate";
  targetTypeName: string;
  contextSummary: ProjectContextSummary;
  hashes: PredicateSemanticHashes;
  resolvedIr: PredicateExpression;
  baselineFingerprint: string | null;
  response: SemanticLockEntry["response"];
};

export type StaticJudgmentReviewCandidate = ReviewCandidateBase & {
  kind: "static-judgment";
  hashes: StaticJudgmentSemanticHashes;
  resolvedValue: boolean;
  baselineFingerprint: string | null;
  response: StaticJudgmentLockEntry["response"];
};

export type ReviewCandidate =
  | PredicateReviewCandidate
  | StaticJudgmentReviewCandidate;

export function parseReviewCandidate(input: unknown): ReviewCandidate {
  const value = objectValue(input, "review candidate");
  const kind = value.kind;
  if (kind !== "predicate" && kind !== "static-judgment") {
    throw new Error(
      "review candidate.kind must be predicate or static-judgment",
    );
  }
  assertKeys(
    value,
    kind === "predicate"
      ? [
          "version",
          "id",
          "status",
          "kind",
          "source",
          "output",
          "symbol",
          "conceptId",
          "provider",
          "model",
          "fingerprint",
          "generatedCodeHash",
          "validation",
          "targetTypeName",
          "contextSummary",
          "hashes",
          "resolvedIr",
          "baselineFingerprint",
          "response",
          "createdAt",
          "approvedAt",
          "reviewer",
        ]
      : [
          "version",
          "id",
          "status",
          "kind",
          "source",
          "output",
          "symbol",
          "conceptId",
          "provider",
          "model",
          "fingerprint",
          "generatedCodeHash",
          "validation",
          "hashes",
          "resolvedValue",
          "baselineFingerprint",
          "response",
          "createdAt",
          "approvedAt",
          "reviewer",
        ],
    "review candidate",
  );
  if (value.version !== 1) {
    throw new Error("review candidate.version must be 1");
  }
  const id = stringValue(value.id, "review candidate.id");
  if (!/^review-[0-9]{14}-[a-f0-9]{8}$/.test(id)) {
    throw new Error("review candidate.id is invalid");
  }
  if (value.status !== "ready" && value.status !== "approved") {
    throw new Error("review candidate.status must be ready or approved");
  }
  const status: "ready" | "approved" = value.status;
  const approvedAt = nullableDate(
    value.approvedAt,
    "review candidate.approvedAt",
  );
  const reviewer = nullableTrimmedString(
    value.reviewer,
    "review candidate.reviewer",
  );
  if (status === "ready" && (approvedAt !== null || reviewer !== null)) {
    throw new Error("ready review candidate must not have approval metadata");
  }
  if (status === "approved" && (approvedAt === null || reviewer === null)) {
    throw new Error("approved review candidate requires approval metadata");
  }
  const base = {
    version: 1 as const,
    id,
    status,
    source: stringValue(value.source, "review candidate.source"),
    output: stringValue(value.output, "review candidate.output"),
    symbol: stringValue(value.symbol, "review candidate.symbol"),
    conceptId: stringValue(value.conceptId, "review candidate.conceptId"),
    provider: stringValue(value.provider, "review candidate.provider"),
    model: stringValue(value.model, "review candidate.model"),
    fingerprint: hashValue(value.fingerprint, "review candidate.fingerprint"),
    generatedCodeHash: hashValue(
      value.generatedCodeHash,
      "review candidate.generatedCodeHash",
    ),
    baselineFingerprint: nullableHash(
      value.baselineFingerprint,
      "review candidate.baselineFingerprint",
    ),
    response: responseValue(value.response, "review candidate.response"),
    createdAt: dateValue(value.createdAt, "review candidate.createdAt"),
    approvedAt,
    reviewer,
  };
  if (kind === "predicate") {
    return {
      ...base,
      kind,
      targetTypeName: stringValue(
        value.targetTypeName,
        "review candidate.targetTypeName",
      ),
      contextSummary: contextSummaryValue(value.contextSummary),
      validation: validationValue(value.validation, "passed"),
      hashes: predicateHashesValue(value.hashes),
      resolvedIr: parsePredicateExpression(
        value.resolvedIr,
        "review candidate.resolvedIr",
      ),
    };
  }
  if (typeof value.resolvedValue !== "boolean") {
    throw new Error("review candidate.resolvedValue must be a boolean");
  }
  return {
    ...base,
    kind,
    validation: validationValue(value.validation, "not-applicable"),
    hashes: staticHashesValue(value.hashes),
    resolvedValue: value.resolvedValue,
  };
}

export function trimmedString(input: unknown, path: string): string {
  const value = stringValue(input, path);
  if (value.trim() !== value) throw new Error(`${path} must be trimmed`);
  return value;
}

function validationValue(
  input: unknown,
  semanticTest: "passed" | "not-applicable",
): ReviewValidation {
  const value = objectValue(input, "review candidate.validation");
  assertKeys(
    value,
    ["candidateTypecheck", "projectTypecheck", "semanticTest"],
    "review candidate.validation",
  );
  if (
    value.candidateTypecheck !== "passed" ||
    value.projectTypecheck !== "passed" ||
    value.semanticTest !== semanticTest
  ) {
    throw new Error("review candidate.validation is invalid");
  }
  return {
    candidateTypecheck: "passed",
    projectTypecheck: "passed",
    semanticTest,
  };
}

function predicateHashesValue(input: unknown): PredicateSemanticHashes {
  const value = objectValue(input, "review candidate.hashes");
  assertKeys(
    value,
    [
      "conceptHash",
      "sourceHash",
      "typeHash",
      "testHash",
      "promptHash",
      "contextVersion",
      "contextHash",
    ],
    "review candidate.hashes",
  );
  if (value.contextVersion !== 1) {
    throw new Error("review candidate.hashes.contextVersion must be 1");
  }
  return {
    conceptHash: hashValue(
      value.conceptHash,
      "review candidate.hashes.conceptHash",
    ),
    sourceHash: hashValue(
      value.sourceHash,
      "review candidate.hashes.sourceHash",
    ),
    typeHash: hashValue(value.typeHash, "review candidate.hashes.typeHash"),
    testHash: hashValue(value.testHash, "review candidate.hashes.testHash"),
    promptHash: hashValue(
      value.promptHash,
      "review candidate.hashes.promptHash",
    ),
    contextVersion: 1,
    contextHash: hashValue(
      value.contextHash,
      "review candidate.hashes.contextHash",
    ),
  };
}

function contextSummaryValue(input: unknown): ProjectContextSummary {
  const value = objectValue(input, "review candidate.contextSummary");
  assertKeys(
    value,
    ["version", "targetSource", "relatedTypeSources", "verifiedBindingSources"],
    "review candidate.contextSummary",
  );
  if (value.version !== 1) {
    throw new Error("review candidate.contextSummary.version must be 1");
  }
  return {
    version: 1,
    targetSource: stringValue(
      value.targetSource,
      "review candidate.contextSummary.targetSource",
    ),
    relatedTypeSources: stringArrayValue(
      value.relatedTypeSources,
      "review candidate.contextSummary.relatedTypeSources",
    ),
    verifiedBindingSources: stringArrayValue(
      value.verifiedBindingSources,
      "review candidate.contextSummary.verifiedBindingSources",
    ),
  };
}

function stringArrayValue(input: unknown, path: string): string[] {
  if (!Array.isArray(input)) throw new Error(`${path} must be an array`);
  return input.map((value, index) => stringValue(value, `${path}[${index}]`));
}

function staticHashesValue(input: unknown): StaticJudgmentSemanticHashes {
  const value = objectValue(input, "review candidate.hashes");
  assertKeys(
    value,
    ["conceptHash", "valueHash", "promptHash"],
    "review candidate.hashes",
  );
  return {
    conceptHash: hashValue(
      value.conceptHash,
      "review candidate.hashes.conceptHash",
    ),
    valueHash: hashValue(value.valueHash, "review candidate.hashes.valueHash"),
    promptHash: hashValue(
      value.promptHash,
      "review candidate.hashes.promptHash",
    ),
  };
}

function responseValue(
  input: unknown,
  path: string,
): SemanticLockEntry["response"] {
  if (input === null) return null;
  const value = objectValue(input, path);
  assertKeys(value, ["id", "model", "usage"], path);
  let usage: OpenAIResult["usage"] = null;
  if (value.usage !== null) {
    const rawUsage = objectValue(value.usage, `${path}.usage`);
    assertKeys(
      rawUsage,
      ["inputTokens", "outputTokens", "totalTokens"],
      `${path}.usage`,
    );
    usage = {
      inputTokens: nonNegativeInteger(
        rawUsage.inputTokens,
        `${path}.usage.inputTokens`,
      ),
      outputTokens: nonNegativeInteger(
        rawUsage.outputTokens,
        `${path}.usage.outputTokens`,
      ),
      totalTokens: nonNegativeInteger(
        rawUsage.totalTokens,
        `${path}.usage.totalTokens`,
      ),
    };
  }
  return {
    id: stringValue(value.id, `${path}.id`),
    model: stringValue(value.model, `${path}.model`),
    usage,
  };
}

function objectValue(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${path} must be an object`);
  }
  return input as Record<string, unknown>;
}

function assertKeys(
  value: Record<string, unknown>,
  expected: string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${path} fields are invalid`);
  }
}

function stringValue(input: unknown, path: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return input;
}

function nullableTrimmedString(input: unknown, path: string): string | null {
  return input === null ? null : trimmedString(input, path);
}

function hashValue(input: unknown, path: string): string {
  const value = stringValue(input, path);
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${path} must be a lowercase SHA-256 hash`);
  }
  return value;
}

function nullableHash(input: unknown, path: string): string | null {
  return input === null ? null : hashValue(input, path);
}

function dateValue(input: unknown, path: string): string {
  const value = stringValue(input, path);
  if (new Date(value).toISOString() !== value) {
    throw new Error(`${path} must be a canonical ISO-8601 UTC timestamp`);
  }
  return value;
}

function nullableDate(input: unknown, path: string): string | null {
  return input === null ? null : dateValue(input, path);
}

function nonNegativeInteger(input: unknown, path: string): number {
  if (typeof input !== "number" || !Number.isInteger(input) || input < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }
  return input;
}
