import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";

import { evaluateExpression } from "./cross-schema-benchmark";
import {
  type OpenAIRequestInput,
  type OpenAIResult,
  parseElaborationResult,
} from "./openai";
import { parseProjectContext } from "./project-context";
import {
  assertProjectFitFrozen,
  type ProjectFitArm,
  type ProjectFitProtocol,
  type ProjectFitStage,
  parseProjectFitModelInput,
  parseProjectFitOracle,
  projectFitPerCallOutputTokenLimit,
  projectFitTotalOutputTokenBudget,
  readProjectFitFrozenJson,
  readProjectFitProtocol,
} from "./project-fit-manifest";
import {
  emptyProjectFitStageSummary,
  type ProjectFitReport,
  type ProjectFitStageGate,
  type ProjectFitStageSummary,
  type ProjectFitTrialResult,
  renderProjectFitReport,
  summarizeProjectFitStage,
} from "./project-fit-report";
import {
  assertKnownKeys,
  parseBoundedJsonText,
  SEMANTIC_LIMITS,
} from "./semantic-limits";

export type RunProjectFitLiveOptions = {
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
  onProgress?: (message: string) => void;
  onCheckpoint?: (completedResponses: number) => void | Promise<void>;
  cooldownMs?: number;
  maxRateLimitRetries?: number;
  wait?: (milliseconds: number) => Promise<void>;
};

type CheckpointEntry =
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

type LiveCheckpoint = {
  version: 2;
  manifestHash: string;
  model: string;
  provider: string;
  costPerMillionTokens: {
    input: number;
    output: number;
  };
  entries: CheckpointEntry[];
};

type StageExecution = {
  summary: ProjectFitStageSummary;
  firstPassCases: Record<ProjectFitArm, number>;
};

