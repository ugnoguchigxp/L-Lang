import { readFile } from "node:fs/promises";

import { atomicWriteJson } from "./atomic-file";
import type { OpenAIResult } from "./openai";
import type { PilotProtocol } from "./pilot-manifest";
import {
  assertKnownKeys,
  parseBoundedJsonText,
  SEMANTIC_LIMITS,
} from "./semantic-limits";

export type CompletedPilotLiveEntry = {
  caseId: string;
  status: "completed";
  response: OpenAIResult;
  latencyMs: number;
};

export type PilotLiveCheckpointEntry =
  | {
      caseId: string;
      status: "pending";
    }
  | CompletedPilotLiveEntry;

export type PilotLiveCheckpoint = {
  version: 1;
  manifestHash: string;
  reviewHash: string;
  model: string;
  provider: string;
  startedAt: string;
  apiAttempts: number;
  cooldownCompletions: number;
  costPerMillionTokens: {
    input: number;
    output: number;
  };
  entries: PilotLiveCheckpointEntry[];
};

export async function loadOrCreatePilotLiveCheckpoint(
  path: string,
  protocol: PilotProtocol,
  metadata: {
    model: string;
    provider: string;
    costPerMillionTokens: { input: number; output: number };
  },
): Promise<PilotLiveCheckpoint> {
  const existing = await readTextIfExists(path);
  if (existing === undefined) {
    const checkpoint: PilotLiveCheckpoint = {
      version: 1,
      manifestHash: protocol.manifestHash,
      reviewHash: protocol.reviewHash,
      model: metadata.model,
      provider: metadata.provider,
      startedAt: new Date().toISOString(),
      apiAttempts: 0,
      cooldownCompletions: 0,
      costPerMillionTokens: metadata.costPerMillionTokens,
      entries: [],
    };
    await atomicWriteJson(path, checkpoint);
    return checkpoint;
  }
  const checkpoint = parsePilotLiveCheckpoint(
    parseBoundedJsonText(existing, "Pilot live checkpoint"),
  );
  if (
    checkpoint.manifestHash !== protocol.manifestHash ||
    checkpoint.reviewHash !== protocol.reviewHash ||
    checkpoint.model !== metadata.model ||
    checkpoint.provider !== metadata.provider ||
    checkpoint.costPerMillionTokens.input !==
      metadata.costPerMillionTokens.input ||
    checkpoint.costPerMillionTokens.output !==
      metadata.costPerMillionTokens.output
  ) {
    throw new Error(
      "Pilot checkpoint metadata does not match the requested run",
    );
  }
  return checkpoint;
}

export function parsePilotLiveCheckpoint(input: unknown): PilotLiveCheckpoint {
  const value = recordValue(input, "Pilot live checkpoint");
  assertExactKeys(
    value,
    [
      "version",
      "manifestHash",
      "reviewHash",
      "model",
      "provider",
      "startedAt",
      "apiAttempts",
      "cooldownCompletions",
      "costPerMillionTokens",
      "entries",
    ],
    "Pilot live checkpoint",
  );
  if (value.version !== 1) {
    throw new Error("Pilot live checkpoint.version must be 1");
  }
  const rates = recordValue(
    value.costPerMillionTokens,
    "Pilot live checkpoint.costPerMillionTokens",
  );
  assertExactKeys(
    rates,
    ["input", "output"],
    "Pilot live checkpoint.costPerMillionTokens",
  );
  if (!Array.isArray(value.entries)) {
    throw new Error("Pilot live checkpoint.entries must be an array");
  }
  const entries = value.entries.map(parseCheckpointEntry);
  if (new Set(entries.map((entry) => entry.caseId)).size !== entries.length) {
    throw new Error("Pilot live checkpoint contains duplicate cases");
  }
  return {
    version: 1,
    manifestHash: hashString(
      value.manifestHash,
      "Pilot live checkpoint.manifestHash",
    ),
    reviewHash: hashString(
      value.reviewHash,
      "Pilot live checkpoint.reviewHash",
    ),
    model: trimmedString(value.model, "Pilot live checkpoint.model"),
    provider: trimmedString(value.provider, "Pilot live checkpoint.provider"),
    startedAt: timestampString(
      value.startedAt,
      "Pilot live checkpoint.startedAt",
    ),
    apiAttempts: nonNegativeInteger(
      value.apiAttempts,
      "Pilot live checkpoint.apiAttempts",
    ),
    cooldownCompletions: nonNegativeInteger(
      value.cooldownCompletions,
      "Pilot live checkpoint.cooldownCompletions",
    ),
    costPerMillionTokens: {
      input: nonNegativeNumber(
        rates.input,
        "Pilot live checkpoint.costPerMillionTokens.input",
      ),
      output: nonNegativeNumber(
        rates.output,
        "Pilot live checkpoint.costPerMillionTokens.output",
      ),
    },
    entries,
  };
}

