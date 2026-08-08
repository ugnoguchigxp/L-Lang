import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { atomicWriteJson, atomicWriteText } from "./atomic-file";
import { validatePredicateContext } from "./context-validator";
import { evaluateExpression } from "./cross-schema-benchmark";
import {
  type OpenAIRequestInput,
  type OpenAIResult,
  parseElaborationResult,
} from "./openai";
import {
  assertPilotLiveWallClockBudget,
  type CompletedPilotLiveEntry,
  loadOrCreatePilotLiveCheckpoint,
  type PilotLiveCheckpoint,
  type PilotLiveCheckpointEntry,
  pilotLiveCheckpointCost,
  validatePilotLiveScheduledEntries,
} from "./pilot-live-checkpoint";
import {
  assertPilotFrozen,
  assertPilotReviewApproved,
  type PilotCase,
  type PilotProtocol,
  readPilotFrozenJson,
  readPilotProtocol,
} from "./pilot-manifest";
import {
  type PilotCaseResult,
  type PilotReport,
  renderPilotReport,
  summarizePilotCases,
} from "./pilot-report";
import { type PilotHiddenCase, parsePilotHiddenCaseSet } from "./pilot-runner";
import { predicateRequestShape, sha256 } from "./semantic-fingerprint";
import { parseBoundedJsonText, SEMANTIC_LIMITS } from "./semantic-limits";
import { scanSemanticSource } from "./semantic-source";

export type RunPilotLiveOptions = {
  manifestPath: string;
  outputRoot?: string;
  runId?: string;
  model: string;
  provider: string;
  costPerMillionTokens: {
    input: number;
    output: number;
  };
  resolve: (input: OpenAIRequestInput) => Promise<OpenAIResult>;
  cooldownMs: 60_000;
  maxRateLimitRetries: number;
  wait?: (milliseconds: number) => Promise<void>;
  onProgress?: (message: string) => void;
  onCheckpoint?: (completedResponses: number) => void | Promise<void>;
};

