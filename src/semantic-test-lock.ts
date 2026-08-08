import { atomicWriteText } from "./atomic-file";
import type { OpenAIResult } from "./openai";
import {
  fingerprintFor,
  sha256,
  stableJson,
} from "./semantic-fingerprint";
import {
  assertTextByteLength,
  readBoundedJsonFile,
  SEMANTIC_LIMITS,
} from "./semantic-limits";
import {
  parseRedCertificate,
  type RedCertificate,
} from "./semantic-red-certificate";
import {
  parseSemanticTddSelectionReport,
  type SemanticTddSelectionReport,
} from "./semantic-tdd-selection-report";
import {
  parseSemanticTestPlan,
  SEMANTIC_TEST_COMPILER_VERSION,
  type SemanticTestPlan,
} from "./semantic-test-ir";

export type SemanticTestLockEntry = {
  fingerprint: string;
  source: string;
  conceptId: string;
  contractHash: string;
  testPlanHash: string;
  testCompilerVersion: string;
  plan: SemanticTestPlan;
  preImplementationRed: RedCertificate;
  postImplementationRed: RedCertificate | null;
  selectionReport: SemanticTddSelectionReport | null;
  provider: string;
  model: string;
  response: {
    id: string;
    model: string;
    usage: OpenAIResult["usage"];
  } | null;
  freezeMode: "automatic" | "staged";
  frozenAt: string;
};

export type SemanticTestLock = {
  version: 1;
  entries: Record<string, SemanticTestLockEntry>;
};

export function semanticTestFingerprint(input: {
  source: string;
  conceptId: string;
  contractHash: string;
  testPlanHash: string;
}): string {
  return fingerprintFor({
    source: input.source,
    conceptId: input.conceptId,
    contractHash: input.contractHash,
    testPlanHash: input.testPlanHash,
    testCompilerVersion: SEMANTIC_TEST_COMPILER_VERSION,
  });
}

export async function readSemanticTestLock(
  path: string,
): Promise<SemanticTestLock> {
  try {
    return parseSemanticTestLock(
      await readBoundedJsonFile(
        path,
        "semantic-test.lock",
        SEMANTIC_LIMITS.lockBytes,
      ),
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { version: 1, entries: {} };
    }
    throw error;
  }
}

export async function writeSemanticTestLock(
  path: string,
  lock: SemanticTestLock,
): Promise<void> {
  const serialized = `${JSON.stringify(lock, null, 2)}\n`;
  assertTextByteLength(
    serialized,
    SEMANTIC_LIMITS.lockBytes,
    "semantic-test.lock",
  );
  parseSemanticTestLock(JSON.parse(serialized) as unknown);
  await atomicWriteText(path, serialized);
}

export function findSemanticTestEntry(
  lock: SemanticTestLock,
  input: {
    source: string;
    conceptId: string;
    contractHash: string;
  },
): SemanticTestLockEntry | undefined {
  return Object.values(lock.entries)
    .filter(
      (entry) =>
        entry.source === input.source &&
        entry.conceptId === input.conceptId &&
        entry.contractHash === input.contractHash &&
        entry.testCompilerVersion === SEMANTIC_TEST_COMPILER_VERSION,
    )
    .sort((left, right) => right.frozenAt.localeCompare(left.frozenAt))[0];
}

export function createSemanticTestLockEntry(input: {
  source: string;
  conceptId: string;
  contractHash: string;
  testPlanHash: string;
  plan: SemanticTestPlan;
  preImplementationRed: RedCertificate;
  provider: string;
  model: string;
  response: OpenAIResult | SemanticTestLockEntry["response"];
  freezeMode: SemanticTestLockEntry["freezeMode"];
  frozenAt?: string;
}): SemanticTestLockEntry {
  const fingerprint = semanticTestFingerprint(input);
  return {
    fingerprint,
    source: input.source,
    conceptId: input.conceptId,
    contractHash: input.contractHash,
    testPlanHash: input.testPlanHash,
    testCompilerVersion: SEMANTIC_TEST_COMPILER_VERSION,
    plan: input.plan,
    preImplementationRed: input.preImplementationRed,
    postImplementationRed: null,
    selectionReport: null,
    provider: input.provider,
    model: input.model,
    response: normalizeResponse(input.response),
    freezeMode: input.freezeMode,
    frozenAt: input.frozenAt ?? new Date().toISOString(),
  };
}

function normalizeResponse(
  response: OpenAIResult | SemanticTestLockEntry["response"],
): SemanticTestLockEntry["response"] {
  if (response === null) return null;
  if ("responseId" in response) {
    return {
      id: response.responseId,
      model: response.model,
      usage: response.usage,
    };
  }
  return response;
}

function parseSemanticTestLock(input: unknown): SemanticTestLock {
  const value = recordValue(input, "semantic-test.lock");
  exactKeys(value, ["version", "entries"], "semantic-test.lock");
  if (value.version !== 1) {
    throw new Error("semantic-test.lock.version must be 1");
  }
  const entries = recordValue(value.entries, "semantic-test.lock.entries");
  return {
    version: 1,
    entries: Object.fromEntries(
      Object.entries(entries).map(([key, entryInput]) => {
        const entry = parseEntry(
          entryInput,
          `semantic-test.lock.entries.${key}`,
        );
        if (entry.fingerprint !== key) {
          throw new Error(
            `semantic-test.lock.entries.${key}.fingerprint must match its map key`,
          );
        }
        return [key, entry];
      }),
    ),
  };
}

