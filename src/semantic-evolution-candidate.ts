import { isAbsolute } from "node:path";

import {
  type Literal,
  type PredicateExpression,
  parsePredicateExpression,
} from "./ir";
import type { OpenAIResult } from "./openai";
import type { ProjectContextSummary } from "./project-context";
import {
  assertConsensusParameters,
  type SemanticConsensusResult,
} from "./semantic-consensus";
import type { SemanticDiff, SemanticLeafChange } from "./semantic-diff";
import type { PredicateSemanticHashes } from "./semantic-fingerprint";
import {
  assertKnownKeys,
  SEMANTIC_LIMITS,
  validateDiagnostics,
} from "./semantic-limits";

export type EvolutionHashes = PredicateSemanticHashes;

export type SemanticEvolutionCandidate = {
  version: 1;
  id: string;
  status: "ready" | "invalid" | "unresolved" | "approved";
  source: string;
  output: string;
  predicate: string;
  concept: string;
  conceptId: string;
  conceptSource: string;
  provider: string;
  model: string;
  baselineFingerprint: string;
  proposedFingerprint: string;
  hashes: EvolutionHashes;
  targetTypeName: string;
  contextSummary: ProjectContextSummary;
  previousIr: PredicateExpression;
  candidateIr: PredicateExpression | null;
  generatedCodeHash: string | null;
  response: {
    id: string;
    model: string;
    usage: OpenAIResult["usage"];
  } | null;
  consensus: Omit<SemanticConsensusResult, "resolution"> | null;
  validation: {
    passed: boolean;
    error: string | null;
  };
  diff: SemanticDiff;
  createdAt: string;
  approvedAt: string | null;
};

const candidateKeys = [
  "version",
  "id",
  "status",
  "source",
  "output",
  "predicate",
  "concept",
  "conceptId",
  "conceptSource",
  "provider",
  "model",
  "baselineFingerprint",
  "proposedFingerprint",
  "hashes",
  "targetTypeName",
  "contextSummary",
  "previousIr",
  "candidateIr",
  "generatedCodeHash",
  "response",
  "consensus",
  "validation",
  "diff",
  "createdAt",
  "approvedAt",
] as const;

export function parseSemanticEvolutionCandidate(
  input: unknown,
): SemanticEvolutionCandidate {
  const value = recordValue(input, "evolution candidate");
  assertExactKeys(value, candidateKeys, "evolution candidate");
  if (value.version !== 1) {
    throw new Error("evolution candidate.version must be 1");
  }
  const id = trimmedString(value.id, "evolution candidate.id");
  if (!/^[0-9]{14}-[a-f0-9]{8}$/.test(id)) {
    throw new Error("evolution candidate.id is invalid");
  }
  const status = statusValue(value.status);
  const previousIr = parsePredicateExpression(
    value.previousIr,
    "evolution candidate.previousIr",
  );
  const candidateIr = value.candidateIr === null
    ? null
    : parsePredicateExpression(
        value.candidateIr,
        "evolution candidate.candidateIr",
      );
  const generatedCodeHash = nullableHash(
    value.generatedCodeHash,
    "evolution candidate.generatedCodeHash",
  );
  const validation = validationValue(value.validation);
  const diff = diffValue(value.diff);
  const createdAt = timestampValue(
    value.createdAt,
    "evolution candidate.createdAt",
  );
  const approvedAt = value.approvedAt === null
    ? null
    : timestampValue(value.approvedAt, "evolution candidate.approvedAt");

  assertCandidateState({
    status,
    candidateIr,
    generatedCodeHash,
    validation,
    diff,
    previousIr,
    approvedAt,
  });

  return {
    version: 1,
    id,
    status,
    source: relativePathValue(value.source, "evolution candidate.source"),
    output: relativePathValue(value.output, "evolution candidate.output"),
    predicate: trimmedString(value.predicate, "evolution candidate.predicate"),
    concept: trimmedString(value.concept, "evolution candidate.concept"),
    conceptId: trimmedString(value.conceptId, "evolution candidate.conceptId"),
    conceptSource: relativePathValue(
      value.conceptSource,
      "evolution candidate.conceptSource",
    ),
    provider: trimmedString(value.provider, "evolution candidate.provider"),
    model: trimmedString(value.model, "evolution candidate.model"),
    baselineFingerprint: hashValue(
      value.baselineFingerprint,
      "evolution candidate.baselineFingerprint",
    ),
    proposedFingerprint: hashValue(
      value.proposedFingerprint,
      "evolution candidate.proposedFingerprint",
    ),
    hashes: hashesValue(value.hashes),
    targetTypeName: trimmedString(
      value.targetTypeName,
      "evolution candidate.targetTypeName",
    ),
    contextSummary: contextSummaryValue(value.contextSummary),
    previousIr,
    candidateIr,
    generatedCodeHash,
    response: responseValue(value.response),
    consensus: consensusValue(value.consensus),
    validation,
    diff,
    createdAt,
    approvedAt,
  };
}