export async function runPilotLive(
  options: RunPilotLiveOptions,
): Promise<{ report: PilotReport; reportDirectory: string }> {
  const protocol = await readPilotProtocol(options.manifestPath);
  assertPilotFrozen(protocol.freeze);
  assertPilotReviewApproved(protocol.review, protocol.manifest);
  validateLiveOptions(options, protocol);

  const maximumOutputCost =
    (protocol.manifest.cases.length *
      protocol.manifest.budget.maxResponseOutputTokens *
      options.costPerMillionTokens.output) /
    1_000_000;
  if (maximumOutputCost > protocol.manifest.budget.maxEstimatedCost) {
    throw new Error(
      "Pilot maximum response output cost exceeds the estimated cost budget",
    );
  }

  const reportDirectory = resolve(
    options.outputRoot ??
      resolve(protocol.directory, "..", "..", ".semantic", "pilots"),
    `${safeName(protocol.manifest.id)}-live-${protocol.manifestHash.slice(0, 12)}-${liveRunId(options.runId)}`,
  );
  await mkdir(reportDirectory, { recursive: true });
  if (await fileExists(resolve(reportDirectory, "report.json"))) {
    throw new Error("Pilot live run is already complete");
  }
  const checkpointPath = resolve(reportDirectory, "checkpoint.json");
  const checkpoint = await loadOrCreatePilotLiveCheckpoint(
    checkpointPath,
    protocol,
    options,
  );
  validatePilotLiveScheduledEntries(checkpoint, protocol);
  if (checkpoint.entries.some((entry) => entry.status === "pending")) {
    throw new Error(
      "Pilot checkpoint contains an uncertain pending API call; use a new runId instead of risking a duplicate call",
    );
  }

  const before = await snapshotFrozenInputs(protocol);
  const results: PilotCaseResult[] = [];
  for (const pilotCase of protocol.manifest.cases) {
    assertPilotLiveWallClockBudget(checkpoint, protocol);
    const source = await scanSemanticSource(
      resolve(protocol.directory, pilotCase.source),
    );
    const request = predicateRequestShape(source);
    const hiddenCases = parsePilotHiddenCaseSet(
      await readPilotFrozenJson(
        protocol,
        pilotCase.hiddenCases,
        `Pilot hidden cases ${pilotCase.id}`,
      ),
      pilotCase.id,
    );
    const completed = await resolveCase({
      protocol,
      pilotCase,
      checkpoint,
      checkpointPath,
      reportDirectory,
      request,
      options,
    });
    results.push(scoreResponse(pilotCase, source, hiddenCases, completed));
    await options.onCheckpoint?.(
      checkpoint.entries.filter((entry) => entry.status === "completed").length,
    );
  }

  assertPilotLiveWallClockBudget(checkpoint, protocol);
  await readPilotProtocol(options.manifestPath);
  const after = await snapshotFrozenInputs(protocol);
  const workspaceMutations = Object.keys(before).filter(
    (file) => before[file] !== after[file],
  ).length;
  const summary = summarizePilotCases(results);
  const estimatedCost = pilotLiveCheckpointCost(checkpoint);
  const checks = {
    exactCaseCount: summary.total === 8,
    firstPassProjectFit:
      summary.firstPassProjectFitRate >=
      protocol.manifest.thresholds.minFirstPassProjectFitRate,
    unresolvedRate:
      rate(summary.unresolved, summary.total) <=
      protocol.manifest.thresholds.maxUnresolvedRate,
    falseResolutionSafety:
      summary.falseResolutions <=
      protocol.manifest.thresholds.maxFalseResolutions,
    hiddenCaseSafety: results
      .filter((entry) => entry.outcome === "resolved")
      .every((entry) => entry.hiddenCasesPassed === entry.hiddenCases),
    workspaceIntegrity: workspaceMutations === 0,
    shadowMode:
      !protocol.manifest.execution.businessWritesAllowed &&
      !protocol.manifest.execution.externalIoAllowed,
    apiCallBudget:
      checkpoint.apiAttempts <= protocol.manifest.budget.maxApiCalls,
    estimatedCostBudget:
      estimatedCost <= protocol.manifest.budget.maxEstimatedCost,
    cooldownAfterEveryAttempt:
      checkpoint.cooldownCompletions === checkpoint.apiAttempts,
  };
  const passed = Object.values(checks).every(Boolean);
  const report: PilotReport = {
    version: 1,
    pilot: protocol.manifest.id,
    status: passed ? "passed" : "failed",
    mode: "live",
    provider: options.provider,
    model: options.model,
    authoritativeInput: {
      manifestHash: protocol.manifestHash,
      freezeStatus: protocol.freeze.status,
    },
    executionMetrics: {
      apiAttempts: checkpoint.apiAttempts,
      cooldownCompletions: checkpoint.cooldownCompletions,
      estimatedCost,
      costPerMillionTokens: options.costPerMillionTokens,
    },
    cases: results,
    summary,
    safety: {
      escapedFalseResolutions: 0,
      businessWrites: 0,
      externalIo: 0,
      workspaceMutations,
      cooldownViolations:
        checkpoint.apiAttempts - checkpoint.cooldownCompletions,
      confidentialDataIncidents: 0,
    },
    checks,
  };
  const responses = checkpoint.entries.filter(
    (entry): entry is CompletedPilotLiveEntry => entry.status === "completed",
  );
  await Promise.all([
    atomicWriteJson(resolve(reportDirectory, "report.json"), report),
    atomicWriteText(
      resolve(reportDirectory, "report.md"),
      renderPilotReport(report),
    ),
    atomicWriteJson(resolve(reportDirectory, "responses.json"), responses),
  ]);
  return { report, reportDirectory };
}