export async function runProjectFitLive(
  options: RunProjectFitLiveOptions,
): Promise<{ report: ProjectFitReport; reportDirectory: string }> {
  const protocol = await readProjectFitProtocol(options.manifestPath);
  assertProjectFitFrozen(protocol.freeze);
  validateExecutionControls(options);
  const tokenRates = validateTokenRates(options.costPerMillionTokens);
  const totalOutputTokenBudget = projectFitTotalOutputTokenBudget(
    protocol.manifest,
  );
  const perCallOutputTokenLimit = projectFitPerCallOutputTokenLimit(
    protocol.manifest,
  );
  const maximumEstimatedCost = estimatedCost(
    protocol.manifest.budget.maxInputTokens,
    totalOutputTokenBudget,
    tokenRates,
  );
  if (maximumEstimatedCost > protocol.manifest.budget.maxEstimatedCost) {
    throw new Error(
      "Project Fit token budgets can exceed the estimated cost budget",
    );
  }

  const reportDirectory = resolve(
    options.outputRoot ??
      resolve(protocol.directory, "..", "..", ".semantic", "project-fit"),
    `${safeName(protocol.manifest.name)}-live-${protocol.manifestHash.slice(0, 12)}-${liveRunId(options.runId)}`,
  );
  await mkdir(reportDirectory, { recursive: true });
  if (await fileExists(resolve(reportDirectory, "report.json"))) {
    throw new Error("Project Fit run is already complete");
  }
  const checkpointPath = resolve(reportDirectory, "checkpoint.json");
  const checkpoint = await loadOrCreateCheckpoint(
    checkpointPath,
    protocol,
    options,
    tokenRates,
  );
  validateCheckpointEntries(
    checkpoint,
    protocol,
    perCallOutputTokenLimit,
    totalOutputTokenBudget,
  );
  if (checkpoint.entries.some((entry) => entry.status === "pending")) {
    throw new Error(
      "Project Fit checkpoint contains an uncertain pending API call; use a new runId instead of risking a duplicate call",
    );
  }

  const initial = await executeStage({
    stage: "initial",
    protocol,
    reportDirectory,
    checkpointPath,
    checkpoint,
    perCallOutputTokenLimit,
    options,
  });
  const initialGate = evaluateStageGate(
    initial,
    protocol.manifest.thresholds,
  );

  let schemaChange: StageExecution = {
    summary: emptyProjectFitStageSummary(),
    firstPassCases: { typeOnly: 0, projectContext: 0 },
  };
  let schemaChangeGate: ProjectFitStageGate = {
    status: "not-run",
    projectContextFirstPassCases: 0,
    typeOnlyFirstPassCases: 0,
    checks: {},
  };
  if (initialGate.status === "passed") {
    schemaChange = await executeStage({
      stage: "schemaChange",
      protocol,
      reportDirectory,
      checkpointPath,
      checkpoint,
      perCallOutputTokenLimit,
      options,
    });
    schemaChangeGate = evaluateStageGate(
      schemaChange,
      protocol.manifest.thresholds,
    );
  }

  await readProjectFitProtocol(options.manifestPath);
  const stages = {
    initial: initial.summary,
    schemaChange: schemaChange.summary,
  };
  const budget = liveBudgetChecks(
    protocol.manifest.budget.maxEstimatedCost,
    stages,
    tokenRates,
  );
  const falseResolutions = totalAcrossStages(
    stages,
    (summary) => summary.falseResolutions,
  );
  const gateChecks = {
    initialGeneration: initialGate.status === "passed",
    schemaChange: schemaChangeGate.status === "passed",
    estimatedCostBudget: budget.estimatedCostBudget,
    falseResolutionSafety: falseResolutions === 0,
  };
  const gatePassed = Object.values(gateChecks).every(Boolean);
  const report: ProjectFitReport = {
    version: 2,
    benchmark: protocol.manifest.name,
    status: gatePassed ? "passed" : "failed",
    provider: options.provider,
    model: options.model,
    contextVersion: 1,
    authoritativeInput: {
      manifestHash: protocol.manifestHash,
      freezeStatus: protocol.freeze.status,
    },
    stages,
    safety: {
      falseResolutions,
      escapedFalseResolutions: 0,
      contextContamination: 0,
      integrityIncidents: 0,
      workspaceMutations: 0,
    },
    gateC: {
      evidence: "live",
      passed: gatePassed,
      estimatedCost: budget.estimatedCost,
      costPerMillionTokens: tokenRates,
      stages: {
        initial: initialGate,
        schemaChange: schemaChangeGate,
      },
      checks: gateChecks,
    },
  };
  const completed = checkpoint.entries.filter(
    (entry): entry is Extract<CheckpointEntry, { status: "completed" }> =>
      entry.status === "completed",
  );
  await Promise.all([
    atomicWriteJson(resolve(reportDirectory, "report.json"), report),
    atomicWriteText(
      resolve(reportDirectory, "report.md"),
      renderProjectFitReport(report),
    ),
    atomicWriteJson(resolve(reportDirectory, "responses.json"), completed),
  ]);
  return { report, reportDirectory };
}

