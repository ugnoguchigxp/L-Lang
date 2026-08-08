import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { resolveContainedFile } from "./contained-path";
import type { OpenAIResult } from "./openai";
import { compileSemanticContract } from "./semantic-contract";
import {
  sha256,
  stableJson,
  workspaceRelativePath,
} from "./semantic-fingerprint";
import { readBoundedJsonFile } from "./semantic-limits";
import {
  assertPreImplementationRed,
  createRedCertificate,
  parseRedCertificate,
  type RedCertificate,
} from "./semantic-red-certificate";
import { scanSemanticSource } from "./semantic-source";
import {
  parseSemanticTestPlan,
  SEMANTIC_TEST_COMPILER_VERSION,
  type SemanticTestPlan,
  validateSemanticTestPlan,
} from "./semantic-test-ir";
import {
  createSemanticTestLockEntry,
  readSemanticTestLock,
  type SemanticTestLockEntry,
  writeSemanticTestLock,
} from "./semantic-test-lock";
import type { SemanticTestSynthesisResolution } from "./semantic-test-synthesizer";

export type SemanticTestReviewCandidate = {
  version: 1;
  id: string;
  status: "ready";
  source: string;
  conceptId: string;
  contractHash: string;
  testPlanHash: string;
  testCompilerVersion: string;
  plan: SemanticTestPlan;
  preImplementationRed: RedCertificate;
  provider: string;
  model: string;
  response: SemanticTestLockEntry["response"];
  createdAt: string;
};

export type SemanticTestReviewApproval = {
  version: 1;
  candidateId: string;
  reviewer: string;
  fingerprint: string;
  approvedAt: string;
};

export async function createSemanticTestReviewCandidate(input: {
  sourcePath: string;
  resolve: (request: {
    contract: ReturnType<typeof compileSemanticContract>["contract"];
    contractHash: string;
    typeScriptSource: string;
  }) => Promise<SemanticTestSynthesisResolution>;
  workspaceRoot?: string;
  reviewRoot?: string;
  provider: string;
  model: string;
}): Promise<{
  candidate: SemanticTestReviewCandidate;
  candidateDirectory: string;
  apiCalls: number;
}> {
  const workspaceRoot = resolve(input.workspaceRoot ?? process.cwd());
  const sourcePath = await resolveContainedFile(
    workspaceRoot,
    input.sourcePath,
    "semantic source",
    { rejectSymbolicLinks: true },
  );
  const source = await scanSemanticSource(sourcePath);
  const sourceRelative = workspaceRelativePath(
    workspaceRoot,
    source.absolutePath,
    "semantic source",
  );
  const compiled = compileSemanticContract(source);
  const resolution = await input.resolve({
    contract: compiled.contract,
    contractHash: compiled.contractHash,
    typeScriptSource: source.concept.typeDeclaration,
  });
  if (resolution.synthesis.outcome === "unresolved") {
    throw new Error(
      `Semantic Test synthesis was unresolved: ${resolution.synthesis.diagnostics.join("; ")}`,
    );
  }
  const validated = validateSemanticTestPlan(
    resolution.synthesis.plan,
    compiled.contract,
    compiled.contractHash,
  );
  const red = createRedCertificate({
    plan: validated.plan,
    testPlanHash: validated.testPlanHash,
    typeSchema: source.concept.typeSchema,
    hardClauseCoverage: validated.hardClauseCoverage,
  });
  assertPreImplementationRed(red.certificate);

  const id = `test-review-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID()}`;
  const candidate: SemanticTestReviewCandidate = {
    version: 1,
    id,
    status: "ready",
    source: sourceRelative,
    conceptId: source.concept.id,
    contractHash: compiled.contractHash,
    testPlanHash: validated.testPlanHash,
    testCompilerVersion: SEMANTIC_TEST_COMPILER_VERSION,
    plan: validated.plan,
    preImplementationRed: red.certificate,
    provider: input.provider,
    model: input.model,
    response:
      resolution.response === null
        ? null
        : {
            id: resolution.response.responseId,
            model: resolution.response.model,
            usage: resolution.response.usage,
          },
    createdAt: new Date().toISOString(),
  };
  const reviewRoot = resolve(
    input.reviewRoot ??
      resolve(workspaceRoot, ".semantic", "test-plan-reviews"),
  );
  const candidateDirectory = resolve(reviewRoot, id);
  await mkdir(reviewRoot, { recursive: true });
  await mkdir(candidateDirectory, { recursive: false });
  await writeFile(
    resolve(candidateDirectory, "candidate.json"),
    `${JSON.stringify(candidate, null, 2)}\n`,
    "utf8",
  );
  return {
    candidate,
    candidateDirectory,
    apiCalls: resolution.response === null ? 0 : 1,
  };
}

