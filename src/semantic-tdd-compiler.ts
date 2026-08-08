import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
  compileSemanticSource,
  type SemanticCommandRunner,
  type SemanticCompileResult,
  type SemanticResolution,
} from "./semantic-compiler";
import { compileSemanticContract } from "./semantic-contract";
import {
  predicateSemanticHashes,
  workspaceRelativePath,
} from "./semantic-fingerprint";
import { buildProjectContext } from "./project-context";
import {
  findReplayEntry,
  readSemanticLock,
  type SemanticLockEntry,
} from "./semantic-lock";
import {
  assertPreImplementationRed,
  createRedCertificate,
  type CompiledRedCertificate,
} from "./semantic-red-certificate";
import {
  evaluatePredicateExpression,
  evaluateSemanticTestPlan,
  renderSemanticTestPlanModule,
  type SemanticTestPlanResult,
} from "./semantic-test-generator";
import {
  validateSemanticTestPlan,
  type ValidatedSemanticTestPlan,
} from "./semantic-test-ir";
import {
  createSemanticTestLockEntry,
  findSemanticTestEntry,
  readSemanticTestLock,
  writeSemanticTestLock,
  type SemanticTestLock,
  type SemanticTestLockEntry,
} from "./semantic-test-lock";
import type { SemanticTestSynthesisResolution } from "./semantic-test-synthesizer";
import {
  createSingleCandidateSelectionReport,
  type SemanticTddSelectionReport,
} from "./semantic-tdd-selection-report";
import { scanSemanticSource, type SemanticSource } from "./semantic-source";

export type SemanticTddCompileOptions = {
  sourcePath: string;
  workspaceRoot?: string;
  mode: "build" | "replay";
  provider?: string;
  model?: string;
  testProvider?: string;
  testModel?: string;
  countsAsApiCall?: boolean;
  testCountsAsApiCall?: boolean;
  lockPath?: string;
  testLockPath?: string;
  auditRoot?: string;
  promotion?: "auto" | "review";
  reviewRoot?: string;
  commandRunner?: SemanticCommandRunner;
  resolveTestPlan?: (input: {
    contract: ReturnType<typeof compileSemanticContract>["contract"];
    contractHash: string;
    typeScriptSource: string;
  }) => Promise<SemanticTestSynthesisResolution>;
  resolveImplementation?: Parameters<
    typeof compileSemanticSource
  >[0]["resolve"];
  writeTestLock?: typeof writeSemanticTestLock;
};

export type SemanticTddCompileResult = {
  status: SemanticCompileResult["status"];
  implementation: SemanticCompileResult;
  testPlanHash: string;
  testPlanCacheHit: boolean;
  testApiCalls: number;
  preImplementationRedHash: string;
  postImplementationRedHash: string;
  mutationScore: number;
  semanticTest: SemanticTestPlanResult;
  selectionReport: SemanticTddSelectionReport;
  testLock: string;
};