function assertCandidateState(input: {
  status: SemanticEvolutionCandidate["status"];
  candidateIr: PredicateExpression | null;
  generatedCodeHash: string | null;
  validation: SemanticEvolutionCandidate["validation"];
  diff: SemanticDiff;
  previousIr: PredicateExpression;
  approvedAt: string | null;
}): void {
  if (stableJson(input.diff.previousIr) !== stableJson(input.previousIr)) {
    throw new Error("evolution candidate.diff.previousIr must match previousIr");
  }
  if (stableJson(input.diff.candidateIr) !== stableJson(input.candidateIr)) {
    throw new Error("evolution candidate.diff.candidateIr must match candidateIr");
  }
  if (input.status === "approved") {
    if (input.approvedAt === null) {
      throw new Error("approved evolution candidate requires approvedAt");
    }
  } else if (input.approvedAt !== null) {
    throw new Error("unapproved evolution candidate must not have approvedAt");
  }
  if (input.status === "unresolved") {
    if (
      input.candidateIr !== null ||
      input.generatedCodeHash !== null ||
      input.validation.passed ||
      input.validation.error !== null ||
      input.diff.classification !== "unresolved"
    ) {
      throw new Error("unresolved evolution candidate state is inconsistent");
    }
    return;
  }
  if (input.candidateIr === null || input.diff.classification === "unresolved") {
    throw new Error("resolved evolution candidate requires candidate IR");
  }
  if (input.status === "ready" || input.status === "approved") {
    if (
      !input.validation.passed ||
      input.validation.error !== null ||
      input.generatedCodeHash === null
    ) {
      throw new Error(`${input.status} evolution candidate state is inconsistent`);
    }
    return;
  }
  if (input.validation.passed || input.validation.error === null) {
    throw new Error("invalid evolution candidate requires a validation error");
  }
}

function statusValue(input: unknown): SemanticEvolutionCandidate["status"] {
  if (
    input !== "ready" &&
    input !== "invalid" &&
    input !== "unresolved" &&
    input !== "approved"
  ) {
    throw new Error("evolution candidate.status is invalid");
  }
  return input;
}

function hashesValue(input: unknown): EvolutionHashes {
  const value = recordValue(input, "evolution candidate.hashes");
  assertExactKeys(
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
    "evolution candidate.hashes",
  );
  if (value.contextVersion !== 1) {
    throw new Error("evolution candidate.hashes.contextVersion must be 1");
  }
  return {
    conceptHash: hashValue(
      value.conceptHash,
      "evolution candidate.hashes.conceptHash",
    ),
    sourceHash: hashValue(
      value.sourceHash,
      "evolution candidate.hashes.sourceHash",
    ),
    typeHash: hashValue(value.typeHash, "evolution candidate.hashes.typeHash"),
    testHash: hashValue(value.testHash, "evolution candidate.hashes.testHash"),
    promptHash: hashValue(
      value.promptHash,
      "evolution candidate.hashes.promptHash",
    ),
    contextVersion: 1,
    contextHash: hashValue(
      value.contextHash,
      "evolution candidate.hashes.contextHash",
    ),
  };
}

