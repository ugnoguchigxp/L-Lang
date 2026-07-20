import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { validatePredicateContext } from "./context-validator";
import {
  parsePredicateExpression,
  type PredicateExpression,
} from "./ir";
import {
  parseElaborationResult,
  type OpenAIRequestInput,
  type OpenAIResult,
} from "./openai";
import { scanSemanticSource, type SemanticSource } from "./semantic-source";

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

type BenchmarkManifest = {
  version: 1;
  name: string;
  trials: number;
  conceptFreeze: string;
  manualTimes: string;
  blindness: {
    oracleAndCasesSentToModel: false;
    conceptsFrozenBeforeFirstModelCall: boolean;
    independentHumanOracleAuthor: boolean;
    note: string;
  };
  thresholds: {
    minimumFirstPassCaseRate: number;
    maximumFalseResolutionRate: number;
    minimumStableCaseRate: number;
    minimumHiddenTestPassRate: number;
    targetManualTimeReduction: number;
  };
  cases: Array<{
    id: string;
    source: string;
    oracle: string;
    tests: string;
    manual?: string;
  }>;
};

type Oracle =
  | { expectedOutcome: "resolved"; body: PredicateExpression }
  | { expectedOutcome: "unresolved"; body: null };

type HiddenCase = {
  name: string;
  input: Record<string, unknown>;
  expected: boolean;
};

type TrialResult = {
  trial: number;
  expectedOutcome: Oracle["expectedOutcome"];
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
  source: SemanticSource;
  oracle: Oracle;
  hiddenCases: HiddenCase[];
  manualPath: string | null;
  sourceLines: number;
  manualLines: number | null;
};

export async function runCrossSchemaBenchmark(
  options: CrossSchemaBenchmarkOptions,
) {
  const manifestPath = resolve(options.manifestPath);
  const manifestDirectory = dirname(manifestPath);
  const manifest = parseManifest(await readJson(manifestPath));
  const freeze = parseConceptFreeze(
    await readJson(resolve(manifestDirectory, manifest.conceptFreeze)),
  );
  const manualTimes = parseManualTimes(
    await readJson(resolve(manifestDirectory, manifest.manualTimes)),
  );
  const prepared = await Promise.all(
    manifest.cases.map((entry) => prepareCase(entry, manifestDirectory)),
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
    expectedOutcome: Oracle["expectedOutcome"];
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
      frozenConcepts: freeze,
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
  directory: string,
): Promise<PreparedCase> {
  const sourcePath = resolve(directory, entry.source);
  const source = await scanSemanticSource(sourcePath);
  const oracleValue = await readJson(resolve(directory, entry.oracle));
  const oracle = parseOracle(oracleValue);
  const hiddenCases = parseHiddenCases(
    await readJson(resolve(directory, entry.tests)),
  );
  const manualPath = entry.manual ? resolve(directory, entry.manual) : null;
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
  freeze: Record<string, string>,
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
    if (freeze[entry.source.concept.id] !== entry.source.concept.hash) {
      throw new Error(`frozen concept hash mismatch: ${entry.source.concept.id}`);
    }
    if (entry.source.tests.acceptSource !== "[]" || entry.source.tests.rejectSource !== "[]") {
      throw new Error(`${entry.id}: benchmark source must not contain oracle cases`);
    }
    if (
      entry.oracle.expectedOutcome === "resolved" &&
      entry.hiddenCases.length === 0
    ) {
      throw new Error(`${entry.id}: resolved oracle requires hidden cases`);
    }
  }
}

function parseManifest(input: unknown): BenchmarkManifest {
  const value = record(input, "benchmark");
  if (
    value.version !== 1 ||
    typeof value.name !== "string" ||
    typeof value.trials !== "number" ||
    !Array.isArray(value.cases)
  ) {
    throw new Error("benchmark manifest is invalid");
  }
  return input as BenchmarkManifest;
}

function parseOracle(input: unknown): Oracle {
  const value = record(input, "oracle");
  if (value.version !== 1) throw new Error("oracle.version must be 1");
  if (value.expectedOutcome === "unresolved" && value.body === null) {
    return { expectedOutcome: "unresolved", body: null };
  }
  if (value.expectedOutcome === "resolved") {
    return {
      expectedOutcome: "resolved",
      body: parsePredicateExpression(value.body, "oracle.body"),
    };
  }
  throw new Error("oracle outcome/body is invalid");
}

function parseHiddenCases(input: unknown): HiddenCase[] {
  const value = record(input, "hidden cases");
  if (value.version !== 1 || !Array.isArray(value.tests)) {
    throw new Error("hidden cases file is invalid");
  }
  return value.tests.map((item, index) => {
    const test = record(item, `hidden cases[${index}]`);
    if (
      typeof test.name !== "string" ||
      typeof test.expected !== "boolean"
    ) {
      throw new Error(`hidden cases[${index}] is invalid`);
    }
    return {
      name: test.name,
      input: record(test.input, `hidden cases[${index}].input`),
      expected: test.expected,
    };
  });
}

function parseConceptFreeze(input: unknown): Record<string, string> {
  const value = record(input, "concept freeze");
  if (value.version !== 1) throw new Error("concept freeze version must be 1");
  const concepts = record(value.concepts, "concept freeze concepts");
  for (const [id, hash] of Object.entries(concepts)) {
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error(`invalid frozen concept hash for ${id}`);
    }
  }
  return concepts as Record<string, string>;
}

function parseManualTimes(input: unknown): Record<string, Record<string, number | null>> {
  const value = record(input, "manual times");
  if (value.version !== 1) throw new Error("manual times version must be 1");
  return record(value.entries, "manual time entries") as Record<
    string,
    Record<string, number | null>
  >;
}

function compareHumanTimes(
  entries: Record<string, Record<string, number | null>>,
  thresholds: BenchmarkManifest["thresholds"],
) {
  const values = Object.values(entries);
  const complete = values.every((entry) =>
    [
      entry.manualAuthoringMs,
      entry.manualReviewMs,
      entry.semanticAuthoringMs,
      entry.semanticReviewMs,
    ].every((value) => typeof value === "number"),
  );
  if (!complete) {
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
  const manualTotalMs = values.reduce(
    (sum, entry) =>
      sum + entry.manualAuthoringMs! + entry.manualReviewMs!,
    0,
  );
  const semanticTotalMs = values.reduce(
    (sum, entry) =>
      sum + entry.semanticAuthoringMs! + entry.semanticReviewMs!,
    0,
  );
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

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
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