function parseEntry(input: unknown, path: string): SemanticTestLockEntry {
  const value = recordValue(input, path);
  exactKeys(
    value,
    [
      "fingerprint",
      "source",
      "conceptId",
      "contractHash",
      "testPlanHash",
      "testCompilerVersion",
      "plan",
      "preImplementationRed",
      "postImplementationRed",
      "selectionReport",
      "provider",
      "model",
      "response",
      "freezeMode",
      "frozenAt",
    ],
    path,
  );
  const plan = parseSemanticTestPlan(value.plan);
  const testPlanHash = hashValue(value.testPlanHash, `${path}.testPlanHash`);
  const expectedTestPlanHash = sha256(
    stableJson({
      compilerVersion: SEMANTIC_TEST_COMPILER_VERSION,
      plan,
    }),
  );
  if (testPlanHash !== expectedTestPlanHash) {
    throw new Error(`${path}.testPlanHash does not match the stored plan`);
  }
  const preImplementationRed = parseRedCertificate(
    value.preImplementationRed,
  );
  if (
    preImplementationRed.testPlanHash !== testPlanHash ||
    preImplementationRed.implementationSignature !== null
  ) {
    throw new Error(`${path}.preImplementationRed is not a pre-implementation certificate`);
  }
  const postImplementationRed =
    value.postImplementationRed === null
      ? null
      : parseRedCertificate(value.postImplementationRed);
  if (
    postImplementationRed !== null &&
    (postImplementationRed.testPlanHash !== testPlanHash ||
      postImplementationRed.implementationSignature === null)
  ) {
    throw new Error(`${path}.postImplementationRed is invalid`);
  }
  const selectionReport =
    value.selectionReport === null
      ? null
      : parseSemanticTddSelectionReport(value.selectionReport);
  const contractHash = hashValue(value.contractHash, `${path}.contractHash`);
  if (plan.contractHash !== contractHash) {
    throw new Error(`${path}.plan.contractHash does not match entry contractHash`);
  }
  if (
    selectionReport !== null &&
    (selectionReport.contractHash !== contractHash ||
      selectionReport.testPlanHash !== testPlanHash ||
      postImplementationRed === null ||
      selectionReport.redCertificateHash !==
        sha256(stableJson(postImplementationRed)))
  ) {
    throw new Error(`${path}.selectionReport is inconsistent with the entry`);
  }
  if (value.testCompilerVersion !== SEMANTIC_TEST_COMPILER_VERSION) {
    throw new Error(`${path}.testCompilerVersion is unsupported`);
  }
  const entry: SemanticTestLockEntry = {
    fingerprint: hashValue(value.fingerprint, `${path}.fingerprint`),
    source: stringValue(value.source, `${path}.source`),
    conceptId: stringValue(value.conceptId, `${path}.conceptId`),
    contractHash,
    testPlanHash,
    testCompilerVersion: SEMANTIC_TEST_COMPILER_VERSION,
    plan,
    preImplementationRed,
    postImplementationRed,
    selectionReport,
    provider: stringValue(value.provider, `${path}.provider`),
    model: stringValue(value.model, `${path}.model`),
    response: responseValue(value.response, `${path}.response`),
    freezeMode: freezeModeValue(value.freezeMode, `${path}.freezeMode`),
    frozenAt: dateValue(value.frozenAt, `${path}.frozenAt`),
  };
  const expectedFingerprint = semanticTestFingerprint(entry);
  if (entry.fingerprint !== expectedFingerprint) {
    throw new Error(`${path}.fingerprint does not match semantic inputs`);
  }
  return entry;
}

function freezeModeValue(
  input: unknown,
  path: string,
): SemanticTestLockEntry["freezeMode"] {
  if (input !== "automatic" && input !== "staged") {
    throw new Error(`${path} must be automatic or staged`);
  }
  return input;
}

function responseValue(
  input: unknown,
  path: string,
): SemanticTestLockEntry["response"] {
  if (input === null) return null;
  const value = recordValue(input, path);
  exactKeys(value, ["id", "model", "usage"], path);
  return {
    id: stringValue(value.id, `${path}.id`),
    model: stringValue(value.model, `${path}.model`),
    usage:
      value.usage === null
        ? null
        : usageValue(value.usage, `${path}.usage`),
  };
}

function usageValue(
  input: unknown,
  path: string,
): NonNullable<OpenAIResult["usage"]> {
  const value = recordValue(input, path);
  exactKeys(
    value,
    ["inputTokens", "outputTokens", "totalTokens"],
    path,
  );
  return {
    inputTokens: nonNegativeInteger(value.inputTokens, `${path}.inputTokens`),
    outputTokens: nonNegativeInteger(value.outputTokens, `${path}.outputTokens`),
    totalTokens: nonNegativeInteger(value.totalTokens, `${path}.totalTokens`),
  };
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) throw new Error(`${path} contains unknown field ${unknown}`);
  const missing = allowed.find((key) => !(key in value));
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
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return input;
}

function hashValue(input: unknown, path: string): string {
  const value = stringValue(input, path);
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${path} must be a SHA-256 hash`);
  }
  return value;
}

function dateValue(input: unknown, path: string): string {
  const value = stringValue(input, path);
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    throw new Error(`${path} must be a canonical ISO timestamp`);
  }
  return value;
}

function nonNegativeInteger(input: unknown, path: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new Error(`${path} must be a non-negative safe integer`);
  }
  return input as number;
}
