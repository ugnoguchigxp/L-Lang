import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";

import { resolveContainedFile } from "./contained-path";
import { validatePredicateContext } from "./context-validator";
import {
  type BenchmarkManifest,
  type CrossSchemaConceptFreeze,
  type CrossSchemaHiddenCase,
  type CrossSchemaManualTimes,
  type CrossSchemaOracle,
  parseCrossSchemaConceptFreeze,
  parseCrossSchemaHiddenCases,
  parseCrossSchemaManifest,
  parseCrossSchemaManualTimes,
  parseCrossSchemaOracle,
  readCrossSchemaJson,
  requiredCrossSchemaFreezeFiles,
  validateCrossSchemaProtocolInputs,
  verifyCrossSchemaFileFreeze,
} from "./cross-schema-benchmark-protocol";
import type { PredicateExpression } from "./ir";
import {
  type OpenAIRequestInput,
  type OpenAIResult,
  parseElaborationResult,
} from "./openai";
import {
  type BenchmarkSemanticSource,
  scanBenchmarkSource,
} from "./semantic-source";

export type BenchmarkResolver = (
  input: OpenAIRequestInput,
) => Promise<OpenAIResult>;

export type CrossSchemaBenchmarkOptions = {
  manifestPath: string;
  outputRoot: string;
  model: string;
  provider: string;
  resolve: BenchmarkResolver;
  onProgress?: (message: string) => void;
};

type TrialResult = {
  trial: number;
  expectedOutcome: CrossSchemaOracle["expectedOutcome"];
  actualOutcome: "resolved" | "unresolved" | "error";
  passed: boolean;
  falseResolution: boolean;
  contextValid: boolean | null;
  exactIrMatch: boolean | null;
  hiddenTestsPassed: boolean | null;
  hiddenTestResults: Array<{
    name: string;
    expected: boolean;
    actual: boolean;
    passed: boolean;
  }>;
  diagnostics: string[];
  actualBody: PredicateExpression | null;
  error: string | null;
  signature: string;
  latencyMs: number;
  response: {
    id: string;
    model: string;
    usage: OpenAIResult["usage"];
    outputText: string;
  } | null;
};

type PreparedCase = {
  id: string;
  sourcePath: string;
  source: BenchmarkSemanticSource;
  oracle: CrossSchemaOracle;
  hiddenCases: CrossSchemaHiddenCase[];
  manualPath: string | null;
  sourceLines: number;
  manualLines: number | null;
};