export async function readSemanticTestReviewCandidate(
  id: string,
  input: {
    workspaceRoot?: string;
    reviewRoot?: string;
  } = {},
): Promise<{
  candidate: SemanticTestReviewCandidate;
  candidateDirectory: string;
  approval: SemanticTestReviewApproval | null;
}> {
  assertCandidateId(id);
  const workspaceRoot = resolve(input.workspaceRoot ?? process.cwd());
  const reviewRoot = resolve(
    input.reviewRoot ??
      resolve(workspaceRoot, ".semantic", "test-plan-reviews"),
  );
  const candidateDirectory = resolve(reviewRoot, id);
  const candidate = parseCandidate(
    await readBoundedJsonFile(
      resolve(candidateDirectory, "candidate.json"),
      "Semantic Test review candidate",
    ),
  );
  if (candidate.id !== id) {
    throw new Error("Semantic Test review candidate ID does not match its directory");
  }
  const approval = await readApproval(candidateDirectory);
  if (approval !== null && approval.candidateId !== candidate.id) {
    throw new Error(
      "Semantic Test review approval does not match its candidate",
    );
  }
  return { candidate, candidateDirectory, approval };
}

export async function approveSemanticTestReview(
  id: string,
  input: {
    reviewer: string;
    workspaceRoot?: string;
    reviewRoot?: string;
    testLockPath?: string;
  },
): Promise<{
  status: "approved" | "already-approved";
  candidate: SemanticTestReviewCandidate;
  approval: SemanticTestReviewApproval;
  testLockPath: string;
}> {
  const reviewer = input.reviewer.trim();
  if (reviewer.length === 0) {
    throw new Error("Semantic Test review approval requires a reviewer");
  }
  const workspaceRoot = resolve(input.workspaceRoot ?? process.cwd());
  const { candidate, candidateDirectory } =
    await readSemanticTestReviewCandidate(id, input);
  const testLockPath = resolve(
    input.testLockPath ?? resolve(workspaceRoot, "semantic-test.lock"),
  );

  const candidateSourcePath = await resolveContainedFile(
    workspaceRoot,
    candidate.source,
    "Semantic Test review candidate source",
    { rejectSymbolicLinks: true },
  );
  const source = await scanSemanticSource(candidateSourcePath);
  const compiled = compileSemanticContract(source);
  if (
    source.concept.id !== candidate.conceptId ||
    compiled.contractHash !== candidate.contractHash
  ) {
    throw new Error(
      "Semantic Test review candidate is stale for the current contract",
    );
  }
  const validated = validateSemanticTestPlan(
    candidate.plan,
    compiled.contract,
    compiled.contractHash,
  );
  const currentPreRed = createRedCertificate({
    plan: validated.plan,
    testPlanHash: validated.testPlanHash,
    typeSchema: source.concept.typeSchema,
    hardClauseCoverage: validated.hardClauseCoverage,
  });
  assertPreImplementationRed(currentPreRed.certificate);
  if (
    stableJson(currentPreRed.certificate) !==
    stableJson(candidate.preImplementationRed)
  ) {
    throw new Error(
      "Semantic Test review candidate Red Certificate is stale",
    );
  }

  await mkdir(dirname(testLockPath), { recursive: true });
  const approvalResult = await withWorkspaceLock(
    `${testLockPath}.workspace-lock`,
    async () => {
      const currentApproval = await readApproval(candidateDirectory);
      const lock = await readSemanticTestLock(testLockPath);
      const existingEntry = Object.values(lock.entries).find(
        (entry) =>
          entry.source === candidate.source &&
          entry.conceptId === candidate.conceptId &&
          entry.contractHash === candidate.contractHash &&
          entry.testPlanHash === candidate.testPlanHash,
      );
      const approvedAt =
        currentApproval?.approvedAt ??
        (existingEntry?.freezeMode === "staged"
          ? existingEntry.frozenAt
          : new Date().toISOString());
      const entry = createSemanticTestLockEntry({
        source: candidate.source,
        conceptId: candidate.conceptId,
        contractHash: candidate.contractHash,
        testPlanHash: candidate.testPlanHash,
        plan: candidate.plan,
        preImplementationRed: candidate.preImplementationRed,
        provider: candidate.provider,
        model: candidate.model,
        response: candidate.response,
        freezeMode: "staged",
        frozenAt: approvedAt,
      });
      if (currentApproval !== null) {
        assertApprovalMatchesCandidate(currentApproval, candidate, entry);
      }
      if (existingEntry !== undefined) {
        assertFrozenEntryMatchesCandidate(existingEntry, entry);
      }

      const nextApproval = currentApproval ?? {
        version: 1,
        candidateId: candidate.id,
        reviewer,
        fingerprint: entry.fingerprint,
        approvedAt,
      } satisfies SemanticTestReviewApproval;

      const approvalPath = resolve(candidateDirectory, "approval.json");
      let createdApproval = false;
      if (currentApproval === null) {
        await writeFile(
          approvalPath,
          `${JSON.stringify(nextApproval, null, 2)}\n`,
          { encoding: "utf8", flag: "wx" },
        );
        createdApproval = true;
      }
      try {
        if (existingEntry === undefined) {
          lock.entries[entry.fingerprint] = entry;
          await writeSemanticTestLock(testLockPath, lock);
        }
      } catch (error) {
        if (createdApproval) {
          await rm(approvalPath, { force: true });
        }
        throw error;
      }
      return {
        approval: nextApproval,
        alreadyApproved: currentApproval !== null,
      };
    },
  );
  return {
    status: approvalResult.alreadyApproved
      ? "already-approved"
      : "approved",
    candidate,
    approval: approvalResult.approval,
    testLockPath,
  };
}

