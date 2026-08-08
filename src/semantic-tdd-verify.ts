import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { compileSemanticContract } from "./semantic-contract";
import { buildProjectContext } from "./project-context";
import {
  generatedOutputPath,
  predicateSemanticHashes,
  sha256,
  stableJson,
  workspaceRelativePath,
} from "./semantic-fingerprint";
import { findReplayEntry, readSemanticLock } from "./semantic-lock";
import {
  assertPreImplementationRed,
  createRedCertificate,
} from "./semantic-red-certificate";
import {
  evaluatePredicateExpression,
  evaluateSemanticTestPlan,
} from "./semantic-test-generator";
import { validateSemanticTestPlan } from "./semantic-test-ir";
import {
  findSemanticTestEntry,
  readSemanticTestLock,
} from "./semantic-test-lock";
import { createSingleCandidateSelectionReport } from "./semantic-tdd-selection-report";
import { scanSemanticSource } from "./semantic-source";

export type SemanticTddVerifyReport = {
  version: 1;
  status: "passed";
  source: string;
  predicate: string;
  contractHash: string;
  testPlanHash: string;
  implementationFingerprint: string;
  generatedCodeHash: string;
  hardObligations: number;
  mutationScore: number;
  selectionOutcome: "selected";
  apiCalls: 0;
  filesWritten: 0;
};

/**
 * Verifies a frozen Semantic TDD build without invoking providers or writing
 * audit, lock, generated, or temporary files.
 */
export async function verifySemanticTddSource(input: {
  sourcePath: string;
  workspaceRoot?: string;
  lockPath?: string;
  testLockPath?: string;
}): Promise<SemanticTddVerifyReport> {
  const workspaceRoot = resolve(input.workspaceRoot ?? process.cwd());
  const lockPath = resolve(
    input.lockPath ?? resolve(workspaceRoot, "semantic.lock"),
  );
  const testLockPath = resolve(
    input.testLockPath ?? resolve(workspaceRoot, "semantic-test.lock"),
  );
  const source = await scanSemanticSource(input.sourcePath);
  const sourceRelative = workspaceRelativePath(
    workspaceRoot,
    source.absolutePath,
    "semantic source",
  );
  const contract = compileSemanticContract(source);
  const testEntry = findSemanticTestEntry(
    await readSemanticTestLock(testLockPath),
    {
      source: sourceRelative,
      conceptId: source.concept.id,
      contractHash: contract.contractHash,
    },
  );
  if (testEntry === undefined) {
    throw new Error(
      "Semantic TDD verification failed: no frozen Test Plan matches the current contract",
    );
  }
  const validated = validateSemanticTestPlan(
    testEntry.plan,
    contract.contract,
    contract.contractHash,
  );
  assertPreImplementationRed(testEntry.preImplementationRed);

  const lock = await readSemanticLock(lockPath);
  const builtContext = await buildProjectContext({
    source,
    workspaceRoot,
    lock,
  });
  const hashes = predicateSemanticHashes(source, builtContext);
  const implementation = findReplayEntry(lock, {
    source: sourceRelative,
    predicate: source.predicate.name,
    conceptId: source.concept.id,
    ...hashes,
  });
  if (implementation === undefined) {
    throw new Error(
      "Semantic TDD verification failed: no Implementation IR matches the current source and contract",
    );
  }

  const result = evaluateSemanticTestPlan(validated.plan, (value) =>
    evaluatePredicateExpression(implementation.resolvedIr, value),
  );
  if (!result.hardPassed) {
    const failed = result.results
      .filter((item) => item.strength === "hard" && !item.passed)
      .map((item) => item.obligationId);
    throw new Error(
      `Semantic TDD verification failed hard obligations: ${failed.join(", ")}`,
    );
  }
  const currentRed = createRedCertificate({
    plan: validated.plan,
    testPlanHash: validated.testPlanHash,
    typeSchema: source.concept.typeSchema,
    hardClauseCoverage: validated.hardClauseCoverage,
    implementation: implementation.resolvedIr,
  });
  const survivors = currentRed.certificate.mutants.filter(
    (mutant) => mutant.classification === "survived",
  );
  if (survivors.length > 0) {
    throw new Error(
      `Semantic TDD verification found surviving mutants: ${survivors.map((mutant) => mutant.id).join(", ")}`,
    );
  }
  if (testEntry.postImplementationRed === null) {
    throw new Error(
      "Semantic TDD verification failed: post-implementation Red Certificate is missing",
    );
  }
  if (
    stableJson(testEntry.postImplementationRed) !==
    stableJson(currentRed.certificate)
  ) {
    throw new Error(
      "Semantic TDD verification failed: post-implementation Red Certificate is stale",
    );
  }
  const expectedSelection = createSingleCandidateSelectionReport({
    contractHash: contract.contractHash,
    testPlanHash: validated.testPlanHash,
    redCertificateHash: currentRed.redCertificateHash,
    candidateId: implementation.fingerprint,
    expression: implementation.resolvedIr,
    hardPassed: result.hardPassed,
    mutationScore: currentRed.certificate.mutationScore,
    mutationPassed: survivors.length === 0,
  });
  if (
    testEntry.selectionReport === null ||
    stableJson(testEntry.selectionReport) !== stableJson(expectedSelection)
  ) {
    throw new Error(
      "Semantic TDD verification failed: Selection Report is missing or stale",
    );
  }

  const outputPath = generatedOutputPath(
    source.absolutePath,
    source.predicate.name,
  );
  let generatedCode: Uint8Array;
  try {
    generatedCode = await readFile(outputPath);
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(
        "Semantic TDD verification failed: generated output is missing",
      );
    }
    throw error;
  }
  const generatedCodeHash = sha256(generatedCode);
  if (generatedCodeHash !== implementation.generatedCodeHash) {
    throw new Error(
      "Semantic TDD verification failed: generated output hash is stale",
    );
  }

  return {
    version: 1,
    status: "passed",
    source: sourceRelative,
    predicate: source.predicate.name,
    contractHash: contract.contractHash,
    testPlanHash: validated.testPlanHash,
    implementationFingerprint: implementation.fingerprint,
    generatedCodeHash,
    hardObligations: result.hard,
    mutationScore: currentRed.certificate.mutationScore,
    selectionOutcome: "selected",
    apiCalls: 0,
    filesWritten: 0,
  };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
