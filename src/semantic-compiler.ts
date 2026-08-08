import {
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  resolve,
} from "node:path";

import { validatePredicateContext } from "./context-validator";
import { generatePredicate } from "./generator";
import {
  type PredicateDefinition,
  parsePredicateDefinition,
  parsePredicateExpression,
} from "./ir";
import {
  renderInterpretedJudgement,
  renderSemanticTestModule,
} from "./judgement-renderer";
import {
  buildOpenAIRequest,
  type ElaborationResult,
  type OpenAIResult,
} from "./openai";
import {
  buildProjectContext,
  type ProjectContextSummary,
  type ProjectContext,
} from "./project-context";
import {
  fingerprintFor,
  generatedOutputPath,
  predicateRequestShape,
  predicateSemanticHashes,
  sha256,
  workspaceRelativePath,
} from "./semantic-fingerprint";
import {
  findLatestPredicateEntry,
  findReplayEntry,
  readSemanticLockSnapshot,
  type SemanticLockEntry,
  type writeSemanticLock,
} from "./semantic-lock";
import {
  cleanupSemanticFiles,
  createSemanticPipelineRun,
  type SemanticCommandRunner,
  semanticResponseMetadata,
  semanticRunDuration,
  writeSemanticJson,
} from "./semantic-pipeline";
import { promoteSemanticArtifact } from "./semantic-promotion";
import { createPredicateSemanticReview } from "./semantic-review";
import { scanSemanticSource } from "./semantic-source";

export type { SemanticCommandRunner } from "./semantic-pipeline";

export type SemanticResolution = {
  elaboration: ElaborationResult;
  response: OpenAIResult | null;
  rawOutput: unknown;
};

export type SemanticCompileOptions = {
  sourcePath: string;
  workspaceRoot?: string;
  mode: "build" | "replay";
  provider?: string;
  model?: string;
  countsAsApiCall?: boolean;
  lockPath?: string;
  auditRoot?: string;
  promotion?: "auto" | "review";
  reviewRoot?: string;
  commandRunner?: SemanticCommandRunner;
  writeLock?: typeof writeSemanticLock;
  validateCandidate?: (input: {
    source: Awaited<ReturnType<typeof scanSemanticSource>>;
    definition: PredicateDefinition;
    candidatePath: string;
    workspaceRoot: string;
    executeCommand: SemanticCommandRunner;
  }) => Promise<void>;
  projectContextMode?: "project-context" | "type-only";
  resolve?: (input: {
    specification: string;
    typeScriptSource: string;
    functionName: string;
    parameterName: string;
    typeName: string;
    projectContext?: ProjectContext;
  }) => Promise<SemanticResolution>;
};

type SemanticCompileResultBase = {
  source: string;
  output: string;
  report: string;
  fingerprint: string;
  provider: string;
  model: string;
  apiCalls: number;
  cacheHit: boolean;
  replayed: boolean;
  generatedCodeHash: string;
};

export type SemanticCompileResult =
  | (SemanticCompileResultBase & {
      status: "passed";
      promotionMode: "auto" | "replay";
    })
  | (SemanticCompileResultBase & {
      status: "review-required";
      promotionMode: "review";
      candidateId: string;
      candidateDirectory: string;
    });