export async function runCrossSchemaBenchmark(
  options: CrossSchemaBenchmarkOptions,
) {
  const requestedManifestPath = resolve(options.manifestPath);
  const manifestPath = await resolveContainedFile(
    dirname(requestedManifestPath),
    basename(requestedManifestPath),
    "cross-schema benchmark manifest",
    {
      containmentLabel: "benchmark directory",
      rejectSymbolicLinks: true,
    },
  );
  const manifestDirectory = dirname(manifestPath);
  const resolveProtocolFile = (path: string, label: string) =>
    resolveContainedFile(manifestDirectory, path, label, {
      containmentLabel: "benchmark directory",
      rejectSymbolicLinks: true,
    });
  const manifest = parseCrossSchemaManifest(
    await readCrossSchemaJson(manifestPath, "cross-schema benchmark manifest"),
  );
  const freezePath = await resolveProtocolFile(
    manifest.conceptFreeze,
    "cross-schema concept freeze",
  );
  const freeze = parseCrossSchemaConceptFreeze(
    await readCrossSchemaJson(freezePath, "cross-schema concept freeze"),
  );
  const manualTimesPath = await resolveProtocolFile(
    manifest.manualTimes,
    "cross-schema manual times",
  );
  const manualTimes = parseCrossSchemaManualTimes(
    await readCrossSchemaJson(manualTimesPath, "cross-schema manual times"),
  );
  validateCrossSchemaProtocolInputs(manifest, manualTimes);
  await verifyCrossSchemaFileFreeze(
    freeze,
    requiredCrossSchemaFreezeFiles(manifestPath, manifest),
    resolveProtocolFile,
  );
  const prepared = await Promise.all(
    manifest.cases.map((entry) =>
      prepareCase(entry, resolveProtocolFile),
    ),
  );
  validateProtocol(manifest, freeze, prepared);

  const runId = `${new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14)}`;
  const runDirectory = resolve(options.outputRoot, `${runId}-${manifest.name}`);
  await mkdir(runDirectory, { recursive: true });
  const startedAt = Date.now();
  const caseReports: Array<{
    id: string;
    conceptId: string;
    conceptHash: string;
    expectedOutcome: CrossSchemaOracle["expectedOutcome"];
    stable: boolean;
    firstPass: boolean;
    sourceLines: number;
    manualLines: number | null;
    trials: TrialResult[];
  }> = [];

  for (const [caseIndex, benchmarkCase] of prepared.entries()) {
    const trials: TrialResult[] = [];
    for (let trial = 1; trial <= manifest.trials; trial += 1) {
      options.onProgress?.(
        `[${caseIndex + 1}/${prepared.length}] ${benchmarkCase.id} trial ${trial}/${manifest.trials}`,
      );
      const result = await runTrial(
        benchmarkCase,
        trial,
        options.model,
        options.resolve,
      );
      trials.push(result);
      await writeJson(
        resolve(runDirectory, "trials", benchmarkCase.id, `${trial}.json`),
        result,
      );
    }
    caseReports.push({
      id: benchmarkCase.id,
      conceptId: benchmarkCase.source.concept.id,
      conceptHash: benchmarkCase.source.concept.hash,
      expectedOutcome: benchmarkCase.oracle.expectedOutcome,
      stable: new Set(trials.map((trial) => trial.signature)).size === 1,
      firstPass: trials[0]?.passed ?? false,
      sourceLines: benchmarkCase.sourceLines,
      manualLines: benchmarkCase.manualLines,
      trials,
    });
  }

  const allTrials = caseReports.flatMap((entry) => entry.trials);
  const resolvedExpected = allTrials.filter(
    (trial) => trial.expectedOutcome === "resolved",
  );
  const ambiguousExpected = allTrials.filter(
    (trial) => trial.expectedOutcome === "unresolved",
  );
  const hiddenTestPassRate = ratio(
    resolvedExpected.filter((trial) => trial.hiddenTestsPassed === true).length,
    resolvedExpected.length,
  );
  const falseResolutionRate = ratio(
    ambiguousExpected.filter((trial) => trial.falseResolution).length,
    ambiguousExpected.length,
  );
  const firstPassCaseRate = ratio(
    caseReports.filter((entry) => entry.firstPass).length,
    caseReports.length,
  );
  const stableCaseRate = ratio(
    caseReports.filter((entry) => entry.stable).length,
    caseReports.length,
  );
  const exactIrRate = ratio(
    resolvedExpected.filter((trial) => trial.exactIrMatch === true).length,
    resolvedExpected.length,
  );
  const resolvedClosureRate = ratio(
    resolvedExpected.filter((trial) => trial.actualOutcome === "resolved").length,
    resolvedExpected.length,
  );
  const totalUsage = sumUsage(allTrials);
  const timeComparison = compareHumanTimes(manualTimes, manifest.thresholds);
  const modelGatePassed =
    firstPassCaseRate >= manifest.thresholds.minimumFirstPassCaseRate &&
    falseResolutionRate <= manifest.thresholds.maximumFalseResolutionRate &&
    stableCaseRate >= manifest.thresholds.minimumStableCaseRate &&
    hiddenTestPassRate >= manifest.thresholds.minimumHiddenTestPassRate;
  const report = {
    version: 1,
    benchmark: manifest.name,
    status: modelGatePassed
      ? timeComparison.status === "pending"
        ? "model-gate-passed-human-time-pending"
        : timeComparison.passed
          ? "passed"
          : "roi-gate-failed"
      : "model-gate-failed",
    provider: options.provider,
    model: options.model,
    lockUsed: false,
    oracleAndCasesSentToModel: false,
    evidenceEligible: freeze.evidenceEligible,
    blindness: manifest.blindness,
    protocol: {
      concepts: new Set(prepared.map((entry) => entry.source.concept.id)).size,
      cases: prepared.length,
      resolvedCases: prepared.filter(
        (entry) => entry.oracle.expectedOutcome === "resolved",
      ).length,
      ambiguousCases: prepared.filter(
        (entry) => entry.oracle.expectedOutcome === "unresolved",
      ).length,
      trialsPerCase: manifest.trials,
      totalTrials: allTrials.length,
      inputFreezeVersion: freeze.version,
      frozenConcepts: freeze.concepts,
    },
    summary: {
      modelGatePassed,
      trialPassRate: ratio(
        allTrials.filter((trial) => trial.passed).length,
        allTrials.length,
      ),
      firstPassCaseRate,
      stableCaseRate,
      resolvedClosureRate,
      falseResolutionRate,
      hiddenTestPassRate,
      exactIrRate,
      totalLatencyMs: allTrials.reduce((sum, trial) => sum + trial.latencyMs, 0),
      averageLatencyMs: Math.round(
        allTrials.reduce((sum, trial) => sum + trial.latencyMs, 0) /
          allTrials.length,
      ),
      usage: totalUsage,
    },
    thresholds: manifest.thresholds,
    humanTimeComparison: timeComparison,
    codeSizeProxy: {
      semanticSourceLines: prepared.reduce(
        (sum, entry) => sum + entry.sourceLines,
        0,
      ),
      manualPredicateLines: prepared.reduce(
        (sum, entry) => sum + (entry.manualLines ?? 0),
        0,
      ),
      note: "Line counts are descriptive only and are not a substitute for measured human authoring and review time.",
    },
    cases: caseReports,
    durationMs: Date.now() - startedAt,
    completedAt: new Date().toISOString(),
  };

  await writeJson(resolve(runDirectory, "report.json"), report);
  await writeFile(
    resolve(runDirectory, "report.md"),
    renderMarkdownReport(report),
    "utf8",
  );
  return { report, runDirectory };
}

