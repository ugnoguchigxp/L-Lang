import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { type ProjectContext, parseProjectContext } from "./project-context";
import {
  type ProjectFitArm,
  type ProjectFitModelInput,
  type ProjectFitStage,
  parseProjectFitModelInput,
  parseProjectFitOracle,
  projectFitTotalOutputTokenBudget,
  readProjectFitFrozenJson,
  readProjectFitProtocol,
} from "./project-fit-manifest";
import {
  type ProjectFitReport,
  type ProjectFitTrialResult,
  renderProjectFitReport,
  summarizeProjectFitStage,
} from "./project-fit-report";
import { sha256, stableJson } from "./semantic-fingerprint";
import { assertKnownKeys } from "./semantic-limits";

export type ProjectFitResolverInput = {
  version: 2;
  stage: ProjectFitStage;
  arm: ProjectFitArm;
  caseId: string;
  trial: number;
  input: ProjectFitModelInput;
  projectContext?: ProjectContext;
};

export type RunProjectFitFixtureOptions = {
  manifestPath: string;
  reportRoot?: string;
  resolveFixture?: (
    input: ProjectFitResolverInput,
  ) => Promise<ProjectFitTrialResult>;
  onModelInput?: (input: ProjectFitResolverInput) => void;
};

export type RunProjectFitFixtureResult = {
  report: ProjectFitReport;
  reportDirectory: string;
};

export async function runProjectFitFixture(
  options: RunProjectFitFixtureOptions,
): Promise<RunProjectFitFixtureResult> {
  const protocol = await readProjectFitProtocol(options.manifestPath);
  const before = await snapshotFrozenInputs(
    protocol.directory,
    protocol.freeze.files,
  );
  const stageTrials = emptyStageTrials();

  for (const stage of ["initial", "schemaChange"] as const) {
    for (const benchmarkCase of protocol.manifest.cases) {
      const files = benchmarkCase.stages[stage];
      const modelInput = parseProjectFitModelInput(
        await readProjectFitFrozenJson(
          protocol,
          files.modelInput,
          `Project Fit ${stage} model input ${benchmarkCase.id}`,
        ),
        `Project Fit ${stage} model input ${benchmarkCase.id}`,
      );
      const projectContext = parseProjectContext(
        await readProjectFitFrozenJson(
          protocol,
          files.projectContext,
          `Project Fit ${stage} context ${benchmarkCase.id}`,
        ),
        `Project Fit ${stage} context ${benchmarkCase.id}`,
      );
      for (const arm of ["typeOnly", "projectContext"] as const) {
        const fixture = parseFixture(
          await readProjectFitFrozenJson(
            protocol,
            files.fixtures[arm],
            `Project Fit ${stage} ${arm} fixture ${benchmarkCase.id}`,
          ),
          benchmarkCase.id,
          stage,
          arm,
          protocol.manifest.trials,
        );
        for (let trial = 0; trial < fixture.trials.length; trial += 1) {
          const resolverInput: ProjectFitResolverInput = {
            version: 2,
            stage,
            arm,
            caseId: benchmarkCase.id,
            trial: trial + 1,
            input: cloneValue(modelInput),
            ...(arm === "projectContext"
              ? { projectContext: cloneValue(projectContext) }
              : {}),
          };
          options.onModelInput?.(resolverInput);
          const expected = fixture.trials[trial];
          if (expected === undefined) {
            throw new Error(
              `Project Fit fixture ${benchmarkCase.id}.${stage}.${arm} is missing trial ${trial + 1}`,
            );
          }
          const result =
            options.resolveFixture === undefined
              ? expected
              : await options.resolveFixture(resolverInput);
          stageTrials[stage][arm].push(
            parseTrial(result, `${benchmarkCase.id}.${stage}.${arm}[${trial}]`),
          );
        }
      }

      parseProjectFitOracle(
        await readProjectFitFrozenJson(
          protocol,
          files.oracle,
          `Project Fit ${stage} oracle ${benchmarkCase.id}`,
        ),
        `Project Fit ${stage} oracle ${benchmarkCase.id}`,
      );
    }
  }

  enforceBudget(
    {
      maxInputTokens: protocol.manifest.budget.maxInputTokens,
      maxOutputTokens: projectFitTotalOutputTokenBudget(protocol.manifest),
    },
    stageTrials,
  );
  const after = await snapshotFrozenInputs(
    protocol.directory,
    protocol.freeze.files,
  );
  const workspaceMutations = Object.keys(before).filter(
    (file) => before[file] !== after[file],
  ).length;
  if (workspaceMutations > 0) {
    throw new Error("Project Fit fixture mutated frozen benchmark inputs");
  }

  const stages = {
    initial: summarizeProjectFitStage(stageTrials.initial),
    schemaChange: summarizeProjectFitStage(stageTrials.schemaChange),
  };
  const allArms = (["initial", "schemaChange"] as const).flatMap((stage) =>
    Object.values(stages[stage].arms),
  );
  const falseResolutions = allArms.reduce(
    (total, arm) => total + arm.falseResolutions,
    0,
  );
  const errors = allArms.reduce((total, arm) => total + arm.errors, 0);
  const report: ProjectFitReport = {
    version: 2,
    benchmark: protocol.manifest.name,
    status:
      falseResolutions === 0 && errors === 0
        ? "fixture-passed"
        : "fixture-failed",
    provider: "fixture",
    model: "fixture",
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
      workspaceMutations,
    },
  };
  const reportRoot = resolve(
    options.reportRoot ??
      resolve(protocol.directory, "..", "..", ".semantic", "project-fit"),
  );
  const reportDirectory = resolve(
    reportRoot,
    `${safeName(protocol.manifest.name)}-fixture-${protocol.manifestHash.slice(0, 12)}`,
  );
  await mkdir(reportDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      resolve(reportDirectory, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      resolve(reportDirectory, "report.md"),
      renderProjectFitReport(report),
      "utf8",
    ),
  ]);
  return { report, reportDirectory };
}

