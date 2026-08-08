import { access, readFile } from "node:fs/promises";

import { atomicWriteJson, atomicWriteText } from "./atomic-file";
import type { OpenAIResult } from "./openai";
import type {
  ProjectFitArm,
  ProjectFitProtocol,
  ProjectFitStage,
} from "./project-fit-manifest";
import {
  assertKnownKeys,
  parseBoundedJsonText,
  SEMANTIC_LIMITS,
} from "./semantic-limits";

export { atomicWriteJson, atomicWriteText };

export type ProjectFitCheckpointEntry =
  | {
      key: string;
      stage: ProjectFitStage;
      caseId: string;
      arm: ProjectFitArm;
      trial: number;
      status: "pending";
    }
  | {
      key: string;
      stage: ProjectFitStage;
      caseId: string;
      arm: ProjectFitArm;
      trial: number;
      status: "completed";
      response: OpenAIResult;
      latencyMs: number;
    };

export type ProjectFitLiveCheckpoint = {
  version: 2;
  manifestHash: string;
  model: string;
  provider: string;
  costPerMillionTokens: {
    input: number;
    output: number;
  };
  entries: ProjectFitCheckpointEntry[];
};

export async function loadOrCreateProjectFitCheckpoint(
  path: string,
  protocol: ProjectFitProtocol,
  metadata: { model: string; provider: string },
  rates: { input: number; output: number },
): Promise<ProjectFitLiveCheckpoint> {
  const existing = await readTextIfExists(path);
  if (existing === undefined) {
    const checkpoint: ProjectFitLiveCheckpoint = {
      version: 2,
      manifestHash: protocol.manifestHash,
      model: metadata.model,
      provider: metadata.provider,
      costPerMillionTokens: rates,
      entries: [],
    };
    await atomicWriteJson(path, checkpoint);
    return checkpoint;
  }
  const checkpoint = parseCheckpoint(
    parseBoundedJsonText(existing, "Project Fit checkpoint"),
  );
  if (
    checkpoint.manifestHash !== protocol.manifestHash ||
    checkpoint.model !== metadata.model ||
    checkpoint.provider !== metadata.provider ||
    checkpoint.costPerMillionTokens.input !== rates.input ||
    checkpoint.costPerMillionTokens.output !== rates.output
  ) {
    throw new Error(
      "Project Fit checkpoint metadata does not match the requested run",
    );
  }
  return checkpoint;
}

export function validateProjectFitCheckpointEntries(
  checkpoint: ProjectFitLiveCheckpoint,
  protocol: ProjectFitProtocol,
  perCallOutputTokenLimit: number,
  totalOutputTokenBudget: number,
): void {
  const allowedKeys = new Set(
    protocol.manifest.cases.flatMap((benchmarkCase) =>
      (["initial", "schemaChange"] as const).flatMap((stage) =>
        Array.from({ length: protocol.manifest.trials }, (_, index) =>
          (["typeOnly", "projectContext"] as const).map((arm) =>
            projectFitTrialKey(stage, benchmarkCase.id, arm, index + 1),
          ),
        ).flat(),
      ),
    ),
  );
  for (const entry of checkpoint.entries) {
    if (!allowedKeys.has(entry.key)) {
      throw new Error(
        `Project Fit checkpoint entry ${entry.key} is not scheduled by the manifest`,
      );
    }
    if (entry.status === "completed") {
      validateProjectFitResponseUsage(
        entry.response,
        perCallOutputTokenLimit,
      );
    }
  }
  validateProjectFitCompletedResponseBudget(
    checkpoint,
    protocol.manifest.budget.maxInputTokens,
    totalOutputTokenBudget,
  );
}

export function validateProjectFitResponseUsage(
  response: OpenAIResult,
  perCallOutputTokenLimit: number,
): void {
  if (response.usage === null) {
    throw new Error(
      "Project Fit response usage is required for budget accounting",
    );
  }
  if (response.usage.outputTokens > perCallOutputTokenLimit) {
    throw new Error(
      `Project Fit response exceeded the per-call output token limit of ${perCallOutputTokenLimit}`,
    );
  }
}

