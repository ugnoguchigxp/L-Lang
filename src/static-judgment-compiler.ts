import {
  writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
  fingerprintFor,
  generatedOutputPath,
  sha256,
  staticJudgmentRequestShape,
  staticJudgmentSemanticHashes,
  workspaceRelativePath,
} from "./semantic-fingerprint";
import {
  findLatestStaticJudgmentEntry,
  findStaticJudgmentReplayEntry,
  readSemanticLockSnapshot,
  type StaticJudgmentLockEntry,
} from "./semantic-lock";
import type { writeSemanticLock } from "./semantic-lock";
import { promoteSemanticArtifact } from "./semantic-promotion";
import {
  cleanupSemanticFiles,
  createSemanticPipelineRun,
  semanticResponseMetadata,
  semanticRunDuration,
  writeSemanticJson,
  type SemanticCommandRunner,
} from "./semantic-pipeline";
import { createStaticJudgmentSemanticReview } from "./semantic-review";
import { generateStaticJudgmentConstant } from "./static-judgment-generator";
import { scanStaticJudgmentSource } from "./static-judgment-source";
import {
  STATIC_JUDGMENT_PROMPT_VERSION,
  type StaticJudgmentResolution,
} from "./static-judgment";
import type { OpenAIResult } from "./openai";

export type StaticJudgmentCompilerResolution = {
  judgment: StaticJudgmentResolution;
  response: OpenAIResult | null;
  rawOutput: unknown;
};

export type StaticJudgmentCompileOptions = {
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
  resolve?: (input: {
    conceptId: string;
    conceptSpecification: string;
    staticValue: string;
    judgmentName: string;
  }) => Promise<StaticJudgmentCompilerResolution>;
};

type StaticJudgmentCompileResultBase = {
  source: string;
  output: string;
  report: string;
  fingerprint: string;
  provider: string;
  model: string;
  apiCalls: number;
  cacheHit: boolean;
  replayed: boolean;
  resolvedValue: boolean;
  generatedCodeHash: string;
};

export type StaticJudgmentCompileResult =
  | (StaticJudgmentCompileResultBase & {
      status: "passed";
      promotionMode: "auto" | "replay";
    })
  | (StaticJudgmentCompileResultBase & {
      status: "review-required";
      promotionMode: "review";
      candidateId: string;
      candidateDirectory: string;
    });

