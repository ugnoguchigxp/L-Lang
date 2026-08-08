import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { OpenAIResult } from "./openai";
import { writeSemanticLock, type SemanticLock } from "./semantic-lock";

export type SemanticCommandRunner = (
  command: string[],
  cwd: string,
  stage: string,
) => Promise<void>;

export type SemanticPipelineRun = {
  runId: string;
  auditDirectory: string;
  reportPath: string;
  startedAt: number;
  executeCommand: SemanticCommandRunner;
  persistLock: (path: string, lock: SemanticLock) => Promise<void>;
};

export async function createSemanticPipelineRun(input: {
  workspaceRoot: string;
  auditRoot?: string;
  defaultAuditKind: "candidates" | "judgments";
  commandRunner?: SemanticCommandRunner;
  writeLock?: typeof writeSemanticLock;
}): Promise<SemanticPipelineRun> {
  const runId = createSemanticRunId();
  const auditDirectory = resolve(
    input.auditRoot ??
      resolve(input.workspaceRoot, ".semantic", input.defaultAuditKind),
    runId,
  );
  await mkdir(auditDirectory, { recursive: true });
  return {
    runId,
    auditDirectory,
    reportPath: resolve(auditDirectory, "report.json"),
    startedAt: Date.now(),
    executeCommand: input.commandRunner ?? runSemanticCommand,
    persistLock: input.writeLock ?? writeSemanticLock,
  };
}

export async function writeSemanticJson(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function cleanupSemanticFiles(paths: string[]): Promise<void> {
  await Promise.all(paths.map(unlinkIfExists));
}

export function semanticResponseMetadata(response: OpenAIResult | null): {
  id: string;
  model: string;
  usage: OpenAIResult["usage"];
} | null {
  return response === null
    ? null
    : {
        id: response.responseId,
        model: response.model,
        usage: response.usage,
      };
}

export function semanticRunDuration(run: SemanticPipelineRun): {
  durationMs: number;
  completedAt: string;
} {
  return {
    durationMs: Date.now() - run.startedAt,
    completedAt: new Date().toISOString(),
  };
}

async function runSemanticCommand(
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
  if (exitCode !== 0) {
    throw new Error(`${stage} failed with exit code ${exitCode}`);
  }
}

function createSemanticRunId(): string {
  const timestamp = new Date()
    .toISOString()
    .replaceAll(/[-:.TZ]/g, "")
    .slice(0, 14);
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