async function resolveCase(input: {
  protocol: PilotProtocol;
  pilotCase: PilotCase;
  checkpoint: PilotLiveCheckpoint;
  checkpointPath: string;
  reportDirectory: string;
  request: ReturnType<typeof predicateRequestShape>;
  options: RunPilotLiveOptions;
}): Promise<CompletedPilotLiveEntry> {
  const existing = input.checkpoint.entries.find(
    (entry) => entry.caseId === input.pilotCase.id,
  );
  if (existing?.status === "completed") {
    validateResponseUsage(existing.response, input.protocol);
    return existing;
  }
  if (existing?.status === "pending") {
    throw new Error(
      `Pilot checkpoint entry ${input.pilotCase.id} is pending; refusing a duplicate API call`,
    );
  }
  const pending: PilotLiveCheckpointEntry = {
    caseId: input.pilotCase.id,
    status: "pending",
  };
  input.checkpoint.entries.push(pending);
  await atomicWriteJson(input.checkpointPath, input.checkpoint);
  input.options.onProgress?.(`initial ${input.pilotCase.id}`);

  let response: OpenAIResult;
  let latencyMs: number;
  try {
    const resolved = await resolveWithRetry(input, {
      model: input.options.model,
      specification: input.request.specification,
      typeScriptSource: input.request.typeScriptSource,
      target: input.request.target,
      maxOutputTokens: input.protocol.manifest.budget.maxResponseOutputTokens,
    });
    response = resolved.response;
    latencyMs = resolved.latencyMs;
    validateResponseUsage(response, input.protocol);
  } catch (error) {
    await atomicWriteJson(resolve(input.reportDirectory, "run-error.json"), {
      version: 1,
      status: "failed",
      caseId: input.pilotCase.id,
      completedResponses: input.checkpoint.entries.filter(
        (entry) => entry.status === "completed",
      ).length,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  const completed: CompletedPilotLiveEntry = {
    caseId: input.pilotCase.id,
    status: "completed",
    response,
    latencyMs,
  };
  input.checkpoint.entries[input.checkpoint.entries.indexOf(pending)] =
    completed;
  await atomicWriteJson(input.checkpointPath, input.checkpoint);
  if (
    pilotLiveCheckpointCost(input.checkpoint) >
    input.protocol.manifest.budget.maxEstimatedCost
  ) {
    throw new Error("Pilot completed responses exceeded estimated cost budget");
  }
  return completed;
}

async function resolveWithRetry(
  input: Parameters<typeof resolveCase>[0],
  request: OpenAIRequestInput,
): Promise<{ response: OpenAIResult; latencyMs: number }> {
  let retries = 0;
  let latencyMs = 0;
  while (true) {
    assertPilotLiveWallClockBudget(input.checkpoint, input.protocol);
    if (
      input.checkpoint.apiAttempts >= input.protocol.manifest.budget.maxApiCalls
    ) {
      throw new Error("Pilot API call budget is exhausted");
    }
    input.checkpoint.apiAttempts += 1;
    await atomicWriteJson(input.checkpointPath, input.checkpoint);
    const startedAt = performance.now();
    try {
      const response = await input.options.resolve(request);
      latencyMs += performance.now() - startedAt;
      await completeCooldown(input, "completed");
      return { response, latencyMs };
    } catch (error) {
      latencyMs += performance.now() - startedAt;
      const rateLimited = isRateLimitError(error);
      await completeCooldown(input, rateLimited ? "rate-limited" : "failed");
      if (!rateLimited || retries >= input.options.maxRateLimitRetries) {
        throw error;
      }
      retries += 1;
      input.options.onProgress?.(
        `rate-limit retry ${retries}/${input.options.maxRateLimitRetries}`,
      );
    }
  }
}

async function completeCooldown(
  input: Parameters<typeof resolveCase>[0],
  outcome: "completed" | "rate-limited" | "failed",
): Promise<void> {
  const milliseconds =
    input.protocol.manifest.budget.cooldownMsAfterEveryAttempt;
  input.options.onProgress?.(
    `${input.pilotCase.id} ${outcome}; cooldown ${milliseconds}ms`,
  );
  await (input.options.wait ?? defaultWait)(milliseconds);
  input.checkpoint.cooldownCompletions += 1;
  await atomicWriteJson(input.checkpointPath, input.checkpoint);
}

function scoreResponse(
  pilotCase: PilotCase,
  source: Awaited<ReturnType<typeof scanSemanticSource>>,
  hiddenCases: PilotHiddenCase[],
  completed: CompletedPilotLiveEntry,
): PilotCaseResult {
  try {
    const elaboration = parseElaborationResult(
      parseBoundedJsonText(
        completed.response.outputText,
        `Pilot response ${pilotCase.id}`,
      ),
    );
    if (elaboration.outcome === "unresolved") {
      return resultBase(pilotCase, completed, hiddenCases.length, {
        outcome: "unresolved",
        contextValid: null,
        hiddenCasesPassed: 0,
        firstPassProjectFit: false,
        falseResolution: false,
        error: null,
      });
    }
    validatePredicateContext(elaboration.body, source);
    const hiddenCasesPassed = hiddenCases.filter(
      (entry) =>
        evaluateExpression(elaboration.body, entry.input) === entry.expected,
    ).length;
    const passed = hiddenCasesPassed === hiddenCases.length;
    return resultBase(pilotCase, completed, hiddenCases.length, {
      outcome: "resolved",
      contextValid: true,
      hiddenCasesPassed,
      firstPassProjectFit: passed,
      falseResolution: !passed,
      error: null,
    });
  } catch (error) {
    return resultBase(pilotCase, completed, hiddenCases.length, {
      outcome: "error",
      contextValid: false,
      hiddenCasesPassed: 0,
      firstPassProjectFit: false,
      falseResolution: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function resultBase(
  pilotCase: PilotCase,
  completed: CompletedPilotLiveEntry,
  hiddenCases: number,
  result: Pick<
    PilotCaseResult,
    | "outcome"
    | "contextValid"
    | "hiddenCasesPassed"
    | "firstPassProjectFit"
    | "falseResolution"
    | "error"
  >,
): PilotCaseResult {
  return {
    id: pilotCase.id,
    domain: pilotCase.domain,
    ...result,
    hiddenCases,
    correctionEffort: 0,
    inputTokens: completed.response.usage?.inputTokens ?? 0,
    outputTokens: completed.response.usage?.outputTokens ?? 0,
    latencyMs: completed.latencyMs,
    baselineWorkMs: 0,
    semanticWorkMs: completed.latencyMs,
  };
}

function validateLiveOptions(
  options: RunPilotLiveOptions,
  protocol: PilotProtocol,
): void {
  if (
    options.cooldownMs !== protocol.manifest.budget.cooldownMsAfterEveryAttempt
  ) {
    throw new Error("Pilot live cooldown must match the frozen 60000ms policy");
  }
  if (
    !Number.isSafeInteger(options.maxRateLimitRetries) ||
    options.maxRateLimitRetries < 0
  ) {
    throw new Error("Pilot rate-limit retries must be a non-negative integer");
  }
  validateRates(options.costPerMillionTokens);
}

function validateResponseUsage(
  response: OpenAIResult,
  protocol: PilotProtocol,
): void {
  if (response.usage === null) {
    throw new Error("Pilot response usage is required for live evidence");
  }
  if (
    response.usage.outputTokens >
    protocol.manifest.budget.maxResponseOutputTokens
  ) {
    throw new Error("Pilot response exceeded the per-call output token limit");
  }
}

function validateRates(rates: RunPilotLiveOptions["costPerMillionTokens"]) {
  for (const [name, value] of Object.entries(rates)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Pilot ${name} token rate must be non-negative`);
    }
  }
}

async function snapshotFrozenInputs(
  protocol: PilotProtocol,
): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      Object.keys(protocol.freeze.files).map(async (file) => [
        file,
        sha256(await readFile(resolve(protocol.directory, file))),
      ]),
    ),
  );
}

function isRateLimitError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(?:status\s+429\b|\brate[\s-]?limit)/iu.test(error.message)
  );
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((done) => setTimeout(done, milliseconds));
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text) > SEMANTIC_LIMITS.externalJsonBytes) {
      throw new Error("Pilot live checkpoint exceeds input budget");
    }
    return text;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  return (await readTextIfExists(path)) !== undefined;
}

function liveRunId(input: string | undefined): string {
  const value =
    input ??
    `${new Date().toISOString().replaceAll(/[^0-9]/gu, "")}-${crypto.randomUUID()}`;
  if (!/^[A-Za-z0-9._-]+$/u.test(value)) {
    throw new Error("Pilot live runId is invalid");
  }
  return value;
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "-");
}

function rate(value: number, total: number): number {
  return total === 0 ? 0 : value / total;
}