export async function compileSemanticTddSource(
  options: SemanticTddCompileOptions,
): Promise<SemanticTddCompileResult> {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const lockPath = resolve(
    options.lockPath ?? resolve(workspaceRoot, "semantic.lock"),
  );
  const testLockPath = resolve(
    options.testLockPath ?? resolve(workspaceRoot, "semantic-test.lock"),
  );
  await mkdir(dirname(testLockPath), { recursive: true });
  return withWorkspaceLock(`${testLockPath}.workspace-lock`, async () => {
    const source = await scanSemanticSource(options.sourcePath);
    const sourceRelative = workspaceRelativePath(
      workspaceRoot,
      source.absolutePath,
      "semantic source",
    );
    const compiledContract = compileSemanticContract(source);
    const testLock = await readSemanticTestLock(testLockPath);
    let testEntry = findSemanticTestEntry(testLock, {
      source: sourceRelative,
      conceptId: source.concept.id,
      contractHash: compiledContract.contractHash,
    });
    const testPlanCacheHit = testEntry !== undefined;
    let testApiCalls = 0;

    if (testEntry === undefined) {
      if (options.mode === "replay") {
        throw new Error(
          "Semantic TDD replay failed: no frozen Test Plan matches the current contract",
        );
      }
      if (options.resolveTestPlan === undefined) {
        throw new Error(
          "Semantic TDD build requires a Test Plan resolver on a test lock miss",
        );
      }
      testApiCalls = options.testCountsAsApiCall === false ? 0 : 1;
      const resolution = await options.resolveTestPlan({
        contract: compiledContract.contract,
        contractHash: compiledContract.contractHash,
        typeScriptSource: source.concept.typeDeclaration,
      });
      if (resolution.synthesis.outcome === "unresolved") {
        throw new Error(
          `Semantic Test synthesis was unresolved: ${resolution.synthesis.diagnostics.join("; ")}`,
        );
      }
      const newlyValidated = validateSemanticTestPlan(
        resolution.synthesis.plan,
        compiledContract.contract,
        compiledContract.contractHash,
      );
      const pre = createRedCertificate({
        plan: newlyValidated.plan,
        testPlanHash: newlyValidated.testPlanHash,
        typeSchema: source.concept.typeSchema,
        hardClauseCoverage: newlyValidated.hardClauseCoverage,
      });
      assertPreImplementationRed(pre.certificate);
      testEntry = createSemanticTestLockEntry({
        source: sourceRelative,
        conceptId: source.concept.id,
        contractHash: compiledContract.contractHash,
        testPlanHash: newlyValidated.testPlanHash,
        plan: newlyValidated.plan,
        preImplementationRed: pre.certificate,
        provider:
          options.testProvider ?? options.provider ?? "fixture:semantic-test",
        model: options.testModel ?? options.model ?? "fixture-model",
        response: resolution.response,
        freezeMode: "automatic",
      });
      testLock.entries[testEntry.fingerprint] = testEntry;
      await (options.writeTestLock ?? writeSemanticTestLock)(
        testLockPath,
        testLock,
      );
    }

    const validated = validateSemanticTestPlan(
      testEntry.plan,
      compiledContract.contract,
      compiledContract.contractHash,
    );
    assertPreImplementationRed(testEntry.preImplementationRed);
    const currentImplementation = await findCurrentImplementation({
      source,
      sourceRelative,
      lockPath,
      workspaceRoot,
    });
    let validation:
      | {
          result: SemanticTestPlanResult;
          red: CompiledRedCertificate;
        }
      | undefined;
    if (currentImplementation !== undefined) {
      validation = validateImplementation(
        source,
        validated,
        currentImplementation.resolvedIr,
      );
    }

    const implementation = await compileSemanticSource({
      sourcePath: source.absolutePath,
      workspaceRoot,
      mode: options.mode,
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.countsAsApiCall === undefined
        ? {}
        : { countsAsApiCall: options.countsAsApiCall }),
      lockPath,
      ...(options.auditRoot === undefined
        ? {}
        : { auditRoot: options.auditRoot }),
      ...(options.promotion === undefined
        ? {}
        : { promotion: options.promotion }),
      ...(options.reviewRoot === undefined
        ? {}
        : { reviewRoot: options.reviewRoot }),
      ...(options.commandRunner === undefined
        ? {}
        : { commandRunner: options.commandRunner }),
      validateCandidate: async (input) => {
        const tddTestPath = resolve(
          dirname(input.candidatePath),
          `.${basename(input.candidatePath, ".ts")}.semantic-tdd.test.ts`,
        );
        const testModule = renderSemanticTestPlanModule({
          candidateModuleName: basename(input.candidatePath, ".ts"),
          predicateName: input.source.predicate.name,
          plan: validated.plan,
        });
        await writeFile(tddTestPath, testModule, "utf8");
        try {
          await input.executeCommand(
            [
              "bunx",
              "tsc",
              "--noEmit",
              "--target",
              "ES2022",
              "--module",
              "ESNext",
              "--moduleResolution",
              "Bundler",
              "--strict",
              "--noUncheckedIndexedAccess",
              "--exactOptionalPropertyTypes",
              "--types",
              "bun",
              input.candidatePath,
              tddTestPath,
            ],
            input.workspaceRoot,
            "semantic-tdd-typecheck",
          );
          await input.executeCommand(
            ["bun", "test", tddTestPath],
            input.workspaceRoot,
            "semantic-tdd-test",
          );
        } finally {
          await rm(tddTestPath, { force: true });
        }
      },
      ...(options.resolveImplementation === undefined
        ? {}
        : {
            resolve: async (input): Promise<SemanticResolution> => {
              const resolveImplementation = options.resolveImplementation;
              if (resolveImplementation === undefined) {
                throw new Error("semantic TDD resolver is unavailable");
              }
              const resolution = await resolveImplementation(input);
              if (resolution.elaboration.outcome === "resolved") {
                validation = validateImplementation(
                  source,
                  validated,
                  resolution.elaboration.body,
                );
              }
              return resolution;
            },
          }),
    });

    const latestImplementation = await findCurrentImplementation({
      source,
      sourceRelative,
      lockPath,
      workspaceRoot,
    });
    if (latestImplementation === undefined) {
      throw new Error(
        "Semantic TDD could not validate the promoted Implementation IR",
      );
    }
    if (validation === undefined) {
      validation = validateImplementation(
        source,
        validated,
        latestImplementation.resolvedIr,
      );
    }

    const selectionReport = createSingleCandidateSelectionReport({
      contractHash: compiledContract.contractHash,
      testPlanHash: validated.testPlanHash,
      redCertificateHash: validation.red.redCertificateHash,
      candidateId: latestImplementation.fingerprint,
      expression: latestImplementation.resolvedIr,
      hardPassed: validation.result.hardPassed,
      mutationScore: validation.red.certificate.mutationScore,
      mutationPassed: !validation.red.certificate.mutants.some(
        (mutant) => mutant.classification === "survived",
      ),
    });
    const updatedEntry: SemanticTestLockEntry = {
      ...testEntry,
      postImplementationRed: validation.red.certificate,
      selectionReport,
    };
    const updatedLock: SemanticTestLock = {
      ...testLock,
      entries: {
        ...testLock.entries,
        [updatedEntry.fingerprint]: updatedEntry,
      },
    };
    await (options.writeTestLock ?? writeSemanticTestLock)(
      testLockPath,
      updatedLock,
    );
    return {
      status: implementation.status,
      implementation,
      testPlanHash: validated.testPlanHash,
      testPlanCacheHit,
      testApiCalls,
      preImplementationRedHash:
        testEntry.preImplementationRed.implementationSignature === null
          ? createRedCertificate({
              plan: validated.plan,
              testPlanHash: validated.testPlanHash,
              typeSchema: source.concept.typeSchema,
              hardClauseCoverage: validated.hardClauseCoverage,
            }).redCertificateHash
          : "",
      postImplementationRedHash: validation.red.redCertificateHash,
      mutationScore: validation.red.certificate.mutationScore,
      semanticTest: validation.result,
      selectionReport,
      testLock: workspaceRelativePath(
        workspaceRoot,
        testLockPath,
        "Semantic Test lock",
      ),
    };
  });
}