export function validateProjectFitCompletedResponseBudget(
  checkpoint: ProjectFitLiveCheckpoint,
  maxInputTokens: number,
  maxOutputTokens: number,
): void {
  const usage = checkpoint.entries
    .filter(
      (
        entry,
      ): entry is Extract<
        ProjectFitCheckpointEntry,
        { status: "completed" }
      > => entry.status === "completed",
    )
    .map((entry) => entry.response.usage);
  if (usage.some((value) => value === null)) {
    throw new Error(
      "Project Fit response usage is required for budget accounting",
    );
  }
  const inputTokens = usage.reduce(
    (total, value) => total + (value?.inputTokens ?? 0),
    0,
  );
  const outputTokens = usage.reduce(
    (total, value) => total + (value?.outputTokens ?? 0),
    0,
  );
  if (inputTokens > maxInputTokens) {
    throw new Error(
      "Project Fit completed responses exceeded the input token budget",
    );
  }
  if (outputTokens > maxOutputTokens) {
    throw new Error(
      "Project Fit completed responses exceeded the output token budget",
    );
  }
}

export function projectFitTrialKey(
  stage: ProjectFitStage,
  caseId: string,
  arm: ProjectFitArm,
  trial: number,
): string {
  return `${stage}:${caseId}:${arm}:${trial}`;
}

export function completedProjectFitResponseCount(
  checkpoint: ProjectFitLiveCheckpoint,
): number {
  return checkpoint.entries.filter((entry) => entry.status === "completed")
    .length;
}

export async function projectFitFileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export function validateProjectFitTokenRates(input: {
  input: unknown;
  output: unknown;
}): { input: number; output: number } {
  const result = { input: input.input, output: input.output };
  for (const [name, value] of Object.entries(result)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(
        `Project Fit ${name} token rate must be a non-negative finite number`,
      );
    }
  }
  return result as { input: number; output: number };
}

function parseCheckpoint(input: unknown): ProjectFitLiveCheckpoint {
  const value = recordValue(input, "Project Fit checkpoint");
  assertExactKeys(
    value,
    [
      "version",
      "manifestHash",
      "model",
      "provider",
      "costPerMillionTokens",
      "entries",
    ],
    "Project Fit checkpoint",
  );
  if (value.version !== 2) {
    throw new Error("Project Fit checkpoint.version must be 2");
  }
  const rates = recordValue(
    value.costPerMillionTokens,
    "Project Fit checkpoint.costPerMillionTokens",
  );
  assertExactKeys(
    rates,
    ["input", "output"],
    "Project Fit checkpoint.costPerMillionTokens",
  );
  if (!Array.isArray(value.entries)) {
    throw new Error("Project Fit checkpoint.entries must be an array");
  }
  const entries = value.entries.map((entry, index) =>
    parseCheckpointEntry(entry, index),
  );
  const keys = new Set<string>();
  for (const entry of entries) {
    if (keys.has(entry.key)) {
      throw new Error(
        `Project Fit checkpoint contains duplicate key ${entry.key}`,
      );
    }
    keys.add(entry.key);
  }
  return {
    version: 2,
    manifestHash: hashValue(
      value.manifestHash,
      "Project Fit checkpoint.manifestHash",
    ),
    model: trimmedString(value.model, "Project Fit checkpoint.model"),
    provider: trimmedString(
      value.provider,
      "Project Fit checkpoint.provider",
    ),
    costPerMillionTokens: validateProjectFitTokenRates({
      input: rates.input,
      output: rates.output,
    }),
    entries,
  };
}