export function validatePilotLiveScheduledEntries(
  checkpoint: PilotLiveCheckpoint,
  protocol: PilotProtocol,
): void {
  const caseIds = new Set(protocol.manifest.cases.map((entry) => entry.id));
  for (const entry of checkpoint.entries) {
    if (!caseIds.has(entry.caseId)) {
      throw new Error(
        `Pilot checkpoint entry ${entry.caseId} is not scheduled by the manifest`,
      );
    }
  }
  if (checkpoint.cooldownCompletions > checkpoint.apiAttempts) {
    throw new Error("Pilot checkpoint has more cooldowns than API attempts");
  }
}

export function pilotLiveCheckpointCost(
  checkpoint: PilotLiveCheckpoint,
): number {
  return checkpoint.entries
    .filter(
      (entry): entry is CompletedPilotLiveEntry => entry.status === "completed",
    )
    .reduce((total, entry) => {
      const usage = entry.response.usage;
      if (usage === null) return total;
      return (
        total +
        (usage.inputTokens * checkpoint.costPerMillionTokens.input +
          usage.outputTokens * checkpoint.costPerMillionTokens.output) /
          1_000_000
      );
    }, 0);
}

export function assertPilotLiveWallClockBudget(
  checkpoint: PilotLiveCheckpoint,
  protocol: PilotProtocol,
): void {
  if (
    Date.now() - Date.parse(checkpoint.startedAt) >
    protocol.manifest.budget.maxWallClockMs
  ) {
    throw new Error("Pilot wall-clock budget is exhausted");
  }
}

function parseCheckpointEntry(
  input: unknown,
  index: number,
): PilotLiveCheckpointEntry {
  const path = `Pilot live checkpoint.entries[${index}]`;
  const value = recordValue(input, path);
  if (value.status === "pending") {
    assertExactKeys(value, ["caseId", "status"], path);
    return {
      caseId: trimmedString(value.caseId, `${path}.caseId`),
      status: "pending",
    };
  }
  if (value.status !== "completed") {
    throw new Error(`${path}.status must be pending or completed`);
  }
  assertExactKeys(value, ["caseId", "status", "response", "latencyMs"], path);
  return {
    caseId: trimmedString(value.caseId, `${path}.caseId`),
    status: "completed",
    response: parseCheckpointResponse(value.response, `${path}.response`),
    latencyMs: nonNegativeNumber(value.latencyMs, `${path}.latencyMs`),
  };
}

function parseCheckpointResponse(input: unknown, path: string): OpenAIResult {
  const value = recordValue(input, path);
  assertExactKeys(value, ["responseId", "model", "outputText", "usage"], path);
  const usage = recordValue(value.usage, `${path}.usage`);
  assertExactKeys(
    usage,
    ["inputTokens", "outputTokens", "totalTokens"],
    `${path}.usage`,
  );
  return {
    responseId: trimmedString(value.responseId, `${path}.responseId`),
    model: trimmedString(value.model, `${path}.model`),
    outputText: trimmedString(value.outputText, `${path}.outputText`),
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
      throw new Error("Pilot live checkpoint exceeds input budget");
    }
    return text;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
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
  if (missing !== undefined) throw new Error(`${path} is missing ${missing}`);
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

function timestampString(input: unknown, path: string): string {
  const value = trimmedString(input, path);
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${path} must be a valid timestamp`);
  }
  return value;
}

function hashString(input: unknown, path: string): string {
  const value = trimmedString(input, path);
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${path} must be a SHA-256 hash`);
  }
  return value;
}

function nonNegativeInteger(input: unknown, path: string): number {
  if (!Number.isSafeInteger(input) || Number(input) < 0) {
    throw new Error(`${path} must be a non-negative safe integer`);
  }
  return Number(input);
}

function nonNegativeNumber(input: unknown, path: string): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) {
    throw new Error(`${path} must be a non-negative finite number`);
  }
  return input;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