async function executeStage(input: {
  stage: ProjectFitStage;
  protocol: ProjectFitProtocol;
  reportDirectory: string;
  checkpointPath: string;
  checkpoint: LiveCheckpoint;
  perCallOutputTokenLimit: number;
  options: RunProjectFitLiveOptions;
}): Promise<StageExecution> {
  const trials: Record<ProjectFitArm, ProjectFitTrialResult[]> = {
    typeOnly: [],
    projectContext: [],
  };
  const firstPassCases: Record<ProjectFitArm, number> = {
    typeOnly: 0,
    projectContext: 0,
  };

  for (const benchmarkCase of input.protocol.manifest.cases) {
    const files = benchmarkCase.stages[input.stage];
    const modelInput = parseProjectFitModelInput(
      await readProjectFitFrozenJson(
        input.protocol,
        files.modelInput,
        `Project Fit ${input.stage} model input ${benchmarkCase.id}`,
      ),
      `Project Fit ${input.stage} model input ${benchmarkCase.id}`,
    );
    const projectContext = parseProjectContext(
      await readProjectFitFrozenJson(
        input.protocol,
        files.projectContext,
        `Project Fit ${input.stage} context ${benchmarkCase.id}`,
      ),
      `Project Fit ${input.stage} context ${benchmarkCase.id}`,
    );
    const oracle = parseProjectFitOracle(
      await readProjectFitFrozenJson(
        input.protocol,
        files.oracle,
        `Project Fit ${input.stage} oracle ${benchmarkCase.id}`,
      ),
      `Project Fit ${input.stage} oracle ${benchmarkCase.id}`,
    ).hiddenCases;
    const pending: Record<
      ProjectFitArm,
      Array<{
        elaboration: ReturnType<typeof parseElaborationResult>;
        response: OpenAIResult;
        latencyMs: number;
      }>
    > = { typeOnly: [], projectContext: [] };

    for (let trial = 1; trial <= input.protocol.manifest.trials; trial += 1) {
      for (const arm of ["typeOnly", "projectContext"] as const) {
        const response = await resolveWithCheckpoint({
          stage: input.stage,
          caseId: benchmarkCase.id,
          arm,
          trial,
          modelInput,
          projectContext,
          reportDirectory: input.reportDirectory,
          checkpointPath: input.checkpointPath,
          checkpoint: input.checkpoint,
          perCallOutputTokenLimit: input.perCallOutputTokenLimit,
          totalInputTokenBudget:
            input.protocol.manifest.budget.maxInputTokens,
          totalOutputTokenBudget: projectFitTotalOutputTokenBudget(
            input.protocol.manifest,
          ),
          options: input.options,
        });
        const latencyMs = response.latencyMs;
        const elaboration = parseElaborationResult(
          JSON.parse(response.response.outputText) as unknown,
        );
        pending[arm].push({
          elaboration,
          response: response.response,
          latencyMs,
        });
      }
    }

    for (const arm of ["typeOnly", "projectContext"] as const) {
      const caseTrials = pending[arm].map((pendingTrial) => {
        const expression =
          pendingTrial.elaboration.outcome === "resolved"
            ? pendingTrial.elaboration.body
            : null;
        const hiddenTestsPassed =
          expression !== null &&
          oracle.every(
            (hiddenCase) =>
              evaluateExpression(
                expression,
                hiddenCase.input,
              ) === hiddenCase.expected,
          );
        return {
          outcome: pendingTrial.elaboration.outcome,
          projectGatePassed: hiddenTestsPassed,
          hiddenTestsPassed,
          correctionEffort: hiddenTestsPassed ? 0 : 1,
          inputTokens: pendingTrial.response.usage?.inputTokens ?? 0,
          outputTokens: pendingTrial.response.usage?.outputTokens ?? 0,
          latencyMs: pendingTrial.latencyMs,
        } satisfies ProjectFitTrialResult;
      });
      trials[arm].push(...caseTrials);
      if (
        caseTrials.every(
          (trial) =>
            trial.outcome === "resolved" &&
            trial.projectGatePassed &&
            trial.correctionEffort === 0,
        )
      ) {
        firstPassCases[arm] += 1;
      }
    }
  }

  return {
    summary: summarizeProjectFitStage(trials),
    firstPassCases,
  };
}