async function prepareCase(
  entry: BenchmarkManifest["cases"][number],
  resolveProtocolFile: (path: string, label: string) => Promise<string>,
): Promise<PreparedCase> {
  const sourcePath = await resolveProtocolFile(
    entry.source,
    `cross-schema source ${entry.id}`,
  );
  const source = await scanBenchmarkSource(sourcePath);
  const oraclePath = await resolveProtocolFile(
    entry.oracle,
    `cross-schema oracle ${entry.id}`,
  );
  const oracle = parseCrossSchemaOracle(
    await readCrossSchemaJson(oraclePath, `cross-schema oracle ${entry.id}`),
  );
  const testsPath = await resolveProtocolFile(
    entry.tests,
    `cross-schema hidden cases ${entry.id}`,
  );
  const hiddenCases = parseCrossSchemaHiddenCases(
    await readCrossSchemaJson(
      testsPath,
      `cross-schema hidden cases ${entry.id}`,
    ),
  );
  const manualPath = entry.manual
    ? await resolveProtocolFile(
        entry.manual,
        `cross-schema manual implementation ${entry.id}`,
      )
    : null;
  return {
    id: entry.id,
    sourcePath,
    source,
    oracle,
    hiddenCases,
    manualPath,
    sourceLines: countNonBlankLines(await readFile(sourcePath, "utf8")),
    manualLines:
      manualPath === null
        ? null
        : countNonBlankLines(await readFile(manualPath, "utf8")),
  };
}

