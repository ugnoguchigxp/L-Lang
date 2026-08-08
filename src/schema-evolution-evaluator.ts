import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { validatePredicateContext } from "./context-validator";
import {
  evaluateExpression,
  expressionSignature,
} from "./cross-schema-benchmark";
import type { PredicateExpression } from "./ir";
import {
  parseElaborationResult,
  type OpenAIRequestInput,
  type OpenAIResult,
} from "./openai";
import {
  classifySemanticChange,
  type SemanticChangeClassification,
  type SemanticDiff,
} from "./semantic-diff";
import {
  comparePredicatesOnType,
  predicateSemanticSignature,
  type PredicateEquivalenceRelation,
} from "./predicate-equivalence";
import {
  selectConsensusVotes,
  type ConsensusSelection,
} from "./schema-evolution-consensus";
import {
  assertFrozenInputs,
  prepareSchemaEvolutionCases,
  readSchemaEvolutionProtocol,
  type PreparedSchemaEvolutionCase,
  type SchemaEvolutionChangeType,
  type SchemaEvolutionOracle,
  validateSchemaEvolutionProtocol,
  verifySchemaEvolutionFreeze,
} from "./schema-evolution-protocol";

export {
  assertFrozenInputs,
  verifyFrozenFileHashes,
  verifySchemaEvolutionFreeze,
} from "./schema-evolution-protocol";
export { relativeSchemaEvolutionReportPath } from "./schema-evolution-protocol";

export type SchemaEvolutionBenchmarkResolver = (
  input: OpenAIRequestInput,
) => Promise<OpenAIResult>;

export type MaterializedSchemaEvolutionOptions = {
  manifestPath: string;
  workspaceRoot?: string;
  outputRoot: string;
  provider: string;
  model: string;
  resolve: SchemaEvolutionBenchmarkResolver;
  requireFrozenInputs?: boolean;
  parallelTrials?: boolean;
  onProgress?: (message: string) => void;
};

type TrialResult = {
  trial: number;
  expectedOutcome: SchemaEvolutionOracle["expectedOutcome"];
  actualOutcome: "resolved" | "unresolved" | "error";
  expectedClassification: SemanticChangeClassification;
  actualClassification: SemanticChangeClassification | "error";
  passed: boolean;
  outcomeCorrect: boolean;
  classificationCorrect: boolean;
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
  actualBody: PredicateExpression | null;
  diff: SemanticDiff | null;
  diagnostics: string[];
  error: string | null;
  signature: string;
  latencyMs: number;
  modelInput: OpenAIRequestInput;
  response: {
    id: string;
    model: string;
    usage: OpenAIResult["usage"];
    outputText: string;
  } | null;
};

type ConsensusCaseResult = {
  selection: ConsensusSelection;
  selectedTrial: number | null;
  selectedOutcome: "resolved" | "unresolved" | null;
  relationToOracle: PredicateEquivalenceRelation | null;
  hiddenTestsPassed: boolean | null;
  outcomeCorrect: boolean;
  semanticMatch: boolean;
  falseResolution: boolean;
  passed: boolean;
};