function contextSummaryValue(input: unknown): ProjectContextSummary {
  const value = recordValue(input, "evolution candidate.contextSummary");
  assertExactKeys(
    value,
    [
      "version",
      "targetSource",
      "relatedTypeSources",
      "verifiedBindingSources",
    ],
    "evolution candidate.contextSummary",
  );
  if (value.version !== 1) {
    throw new Error("evolution candidate.contextSummary.version must be 1");
  }
  return {
    version: 1,
    targetSource: relativePathValue(
      value.targetSource,
      "evolution candidate.contextSummary.targetSource",
    ),
    relatedTypeSources: relativePathArray(
      value.relatedTypeSources,
      "evolution candidate.contextSummary.relatedTypeSources",
    ),
    verifiedBindingSources: relativePathArray(
      value.verifiedBindingSources,
      "evolution candidate.contextSummary.verifiedBindingSources",
    ),
  };
}

function responseValue(
  input: unknown,
): SemanticEvolutionCandidate["response"] {
  if (input === null) return null;
  const path = "evolution candidate.response";
  const value = recordValue(input, path);
  assertExactKeys(value, ["id", "model", "usage"], path);
  return {
    id: trimmedString(value.id, `${path}.id`),
    model: trimmedString(value.model, `${path}.model`),
    usage: usageValue(value.usage, `${path}.usage`),
  };
}

function usageValue(input: unknown, path: string): OpenAIResult["usage"] {
  if (input === null) return null;
  const value = recordValue(input, path);
  assertExactKeys(value, ["inputTokens", "outputTokens", "totalTokens"], path);
  return {
    inputTokens: nonNegativeInteger(value.inputTokens, `${path}.inputTokens`),
    outputTokens: nonNegativeInteger(value.outputTokens, `${path}.outputTokens`),
    totalTokens: nonNegativeInteger(value.totalTokens, `${path}.totalTokens`),
  };
}

function consensusValue(
  input: unknown,
): SemanticEvolutionCandidate["consensus"] {
  if (input === null) return null;
  const path = "evolution candidate.consensus";
  const value = recordValue(input, path);
  assertExactKeys(
    value,
    [
      "samples",
      "quorum",
      "reached",
      "selectedOutcome",
      "selectedSignature",
      "supportingSamples",
      "votes",
    ],
    path,
  );
  const samples = positiveInteger(value.samples, `${path}.samples`);
  const quorum = positiveInteger(value.quorum, `${path}.quorum`);
  assertConsensusParameters(samples, quorum);
  if (samples === 1) {
    throw new Error(`${path}.samples must be greater than 1`);
  }
  if (typeof value.reached !== "boolean") {
    throw new Error(`${path}.reached must be a boolean`);
  }
  const selectedOutcome = selectedOutcomeValue(
    value.selectedOutcome,
    `${path}.selectedOutcome`,
  );
  const selectedSignature = nullableString(
    value.selectedSignature,
    `${path}.selectedSignature`,
  );
  const supportingSamples = sampleNumbers(
    value.supportingSamples,
    samples,
    `${path}.supportingSamples`,
  );
  if (!Array.isArray(value.votes) || value.votes.length !== samples) {
    throw new Error(`${path}.votes must contain exactly ${samples} items`);
  }
  const votes = value.votes.map((vote, index) =>
    consensusVoteValue(vote, `${path}.votes[${index}]`),
  );
  const voteSamples = votes.map((vote) => vote.sample);
  if (new Set(voteSamples).size !== samples || voteSamples.some((sample) => sample > samples)) {
    throw new Error(`${path}.votes must contain each sample exactly once`);
  }
  if (value.reached) {
    if (
      selectedOutcome === null ||
      selectedSignature === null ||
      supportingSamples.length < quorum
    ) {
      throw new Error(`${path} reached state is inconsistent`);
    }
  } else if (
    selectedOutcome !== null ||
    selectedSignature !== null ||
    supportingSamples.length !== 0
  ) {
    throw new Error(`${path} unreached state is inconsistent`);
  }
  return {
    samples,
    quorum,
    reached: value.reached,
    selectedOutcome,
    selectedSignature,
    supportingSamples,
    votes,
  };
}