async function resolveWithCheckpoint(input: {
  stage: ProjectFitStage;
  caseId: string;
  arm: ProjectFitArm;
  trial: number;
  modelInput: ReturnType<typeof parseProjectFitModelInput>;
  projectContext: ReturnType<typeof parseProjectContext>;
  reportDirectory: string;
  checkpointPath: string;
  checkpoint: LiveCheckpoint;
  perCallOutputTokenLimit: number;
  totalInputTokenBudget: number;
  totalOutputTokenBudget: number;
  options: RunProjectFitLiveOptions;
}): Promise<{ response: OpenAIResult; latencyMs: number }> {
  const key = trialKey(input.stage, input.caseId, input.arm, input.trial);
  const existing = input.checkpoint.entries.find((entry) => entry.key === key);
  if (existing?.status === "completed") {
    validateResponseUsage(existing.response, input.perCallOutputTokenLimit);
    return { response: existing.response, latencyMs: existing.latencyMs };
  }
  if (existing?.status === "pending") {
    throw new Error(
      `Project Fit checkpoint entry ${key} is pending; refusing a duplicate API call`,
    );
  }

  input.options.onProgress?.(
    `${input.stage} ${input.caseId} ${input.arm} trial ${input.trial}`,
  );
  const pending: CheckpointEntry = {
    key,
    stage: input.stage,
    caseId: input.caseId,
    arm: input.arm,
    trial: input.trial,
    status: "pending",
  };
  input.checkpoint.entries.push(pending);
  await atomicWriteJson(input.checkpointPath, input.checkpoint);

  const startedAt = performance.now();
  let response: OpenAIResult;
  try {
    response = await resolveWithRateLimitRetry(input.options, {
      model: input.options.model,
      specification: input.modelInput.intent,
      typeScriptSource: input.modelInput.target.typeScriptSource,
      target: {
        functionName: input.modelInput.target.functionName,
        parameterName: input.modelInput.target.parameterName,
        typeName: input.modelInput.target.typeName,
      },
      ...(input.arm === "projectContext"
        ? { projectContext: input.projectContext }
        : {}),
      maxOutputTokens: input.perCallOutputTokenLimit,
    });
  } catch (error) {
    await writeRunError(input.reportDirectory, {
      key,
      stage: "resolve",
      completedResponses: completedCount(input.checkpoint),
    });
    throw error;
  }
  const latencyMs = performance.now() - startedAt;
  const completed: CheckpointEntry = {
    key,
    stage: input.stage,
    caseId: input.caseId,
    arm: input.arm,
    trial: input.trial,
    status: "completed",
    response,
    latencyMs,
  };
  input.checkpoint.entries[
    input.checkpoint.entries.indexOf(pending)
  ] = completed;
  await atomicWriteJson(input.checkpointPath, input.checkpoint);
  await waitForCooldown(input.options, key, "completed");
  await input.options.onCheckpoint?.(completedCount(input.checkpoint));

  try {
    validateResponseUsage(response, input.perCallOutputTokenLimit);
    validateCompletedResponseBudget(
      input.checkpoint,
      input.totalInputTokenBudget,
      input.totalOutputTokenBudget,
    );
    parseElaborationResult(JSON.parse(response.outputText) as unknown);
  } catch (error) {
    await writeRunError(input.reportDirectory, {
      key,
      stage:
        response.usage === null ||
          response.usage.outputTokens > input.perCallOutputTokenLimit
          ? "budget-validation"
          : "response-validation",
      completedResponses: completedCount(input.checkpoint),
    });
    throw error;
  }
  return { response, latencyMs };
}

async function resolveWithRateLimitRetry(
  options: RunProjectFitLiveOptions,
  request: OpenAIRequestInput,
): Promise<OpenAIResult> {
  const maxRetries = options.maxRateLimitRetries ?? 0;
  let retries = 0;
  for (;;) {
    try {
      return await options.resolve(request);
    } catch (error) {
      const rateLimited = isRateLimitError(error);
      await waitForCooldown(
        options,
        `API attempt ${retries + 1}`,
        rateLimited ? "rate-limited" : "failed",
      );
      if (!rateLimited || retries >= maxRetries) throw error;
      retries += 1;
      options.onProgress?.(
        `rate-limit retry ${retries}/${maxRetries}`,
      );
    }
  }
}

async function waitForCooldown(
  options: RunProjectFitLiveOptions,
  task: string,
  outcome: "completed" | "rate-limited" | "failed",
): Promise<void> {
  const milliseconds = options.cooldownMs ?? 0;
  if (milliseconds === 0) return;
  options.onProgress?.(
    `${task} ${outcome}; cooldown ${milliseconds}ms`,
  );
  await (options.wait ?? defaultWait)(milliseconds);
}