export async function compileSemanticSource(
  options: SemanticCompileOptions,
): Promise<SemanticCompileResult> {
  const promotion = options.promotion ?? "auto";
  if (options.mode === "replay" && promotion === "review") {
    throw new Error("replay does not support review promotion");
  }
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const source = await scanSemanticSource(options.sourcePath);
  const sourceRelative = workspaceRelativePath(
    workspaceRoot,
    source.absolutePath,
    "semantic source",
  );

  const importModule = `./${basename(source.absolutePath, extname(source.absolutePath))}`;
  const conceptSource = workspaceRelativePath(
    workspaceRoot,
    source.concept.definitionPath,
    "concept definition",
  );
  const lockPath = resolve(options.lockPath ?? resolve(workspaceRoot, "semantic.lock"));
  const { lock, revision: lockRevision } =
    await readSemanticLockSnapshot(lockPath);
  const requestShape = predicateRequestShape(source);
  const builtContext =
    options.projectContextMode === "type-only"
      ? undefined
      : await buildProjectContext({ source, workspaceRoot, lock });
  const hashes = predicateSemanticHashes(source, builtContext);
  const contextSummary: ProjectContextSummary =
    builtContext?.summary ?? {
      version: 1,
      targetSource: sourceRelative,
      relatedTypeSources: [],
      verifiedBindingSources: [],
    };
  let provider = options.provider ?? "lock";
  let model = options.model ?? "lock";
  let fingerprint = fingerprintFor({
    source: sourceRelative,
    predicate: source.predicate.name,
    conceptId: source.concept.id,
    provider,
    model,
    ...hashes,
  });
  let entry =
    options.mode === "replay"
      ? findReplayEntry(lock, {
          source: sourceRelative,
          predicate: source.predicate.name,
          conceptId: source.concept.id,
          ...hashes,
        })
      : lock.entries[fingerprint];

  if (options.mode === "replay" && entry === undefined) {
    throw new Error("replay failed: no lock entry matches the current source, type, tests, and prompt");
  }

  let resolution: SemanticResolution;
  let apiCalls = 0;
  const cacheHit = entry !== undefined;

  if (entry !== undefined) {
    provider = entry.provider;
    model = entry.model;
    fingerprint = entry.fingerprint;
    resolution = {
      elaboration: {
        outcome: "resolved",
        body: parsePredicateExpression(entry.resolvedIr, "semantic.lock.resolvedIr"),
        diagnostics: [],
      },
      response: entry.response
        ? {
            responseId: entry.response.id,
            model: entry.response.model,
            usage: entry.response.usage,
            outputText: JSON.stringify({
              outcome: "resolved",
              body: entry.resolvedIr,
              diagnostics: [],
            }),
          }
        : null,
      rawOutput: { source: "semantic.lock", fingerprint: entry.fingerprint },
    };
  } else {
    if (options.mode === "replay" || options.resolve === undefined) {
      throw new Error("build requires an LLM or fixture resolver on a lock miss");
    }
    apiCalls = options.countsAsApiCall === false ? 0 : 1;
    resolution = await options.resolve({
      specification: requestShape.specification,
      typeScriptSource: requestShape.typeScriptSource,
      ...requestShape.target,
      ...(builtContext === undefined
        ? {}
        : { projectContext: builtContext.context }),
    });
  }

  const pipeline = await createSemanticPipelineRun({
    workspaceRoot,
    ...(options.auditRoot === undefined ? {} : { auditRoot: options.auditRoot }),
    defaultAuditKind: "candidates",
    ...(options.commandRunner === undefined
      ? {}
      : { commandRunner: options.commandRunner }),
    ...(options.writeLock === undefined ? {} : { writeLock: options.writeLock }),
  });
  const {
    runId,
    auditDirectory,
    reportPath,
    executeCommand,
    persistLock,
  } = pipeline;
  await writeSemanticJson(resolve(auditDirectory, "input.json"), {
    version: 1,
    source: sourceRelative,
    concept: source.concept.name,
    conceptId: source.concept.id,
    conceptHash: hashes.conceptHash,
    conceptSource,
    bindingKind: source.concept.shared ? "shared" : "local",
    predicate: source.predicate.name,
    specification: source.concept.specification,
    conceptStructure: source.concept.structure,
    typeDeclaration: source.concept.typeDeclaration,
    typeSchema: source.concept.typeSchema,
    testCasesSentToModel: false,
    provider,
    model,
    hashes,
    projectContext: {
      version: hashes.contextVersion,
      hash: hashes.contextHash,
      summary: contextSummary,
      modelVisible: builtContext !== undefined,
    },
  });
  await writeSemanticJson(
    resolve(auditDirectory, "response.output.json"),
    resolution.rawOutput,
  );

  const sourceDirectory = dirname(source.absolutePath);
  const outputStem = basename(
    generatedOutputPath(source.absolutePath, source.predicate.name),
    ".generated.ts",
  );
  const finalPath = generatedOutputPath(source.absolutePath, source.predicate.name);
  const candidatePath = resolve(sourceDirectory, `.${outputStem}.${runId}.candidate.ts`);
  const candidateTestPath = resolve(
    sourceDirectory,
    `.${outputStem}.${runId}.candidate.test.ts`,
  );
  let stage = "elaboration";
  let code = "";
  let definition: PredicateDefinition | null = null;

  try {
    if (resolution.elaboration.outcome === "unresolved") {
      throw new Error(
        `specification was unresolved: ${resolution.elaboration.diagnostics.join("; ")}`,
      );
    }

    stage = "context-validation";
    validatePredicateContext(resolution.elaboration.body, source);
    console.log("\ninterpreted judgement");
    console.log(
      renderInterpretedJudgement({
        predicateName: source.predicate.name,
        parameterName: source.predicate.parameterName,
        expression: resolution.elaboration.body,
      }),
    );
    console.log("");
    definition = parsePredicateDefinition({
      version: 1,
      name: source.predicate.name,
      description: source.concept.specification,
      input: {
        parameter: source.predicate.parameterName,
        type: source.concept.typeName,
        module: importModule,
      },
      returns: "boolean",
      body: resolution.elaboration.body,
    });
    code = generatePredicate(definition);
    if (entry !== undefined && sha256(code) !== entry.generatedCodeHash) {
      throw new Error(
        "semantic.lock integrity failed: deterministic generated code hash changed",
      );
    }
    const candidateTest = renderSemanticTestModule({
      candidateModuleName: basename(candidatePath, ".ts"),
      predicateName: source.predicate.name,
      acceptSource: source.tests.acceptSource,
      rejectSource: source.tests.rejectSource,
      boundarySource: source.tests.boundarySource,
      counterfactualSource: source.tests.counterfactualSource,
      invarianceSource: source.tests.invarianceSource,
    });
    await writeSemanticJson(
      resolve(auditDirectory, "predicate.ir.json"),
      definition,
    );
    await writeFile(resolve(auditDirectory, "candidate.ts"), code, "utf8");
    await writeFile(resolve(auditDirectory, "candidate.test.ts"), candidateTest, "utf8");
    await writeFile(candidatePath, code, "utf8");
    await writeFile(candidateTestPath, candidateTest, "utf8");

    stage = "candidate-typecheck";
    await executeCommand(
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
        candidatePath,
        candidateTestPath,
      ],
      workspaceRoot,
      stage,
    );
    stage = "semantic-test";
    await executeCommand(["bun", "test", candidateTestPath], workspaceRoot, stage);
    if (options.validateCandidate !== undefined) {
      stage = "additional-candidate-validation";
      await options.validateCandidate({
        source,
        definition,
        candidatePath,
        workspaceRoot,
        executeCommand,
      });
    }
    stage = "project-typecheck";
    await executeCommand(["bun", "run", "typecheck"], workspaceRoot, stage);
    await cleanupSemanticFiles([candidatePath, candidateTestPath]);

    const generatedCodeHash = sha256(code);
    const output = workspaceRelativePath(workspaceRoot, finalPath, "generated output");
    if (promotion === "review") {
      const review = await createPredicateSemanticReview({
        workspaceRoot,
        ...(options.reviewRoot === undefined ? {} : { reviewRoot: options.reviewRoot }),
        source: sourceRelative,
        output,
        symbol: source.predicate.name,
        conceptId: source.concept.id,
        provider,
        model,
        fingerprint,
        hashes,
        targetTypeName: source.concept.typeName,
        contextSummary,
        resolvedIr: definition.body,
        baseline: findLatestPredicateEntry(lock, {
          source: sourceRelative,
          predicate: source.predicate.name,
        }),
        response: lockResponse(resolution.response),
        generatedCode: code,
        typeSchema: source.concept.typeSchema,
      });
      stage = "report";
      await writeSemanticJson(reportPath, {
        version: 1,
        status: "review-required",
        stage: "complete",
        source: sourceRelative,
        output,
        candidateId: review.candidate.id,
        candidateDirectory: workspaceRelativePath(
          workspaceRoot,
          review.candidateDirectory,
          "review candidate directory",
        ),
        provider,
        model,
        response: semanticResponseMetadata(resolution.response),
        fingerprint,
        apiCalls,
        cacheHit,
        replayed: false,
        hashes: { ...hashes, generatedCodeHash },
        ...semanticRunDuration(pipeline),
      });
      return {
        status: "review-required",
        promotionMode: "review",
        source: sourceRelative,
        output,
        report: workspaceRelativePath(workspaceRoot, reportPath, "audit report"),
        fingerprint,
        provider,
        model,
        apiCalls,
        cacheHit,
        replayed: false,
        generatedCodeHash,
        candidateId: review.candidate.id,
        candidateDirectory: workspaceRelativePath(
          workspaceRoot,
          review.candidateDirectory,
          "review candidate directory",
        ),
      };
    }
    if (!cacheHit) {
      const promotedAt = new Date().toISOString();
      entry = {
        fingerprint,
        source: sourceRelative,
        concept: source.concept.name,
        conceptId: source.concept.id,
        conceptSource,
        predicate: source.predicate.name,
        targetTypeName: source.concept.typeName,
        provider,
        model,
        ...hashes,
        contextSummary,
        resolvedIr: definition.body,
        generatedCodeHash,
        response: resolution.response
          ? {
              id: resolution.response.responseId,
              model: resolution.response.model,
              usage: resolution.response.usage,
            }
          : null,
        createdAt: promotedAt,
        promotion: {
          mode: "auto",
          promotedAt,
          validation: {
            candidateTypecheck: "passed",
            projectTypecheck: "passed",
            semanticTest: "passed",
            fullTest: "passed",
          },
        },
      };
      lock.entries[fingerprint] = entry;
    }
    stage = "promotion";
    await promoteSemanticArtifact({
      outputPath: finalPath,
      generatedCode: code,
      lockPath,
      nextLock: lock,
      expectedLockHash: lockRevision,
      command: options.mode,
      persistLock: !cacheHit,
      runFullTest: async () => {
        stage = "full-test";
        await executeCommand(["bun", "test"], workspaceRoot, stage);
      },
      writeLock: async (path, nextLock) => {
        stage = "lock";
        if (!cacheHit) await persistLock(path, nextLock);
      },
    });
    stage = "report";
    await writeSemanticJson(reportPath, {
      version: 1,
      status: "passed",
      promotionMode: options.mode === "replay" ? "replay" : "auto",
      stage: "complete",
      source: sourceRelative,
      output: workspaceRelativePath(workspaceRoot, finalPath, "generated output"),
      provider,
      model,
      response: semanticResponseMetadata(resolution.response),
      fingerprint,
      apiCalls,
      cacheHit,
      replayed: options.mode === "replay",
      hashes: { ...hashes, generatedCodeHash },
      ...semanticRunDuration(pipeline),
    });

    return {
      status: "passed",
      promotionMode: options.mode === "replay" ? "replay" : "auto",
      source: sourceRelative,
      output: workspaceRelativePath(workspaceRoot, finalPath, "generated output"),
      report: workspaceRelativePath(workspaceRoot, reportPath, "audit report"),
      fingerprint,
      provider,
      model,
      apiCalls,
      cacheHit,
      replayed: options.mode === "replay",
      generatedCodeHash,
    };
  } catch (error) {
    await writeSemanticJson(reportPath, {
      version: 1,
      status: "failed",
      failedStage: stage,
      source: sourceRelative,
      provider,
      model,
      response: semanticResponseMetadata(resolution.response),
      fingerprint,
      apiCalls,
      cacheHit,
      replayed: options.mode === "replay",
      hashes: {
        ...hashes,
        generatedCodeHash: code.length > 0 ? sha256(code) : null,
      },
      error: error instanceof Error ? error.message : String(error),
      ...semanticRunDuration(pipeline),
    });
    throw error;
  } finally {
    await cleanupSemanticFiles([candidatePath, candidateTestPath]);
  }
}

function lockResponse(
  response: OpenAIResult | null,
): SemanticLockEntry["response"] {
  return response === null
    ? null
    : {
        id: response.responseId,
        model: response.model,
        usage: response.usage,
      };
}

export function renderPromptForAudit(input: {
  model: string;
  specification: string;
  typeScriptSource: string;
  functionName: string;
  parameterName: string;
  typeName: string;
  projectContext?: ProjectContext;
}): object {
  return buildOpenAIRequest({
    model: input.model,
    specification: input.specification,
    typeScriptSource: input.typeScriptSource,
    target: {
      functionName: input.functionName,
      parameterName: input.parameterName,
      typeName: input.typeName,
    },
    ...(input.projectContext === undefined
      ? {}
      : { projectContext: input.projectContext }),
  });
}