function consensusVoteValue(
  input: unknown,
  path: string,
): SemanticConsensusResult["votes"][number] {
  const value = recordValue(input, path);
  assertExactKeys(
    value,
    [
      "sample",
      "outcome",
      "eligible",
      "signature",
      "rewrites",
      "diagnostics",
      "error",
    ],
    path,
  );
  const sample = positiveInteger(value.sample, `${path}.sample`);
  if (
    value.outcome !== "resolved" &&
    value.outcome !== "unresolved" &&
    value.outcome !== "error"
  ) {
    throw new Error(`${path}.outcome is invalid`);
  }
  if (typeof value.eligible !== "boolean") {
    throw new Error(`${path}.eligible must be a boolean`);
  }
  const signature = nullableString(value.signature, `${path}.signature`);
  const error = nullableBoundedString(value.error, `${path}.error`);
  if (
    (value.outcome === "error" && (value.eligible || signature !== null || error === null)) ||
    (value.outcome !== "error" && (!value.eligible || signature === null || error !== null))
  ) {
    throw new Error(`${path} state is inconsistent`);
  }
  return {
    sample,
    outcome: value.outcome,
    eligible: value.eligible,
    signature,
    rewrites: validateDiagnostics(value.rewrites, `${path}.rewrites`),
    diagnostics: validateDiagnostics(value.diagnostics, `${path}.diagnostics`),
    error,
  };
}

function selectedOutcomeValue(
  input: unknown,
  path: string,
): "resolved" | "unresolved" | null {
  if (input === null || input === "resolved" || input === "unresolved") {
    return input;
  }
  throw new Error(`${path} is invalid`);
}

function sampleNumbers(input: unknown, samples: number, path: string): number[] {
  if (!Array.isArray(input)) throw new Error(`${path} must be an array`);
  const result = input.map((value, index) =>
    positiveInteger(value, `${path}[${index}]`),
  );
  if (
    result.some((sample) => sample > samples) ||
    new Set(result).size !== result.length
  ) {
    throw new Error(`${path} contains invalid samples`);
  }
  return result;
}

function validationValue(
  input: unknown,
): SemanticEvolutionCandidate["validation"] {
  const path = "evolution candidate.validation";
  const value = recordValue(input, path);
  assertExactKeys(value, ["passed", "error"], path);
  if (typeof value.passed !== "boolean") {
    throw new Error(`${path}.passed must be a boolean`);
  }
  return {
    passed: value.passed,
    error: nullableBoundedString(value.error, `${path}.error`),
  };
}

function diffValue(input: unknown): SemanticDiff {
  const path = "evolution candidate.diff";
  const value = recordValue(input, path);
  assertExactKeys(
    value,
    [
      "classification",
      "summary",
      "previousIr",
      "candidateIr",
      "logicalShapeChanged",
      "leafChanges",
      "diagnostics",
    ],
    path,
  );
  if (
    value.classification !== "compatible" &&
    value.classification !== "breaking" &&
    value.classification !== "unresolved"
  ) {
    throw new Error(`${path}.classification is invalid`);
  }
  if (typeof value.logicalShapeChanged !== "boolean") {
    throw new Error(`${path}.logicalShapeChanged must be a boolean`);
  }
  if (
    !Array.isArray(value.leafChanges) ||
    value.leafChanges.length > SEMANTIC_LIMITS.predicateConditions * 2
  ) {
    throw new Error(`${path}.leafChanges is invalid`);
  }
  return {
    classification: value.classification,
    summary: boundedString(value.summary, `${path}.summary`),
    previousIr: parsePredicateExpression(value.previousIr, `${path}.previousIr`),
    candidateIr: value.candidateIr === null
      ? null
      : parsePredicateExpression(value.candidateIr, `${path}.candidateIr`),
    logicalShapeChanged: value.logicalShapeChanged,
    leafChanges: value.leafChanges.map((change, index) =>
      leafChangeValue(change, `${path}.leafChanges[${index}]`),
    ),
    diagnostics: validateDiagnostics(value.diagnostics, `${path}.diagnostics`),
  };
}

