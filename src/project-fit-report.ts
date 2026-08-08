import type {
  ProjectFitArm,
  ProjectFitStage,
} from "./project-fit-manifest";

export type ProjectFitTrialResult = {
  outcome: "resolved" | "unresolved" | "error";
  projectGatePassed: boolean;
  hiddenTestsPassed: boolean;
  correctionEffort: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
};

export type ProjectFitArmSummary = {
  trials: number;
  resolved: number;
  unresolved: number;
  errors: number;
  firstPassProjectFit: number;
  falseResolutions: number;
  medianCorrectionEffort: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
};

export type ProjectFitStageSummary = {
  arms: Record<ProjectFitArm, ProjectFitArmSummary>;
  comparison: {
    firstPassDelta: number;
    unresolvedRateDelta: number;
    medianCorrectionEffortDelta: number;
    inputTokenDelta: number;
    latencyDeltaMs: number;
  };
};

export type ProjectFitStageGate = {
  status: "passed" | "failed" | "not-run";
  projectContextFirstPassCases: number;
  typeOnlyFirstPassCases: number;
  checks: Record<string, boolean>;
};

export type ProjectFitReport = {
  version: 2;
  benchmark: string;
  status: "fixture-passed" | "fixture-failed" | "passed" | "failed";
  provider: string;
  model: string;
  contextVersion: 1;
  authoritativeInput: {
    manifestHash: string;
    freezeStatus: "draft" | "frozen";
  };
  stages: Record<ProjectFitStage, ProjectFitStageSummary>;
  safety: {
    falseResolutions: number;
    escapedFalseResolutions: number;
    contextContamination: number;
    integrityIncidents: number;
    workspaceMutations: number;
  };
  gateC?: {
    evidence: "live";
    passed: boolean;
    estimatedCost: number;
    costPerMillionTokens: {
      input: number;
      output: number;
    };
    stages: Record<ProjectFitStage, ProjectFitStageGate>;
    checks: Record<string, boolean>;
  };
};

export function summarizeProjectFitArm(
  trials: readonly ProjectFitTrialResult[],
): ProjectFitArmSummary {
  const correction = trials
    .map((trial) => trial.correctionEffort)
    .sort((left, right) => left - right);
  return {
    trials: trials.length,
    resolved: trials.filter((trial) => trial.outcome === "resolved").length,
    unresolved: trials.filter((trial) => trial.outcome === "unresolved").length,
    errors: trials.filter((trial) => trial.outcome === "error").length,
    firstPassProjectFit: trials.filter(
      (trial) =>
        trial.outcome === "resolved" &&
        trial.projectGatePassed &&
        trial.correctionEffort === 0,
    ).length,
    falseResolutions: trials.filter(
      (trial) => trial.outcome === "resolved" && !trial.hiddenTestsPassed,
    ).length,
    medianCorrectionEffort: median(correction),
    inputTokens: sum(trials.map((trial) => trial.inputTokens)),
    outputTokens: sum(trials.map((trial) => trial.outputTokens)),
    latencyMs: sum(trials.map((trial) => trial.latencyMs)),
  };
}

export function summarizeProjectFitStage(
  trials: Record<ProjectFitArm, readonly ProjectFitTrialResult[]>,
): ProjectFitStageSummary {
  const typeOnly = summarizeProjectFitArm(trials.typeOnly);
  const projectContext = summarizeProjectFitArm(trials.projectContext);
  return {
    arms: { typeOnly, projectContext },
    comparison: {
      firstPassDelta:
        projectContext.firstPassProjectFit - typeOnly.firstPassProjectFit,
      unresolvedRateDelta:
        rate(projectContext.unresolved, projectContext.trials) -
        rate(typeOnly.unresolved, typeOnly.trials),
      medianCorrectionEffortDelta:
        projectContext.medianCorrectionEffort -
        typeOnly.medianCorrectionEffort,
      inputTokenDelta: projectContext.inputTokens - typeOnly.inputTokens,
      latencyDeltaMs: projectContext.latencyMs - typeOnly.latencyMs,
    },
  };
}

export function emptyProjectFitStageSummary(): ProjectFitStageSummary {
  return summarizeProjectFitStage({ typeOnly: [], projectContext: [] });
}

export function renderProjectFitReport(report: ProjectFitReport): string {
  const sections = (["initial", "schemaChange"] as const).flatMap((stage) => {
    const summary = report.stages[stage];
    const rows = (["typeOnly", "projectContext"] as const).map((arm) => {
      const value = summary.arms[arm];
      return `| ${arm} | ${value.firstPassProjectFit}/${value.trials} | ${value.unresolved} | ${value.falseResolutions} | ${value.medianCorrectionEffort} | ${value.inputTokens} | ${value.outputTokens} | ${value.latencyMs} |`;
    });
    const gate = report.gateC?.stages[stage];
    return [
      `## ${stage === "initial" ? "Initial generation" : "Schema change"}`,
      "",
      "| Arm | First-pass fit | Unresolved | False resolutions | Median correction | Input tokens | Output tokens | Latency ms |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...rows,
      "",
      `- First-pass delta: ${summary.comparison.firstPassDelta}`,
      `- Unresolved-rate delta: ${summary.comparison.unresolvedRateDelta}`,
      `- Median correction delta: ${summary.comparison.medianCorrectionEffortDelta}`,
      `- Input-token delta: ${summary.comparison.inputTokenDelta}`,
      `- Latency delta ms: ${summary.comparison.latencyDeltaMs}`,
      ...(gate === undefined
        ? []
        : [
            `- Gate status: ${gate.status}`,
            ...Object.entries(gate.checks).map(
              ([check, passed]) => `- ${check}: ${passed}`,
            ),
          ]),
      "",
    ];
  });
  return [
    `# ${report.benchmark}`,
    "",
    `- Status: ${report.status}`,
    `- Freeze: ${report.authoritativeInput.freezeStatus}`,
    `- Provider/model: ${report.provider}/${report.model}`,
    `- Context version: ${report.contextVersion}`,
    `- Manifest SHA-256: ${report.authoritativeInput.manifestHash}`,
    "",
    ...sections,
    "## Safety",
    "",
    `- False resolutions: ${report.safety.falseResolutions}`,
    `- Workspace mutations: ${report.safety.workspaceMutations}`,
    `- Context contamination: ${report.safety.contextContamination}`,
    `- Integrity incidents: ${report.safety.integrityIncidents}`,
    ...(report.gateC === undefined
      ? []
      : [
          `- Gate C passed: ${report.gateC.passed}`,
          `- Estimated cost: ${report.gateC.estimatedCost}`,
          ...Object.entries(report.gateC.checks).map(
            ([check, passed]) => `- ${check}: ${passed}`,
          ),
        ]),
    "",
  ].join("\n");
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const middle = Math.floor(values.length / 2);
  const upper = values[middle] ?? 0;
  return values.length % 2 === 0
    ? ((values[middle - 1] ?? 0) + upper) / 2
    : upper;
}

function rate(value: number, total: number): number {
  return total === 0 ? 0 : value / total;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
