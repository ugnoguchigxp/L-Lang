import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  relative,
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
  PREDICATE_PROMPT_VERSION,
  type ElaborationResult,
  type OpenAIResult,
} from "./openai";
import {
  findReplayEntry,
  readSemanticLock,
  writeSemanticLock,
  type SemanticLockEntry,
} from "./semantic-lock";
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
  commandRunner?: SemanticCommandRunner;
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

export type SemanticCompileResult = {
  status: "passed";
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

type Hashes = {
  conceptHash: string;
  sourceHash: string;
  typeHash: string;
  testHash: string;
  promptHash: string;
};

export async function compileSemanticSource(
  options: SemanticCompileOptions,
): Promise<SemanticCompileResult> {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const source = await scanSemanticSource(options.sourcePath);
  const sourceRelative = normalizePath(relative(workspaceRoot, source.absolutePath));
  if (sourceRelative.startsWith("../")) {
    throw new Error("semantic source must be inside the workspace root");
  }

  const importModule = `./${basename(source.absolutePath, extname(source.absolutePath))}`;
  const conceptSource = normalizePath(
    relative(workspaceRoot, source.concept.definitionPath),
  );
  if (conceptSource.startsWith("../")) {
    throw new Error("concept definition must be inside the workspace root");
  }
  const requestShape = {
    specification: source.concept.specification,
    typeScriptSource: source.concept.typeDeclaration,
    target: {
      functionName: source.predicate.name,
      parameterName: source.predicate.parameterName,
      typeName: source.concept.typeName,
    },
  };
  const hashes: Hashes = {
    conceptHash: source.concept.hash,
    sourceHash: sha256(source.sourceText),
    typeHash: sha256(
      stableJson({
        declaration: source.concept.typeDeclaration,
        schema: source.concept.typeSchema,
      }),
    ),
    testHash: sha256(
      stableJson({
        accept: source.tests.acceptSource,
        reject: source.tests.rejectSource,
      }),
    ),
    promptHash: sha256(
      stableJson({ version: PREDICATE_PROMPT_VERSION, ...requestShape }),
    ),
  };

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
    typeDeclaration: source.concept.typeDeclaration,
    typeSchema: source.concept.typeSchema,
    testCasesSentToModel: false,
    provider,
    model,
    hashes,
  });
  await writeJson(resolve(auditDirectory, "response.output.json"), resolution.rawOutput);

  const sourceDirectory = dirname(source.absolutePath);
  const outputStem = kebabCase(source.predicate.name);
  const finalPath = resolve(sourceDirectory, `${outputStem}.generated.ts`);
  const candidatePath = resolve(sourceDirectory, `.${outputStem}.${runId}.candidate.ts`);
  const candidateTestPath = resolve(
    sourceDirectory,
    `.${outputStem}.${runId}.candidate.test.ts`,
  );
  const reportPath = resolve(auditDirectory, "report.json");
  let stage = "elaboration";
  let code = "";
  let definition: PredicateDefinition | null = null;
  let previousFinal: string | undefined;
  let promoted = false;
  const startedAt = Date.now();
  const executeCommand = options.commandRunner ?? runCommand;

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

    stage = "project-typecheck";
    await executeCommand(["bun", "run", "typecheck"], workspaceRoot, stage);
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
    await Promise.all([unlinkIfExists(candidatePath), unlinkIfExists(candidateTestPath)]);

    stage = "promotion";
    previousFinal = await readOptional(finalPath);
    await atomicWrite(finalPath, code);
    promoted = true;
    try {
      stage = "full-test";
      await executeCommand(["bun", "test"], workspaceRoot, stage);
    } catch (error) {
      stage = "rollback";
      await restoreFinal(finalPath, previousFinal);
      promoted = false;
      throw error;
    }

    const generatedCodeHash = sha256(code);
    if (!cacheHit) {
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
        createdAt: new Date().toISOString(),
      };
      lock.entries[fingerprint] = entry;
      stage = "lock";
      await writeSemanticLock(lockPath, lock);
    }
    stage = "report";
    await writeJson(reportPath, {
      version: 1,
      status: "passed",
      stage: "complete",
      source: sourceRelative,
      output: normalizePath(relative(workspaceRoot, finalPath)),
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
      source: sourceRelative,
      output: normalizePath(relative(workspaceRoot, finalPath)),
      report: normalizePath(relative(workspaceRoot, reportPath)),
      fingerprint,
      provider,
      model,
      apiCalls,
      cacheHit,
      replayed: options.mode === "replay",
      generatedCodeHash,
    };
  } catch (error) {
    if (promoted && stage === "lock") {
      await restoreFinal(finalPath, previousFinal);
      promoted = false;
      stage = "rollback";
    }
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

async function atomicWrite(path: string, value: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.promote.tmp`;
  await writeFile(temporary, value, "utf8");
  await rename(temporary, path);
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function restoreFinal(path: string, previous: string | undefined): Promise<void> {
  if (previous === undefined) {
    await unlinkIfExists(path);
  } else {
    await atomicWrite(path, previous);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fingerprintFor(input: object): string {
  return sha256(stableJson(input));
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function kebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replaceAll("_", "-")
    .toLowerCase();
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
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
