import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { evaluateExpression } from "./cross-schema-benchmark";
import {
  type OpenAIRequestInput,
  type OpenAIResult,
  parseElaborationResult,
} from "./openai";
import { parseProjectContext } from "./project-context";
import {
  atomicWriteJson,
  atomicWriteText,
  completedProjectFitResponseCount,
  loadOrCreateProjectFitCheckpoint,
  projectFitFileExists,
  projectFitTrialKey,
  type ProjectFitCheckpointEntry,
  type ProjectFitLiveCheckpoint,
  validateProjectFitCheckpointEntries,
  validateProjectFitCompletedResponseBudget,
  validateProjectFitResponseUsage,
  validateProjectFitTokenRates,
} from "./project-fit-live-checkpoint";
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
  const tokenRates = validateProjectFitTokenRates(options.costPerMillionTokens);
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
  if (await projectFitFileExists(resolve(reportDirectory, "report.json"))) {
    throw new Error("Project Fit run is already complete");
  }
  const checkpointPath = resolve(reportDirectory, "checkpoint.json");
  const checkpoint = await loadOrCreateProjectFitCheckpoint(
    checkpointPath,
    protocol,
    options,
    tokenRates,
  );
  validateProjectFitCheckpointEntries(
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
  const initialGate = evaluateStageGate(initial, protocol.manifest.thresholds);

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
    (
      entry,
    ): entry is Extract<ProjectFitCheckpointEntry, { status: "completed" }> =>
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
  checkpoint: ProjectFitLiveCheckpoint;
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
          totalInputTokenBudget: input.protocol.manifest.budget.maxInputTokens,
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
              evaluateExpression(expression, hiddenCase.input) ===
              hiddenCase.expected,
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
  checkpoint: ProjectFitLiveCheckpoint;
  perCallOutputTokenLimit: number;
  totalInputTokenBudget: number;
  totalOutputTokenBudget: number;
  options: RunProjectFitLiveOptions;
}): Promise<{ response: OpenAIResult; latencyMs: number }> {
  const key = projectFitTrialKey(
    input.stage,
    input.caseId,
    input.arm,
    input.trial,
  );
  const existing = input.checkpoint.entries.find((entry) => entry.key === key);
  if (existing?.status === "completed") {
    validateProjectFitResponseUsage(
      existing.response,
      input.perCallOutputTokenLimit,
    );
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
  const pending: ProjectFitCheckpointEntry = {
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
      completedResponses: completedProjectFitResponseCount(input.checkpoint),
    });
    throw error;
  }
  const latencyMs = performance.now() - startedAt;
  const completed: ProjectFitCheckpointEntry = {
    key,
    stage: input.stage,
    caseId: input.caseId,
    arm: input.arm,
    trial: input.trial,
    status: "completed",
    response,
    latencyMs,
  };
  input.checkpoint.entries[input.checkpoint.entries.indexOf(pending)] =
    completed;
  await atomicWriteJson(input.checkpointPath, input.checkpoint);
  await waitForCooldown(input.options, key, "completed");
  await input.options.onCheckpoint?.(
    completedProjectFitResponseCount(input.checkpoint),
  );

  try {
    validateProjectFitResponseUsage(response, input.perCallOutputTokenLimit);
    validateProjectFitCompletedResponseBudget(
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
      completedResponses: completedProjectFitResponseCount(input.checkpoint),
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
      options.onProgress?.(`rate-limit retry ${retries}/${maxRetries}`);
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
  options.onProgress?.(`${task} ${outcome}; cooldown ${milliseconds}ms`);
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
    projectContextFalseResolutionSafety: projectContext.falseResolutions === 0,
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
  return (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
}