function parseCheckpointEntry(
  input: unknown,
  index: number,
): ProjectFitCheckpointEntry {
  const path = `Project Fit checkpoint.entries[${index}]`;
  const value = recordValue(input, path);
  if (value.status === "pending") {
    assertExactKeys(
      value,
      ["key", "stage", "caseId", "arm", "trial", "status"],
      path,
    );
  } else if (value.status === "completed") {
    assertExactKeys(
      value,
      [
        "key",
        "stage",
        "caseId",
        "arm",
        "trial",
        "status",
        "response",
        "latencyMs",
      ],
      path,
    );
  } else {
    throw new Error(`${path}.status is invalid`);
  }
  const stage = stageValue(value.stage, `${path}.stage`);
  const arm = armValue(value.arm, `${path}.arm`);
  const caseId = trimmedString(value.caseId, `${path}.caseId`);
  const trial = positiveInteger(value.trial, `${path}.trial`);
  const key = trimmedString(value.key, `${path}.key`);
  if (key !== projectFitTrialKey(stage, caseId, arm, trial)) {
    throw new Error(`${path}.key does not match its coordinates`);
  }
  if (value.status === "pending") {
    return { key, stage, caseId, arm, trial, status: "pending" };
  }
  return {
    key,
    stage,
    caseId,
    arm,
    trial,
    status: "completed",
    response: parseCheckpointResponse(value.response, `${path}.response`),
    latencyMs: nonNegativeNumber(value.latencyMs, `${path}.latencyMs`),
  };
}

function parseCheckpointResponse(input: unknown, path: string): OpenAIResult {
  const value = recordValue(input, path);
  assertExactKeys(
    value,
    ["responseId", "model", "outputText", "usage"],
    path,
  );
  const usage = recordValue(value.usage, `${path}.usage`);
  assertExactKeys(
    usage,
    ["inputTokens", "outputTokens", "totalTokens"],
    `${path}.usage`,
  );
  return {
    responseId: trimmedString(value.responseId, `${path}.responseId`),
    model: trimmedString(value.model, `${path}.model`),
    outputText: boundedString(value.outputText, `${path}.outputText`),
    usage: {
      inputTokens: nonNegativeInteger(
        usage.inputTokens,
        `${path}.usage.inputTokens`,
      ),
      outputTokens: nonNegativeInteger(
        usage.outputTokens,
        `${path}.usage.outputTokens`,
      ),
      totalTokens: nonNegativeInteger(
        usage.totalTokens,
        `${path}.usage.totalTokens`,
      ),
    },
  };
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text) > SEMANTIC_LIMITS.externalJsonBytes) {
      throw new Error("Project Fit checkpoint exceeds input budget");
    }
    return text;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error &&
    error.code === "ENOENT"
  );
}

function recordValue(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${path} must be an object`);
  }
  return input as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  assertKnownKeys(value, keys, path);
  const missing = keys.find((key) => !(key in value));
  if (missing !== undefined) {
    throw new Error(`${path} is missing ${missing}`);
  }
}

function trimmedString(input: unknown, path: string): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.trim() !== input
  ) {
    throw new Error(`${path} must be a non-empty trimmed string`);
  }
  return input;
}

function boundedString(input: unknown, path: string): string {
  const value = trimmedString(input, path);
  if (Buffer.byteLength(value) > SEMANTIC_LIMITS.externalJsonBytes) {
    throw new Error(`${path} exceeds input budget`);
  }
  return value;
}

function hashValue(input: unknown, path: string): string {
  const value = trimmedString(input, path);
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${path} must be a SHA-256 hash`);
  }
  return value;
}

function positiveInteger(input: unknown, path: string): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < 1
  ) {
    throw new Error(`${path} must be a positive safe integer`);
  }
  return input;
}

function nonNegativeInteger(input: unknown, path: string): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < 0
  ) {
    throw new Error(`${path} must be a non-negative safe integer`);
  }
  return input;
}

function nonNegativeNumber(input: unknown, path: string): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) {
    throw new Error(`${path} must be a non-negative finite number`);
  }
  return input;
}

function stageValue(input: unknown, path: string): ProjectFitStage {
  if (input !== "initial" && input !== "schemaChange") {
    throw new Error(`${path} is invalid`);
  }
  return input;
}

function armValue(input: unknown, path: string): ProjectFitArm {
  if (input !== "typeOnly" && input !== "projectContext") {
    throw new Error(`${path} is invalid`);
  }
  return input;
}