function isRateLimitError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(?:status\s+429\b|\brate[\s-]?limit)/i.test(error.message)
  );
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => {
    setTimeout(resolveWait, milliseconds);
  });
}

function evaluateStageGate(
  execution: StageExecution,
  thresholds: ProjectFitProtocol["manifest"]["thresholds"],
): ProjectFitStageGate {
  const { typeOnly, projectContext } = execution.summary.arms;
  const checks = {
    minimumProjectContextFirstPass:
      execution.firstPassCases.projectContext >=
      thresholds.minProjectContextFirstPassCases,
    minimumFirstPassDelta:
      execution.firstPassCases.projectContext -
        execution.firstPassCases.typeOnly >=
      thresholds.minFirstPassDeltaCases,
    falseResolutionDelta:
      projectContext.falseResolutions - typeOnly.falseResolutions <=
      thresholds.maxFalseResolutionDelta,
    unresolvedRateRegression:
      rate(projectContext.unresolved, projectContext.trials) -
        rate(typeOnly.unresolved, typeOnly.trials) <=
      thresholds.maxUnresolvedRateRegression,
    latencyBudget:
      projectContext.latencyMs - typeOnly.latencyMs <=
      thresholds.maxLatencyDeltaMs,
    projectContextFalseResolutionSafety:
      projectContext.falseResolutions === 0,
  };
  return {
    status: Object.values(checks).every(Boolean) ? "passed" : "failed",
    projectContextFirstPassCases: execution.firstPassCases.projectContext,
    typeOnlyFirstPassCases: execution.firstPassCases.typeOnly,
    checks,
  };
}

function liveBudgetChecks(
  maxEstimatedCost: number,
  stages: Record<ProjectFitStage, ProjectFitStageSummary>,
  rates: { input: number; output: number },
): {
  estimatedCostBudget: boolean;
  estimatedCost: number;
} {
  const inputTokens = totalAcrossStages(
    stages,
    (summary) => summary.inputTokens,
  );
  const outputTokens = totalAcrossStages(
    stages,
    (summary) => summary.outputTokens,
  );
  const cost = estimatedCost(inputTokens, outputTokens, rates);
  return {
    estimatedCostBudget: cost <= maxEstimatedCost,
    estimatedCost: cost,
  };
}

function totalAcrossStages(
  stages: Record<ProjectFitStage, ProjectFitStageSummary>,
  select: (summary: ProjectFitStageSummary["arms"][ProjectFitArm]) => number,
): number {
  return (["initial", "schemaChange"] as const).reduce(
    (total, stage) =>
      total +
      select(stages[stage].arms.typeOnly) +
      select(stages[stage].arms.projectContext),
    0,
  );
}