function assertApprovalMatchesCandidate(
  approval: SemanticTestReviewApproval,
  candidate: SemanticTestReviewCandidate,
  entry: SemanticTestLockEntry,
): void {
  if (
    approval.candidateId !== candidate.id ||
    approval.fingerprint !== entry.fingerprint
  ) {
    throw new Error(
      "Semantic Test review approval does not match its candidate",
    );
  }
}

function assertFrozenEntryMatchesCandidate(
  actual: SemanticTestLockEntry,
  expected: SemanticTestLockEntry,
): void {
  const immutable = (entry: SemanticTestLockEntry) => ({
    fingerprint: entry.fingerprint,
    source: entry.source,
    conceptId: entry.conceptId,
    contractHash: entry.contractHash,
    testPlanHash: entry.testPlanHash,
    testCompilerVersion: entry.testCompilerVersion,
    plan: entry.plan,
    preImplementationRed: entry.preImplementationRed,
    provider: entry.provider,
    model: entry.model,
    response: entry.response,
    freezeMode: entry.freezeMode,
    frozenAt: entry.frozenAt,
  });
  if (stableJson(immutable(actual)) !== stableJson(immutable(expected))) {
    throw new Error(
      "semantic-test.lock contains incompatible Test Plan provenance",
    );
  }
}