async function runTrial(
  benchmarkCase: PreparedCase,
  trial: number,
  model: string,
  resolver: BenchmarkResolver,
): Promise<TrialResult> {
  const startedAt = performance.now();
  try {
    const response = await resolver({
      model,
      specification: benchmarkCase.source.concept.specification,
      typeScriptSource: benchmarkCase.source.concept.typeDeclaration,
      target: {
        functionName: benchmarkCase.source.predicate.name,
        parameterName: benchmarkCase.source.predicate.parameterName,
        typeName: benchmarkCase.source.concept.typeName,
      },
    });
    const elaboration = parseElaborationResult(
      JSON.parse(response.outputText) as unknown,
    );
    const base = {
      trial,
      expectedOutcome: benchmarkCase.oracle.expectedOutcome,
      diagnostics: elaboration.diagnostics,
      error: null,
      latencyMs: Math.round(performance.now() - startedAt),
      response: {
        id: response.responseId,
        model: response.model,
        usage: response.usage,
        outputText: response.outputText,
      },
    };

    if (elaboration.outcome === "unresolved") {
      const passed = benchmarkCase.oracle.expectedOutcome === "unresolved";
      return {
        ...base,
        actualOutcome: "unresolved",
        passed,
        falseResolution: false,
        contextValid: null,
        exactIrMatch: null,
        hiddenTestsPassed: null,
        hiddenTestResults: [],
        actualBody: null,
        signature: stableJson({ outcome: "unresolved" }),
      };
    }

    let contextValid = true;
    let contextError: string | null = null;
    try {
      validatePredicateContext(elaboration.body, benchmarkCase.source);
    } catch (error) {
      contextValid = false;
      contextError = error instanceof Error ? error.message : String(error);
    }
    const hiddenTestResults = benchmarkCase.hiddenCases.map((hiddenCase) => {
      const actual = evaluateExpression(elaboration.body, hiddenCase.input);
      return {
        name: hiddenCase.name,
        expected: hiddenCase.expected,
        actual,
        passed: actual === hiddenCase.expected,
      };
    });
    const hiddenTestsPassed = hiddenTestResults.every((result) => result.passed);
    const exactIrMatch =
      benchmarkCase.oracle.expectedOutcome === "resolved"
        ? expressionSignature(elaboration.body) ===
          expressionSignature(benchmarkCase.oracle.body)
        : null;
    const falseResolution = benchmarkCase.oracle.expectedOutcome === "unresolved";
    return {
      ...base,
      actualOutcome: "resolved",
      passed:
        benchmarkCase.oracle.expectedOutcome === "resolved" &&
        contextValid &&
        hiddenTestsPassed,
      falseResolution,
      contextValid,
      exactIrMatch,
      hiddenTestsPassed,
      hiddenTestResults,
      actualBody: elaboration.body,
      diagnostics: contextError
        ? [...elaboration.diagnostics, contextError]
        : elaboration.diagnostics,
      signature: stableJson({
        outcome: "resolved",
        body: normalizeExpression(elaboration.body),
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      trial,
      expectedOutcome: benchmarkCase.oracle.expectedOutcome,
      actualOutcome: "error",
      passed: false,
      falseResolution: false,
      contextValid: null,
      exactIrMatch: null,
      hiddenTestsPassed: null,
      hiddenTestResults: [],
      diagnostics: [],
      actualBody: null,
      error: message,
      signature: stableJson({ outcome: "error", message }),
      latencyMs: Math.round(performance.now() - startedAt),
      response: null,
    };
  }
}

export function evaluateExpression(
  expression: PredicateExpression,
  input: Record<string, unknown>,
): boolean {
  switch (expression.kind) {
    case "all":
      return expression.conditions.every((condition) =>
        evaluateExpression(condition, input),
      );
    case "any":
      return expression.conditions.some((condition) =>
        evaluateExpression(condition, input),
      );
    case "not":
      return !evaluateExpression(expression.condition, input);
    case "equals":
      return Object.is(readProperty(input, expression.property), expression.value);
    case "present": {
      const value = readProperty(input, expression.property);
      return value !== null && value !== undefined;
    }
  }
}

export function expressionSignature(expression: PredicateExpression): string {
  return stableJson(normalizeExpression(expression));
}

function normalizeExpression(expression: PredicateExpression): PredicateExpression {
  switch (expression.kind) {
    case "all":
    case "any":
      return {
        kind: expression.kind,
        conditions: expression.conditions
          .map(normalizeExpression)
          .sort((left, right) => stableJson(left).localeCompare(stableJson(right))),
      };
    case "not":
      return { kind: "not", condition: normalizeExpression(expression.condition) };
    case "equals":
      return {
        kind: "equals",
        property: [...expression.property],
        value: expression.value,
      };
    case "present":
      return { kind: "present", property: [...expression.property] };
  }
}

function readProperty(input: Record<string, unknown>, path: string[]): unknown {
  let value: unknown = input;
  for (const part of path) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function validateProtocol(
  manifest: BenchmarkManifest,
  freeze: CrossSchemaConceptFreeze,
  cases: PreparedCase[],
): void {
  if (manifest.trials !== 3 || cases.length !== 9) {
    throw new Error("benchmark protocol requires exactly 9 cases and 3 trials");
  }
  const resolved = cases.filter(
    (entry) => entry.oracle.expectedOutcome === "resolved",
  );
  if (resolved.length !== 6 || cases.length - resolved.length !== 3) {
    throw new Error("benchmark protocol requires exactly 6 resolved and 3 ambiguous cases");
  }
  const conceptIds = new Set(cases.map((entry) => entry.source.concept.id));
  if (conceptIds.size !== 3) {
    throw new Error("benchmark protocol requires exactly 3 concepts");
  }
  for (const entry of cases) {
    if (
      freeze.concepts[entry.source.concept.id] !== entry.source.concept.hash
    ) {
      throw new Error(`frozen concept hash mismatch: ${entry.source.concept.id}`);
    }
    if (
      entry.oracle.expectedOutcome === "resolved" &&
      entry.hiddenCases.length === 0
    ) {
      throw new Error(`${entry.id}: resolved oracle requires hidden cases`);
    }
  }
}

function compareHumanTimes(
  entries: CrossSchemaManualTimes,
  thresholds: BenchmarkManifest["thresholds"],
) {
  const values = Object.values(entries);
  let manualTotalMs = 0;
  let semanticTotalMs = 0;
  for (const entry of values) {
    const {
      manualAuthoringMs,
      manualReviewMs,
      semanticAuthoringMs,
      semanticReviewMs,
    } = entry;
    if (
      typeof manualAuthoringMs !== "number" ||
      typeof manualReviewMs !== "number" ||
      typeof semanticAuthoringMs !== "number" ||
      typeof semanticReviewMs !== "number"
    ) {
      return {
        status: "pending" as const,
        passed: null,
        manualTotalMs: null,
        semanticTotalMs: null,
        reduction: null,
        targetReduction: thresholds.targetManualTimeReduction,
        reason: "Human manual and semantic authoring/review times have not been measured; null values are never estimated.",
      };
    }
    manualTotalMs += manualAuthoringMs + manualReviewMs;
    semanticTotalMs += semanticAuthoringMs + semanticReviewMs;
  }
  const reduction = (manualTotalMs - semanticTotalMs) / manualTotalMs;
  return {
    status: "measured" as const,
    passed: reduction >= thresholds.targetManualTimeReduction,
    manualTotalMs,
    semanticTotalMs,
    reduction,
    targetReduction: thresholds.targetManualTimeReduction,
    reason: null,
  };
}

function sumUsage(trials: TrialResult[]) {
  const usage = trials.flatMap((trial) =>
    trial.response?.usage ? [trial.response.usage] : [],
  );
  return {
    inputTokens: usage.reduce((sum, entry) => sum + entry.inputTokens, 0),
    outputTokens: usage.reduce((sum, entry) => sum + entry.outputTokens, 0),
    totalTokens: usage.reduce((sum, entry) => sum + entry.totalTokens, 0),
  };
}

function renderMarkdownReport(report: {
  benchmark: string;
  status: string;
  provider: string;
  model: string;
  summary: Record<string, unknown>;
  humanTimeComparison: { status: string; reason: string | null };
  cases: Array<{
    id: string;
    expectedOutcome: string;
    firstPass: boolean;
    stable: boolean;
    trials: TrialResult[];
  }>;
}): string {
  const summary = report.summary as {
    modelGatePassed: boolean;
    trialPassRate: number;
    firstPassCaseRate: number;
    stableCaseRate: number;
    resolvedClosureRate: number;
    falseResolutionRate: number;
    hiddenTestPassRate: number;
    exactIrRate: number;
    averageLatencyMs: number;
    usage: { totalTokens: number };
  };
  return [
    `# ${report.benchmark}`,
    "",
    `- Status: ${report.status}`,
    `- Provider/model: ${report.provider}/${report.model}`,
    "- Lock used: false",
    "- Oracle/tests sent to model: false",
    `- Model gate: ${summary.modelGatePassed ? "PASS" : "FAIL"}`,
    "",
    "## Metrics",
    "",
    `- Trial pass rate: ${percent(summary.trialPassRate)}`,
    `- First-pass case rate: ${percent(summary.firstPassCaseRate)}`,
    `- Stable case rate: ${percent(summary.stableCaseRate)}`,
    `- Resolved closure rate: ${percent(summary.resolvedClosureRate)}`,
    `- False-resolution rate: ${percent(summary.falseResolutionRate)}`,
    `- Hidden-test pass rate: ${percent(summary.hiddenTestPassRate)}`,
    `- Exact IR rate: ${percent(summary.exactIrRate)}`,
    `- Average API latency: ${summary.averageLatencyMs} ms`,
    `- Total tokens: ${summary.usage.totalTokens}`,
    "",
    "## Cases",
    "",
    "| Case | Expected | First pass | Stable | Trial outcomes |",
    "| --- | --- | --- | --- | --- |",
    ...report.cases.map(
      (entry) =>
        `| ${entry.id} | ${entry.expectedOutcome} | ${entry.firstPass ? "PASS" : "FAIL"} | ${entry.stable ? "yes" : "no"} | ${entry.trials.map((trial) => `${trial.actualOutcome}:${trial.passed ? "pass" : "fail"}`).join(", ")} |`,
    ),
    "",
    "## Human time comparison",
    "",
    report.humanTimeComparison.status === "pending"
      ? `Pending: ${report.humanTimeComparison.reason}`
      : "Measured; see report.json for totals and reduction.",
    "",
  ].join("\n");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function countNonBlankLines(value: string): number {
  return value.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function relativeReportPath(workspaceRoot: string, path: string): string {
  return relative(workspaceRoot, path).replaceAll("\\", "/");
}