export async function compileStaticJudgmentSource(
  options: StaticJudgmentCompileOptions,
): Promise<StaticJudgmentCompileResult> {
  const promotion = options.promotion ?? "auto";
  if (options.mode === "replay" && promotion === "review") {
    throw new Error("Static Judgment replay does not support review promotion");
  }
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const source = await scanStaticJudgmentSource(options.sourcePath);
  const sourceRelative = workspaceRelativePath(
    workspaceRoot,
    source.absolutePath,
    "Static Judgment source",
  );
  const conceptSource = workspaceRelativePath(
    workspaceRoot,
    source.concept.definitionPath,
    "Static Judgment Concept",
  );

  const requestShape = staticJudgmentRequestShape(source);
  const hashes = staticJudgmentSemanticHashes(source);

  const lockPath = resolve(options.lockPath ?? resolve(workspaceRoot, "semantic.lock"));
  const { lock, revision: lockRevision } =
    await readSemanticLockSnapshot(lockPath);
  let provider = options.provider ?? "lock";
  let model = options.model ?? "lock";
  let fingerprint = fingerprintFor({
    source: sourceRelative,
    judgment: source.judgment.name,
    conceptId: source.concept.id,
    provider,
    model,
    ...hashes,
  });
  let entry = options.mode === "replay"
    ? findStaticJudgmentReplayEntry(lock, {
        source: sourceRelative,
        judgment: source.judgment.name,
        conceptId: source.concept.id,
        ...hashes,
      })
    : lock.judgments?.[fingerprint];

  if (options.mode === "replay" && entry === undefined) {
    throw new Error(
      "Static Judgment replay failed: no lock entry matches the current Concept, value, and prompt",
    );
  }

  let resolution: StaticJudgmentCompilerResolution;
  let apiCalls = 0;
  const cacheHit = entry !== undefined;
  if (entry !== undefined) {
    provider = entry.provider;
    model = entry.model;
    fingerprint = entry.fingerprint;
    resolution = {
      judgment: {
        outcome: "resolved",
        value: entry.resolvedValue,
        diagnostics: [],
      },
      response: entry.response
        ? {
            responseId: entry.response.id,
            model: entry.response.model,
            usage: entry.response.usage,
            outputText: JSON.stringify({
              outcome: "resolved",
              value: entry.resolvedValue,
              diagnostics: [],
            }),
          }
        : null,
      rawOutput: { source: "semantic.lock", fingerprint: entry.fingerprint },
    };
  } else {
    if (options.mode === "replay" || options.resolve === undefined) {
      throw new Error("Static Judgment build requires a resolver on a lock miss");
    }
    apiCalls = options.countsAsApiCall === false ? 0 : 1;
    resolution = await options.resolve(requestShape);
  }

  const pipeline = await createSemanticPipelineRun({
    workspaceRoot,
    ...(options.auditRoot === undefined ? {} : { auditRoot: options.auditRoot }),
    defaultAuditKind: "judgments",
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
    judgment: source.judgment.name,
    concept: source.concept.name,
    conceptId: source.concept.id,
    conceptHash: hashes.conceptHash,
    conceptSource,
    conceptStructure: source.concept.structure,
    valueHash: hashes.valueHash,
    promptHash: hashes.promptHash,
    promptVersion: STATIC_JUDGMENT_PROMPT_VERSION,
    provider,
    model,
  });
  await writeSemanticJson(
    resolve(auditDirectory, "response.output.json"),
    resolution.rawOutput,
  );
  await writeSemanticJson(
    resolve(auditDirectory, "judgment.json"),
    resolution.judgment,
  );

  const sourceDirectory = dirname(source.absolutePath);
  const finalPath = generatedOutputPath(source.absolutePath, source.judgment.name);
  const outputStem = basename(finalPath, ".generated.ts");
  const candidatePath = resolve(
    sourceDirectory,
    `.${outputStem}.${runId}.candidate.ts`,
  );
  let stage = "judgment";
  let code = "";

  try {
    if (resolution.judgment.outcome === "unresolved") {
      throw new Error(
        `Static Judgment was unresolved: ${resolution.judgment.diagnostics.join("; ")}`,
      );
    }

    stage = "generation";
    code = generateStaticJudgmentConstant(
      source.judgment.name,
      resolution.judgment.value,
    );
    if (entry !== undefined && sha256(code) !== entry.generatedCodeHash) {
      throw new Error(
        "semantic.lock integrity failed: deterministic Static Judgment code hash changed",
      );
    }
    await writeFile(resolve(auditDirectory, "candidate.ts"), code, "utf8");
    await writeFile(candidatePath, code, "utf8");

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
      ],
      workspaceRoot,
      stage,
    );
    stage = "project-typecheck";
    await executeCommand(["bun", "run", "typecheck"], workspaceRoot, stage);
    await cleanupSemanticFiles([candidatePath]);

    const generatedCodeHash = sha256(code);
    const output = workspaceRelativePath(workspaceRoot, finalPath, "generated output");
    if (promotion === "review") {
      const review = await createStaticJudgmentSemanticReview({
        workspaceRoot,
        ...(options.reviewRoot === undefined ? {} : { reviewRoot: options.reviewRoot }),
        source: sourceRelative,
        output,
        symbol: source.judgment.name,
        conceptId: source.concept.id,
        provider,
        model,
        fingerprint,
        hashes,
        resolvedValue: resolution.judgment.value,
        baseline: findLatestStaticJudgmentEntry(lock, {
          source: sourceRelative,
          judgment: source.judgment.name,
        }),
        response: lockResponse(resolution.response),
        generatedCode: code,
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
        judgment: source.judgment.name,
        resolvedValue: resolution.judgment.value,
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
        resolvedValue: resolution.judgment.value,
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
        judgment: source.judgment.name,
        conceptId: source.concept.id,
        ...hashes,
        provider,
        model,
        resolvedValue: resolution.judgment.value,
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
            semanticTest: "not-applicable",
            fullTest: "passed",
          },
        },
      } satisfies StaticJudgmentLockEntry;
      lock.judgments ??= {};
      lock.judgments[fingerprint] = entry;
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
      stage: "complete",
      source: sourceRelative,
      output: workspaceRelativePath(workspaceRoot, finalPath, "generated output"),
      judgment: source.judgment.name,
      resolvedValue: resolution.judgment.value,
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
      resolvedValue: resolution.judgment.value,
      generatedCodeHash,
    };
  } catch (error) {
    await writeSemanticJson(reportPath, {
      version: 1,
      status: "failed",
      failedStage: stage,
      source: sourceRelative,
      judgment: source.judgment.name,
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
    await cleanupSemanticFiles([candidatePath]);
  }
}

function lockResponse(
  response: OpenAIResult | null,
): StaticJudgmentLockEntry["response"] {
  return response === null
    ? null
    : {
        id: response.responseId,
        model: response.model,
        usage: response.usage,
      };
}