function leafChangeValue(input: unknown, path: string): SemanticLeafChange {
  const value = recordValue(input, path);
  assertExactKeys(value, ["before", "after", "changes"], path);
  const before = leafValue(value.before, `${path}.before`);
  const after = leafValue(value.after, `${path}.after`);
  if (before === null && after === null) {
    throw new Error(`${path} must have a before or after value`);
  }
  if (!Array.isArray(value.changes)) {
    throw new Error(`${path}.changes must be an array`);
  }
  const allowed = ["operator", "property", "value", "added", "removed"] as const;
  const changes = value.changes.map((change, index) => {
    if (!allowed.includes(change as (typeof allowed)[number])) {
      throw new Error(`${path}.changes[${index}] is invalid`);
    }
    return change as (typeof allowed)[number];
  });
  if (new Set(changes).size !== changes.length) {
    throw new Error(`${path}.changes must not contain duplicates`);
  }
  return { before, after, changes };
}

function leafValue(
  input: unknown,
  path: string,
): SemanticLeafChange["before"] {
  if (input === null) return null;
  const value = recordValue(input, path);
  if (value.kind === "equals") {
    assertExactKeys(value, ["kind", "property", "value"], path);
    const expression = parsePredicateExpression(value, path);
    if (expression.kind !== "equals") throw new Error(`${path} is invalid`);
    return {
      kind: "equals",
      property: expression.property,
      value: expression.value as Literal,
    };
  }
  assertExactKeys(value, ["kind", "property"], path);
  const expression = parsePredicateExpression(value, path);
  if (expression.kind !== "present") {
    throw new Error(`${path}.kind must be equals or present`);
  }
  return { kind: "present", property: expression.property };
}

function relativePathArray(input: unknown, path: string): string[] {
  if (!Array.isArray(input)) throw new Error(`${path} must be an array`);
  if (input.length > PROJECT_CONTEXT_PATH_LIMIT) {
    throw new Error(`${path} contains too many items`);
  }
  return input.map((value, index) =>
    relativePathValue(value, `${path}[${index}]`),
  );
}

const PROJECT_CONTEXT_PATH_LIMIT = 32;

function relativePathValue(input: unknown, path: string): string {
  const value = trimmedString(input, path);
  const segments = value.split("/");
  if (
    isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`${path} must be a normalized workspace-relative path`);
  }
  return value;
}

function hashValue(input: unknown, path: string): string {
  const value = trimmedString(input, path);
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${path} must be a lowercase SHA-256 hash`);
  }
  return value;
}

function nullableHash(input: unknown, path: string): string | null {
  return input === null ? null : hashValue(input, path);
}

function timestampValue(input: unknown, path: string): string {
  const value = trimmedString(input, path);
  try {
    if (new Date(value).toISOString() !== value) throw new Error();
  } catch {
    throw new Error(`${path} must be a canonical ISO-8601 UTC timestamp`);
  }
  return value;
}

function trimmedString(input: unknown, path: string): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.trim() !== input
  ) {
    throw new Error(`${path} must be a non-empty trimmed string`);
  }
  return input;
}

function boundedString(input: unknown, path: string): string {
  const value = trimmedString(input, path);
  if (value.length > SEMANTIC_LIMITS.diagnosticCharacters) {
    throw new Error(`${path} is too long`);
  }
  return value;
}

function nullableString(input: unknown, path: string): string | null {
  return input === null ? null : trimmedString(input, path);
}

function nullableBoundedString(input: unknown, path: string): string | null {
  return input === null ? null : boundedString(input, path);
}

function positiveInteger(input: unknown, path: string): number {
  if (!Number.isSafeInteger(input) || Number(input) < 1) {
    throw new Error(`${path} must be a positive safe integer`);
  }
  return Number(input);
}

function nonNegativeInteger(input: unknown, path: string): number {
  if (!Number.isSafeInteger(input) || Number(input) < 0) {
    throw new Error(`${path} must be a non-negative safe integer`);
  }
  return Number(input);
}

function recordValue(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${path} must be an object`);
  }
  return input as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  assertKnownKeys(value, keys, path);
  const missing = keys.find((key) => !(key in value));
  if (missing !== undefined) throw new Error(`${path} is missing ${missing}`);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