export async function evaluateMaterializedSchemaEvolution(
  options: MaterializedSchemaEvolutionOptions,
) {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const { directory, manifest, freeze } = await readSchemaEvolutionProtocol(
    options.manifestPath,
  );
  await verifySchemaEvolutionFreeze(directory, manifest, freeze);
  if (options.requireFrozenInputs ?? true) assertFrozenInputs(freeze);

  const prepared = await prepareSchemaEvolutionCases(manifest, directory);
  validateSchemaEvolutionProtocol(manifest, prepared);
  const beforeArtifacts = await snapshotWorkspaceArtifacts(workspaceRoot);
  const runId = `${new Date()
    .toISOString()
    .replaceAll(/[-:.TZ]/g, "")
    .slice(0, 14)}`;
  const runDirectory = resolve(options.outputRoot, `${runId}-${manifest.name}`);
  await mkdir(runDirectory, { recursive: true });
  const startedAt = Date.now();
  const caseReports: Array<{
    id: string;
    conceptId: string;
    changeType: SchemaEvolutionChangeType;
    expectedOutcome: SchemaEvolutionOracle["expectedOutcome"];
    expectedClassification: SemanticChangeClassification;
    firstPass: boolean;
    stable: boolean;
    consensus: ConsensusCaseResult;
    trials: TrialResult[];
  }> = [];

  for (const [caseIndex, benchmarkCase] of prepared.entries()) {
    const runOne = async (trial: number) => {
      options.onProgress?.(
        `[${caseIndex + 1}/${prepared.length}] ${benchmarkCase.id} trial ${trial}/${manifest.trials}`,
      );
      const result = await runTrial(
        benchmarkCase,
        trial,
        options.model,
        options.resolve,
      );
      await writeJson(
        resolve(runDirectory, "trials", benchmarkCase.id, `${trial}.json`),
        result,
      );
      return result;
    };
    const parallel =
      options.parallelTrials ?? manifest.evaluation?.parallel ?? false;
    const trials = parallel
      ? await Promise.all(
          Array.from({ length: manifest.trials }, (_, index) =>
            runOne(index + 1),
          ),
        )
      : await runSequentially(manifest.trials, runOne);
    const consensus = evaluateCaseConsensus(
      benchmarkCase,
      trials,
      manifest.evaluation?.quorum ?? 2,
    );
    caseReports.push({
      id: benchmarkCase.id,
      conceptId: benchmarkCase.conceptId,
      changeType: benchmarkCase.changeType,
      expectedOutcome: benchmarkCase.oracle.expectedOutcome,
      expectedClassification: benchmarkCase.oracle.expectedClassification,
      firstPass: trials[0]?.passed ?? false,
      stable: new Set(trials.map((trial) => trial.signature)).size === 1,
      consensus,
      trials,
    });
  }

  const afterArtifacts = await snapshotWorkspaceArtifacts(workspaceRoot);
  const workspaceMutations = compareSnapshots(beforeArtifacts, afterArtifacts);
  const allTrials = caseReports.flatMap((entry) => entry.trials);
  const resolvedExpected = allTrials.filter(
    (trial) => trial.expectedOutcome === "resolved",
  );
  const unresolvedExpected = allTrials.filter(
    (trial) => trial.expectedOutcome === "unresolved",
  );
  const summary = {
    trialPassRate: ratio(
      allTrials.filter((trial) => trial.passed).length,
      allTrials.length,
    ),
    firstPassCaseRate: ratio(
      caseReports.filter((entry) => entry.firstPass).length,
      caseReports.length,
    ),
    stableCaseRate: ratio(
      caseReports.filter((entry) => entry.stable).length,
      caseReports.length,
    ),
    outcomeAccuracy: ratio(
      allTrials.filter((trial) => trial.outcomeCorrect).length,
      allTrials.length,
    ),
    classificationAccuracy: ratio(
      allTrials.filter((trial) => trial.classificationCorrect).length,
      allTrials.length,
    ),
    exactIrRate: ratio(
      resolvedExpected.filter((trial) => trial.exactIrMatch === true).length,
      resolvedExpected.length,
    ),
    hiddenTestPassRate: ratio(
      resolvedExpected.filter((trial) => trial.hiddenTestsPassed === true)
        .length,
      resolvedExpected.length,
    ),
    falseResolutionRate: ratio(
      unresolvedExpected.filter((trial) => trial.falseResolution).length,
      unresolvedExpected.length,
    ),
    consensusCasePassRate: ratio(
      caseReports.filter((entry) => entry.consensus.passed).length,
      caseReports.length,
    ),
    consensusQuorumRate: ratio(
      caseReports.filter((entry) => entry.consensus.selection.reached).length,
      caseReports.length,
    ),
    consensusFalseResolutionRate: ratio(
      caseReports.filter((entry) => entry.consensus.falseResolution).length,
      caseReports.filter((entry) => entry.expectedOutcome === "unresolved")
        .length,
    ),
    workspaceMutationCount: workspaceMutations.length,
    workspaceMutations,
    totalLatencyMs: allTrials.reduce((sum, trial) => sum + trial.latencyMs, 0),
    averageLatencyMs: Math.round(
      allTrials.reduce((sum, trial) => sum + trial.latencyMs, 0) /
        allTrials.length,
    ),
    usage: sumUsage(allTrials),
  };
  const consensusPrimary = manifest.evaluation?.primary === "consensus";
  const modelGatePassed = consensusPrimary
    ? summary.consensusCasePassRate >=
        (manifest.thresholds.minimumConsensusCaseRate ?? 1) &&
      summary.consensusQuorumRate >=
        (manifest.thresholds.minimumConsensusQuorumRate ?? 1) &&
      summary.consensusFalseResolutionRate <=
        manifest.thresholds.maximumFalseResolutionRate &&
      summary.workspaceMutationCount <=
        manifest.thresholds.maximumWorkspaceMutationCount
    : summary.firstPassCaseRate >=
        manifest.thresholds.minimumFirstPassCaseRate &&
      summary.stableCaseRate >= manifest.thresholds.minimumStableCaseRate &&
      summary.classificationAccuracy >=
        manifest.thresholds.minimumClassificationAccuracy &&
      summary.hiddenTestPassRate >=
        manifest.thresholds.minimumHiddenTestPassRate &&
      summary.falseResolutionRate <=
        manifest.thresholds.maximumFalseResolutionRate &&
      summary.workspaceMutationCount <=
        manifest.thresholds.maximumWorkspaceMutationCount;
  const report = {
    version: 1,
    benchmark: manifest.name,
    status: modelGatePassed
      ? freeze.status === "frozen"
        ? "passed"
        : "fixture-gate-passed-input-freeze-pending"
      : "failed",
    provider: options.provider,
    model: options.model,
    lockUsed: false,
    generatedCodeMutated: workspaceMutations.some(
      (path) => path !== "semantic.lock",
    ),
    oracleAndCasesSentToModel: false,
    evaluation: manifest.evaluation ?? {
      primary: "trials",
      samples: 3,
      quorum: 2,
      parallel: false,
    },
    freeze: {
      status: freeze.status,
      fileCount: Object.keys(freeze.files).length,
    },
    protocol: {
      concepts: manifest.concepts.length,
      changeTypes: 6,
      cases: prepared.length,
      resolvedCases: prepared.filter(
        (entry) => entry.oracle.expectedOutcome === "resolved",
      ).length,
      unresolvedCases: prepared.filter(
        (entry) => entry.oracle.expectedOutcome === "unresolved",
      ).length,
      trialsPerCase: manifest.trials,
      totalTrials: allTrials.length,
    },
    summary: { ...summary, modelGatePassed },
    thresholds: manifest.thresholds,
    cases: caseReports,
    durationMs: Date.now() - startedAt,
    completedAt: new Date().toISOString(),
  };
  await writeJson(resolve(runDirectory, "report.json"), report);
  await writeFile(
    resolve(runDirectory, "report.md"),
    renderReport(report),
    "utf8",
  );
  return { report, runDirectory };
}

