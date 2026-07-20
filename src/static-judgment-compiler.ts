import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import type { SemanticCommandRunner } from "./semantic-compiler";
import {
  findStaticJudgmentReplayEntry,
  readSemanticLock,
  writeSemanticLock,
  type StaticJudgmentLockEntry,
} from "./semantic-lock";
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
  commandRunner?: SemanticCommandRunner;
  writeLock?: typeof writeSemanticLock;
  resolve?: (input: {
    conceptId: string;
    conceptSpecification: string;
    staticValue: string;
    judgmentName: string;
  }) => Promise<StaticJudgmentCompilerResolution>;
};

export type StaticJudgmentCompileResult = {
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
  resolvedValue: boolean;
  generatedCodeHash: string;
};

type JudgmentHashes = {
  conceptHash: string;
  valueHash: string;
  promptHash: string;
};

export async function compileStaticJudgmentSource(
  options: StaticJudgmentCompileOptions,
): Promise<StaticJudgmentCompileResult> {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const source = await scanStaticJudgmentSource(options.sourcePath);
  const sourceRelative = normalizePath(relative(workspaceRoot, source.absolutePath));
  if (sourceRelative.startsWith("../")) {
    throw new Error("Static Judgment source must be inside the workspace root");
  }
  const conceptSource = normalizePath(
    relative(workspaceRoot, source.concept.definitionPath),
  );
  if (conceptSource.startsWith("../")) {
    throw new Error("Static Judgment Concept must be inside the workspace root");
  }

  const requestShape = {
    conceptId: source.concept.id,
    conceptSpecification: source.concept.specification,
    staticValue: source.value.text,
    judgmentName: source.judgment.name,
  };
  const hashes: JudgmentHashes = {
    conceptHash: source.concept.hash,
    valueHash: sha256(source.value.text),
    promptHash: sha256(stableJson({
      version: STATIC_JUDGMENT_PROMPT_VERSION,
      ...requestShape,
    })),
  };

  const lockPath = resolve(options.lockPath ?? resolve(workspaceRoot, "semantic.lock"));
  const lock = await readSemanticLock(lockPath);
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

  const runId = `${new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const auditDirectory = resolve(
    options.auditRoot ?? resolve(workspaceRoot, ".semantic", "judgments"),
    runId,
  );
  await mkdir(auditDirectory, { recursive: true });
  await writeJson(resolve(auditDirectory, "input.json"), {
    version: 1,
    source: sourceRelative,
    judgment: source.judgment.name,
    concept: source.concept.name,
    conceptId: source.concept.id,
    conceptHash: hashes.conceptHash,
    conceptSource,
    valueHash: hashes.valueHash,
    promptHash: hashes.promptHash,
    promptVersion: STATIC_JUDGMENT_PROMPT_VERSION,
    provider,
    model,
  });
  await writeJson(
    resolve(auditDirectory, "response.output.json"),
    resolution.rawOutput,
  );
  await writeJson(resolve(auditDirectory, "judgment.json"), resolution.judgment);

  const sourceDirectory = dirname(source.absolutePath);
  const outputStem = kebabCase(source.judgment.name);
  const finalPath = resolve(sourceDirectory, `${outputStem}.generated.ts`);
  const candidatePath = resolve(
    sourceDirectory,
    `.${outputStem}.${runId}.candidate.ts`,
  );
  const reportPath = resolve(auditDirectory, "report.json");
  const executeCommand = options.commandRunner ?? runCommand;
  const persistLock = options.writeLock ?? writeSemanticLock;
  const startedAt = Date.now();
  let stage = "judgment";
  let code = "";
  let previousFinal: string | undefined;
  let promoted = false;

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
    await unlinkIfExists(candidatePath);

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
        createdAt: new Date().toISOString(),
      } satisfies StaticJudgmentLockEntry;
      lock.judgments ??= {};
      lock.judgments[fingerprint] = entry;
      stage = "lock";
      await persistLock(lockPath, lock);
    }

    stage = "report";
    await writeJson(reportPath, {
      version: 1,
      status: "passed",
      stage: "complete",
      source: sourceRelative,
      output: normalizePath(relative(workspaceRoot, finalPath)),
      judgment: source.judgment.name,
      resolvedValue: resolution.judgment.value,
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
      resolvedValue: resolution.judgment.value,
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
      judgment: source.judgment.name,
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
    await unlinkIfExists(candidatePath);
  }
}

async function runCommand(
  command: string[],
  cwd: string,
  stage: string,
): Promise<void> {
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

async function restoreFinal(
  path: string,
  previous: string | undefined,
): Promise<void> {
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