type Fixture = {
  version: 2;
  trials: ProjectFitTrialResult[];
};

function parseFixture(
  input: unknown,
  caseId: string,
  stage: ProjectFitStage,
  arm: ProjectFitArm,
  trials: number,
): Fixture {
  const path = `Project Fit fixture ${caseId}.${stage}.${arm}`;
  const value = recordValue(input, path);
  assertExactKeys(value, ["version", "trials"], path);
  if (value.version !== 2 || !Array.isArray(value.trials)) {
    throw new Error(`${path} is invalid`);
  }
  if (value.trials.length !== trials) {
    throw new Error(`${path} must contain exactly ${trials} trials`);
  }
  return {
    version: 2,
    trials: value.trials.map((trial, index) =>
      parseTrial(trial, `${path}.trials[${index}]`),
    ),
  };
}

function parseTrial(input: unknown, path: string): ProjectFitTrialResult {
  const value = recordValue(input, path);
  assertExactKeys(
    value,
    [
      "outcome",
      "projectGatePassed",
      "hiddenTestsPassed",
      "correctionEffort",
      "inputTokens",
      "outputTokens",
      "latencyMs",
    ],
    path,
  );
  if (
    value.outcome !== "resolved" &&
    value.outcome !== "unresolved" &&
    value.outcome !== "error"
  ) {
    throw new Error(`${path}.outcome is invalid`);
  }
  if (
    typeof value.projectGatePassed !== "boolean" ||
    typeof value.hiddenTestsPassed !== "boolean"
  ) {
    throw new Error(`${path} boolean results are invalid`);
  }
  return {
    outcome: value.outcome,
    projectGatePassed: value.projectGatePassed,
    hiddenTestsPassed: value.hiddenTestsPassed,
    correctionEffort: nonNegativeNumber(
      value.correctionEffort,
      `${path}.correctionEffort`,
    ),
    inputTokens: nonNegativeInteger(value.inputTokens, `${path}.inputTokens`),
    outputTokens: nonNegativeInteger(
      value.outputTokens,
      `${path}.outputTokens`,
    ),
    latencyMs: nonNegativeNumber(value.latencyMs, `${path}.latencyMs`),
  };
}

function emptyStageTrials(): Record<
  ProjectFitStage,
  Record<ProjectFitArm, ProjectFitTrialResult[]>
> {
  return {
    initial: { typeOnly: [], projectContext: [] },
    schemaChange: { typeOnly: [], projectContext: [] },
  };
}

function enforceBudget(
  budget: {
    maxInputTokens: number;
    maxOutputTokens: number;
  },
  stages: Record<
    ProjectFitStage,
    Record<ProjectFitArm, ProjectFitTrialResult[]>
  >,
): void {
  const all = (["initial", "schemaChange"] as const).flatMap((stage) => [
    ...stages[stage].typeOnly,
    ...stages[stage].projectContext,
  ]);
  const inputTokens = all.reduce(
    (total, trial) => total + trial.inputTokens,
    0,
  );
  const outputTokens = all.reduce(
    (total, trial) => total + trial.outputTokens,
    0,
  );
  if (inputTokens > budget.maxInputTokens) {
    throw new Error("Project Fit fixture exceeded input token budget");
  }
  if (outputTokens > budget.maxOutputTokens) {
    throw new Error("Project Fit fixture exceeded output token budget");
  }
}

async function snapshotFrozenInputs(
  directory: string,
  files: Record<string, string>,
): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      Object.keys(files)
        .sort()
        .map(
          async (file) =>
            [file, sha256(await readFile(resolve(directory, file)))] as const,
        ),
    ),
  );
}

function cloneValue<T>(value: T): T {
  return JSON.parse(stableJson(value)) as T;
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

function nonNegativeInteger(input: unknown, path: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
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

function safeName(value: string): string {
  const result = value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (result.length === 0) {
    throw new Error("Project Fit report name is invalid");
  }
  return result;
}