function validateImplementation(
  source: SemanticSource,
  validated: ValidatedSemanticTestPlan,
  expression: SemanticLockEntry["resolvedIr"],
): {
  result: SemanticTestPlanResult;
  red: CompiledRedCertificate;
} {
  const result = evaluateSemanticTestPlan(validated.plan, (value) =>
    evaluatePredicateExpression(expression, value),
  );
  if (!result.hardPassed) {
    const failed = result.results
      .filter((item) => item.strength === "hard" && !item.passed)
      .map((item) => item.obligationId);
    throw new Error(
      `Implementation IR failed frozen hard Test Obligations: ${failed.join(", ")}`,
    );
  }
  const red = createRedCertificate({
    plan: validated.plan,
    testPlanHash: validated.testPlanHash,
    typeSchema: source.concept.typeSchema,
    hardClauseCoverage: validated.hardClauseCoverage,
    implementation: expression,
  });
  const survived = red.certificate.mutants.filter(
    (mutant) => mutant.classification === "survived",
  );
  if (survived.length > 0) {
    throw new Error(
      `frozen Test Plan did not kill Predicate mutants: ${survived.map((mutant) => mutant.id).join(", ")}`,
    );
  }
  return { result, red };
}

async function findCurrentImplementation(input: {
  source: SemanticSource;
  sourceRelative: string;
  lockPath: string;
  workspaceRoot: string;
}): Promise<SemanticLockEntry | undefined> {
  const lock = await readSemanticLock(input.lockPath);
  const builtContext = await buildProjectContext({
    source: input.source,
    workspaceRoot: input.workspaceRoot,
    lock,
  });
  const hashes = predicateSemanticHashes(input.source, builtContext);
  return findReplayEntry(lock, {
    source: input.sourceRelative,
    predicate: input.source.predicate.name,
    conceptId: input.source.concept.id,
    ...hashes,
  });
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
        `Semantic TDD workspace is busy or requires recovery: ${lockDirectory}`,
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