async function loadOrCreateCheckpoint(
  path: string,
  protocol: ProjectFitProtocol,
  options: RunProjectFitLiveOptions,
  rates: { input: number; output: number },
): Promise<LiveCheckpoint> {
  const existing = await readTextIfExists(path);
  if (existing === undefined) {
    const checkpoint: LiveCheckpoint = {
      version: 2,
      manifestHash: protocol.manifestHash,
      model: options.model,
      provider: options.provider,
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
    checkpoint.model !== options.model ||
    checkpoint.provider !== options.provider ||
    checkpoint.costPerMillionTokens.input !== rates.input ||
    checkpoint.costPerMillionTokens.output !== rates.output
  ) {
    throw new Error(
      "Project Fit checkpoint metadata does not match the requested run",
    );
  }
  return checkpoint;
}

function parseCheckpoint(input: unknown): LiveCheckpoint {
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
    parseCheckpointEntry(entry, index)
  );
  const keys = new Set<string>();
  for (const entry of entries) {
    if (keys.has(entry.key)) {
      throw new Error(`Project Fit checkpoint contains duplicate key ${entry.key}`);
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
    provider: trimmedString(value.provider, "Project Fit checkpoint.provider"),
    costPerMillionTokens: validateTokenRates({
      input: rates.input as number,
      output: rates.output as number,
    }),
    entries,
  };
}

function parseCheckpointEntry(input: unknown, index: number): CheckpointEntry {
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
  if (key !== trialKey(stage, caseId, arm, trial)) {
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

function validateResponseUsage(
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

function validateCheckpointEntries(
  checkpoint: LiveCheckpoint,
  protocol: ProjectFitProtocol,
  perCallOutputTokenLimit: number,
  totalOutputTokenBudget: number,
): void {
  const allowedKeys = new Set(
    protocol.manifest.cases.flatMap((benchmarkCase) =>
      (["initial", "schemaChange"] as const).flatMap((stage) =>
        Array.from({ length: protocol.manifest.trials }, (_, index) =>
          (["typeOnly", "projectContext"] as const).map((arm) =>
            trialKey(stage, benchmarkCase.id, arm, index + 1)
          )
        ).flat()
      )
    ),
  );
  for (const entry of checkpoint.entries) {
    if (!allowedKeys.has(entry.key)) {
      throw new Error(
        `Project Fit checkpoint entry ${entry.key} is not scheduled by the manifest`,
      );
    }
    if (entry.status === "completed") {
      validateResponseUsage(entry.response, perCallOutputTokenLimit);
    }
  }
  validateCompletedResponseBudget(
    checkpoint,
    protocol.manifest.budget.maxInputTokens,
    totalOutputTokenBudget,
  );
}

function validateCompletedResponseBudget(
  checkpoint: LiveCheckpoint,
  maxInputTokens: number,
  maxOutputTokens: number,
): void {
  const usage = checkpoint.entries
    .filter(
      (
        entry,
      ): entry is Extract<CheckpointEntry, { status: "completed" }> =>
        entry.status === "completed",
    )
    .map((entry) => entry.response.usage);
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

function trialKey(
  stage: ProjectFitStage,
  caseId: string,
  arm: ProjectFitArm,
  trial: number,
): string {
  return `${stage}:${caseId}:${arm}:${trial}`;
}

function completedCount(checkpoint: LiveCheckpoint): number {
  return checkpoint.entries.filter((entry) => entry.status === "completed")
    .length;
}

async function writeRunError(
  reportDirectory: string,
  input: {
    key: string;
    stage: "resolve" | "budget-validation" | "response-validation";
    completedResponses: number;
  },
): Promise<void> {
  await atomicWriteJson(resolve(reportDirectory, "run-error.json"), {
    version: 2,
    status: "failed",
    ...input,
  });
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicWriteText(path: string, value: string): Promise<void> {
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  await writeFile(temporary, value, "utf8");
  await rename(temporary, path);
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text) > SEMANTIC_LIMITS.externalJsonBytes) {
      throw new Error("Project Fit checkpoint exceeds input budget");
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

function rate(value: number, total: number): number {
  return total === 0 ? 0 : value / total;
}

function liveRunId(input: string | undefined): string {
  const value =
    input ??
    `${new Date().toISOString().replaceAll(/[^0-9]/g, "")}-${crypto.randomUUID()}`;
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error("Project Fit live runId is invalid");
  }
  return value;
}

function safeName(value: string): string {
  const result = value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (result.length === 0) {
    throw new Error("Project Fit benchmark name is invalid");
  }
  return result;
}

function validateTokenRates(input: {
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

function validateExecutionControls(options: RunProjectFitLiveOptions): void {
  for (const [name, value] of [
    ["cooldownMs", options.cooldownMs ?? 0],
    ["maxRateLimitRetries", options.maxRateLimitRetries ?? 0],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `Project Fit ${name} must be a non-negative safe integer`,
      );
    }
  }
}

function estimatedCost(
  inputTokens: number,
  outputTokens: number,
  rates: { input: number; output: number },
): number {
  return (
    (inputTokens * rates.input + outputTokens * rates.output) /
    1_000_000
  );
}

function recordValue(
  input: unknown,
  path: string,
): Record<string, unknown> {
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
  if (
    typeof input !== "number" ||
    !Number.isFinite(input) ||
    input < 0
  ) {
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