async function runTrial(
  benchmarkCase: PreparedSchemaEvolutionCase,
  trial: number,
  model: string,
  resolver: SchemaEvolutionBenchmarkResolver,
): Promise<TrialResult> {
  const modelInput: OpenAIRequestInput = {
    model,
    specification: benchmarkCase.source.concept.specification,
    typeScriptSource: benchmarkCase.source.concept.typeDeclaration,
    target: {
      functionName: benchmarkCase.source.predicate.name,
      parameterName: benchmarkCase.source.predicate.parameterName,
      typeName: benchmarkCase.source.concept.typeName,
    },
  };
  const startedAt = performance.now();
  try {
    const response = await resolver(modelInput);
    const elaboration = parseElaborationResult(
      JSON.parse(response.outputText) as unknown,
    );
    const responseAudit = {
      id: response.responseId,
      model: response.model,
      usage: response.usage,
      outputText: response.outputText,
    };
    if (elaboration.outcome === "unresolved") {
      const diff = classifySemanticChange({
        previous: benchmarkCase.baselineIr,
        candidate: null,
        diagnostics: elaboration.diagnostics,
        validationPassed: false,
        typeSchema: benchmarkCase.source.concept.typeSchema,
      });
      const outcomeCorrect =
        benchmarkCase.oracle.expectedOutcome === "unresolved";
      const classificationCorrect =
        diff.classification === benchmarkCase.oracle.expectedClassification;
      return {
        trial,
        expectedOutcome: benchmarkCase.oracle.expectedOutcome,
        actualOutcome: "unresolved",
        expectedClassification: benchmarkCase.oracle.expectedClassification,
        actualClassification: diff.classification,
        passed: outcomeCorrect && classificationCorrect,
        outcomeCorrect,
        classificationCorrect,
        falseResolution: false,
        contextValid: null,
        exactIrMatch: null,
        hiddenTestsPassed: null,
        hiddenTestResults: [],
        actualBody: null,
        diff,
        diagnostics: elaboration.diagnostics,
        error: null,
        signature: stableJson({ outcome: "unresolved" }),
        latencyMs: Math.round(performance.now() - startedAt),
        modelInput,
        response: responseAudit,
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
    const hiddenTestsPassed = hiddenTestResults.every(
      (result) => result.passed,
    );
    const exactIrMatch =
      benchmarkCase.oracle.expectedOutcome === "resolved" &&
      expressionSignature(elaboration.body) ===
        expressionSignature(benchmarkCase.oracle.body);
    const diff = classifySemanticChange({
      previous: benchmarkCase.baselineIr,
      candidate: elaboration.body,
      diagnostics: elaboration.diagnostics,
      validationPassed: contextValid,
      validationError: contextError,
      typeSchema: benchmarkCase.source.concept.typeSchema,
    });
    const outcomeCorrect = benchmarkCase.oracle.expectedOutcome === "resolved";
    const classificationCorrect =
      diff.classification === benchmarkCase.oracle.expectedClassification;
    return {
      trial,
      expectedOutcome: benchmarkCase.oracle.expectedOutcome,
      actualOutcome: "resolved",
      expectedClassification: benchmarkCase.oracle.expectedClassification,
      actualClassification: diff.classification,
      passed:
        outcomeCorrect &&
        classificationCorrect &&
        contextValid &&
        exactIrMatch &&
        hiddenTestsPassed,
      outcomeCorrect,
      classificationCorrect,
      falseResolution: benchmarkCase.oracle.expectedOutcome === "unresolved",
      contextValid,
      exactIrMatch,
      hiddenTestsPassed,
      hiddenTestResults,
      actualBody: elaboration.body,
      diff,
      diagnostics: contextError
        ? [...elaboration.diagnostics, contextError]
        : elaboration.diagnostics,
      error: null,
      signature: stableJson({
        outcome: "resolved",
        body: expressionSignature(elaboration.body),
      }),
      latencyMs: Math.round(performance.now() - startedAt),
      modelInput,
      response: responseAudit,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      trial,
      expectedOutcome: benchmarkCase.oracle.expectedOutcome,
      actualOutcome: "error",
      expectedClassification: benchmarkCase.oracle.expectedClassification,
      actualClassification: "error",
      passed: false,
      outcomeCorrect: false,
      classificationCorrect: false,
      falseResolution: false,
      contextValid: null,
      exactIrMatch: null,
      hiddenTestsPassed: null,
      hiddenTestResults: [],
      actualBody: null,
      diff: null,
      diagnostics: [],
      error: message,
      signature: stableJson({ outcome: "error", message }),
      latencyMs: Math.round(performance.now() - startedAt),
      modelInput,
      response: null,
    };
  }
}

function evaluateCaseConsensus(
  benchmarkCase: PreparedSchemaEvolutionCase,
  trials: TrialResult[],
  quorum: number,
): ConsensusCaseResult {
  const votes = trials.map((trial) => {
    if (trial.actualOutcome === "unresolved") {
      return {
        trial: trial.trial,
        outcome: "unresolved" as const,
        eligible: true,
        signature: "unresolved",
      };
    }
    if (
      trial.actualOutcome === "resolved" &&
      trial.actualBody !== null &&
      trial.contextValid === true
    ) {
      return {
        trial: trial.trial,
        outcome: "resolved" as const,
        eligible: true,
        signature: predicateSemanticSignature(
          trial.actualBody,
          benchmarkCase.source.concept.typeSchema,
        ).signature,
      };
    }
    return {
      trial: trial.trial,
      outcome: "error" as const,
      eligible: false,
      signature: null,
    };
  });
  const selection = selectConsensusVotes(votes, quorum);
  const representative =
    selection.selectedOutcome === "resolved"
      ? trials.find(
          (trial) =>
            trial.actualOutcome === "resolved" &&
            trial.actualBody !== null &&
            predicateSemanticSignature(
              trial.actualBody,
              benchmarkCase.source.concept.typeSchema,
            ).signature === selection.selectedSignature,
        )
      : selection.selectedOutcome === "unresolved"
        ? trials.find((trial) => trial.actualOutcome === "unresolved")
        : undefined;
  const relationToOracle =
    representative?.actualBody !== null &&
    representative?.actualBody !== undefined &&
    benchmarkCase.oracle.expectedOutcome === "resolved"
      ? comparePredicatesOnType(
          representative.actualBody,
          benchmarkCase.oracle.body,
          benchmarkCase.source.concept.typeSchema,
        ).relation
      : null;
  const outcomeCorrect =
    selection.reached &&
    selection.selectedOutcome === benchmarkCase.oracle.expectedOutcome;
  const semanticMatch =
    benchmarkCase.oracle.expectedOutcome === "unresolved"
      ? selection.selectedOutcome === "unresolved"
      : relationToOracle === "exact" || relationToOracle === "equivalent";
  const hiddenTestsPassed = representative?.hiddenTestsPassed ?? null;
  const falseResolution =
    benchmarkCase.oracle.expectedOutcome === "unresolved" &&
    selection.selectedOutcome === "resolved";
  return {
    selection,
    selectedTrial: representative?.trial ?? null,
    selectedOutcome: selection.selectedOutcome,
    relationToOracle,
    hiddenTestsPassed,
    outcomeCorrect,
    semanticMatch,
    falseResolution,
    passed:
      outcomeCorrect &&
      semanticMatch &&
      (benchmarkCase.oracle.expectedOutcome === "unresolved" ||
        hiddenTestsPassed === true),
  };
}

async function runSequentially<T>(
  count: number,
  run: (index: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = [];
  for (let index = 1; index <= count; index += 1)
    results.push(await run(index));
  return results;
}

async function snapshotWorkspaceArtifacts(workspaceRoot: string) {
  const snapshot: Record<string, string | null> = {};
  const lockPath = resolve(workspaceRoot, "semantic.lock");
  snapshot["semantic.lock"] = await hashOptional(lockPath);
  const glob = new Bun.Glob("**/*.generated.ts");
  for await (const path of glob.scan({
    cwd: workspaceRoot,
    dot: false,
    onlyFiles: true,
  })) {
    snapshot[path] = sha256(await readFile(resolve(workspaceRoot, path)));
  }
  return snapshot;
}

function compareSnapshots(
  before: Record<string, string | null>,
  after: Record<string, string | null>,
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path])
    .sort();
}

async function hashOptional(path: string): Promise<string | null> {
  try {
    return sha256(await readFile(path));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function renderReport(report: {
  benchmark: string;
  status: string;
  provider: string;
  model: string;
  freeze: {
    status: string;
    fileCount: number;
  };
  protocol: { totalTrials: number };
  summary: {
    modelGatePassed: boolean;
    trialPassRate: number;
    firstPassCaseRate: number;
    stableCaseRate: number;
    classificationAccuracy: number;
    exactIrRate: number;
    hiddenTestPassRate: number;
    falseResolutionRate: number;
    consensusCasePassRate: number;
    consensusQuorumRate: number;
    consensusFalseResolutionRate: number;
    workspaceMutationCount: number;
    averageLatencyMs: number;
    usage: { totalTokens: number };
  };
  cases: Array<{
    id: string;
    changeType: SchemaEvolutionChangeType;
    expectedOutcome: string;
    firstPass: boolean;
    stable: boolean;
    consensus: ConsensusCaseResult;
    trials: TrialResult[];
  }>;
}): string {
  const summary = report.summary;
  return [
    `# ${report.benchmark}`,
    "",
    `- Status: ${report.status}`,
    `- Provider/model: ${report.provider}/${report.model}`,
    `- Freeze: ${report.freeze.status}`,
    "- Lock used: false",
    "- Oracle/tests sent to model: false",
    `- Model gate: ${summary.modelGatePassed ? "PASS" : "FAIL"}`,
    "",
    "## Metrics",
    "",
    `- Trials: ${report.protocol.totalTrials}`,
    `- Trial pass rate: ${percent(summary.trialPassRate)}`,
    `- First-pass case rate: ${percent(summary.firstPassCaseRate)}`,
    `- Stable case rate: ${percent(summary.stableCaseRate)}`,
    `- Classification accuracy: ${percent(summary.classificationAccuracy)}`,
    `- Exact IR rate: ${percent(summary.exactIrRate)}`,
    `- Hidden-test pass rate: ${percent(summary.hiddenTestPassRate)}`,
    `- False-resolution rate: ${percent(summary.falseResolutionRate)}`,
    `- Consensus case pass rate: ${percent(summary.consensusCasePassRate)}`,
    `- Consensus quorum rate: ${percent(summary.consensusQuorumRate)}`,
    `- Consensus false-resolution rate: ${percent(summary.consensusFalseResolutionRate)}`,
    `- Workspace mutations: ${summary.workspaceMutationCount}`,
    `- Average API latency: ${summary.averageLatencyMs} ms`,
    `- Total tokens: ${summary.usage.totalTokens}`,
    "",
    "## Cases",
    "",
    "| Case | Change | Expected | First pass | Consensus | Stable | Outcomes |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.cases.map(
      (entry) =>
        `| ${entry.id} | ${entry.changeType} | ${entry.expectedOutcome} | ${entry.firstPass ? "PASS" : "FAIL"} | ${entry.consensus.passed ? "PASS" : "FAIL"} (${entry.consensus.selection.supportingTrials.join(",") || "no quorum"}) | ${entry.stable ? "yes" : "no"} | ${entry.trials.map((trial) => `${trial.actualOutcome}/${trial.actualClassification}:${trial.passed ? "pass" : "fail"}`).join(", ")} |`,
    ),
    "",
  ].join("\n");
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

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
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

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
