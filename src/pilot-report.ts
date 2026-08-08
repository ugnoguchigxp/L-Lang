export type PilotCaseResult = {
  id: string;
  domain: string;
  outcome: "resolved" | "unresolved" | "error";
  contextValid: boolean | null;
  hiddenCases: number;
  hiddenCasesPassed: number;
  firstPassProjectFit: boolean;
  falseResolution: boolean;
  correctionEffort: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  baselineWorkMs: number;
  semanticWorkMs: number;
  error: string | null;
};

export type PilotReport = {
  version: 1;
  pilot: string;
  status: "fixture-passed" | "fixture-failed" | "passed" | "failed";
  mode: "fixture" | "live";
  provider: string;
  model: string;
  authoritativeInput: {
    manifestHash: string;
    freezeStatus: "draft" | "frozen" | "completed";
  };
  executionMetrics: {
    apiAttempts: number;
    cooldownCompletions: number;
    estimatedCost: number;
    costPerMillionTokens: {
      input: number;
      output: number;
    };
  };
  cases: PilotCaseResult[];
  summary: {
    total: number;
    resolved: number;
    unresolved: number;
    errors: number;
    firstPassProjectFit: number;
    firstPassProjectFitRate: number;
    falseResolutions: number;
    hiddenCases: number;
    hiddenCasesPassed: number;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    baselineWorkMs: number;
    semanticWorkMs: number;
  };
  safety: {
    escapedFalseResolutions: number;
    businessWrites: number;
    externalIo: number;
    workspaceMutations: number;
    cooldownViolations: number;
    confidentialDataIncidents: number;
  };
  checks: Record<string, boolean>;
};

export function summarizePilotCases(
  cases: readonly PilotCaseResult[],
): PilotReport["summary"] {
  const total = cases.length;
  const firstPassProjectFit = cases.filter(
    (entry) => entry.firstPassProjectFit,
  ).length;
  return {
    total,
    resolved: cases.filter((entry) => entry.outcome === "resolved").length,
    unresolved: cases.filter((entry) => entry.outcome === "unresolved").length,
    errors: cases.filter((entry) => entry.outcome === "error").length,
    firstPassProjectFit,
    firstPassProjectFitRate: total === 0 ? 0 : firstPassProjectFit / total,
    falseResolutions: cases.filter((entry) => entry.falseResolution).length,
    hiddenCases: sum(cases.map((entry) => entry.hiddenCases)),
    hiddenCasesPassed: sum(cases.map((entry) => entry.hiddenCasesPassed)),
    inputTokens: sum(cases.map((entry) => entry.inputTokens)),
    outputTokens: sum(cases.map((entry) => entry.outputTokens)),
    latencyMs: sum(cases.map((entry) => entry.latencyMs)),
    baselineWorkMs: sum(cases.map((entry) => entry.baselineWorkMs)),
    semanticWorkMs: sum(cases.map((entry) => entry.semanticWorkMs)),
  };
}

export function renderPilotReport(report: PilotReport): string {
  const rows = report.cases.map(
    (entry) =>
      `| ${entry.id} | ${entry.domain} | ${entry.outcome} | ${entry.firstPassProjectFit} | ${entry.hiddenCasesPassed}/${entry.hiddenCases} | ${entry.falseResolution} | ${entry.correctionEffort} | ${entry.latencyMs} |`,
  );
  return [
    `# ${report.pilot}`,
    "",
    `- Status: ${report.status}`,
    `- Mode: ${report.mode}`,
    `- Freeze: ${report.authoritativeInput.freezeStatus}`,
    `- Provider/model: ${report.provider}/${report.model}`,
    `- Manifest SHA-256: ${report.authoritativeInput.manifestHash}`,
    `- API attempts: ${report.executionMetrics.apiAttempts}`,
    `- Cooldowns completed: ${report.executionMetrics.cooldownCompletions}`,
    `- Estimated cost: ${report.executionMetrics.estimatedCost}`,
    "",
    "| Case | Domain | Outcome | First-pass fit | Hidden cases | False resolution | Correction | Latency ms |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    "## Summary",
    "",
    `- First-pass project fit: ${report.summary.firstPassProjectFit}/${report.summary.total}`,
    `- Resolved: ${report.summary.resolved}`,
    `- Unresolved: ${report.summary.unresolved}`,
    `- Errors: ${report.summary.errors}`,
    `- False resolutions: ${report.summary.falseResolutions}`,
    `- Hidden cases: ${report.summary.hiddenCasesPassed}/${report.summary.hiddenCases}`,
    `- Input tokens: ${report.summary.inputTokens}`,
    `- Output tokens: ${report.summary.outputTokens}`,
    `- Latency ms: ${report.summary.latencyMs}`,
    `- Baseline work ms: ${report.summary.baselineWorkMs}`,
    `- Semantic work ms: ${report.summary.semanticWorkMs}`,
    "",
    "## Safety",
    "",
    `- Escaped false resolutions: ${report.safety.escapedFalseResolutions}`,
    `- Business writes: ${report.safety.businessWrites}`,
    `- External I/O: ${report.safety.externalIo}`,
    `- Workspace mutations: ${report.safety.workspaceMutations}`,
    `- Cooldown violations: ${report.safety.cooldownViolations}`,
    `- Confidential data incidents: ${report.safety.confidentialDataIncidents}`,
    ...Object.entries(report.checks).map(
      ([check, passed]) => `- ${check}: ${passed}`,
    ),
    "",
  ].join("\n");
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
