import { randomUUID } from "node:crypto";
import {
  mkdir,
  unlink,
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
  renderInterpretedJudgement,
  renderSemanticTestModule,
} from "./judgement-renderer";
import {
  parsePredicateDefinition,
  parsePredicateExpression,
  type PredicateDefinition,
} from "./ir";
import {
  buildOpenAIRequest,
  type ElaborationResult,
  type OpenAIResult,
} from "./openai";
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
  readSemanticLock,
  writeSemanticLock,
  type SemanticLockEntry,
} from "./semantic-lock";
import { promoteSemanticArtifact } from "./semantic-promotion";
import { createPredicateSemanticReview } from "./semantic-review";
import { scanSemanticSource } from "./semantic-source";

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
  resolve?: (input: {
    specification: string;
    typeScriptSource: string;
    functionName: string;
    parameterName: string;
    typeName: string;
  }) => Promise<SemanticResolution>;
};

export type SemanticCommandRunner = (
  command: string[],
  cwd: string,
  stage: string,
) => Promise<void>;

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
  const requestShape = predicateRequestShape(source);
  const hashes = predicateSemanticHashes(source);

  const lockPath = resolve(options.lockPath ?? resolve(workspaceRoot, "semantic.lock"));
  const lock = await readSemanticLock(lockPath);
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
    });
  }

  const runId = `${new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const auditDirectory = resolve(
    options.auditRoot ?? resolve(workspaceRoot, ".semantic", "candidates"),
    runId,
  );
  await mkdir(auditDirectory, { recursive: true });
  await writeJson(resolve(auditDirectory, "input.json"), {
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
  });
  await writeJson(resolve(auditDirectory, "response.output.json"), resolution.rawOutput);

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
  const reportPath = resolve(auditDirectory, "report.json");
  let stage = "elaboration";
  let code = "";
  let definition: PredicateDefinition | null = null;
  const startedAt = Date.now();
  const executeCommand = options.commandRunner ?? runCommand;
  const persistLock = options.writeLock ?? writeSemanticLock;

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
    });
    await writeJson(resolve(auditDirectory, "predicate.ir.json"), definition);
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
    stage = "project-typecheck";
    await executeCommand(["bun", "run", "typecheck"], workspaceRoot, stage);
    await Promise.all([unlinkIfExists(candidatePath), unlinkIfExists(candidateTestPath)]);

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
      await writeJson(reportPath, {
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
        response: responseMetadata(resolution.response),
        fingerprint,
        apiCalls,
        cacheHit,
        replayed: false,
        hashes: { ...hashes, generatedCodeHash },
        durationMs: Date.now() - startedAt,
        completedAt: new Date().toISOString(),
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
        provider,
        model,
        ...hashes,
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
    await writeJson(reportPath, {
      version: 1,
      status: "passed",
      promotionMode: options.mode === "replay" ? "replay" : "auto",
      stage: "complete",
      source: sourceRelative,
      output: workspaceRelativePath(workspaceRoot, finalPath, "generated output"),
      provider,
      model,
      response: responseMetadata(resolution.response),
      fingerprint,
      apiCalls,
      cacheHit,
      replayed: options.mode === "replay",
      hashes: { ...hashes, generatedCodeHash },
      durationMs: Date.now() - startedAt,
      completedAt: new Date().toISOString(),
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
    await writeJson(reportPath, {
      version: 1,
      status: "failed",
      failedStage: stage,
      source: sourceRelative,
      provider,
      model,
      response: responseMetadata(resolution.response),
      fingerprint,
      apiCalls,
      cacheHit,
      replayed: options.mode === "replay",
      hashes: {
        ...hashes,
        generatedCodeHash: code.length > 0 ? sha256(code) : null,
      },
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
      completedAt: new Date().toISOString(),
    });
    throw error;
  } finally {
    await Promise.all([unlinkIfExists(candidatePath), unlinkIfExists(candidateTestPath)]);
  }
}

async function runCommand(command: string[], cwd: string, stage: string): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${stage} failed with exit code ${exitCode}`);
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function responseMetadata(response: OpenAIResult | null): object | null {
  return response === null
    ? null
    : {
        id: response.responseId,
        model: response.model,
        usage: response.usage,
      };
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

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

export function renderPromptForAudit(input: {
  model: string;
  specification: string;
  typeScriptSource: string;
  functionName: string;
  parameterName: string;
  typeName: string;
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
  });
}