function parseCandidate(input: unknown): SemanticTestReviewCandidate {
  const value = recordValue(input, "Semantic Test review candidate");
  exactKeys(
    value,
    [
      "version",
      "id",
      "status",
      "source",
      "conceptId",
      "contractHash",
      "testPlanHash",
      "testCompilerVersion",
      "plan",
      "preImplementationRed",
      "provider",
      "model",
      "response",
      "createdAt",
    ],
    "Semantic Test review candidate",
  );
  if (value.version !== 1 || value.status !== "ready") {
    throw new Error("Semantic Test review candidate version/status is invalid");
  }
  const id = stringValue(value.id, "candidate.id");
  assertCandidateId(id);
  const plan = parseSemanticTestPlan(value.plan);
  const testPlanHash = hashValue(value.testPlanHash, "candidate.testPlanHash");
  const expectedHash = sha256(
    stableJson({
      compilerVersion: SEMANTIC_TEST_COMPILER_VERSION,
      plan,
    }),
  );
  if (testPlanHash !== expectedHash) {
    throw new Error("candidate.testPlanHash does not match its plan");
  }
  if (value.testCompilerVersion !== SEMANTIC_TEST_COMPILER_VERSION) {
    throw new Error("candidate.testCompilerVersion is unsupported");
  }
  const preImplementationRed = parseRedCertificate(
    value.preImplementationRed,
  );
  if (
    preImplementationRed.testPlanHash !== testPlanHash ||
    preImplementationRed.implementationSignature !== null
  ) {
    throw new Error("candidate.preImplementationRed is invalid");
  }
  return {
    version: 1,
    id,
    status: "ready",
    source: stringValue(value.source, "candidate.source"),
    conceptId: stringValue(value.conceptId, "candidate.conceptId"),
    contractHash: hashValue(value.contractHash, "candidate.contractHash"),
    testPlanHash,
    testCompilerVersion: SEMANTIC_TEST_COMPILER_VERSION,
    plan,
    preImplementationRed,
    provider: stringValue(value.provider, "candidate.provider"),
    model: stringValue(value.model, "candidate.model"),
    response: responseValue(value.response),
    createdAt: dateValue(value.createdAt, "candidate.createdAt"),
  };
}

async function readApproval(
  candidateDirectory: string,
): Promise<SemanticTestReviewApproval | null> {
  try {
    const value = recordValue(
      await readBoundedJsonFile(
        resolve(candidateDirectory, "approval.json"),
        "Semantic Test review approval",
      ),
      "Semantic Test review approval",
    );
    exactKeys(
      value,
      ["version", "candidateId", "reviewer", "fingerprint", "approvedAt"],
      "Semantic Test review approval",
    );
    if (value.version !== 1) {
      throw new Error("Semantic Test review approval.version must be 1");
    }
    return {
      version: 1,
      candidateId: stringValue(value.candidateId, "approval.candidateId"),
      reviewer: stringValue(value.reviewer, "approval.reviewer"),
      fingerprint: hashValue(value.fingerprint, "approval.fingerprint"),
      approvedAt: dateValue(value.approvedAt, "approval.approvedAt"),
    };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function responseValue(
  input: unknown,
): SemanticTestLockEntry["response"] {
  if (input === null) return null;
  const value = recordValue(input, "candidate.response");
  exactKeys(value, ["id", "model", "usage"], "candidate.response");
  return {
    id: stringValue(value.id, "candidate.response.id"),
    model: stringValue(value.model, "candidate.response.model"),
    usage:
      value.usage === null
        ? null
        : usageValue(value.usage, "candidate.response.usage"),
  };
}

function usageValue(
  input: unknown,
  path: string,
): NonNullable<OpenAIResult["usage"]> {
  const usage = recordValue(input, path);
  exactKeys(
    usage,
    ["inputTokens", "outputTokens", "totalTokens"],
    path,
  );
  return {
    inputTokens: nonNegativeInteger(
      usage.inputTokens,
      `${path}.inputTokens`,
    ),
    outputTokens: nonNegativeInteger(
      usage.outputTokens,
      `${path}.outputTokens`,
    ),
    totalTokens: nonNegativeInteger(
      usage.totalTokens,
      `${path}.totalTokens`,
    ),
  };
}

async function withWorkspaceLock<T>(
  lockDirectory: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    await mkdir(lockDirectory);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      throw new Error(
        `Semantic Test review workspace is busy or requires recovery: ${lockDirectory}`,
      );
    }
    throw error;
  }
  try {
    return await action();
  } finally {
    await rm(lockDirectory, { recursive: true, force: true });
  }
}

function assertCandidateId(id: string): void {
  if (!/^test-review-[A-Za-z0-9-]+$/.test(id)) {
    throw new Error("Invalid Semantic Test review candidate ID");
  }
}

function exactKeys(
  value: Record<string, unknown>,
  keys: string[],
  path: string,
): void {
  const expected = new Set(keys);
  const unknown = Object.keys(value).find((key) => !expected.has(key));
  if (unknown !== undefined) throw new Error(`${path} contains unknown field ${unknown}`);
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

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
