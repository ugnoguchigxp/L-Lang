import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { validatePredicateContext } from "./context-validator";
import { evaluateExpression, expressionSignature } from "./cross-schema-benchmark";
import { parsePredicateExpression, type PredicateExpression } from "./ir";
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
import { selectConsensusVotes, type ConsensusSelection } from "./schema-evolution-consensus";
import { scanSemanticSource, type SemanticSource } from "./semantic-source";

export type SchemaEvolutionBenchmarkResolver = (
  input: OpenAIRequestInput,
) => Promise<OpenAIResult>;

export type SchemaEvolutionBenchmarkOptions = {
  manifestPath: string;
  workspaceRoot?: string;
  outputRoot: string;
  provider: string;
  model: string;
  resolve: SchemaEvolutionBenchmarkResolver;
  requireHumanReview?: boolean;
  parallelTrials?: boolean;
  onProgress?: (message: string) => void;
};

type ChangeType =
  | "add-property"
  | "rename"
  | "representation"
  | "optionality"
  | "remove-role"
  | "ambiguity";

type BenchmarkManifest = {
  version: 1;
  name: string;
  trials: number;
  freeze: string;
  blindness: {
    oracleAndCasesSentToModel: false;
    lockUsed: false;
    generatedCodeMutationAllowed: false;
    note: string;
  };
  thresholds: {
    minimumFirstPassCaseRate: number;
    minimumStableCaseRate: number;
    minimumClassificationAccuracy: number;
    minimumHiddenTestPassRate: number;
    maximumFalseResolutionRate: number;
    maximumWorkspaceMutationCount: number;
    minimumConsensusCaseRate?: number;
    minimumConsensusQuorumRate?: number;
  };
  evaluation?: {
    primary: "trials" | "consensus";
    samples: 3;
    quorum: 2;
    parallel: boolean;
  };
  protocol?: {
    concepts: number;
    cases: number;
    resolvedCases: number;
    unresolvedCases: number;
    casesPerChangeType: number;
  };
  concepts: Array<{
    id: string;
    definition: string;
    baselineSource: string;
    baselineOracle: string;
  }>;
  cases: Array<{
    id: string;
    conceptId: string;
    changeType: ChangeType;
    source: string;
    oracle: string;
    tests: string;
  }>;
};

type FreezeManifest = {
  version: 1;
  status: "draft" | "human-reviewed";
  humanReviewed: boolean;
  reviewer: string | null;
  reviewedAt: string | null;
  instructions: string;
  files: Record<string, string>;
};

type Oracle =
  | {
      expectedOutcome: "resolved";
      expectedClassification: "compatible";
      body: PredicateExpression;
    }
  | {
      expectedOutcome: "unresolved";
      expectedClassification: "unresolved";
      body: null;
    };

type HiddenCase = {
  name: string;
  input: Record<string, unknown>;
  expected: boolean;
};

type PreparedCase = {
  id: string;
  conceptId: string;
  changeType: ChangeType;
  source: SemanticSource;
  baselineIr: PredicateExpression;
  oracle: Oracle;
  hiddenCases: HiddenCase[];
};

type TrialResult = {
  trial: number;
  expectedOutcome: Oracle["expectedOutcome"];
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

export async function runSchemaEvolutionBenchmark(
  options: SchemaEvolutionBenchmarkOptions,
) {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const manifestPath = resolve(options.manifestPath);
  const directory = dirname(manifestPath);
  const manifest = parseManifest(await readJson(manifestPath));
  const freeze = parseFreeze(await readJson(resolve(directory, manifest.freeze)));
  await verifySchemaEvolutionFreeze(directory, manifest, freeze);
  if (options.requireHumanReview ?? true) assertHumanReviewedFreeze(freeze);

  const prepared = await prepareCases(manifest, directory);
  validateProtocol(manifest, prepared);
  const beforeArtifacts = await snapshotWorkspaceArtifacts(workspaceRoot);
  const runId = `${new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14)}`;
  const runDirectory = resolve(options.outputRoot, `${runId}-${manifest.name}`);
  await mkdir(runDirectory, { recursive: true });
  const startedAt = Date.now();
  const caseReports: Array<{
    id: string;
    conceptId: string;
    changeType: ChangeType;
    expectedOutcome: Oracle["expectedOutcome"];
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
      const result = await runTrial(benchmarkCase, trial, options.model, options.resolve);
      await writeJson(
        resolve(runDirectory, "trials", benchmarkCase.id, `${trial}.json`),
        result,
      );
      return result;
    };
    const parallel = options.parallelTrials ?? manifest.evaluation?.parallel ?? false;
    const trials = parallel
      ? await Promise.all(Array.from({ length: manifest.trials }, (_, index) => runOne(index + 1)))
      : await runSequentially(manifest.trials, runOne);
    const consensus = evaluateCaseConsensus(benchmarkCase, trials, manifest.evaluation?.quorum ?? 2);
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
    trialPassRate: ratio(allTrials.filter((trial) => trial.passed).length, allTrials.length),
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
      resolvedExpected.filter((trial) => trial.hiddenTestsPassed === true).length,
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
      caseReports.filter((entry) => entry.expectedOutcome === "unresolved").length,
    ),
    workspaceMutationCount: workspaceMutations.length,
    workspaceMutations,
    totalLatencyMs: allTrials.reduce((sum, trial) => sum + trial.latencyMs, 0),
    averageLatencyMs: Math.round(
      allTrials.reduce((sum, trial) => sum + trial.latencyMs, 0) / allTrials.length,
    ),
    usage: sumUsage(allTrials),
  };
  const consensusPrimary = manifest.evaluation?.primary === "consensus";
  const modelGatePassed = consensusPrimary
    ? summary.consensusCasePassRate >= (manifest.thresholds.minimumConsensusCaseRate ?? 1) &&
      summary.consensusQuorumRate >= (manifest.thresholds.minimumConsensusQuorumRate ?? 1) &&
      summary.consensusFalseResolutionRate <= manifest.thresholds.maximumFalseResolutionRate &&
      summary.workspaceMutationCount <= manifest.thresholds.maximumWorkspaceMutationCount
    : summary.firstPassCaseRate >= manifest.thresholds.minimumFirstPassCaseRate &&
      summary.stableCaseRate >= manifest.thresholds.minimumStableCaseRate &&
      summary.classificationAccuracy >= manifest.thresholds.minimumClassificationAccuracy &&
      summary.hiddenTestPassRate >= manifest.thresholds.minimumHiddenTestPassRate &&
      summary.falseResolutionRate <= manifest.thresholds.maximumFalseResolutionRate &&
      summary.workspaceMutationCount <= manifest.thresholds.maximumWorkspaceMutationCount;
  const report = {
    version: 1,
    benchmark: manifest.name,
    status: modelGatePassed
      ? freeze.humanReviewed
        ? "passed"
        : "fixture-gate-passed-human-review-pending"
      : "failed",
    provider: options.provider,
    model: options.model,
    lockUsed: false,
    generatedCodeMutated: workspaceMutations.some((path) => path !== "semantic.lock"),
    oracleAndCasesSentToModel: false,
    evaluation: manifest.evaluation ?? {
      primary: "trials",
      samples: 3,
      quorum: 2,
      parallel: false,
    },
    freeze: {
      status: freeze.status,
      humanReviewed: freeze.humanReviewed,
      reviewer: freeze.reviewer,
      reviewedAt: freeze.reviewedAt,
      fileCount: Object.keys(freeze.files).length,
    },
    protocol: {
      concepts: manifest.concepts.length,
      changeTypes: 6,
      cases: prepared.length,
      resolvedCases: prepared.filter((entry) => entry.oracle.expectedOutcome === "resolved").length,
      unresolvedCases: prepared.filter((entry) => entry.oracle.expectedOutcome === "unresolved").length,
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
  await writeFile(resolve(runDirectory, "report.md"), renderReport(report), "utf8");
  return { report, runDirectory };
}

export function assertHumanReviewedFreeze(freeze: {
  status: "draft" | "human-reviewed";
  humanReviewed: boolean;
  reviewer: string | null;
  reviewedAt: string | null;
}): void {
  if (
    !freeze.humanReviewed ||
    freeze.status !== "human-reviewed" ||
    typeof freeze.reviewer !== "string" ||
    freeze.reviewer.trim().length === 0 ||
    typeof freeze.reviewedAt !== "string" ||
    Number.isNaN(Date.parse(freeze.reviewedAt))
  ) {
    throw new Error(
      "benchmark inputs are frozen as draft; independent human review is required before live execution",
    );
  }
}

async function runTrial(
  benchmarkCase: PreparedCase,
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
    const elaboration = parseElaborationResult(JSON.parse(response.outputText) as unknown);
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
      const outcomeCorrect = benchmarkCase.oracle.expectedOutcome === "unresolved";
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
    const hiddenTestsPassed = hiddenTestResults.every((result) => result.passed);
    const exactIrMatch =
      benchmarkCase.oracle.expectedOutcome === "resolved" &&
      expressionSignature(elaboration.body) === expressionSignature(benchmarkCase.oracle.body);
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
      signature: stableJson({ outcome: "resolved", body: expressionSignature(elaboration.body) }),
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
  benchmarkCase: PreparedCase,
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
  const representative = selection.selectedOutcome === "resolved"
    ? trials.find((trial) =>
        trial.actualOutcome === "resolved" &&
        trial.actualBody !== null &&
        predicateSemanticSignature(
          trial.actualBody,
          benchmarkCase.source.concept.typeSchema,
        ).signature === selection.selectedSignature
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
    selection.reached && selection.selectedOutcome === benchmarkCase.oracle.expectedOutcome;
  const semanticMatch = benchmarkCase.oracle.expectedOutcome === "unresolved"
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
      (benchmarkCase.oracle.expectedOutcome === "unresolved" || hiddenTestsPassed === true),
  };
}

async function runSequentially<T>(
  count: number,
  run: (index: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = [];
  for (let index = 1; index <= count; index += 1) results.push(await run(index));
  return results;
}

async function prepareCases(
  manifest: BenchmarkManifest,
  directory: string,
): Promise<PreparedCase[]> {
  const baselines = new Map<string, { source: SemanticSource; body: PredicateExpression }>();
  for (const concept of manifest.concepts) {
    const source = await scanSemanticSource(resolve(directory, concept.baselineSource));
    const body = parseBaseline(await readJson(resolve(directory, concept.baselineOracle)));
    validatePredicateContext(body, source);
    baselines.set(concept.id, { source, body });
  }
  return Promise.all(manifest.cases.map(async (entry) => {
    const baseline = baselines.get(entry.conceptId);
    if (baseline === undefined) throw new Error(`${entry.id}: baseline is missing`);
    const source = await scanSemanticSource(resolve(directory, entry.source));
    if (source.concept.id !== entry.conceptId) {
      throw new Error(`${entry.id}: source Concept does not match manifest`);
    }
    return {
      id: entry.id,
      conceptId: entry.conceptId,
      changeType: entry.changeType,
      source,
      baselineIr: baseline.body,
      oracle: parseOracle(await readJson(resolve(directory, entry.oracle))),
      hiddenCases: parseHiddenCases(await readJson(resolve(directory, entry.tests))),
    };
  }));
}

function validateProtocol(manifest: BenchmarkManifest, cases: PreparedCase[]): void {
  const protocol = manifest.protocol ?? {
    concepts: 3,
    cases: 18,
    resolvedCases: 12,
    unresolvedCases: 6,
    casesPerChangeType: 3,
  };
  if (
    manifest.trials !== 3 ||
    manifest.concepts.length !== protocol.concepts ||
    cases.length !== protocol.cases
  ) {
    throw new Error(
      `protocol requires exactly ${protocol.concepts} Concepts, ${protocol.cases} cases, and 3 trials`,
    );
  }
  const changeTypes: ChangeType[] = [
    "add-property", "rename", "representation", "optionality", "remove-role", "ambiguity",
  ];
  for (const changeType of changeTypes) {
    if (
      cases.filter((entry) => entry.changeType === changeType).length !==
        protocol.casesPerChangeType
    ) {
      throw new Error(
        `protocol requires ${protocol.casesPerChangeType} cases for ${changeType}`,
      );
    }
  }
  const resolved = cases.filter((entry) => entry.oracle.expectedOutcome === "resolved");
  if (
    resolved.length !== protocol.resolvedCases ||
    cases.length - resolved.length !== protocol.unresolvedCases
  ) {
    throw new Error(
      `protocol requires exactly ${protocol.resolvedCases} resolved and ${protocol.unresolvedCases} unresolved cases`,
    );
  }
  for (const entry of cases) {
    if (entry.source.tests.acceptSource !== "[]" || entry.source.tests.rejectSource !== "[]") {
      throw new Error(`${entry.id}: source must not contain oracle cases`);
    }
    if (entry.oracle.expectedOutcome === "resolved") {
      validatePredicateContext(entry.oracle.body, entry.source);
      if (entry.hiddenCases.length === 0) throw new Error(`${entry.id}: hidden cases required`);
    } else if (entry.hiddenCases.length !== 0) {
      throw new Error(`${entry.id}: unresolved case must not contain behavioral oracle cases`);
    }
  }
}

export async function verifySchemaEvolutionFreeze(
  directory: string,
  manifest: BenchmarkManifest,
  freeze: FreezeManifest,
): Promise<void> {
  const required = new Set([
    "benchmark.json",
    ...manifest.concepts.flatMap((entry) => [
      entry.definition,
      entry.baselineSource,
      entry.baselineOracle,
    ]),
    ...manifest.cases.flatMap((entry) => [entry.source, entry.oracle, entry.tests]),
  ]);
  const frozen = new Set(Object.keys(freeze.files));
  if (stableJson([...required].sort()) !== stableJson([...frozen].sort())) {
    throw new Error("freeze file set does not exactly match benchmark inputs");
  }
  await verifyFrozenFileHashes(directory, freeze.files);
}

export async function verifyFrozenFileHashes(
  directory: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [path, expected] of Object.entries(files)) {
    const actual = sha256(await readFile(resolve(directory, path)));
    if (actual !== expected) throw new Error(`frozen input hash mismatch: ${path}`);
  }
}

async function snapshotWorkspaceArtifacts(workspaceRoot: string) {
  const snapshot: Record<string, string | null> = {};
  const lockPath = resolve(workspaceRoot, "semantic.lock");
  snapshot["semantic.lock"] = await hashOptional(lockPath);
  const glob = new Bun.Glob("**/*.generated.ts");
  for await (const path of glob.scan({ cwd: workspaceRoot, dot: false, onlyFiles: true })) {
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

function parseManifest(input: unknown): BenchmarkManifest {
  const value = record(input, "benchmark");
  if (
    value.version !== 1 ||
    typeof value.name !== "string" ||
    value.trials !== 3 ||
    !Array.isArray(value.concepts) ||
    !Array.isArray(value.cases)
  ) {
    throw new Error("schema evolution benchmark manifest is invalid");
  }
  return input as BenchmarkManifest;
}

function parseFreeze(input: unknown): FreezeManifest {
  const value = record(input, "freeze");
  if (
    value.version !== 1 ||
    (value.status !== "draft" && value.status !== "human-reviewed") ||
    typeof value.humanReviewed !== "boolean" ||
    !(typeof value.reviewer === "string" || value.reviewer === null) ||
    !(typeof value.reviewedAt === "string" || value.reviewedAt === null) ||
    typeof value.instructions !== "string"
  ) {
    throw new Error("freeze manifest is invalid");
  }
  const files = record(value.files, "freeze.files");
  if (
    value.humanReviewed === true &&
    (value.status !== "human-reviewed" ||
      typeof value.reviewer !== "string" ||
      value.reviewer.trim().length === 0 ||
      typeof value.reviewedAt !== "string" ||
      Number.isNaN(Date.parse(value.reviewedAt)))
  ) {
    throw new Error("human-reviewed freeze requires reviewer and reviewedAt");
  }
  for (const [path, hash] of Object.entries(files)) {
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error(`invalid frozen hash: ${path}`);
    }
  }
  return input as FreezeManifest;
}

function parseBaseline(input: unknown): PredicateExpression {
  const value = record(input, "baseline oracle");
  if (value.version !== 1) throw new Error("baseline oracle version must be 1");
  return parsePredicateExpression(value.body, "baseline oracle.body");
}

function parseOracle(input: unknown): Oracle {
  const value = record(input, "oracle");
  if (value.version !== 1) throw new Error("oracle version must be 1");
  if (
    value.expectedOutcome === "unresolved" &&
    value.expectedClassification === "unresolved" &&
    value.body === null
  ) {
    return { expectedOutcome: "unresolved", expectedClassification: "unresolved", body: null };
  }
  if (value.expectedOutcome === "resolved" && value.expectedClassification === "compatible") {
    return {
      expectedOutcome: "resolved",
      expectedClassification: "compatible",
      body: parsePredicateExpression(value.body, "oracle.body"),
    };
  }
  throw new Error("oracle outcome, classification, or body is invalid");
}

function parseHiddenCases(input: unknown): HiddenCase[] {
  const value = record(input, "hidden cases");
  if (value.version !== 1 || !Array.isArray(value.tests)) {
    throw new Error("hidden cases file is invalid");
  }
  return value.tests.map((item, index) => {
    const test = record(item, `hidden cases[${index}]`);
    if (typeof test.name !== "string" || typeof test.expected !== "boolean") {
      throw new Error(`hidden cases[${index}] is invalid`);
    }
    return {
      name: test.name,
      input: record(test.input, `hidden cases[${index}].input`),
      expected: test.expected,
    };
  });
}

function renderReport(report: {
  benchmark: string;
  status: string;
  provider: string;
  model: string;
  freeze: {
    status: string;
    humanReviewed: boolean;
    reviewer: string | null;
    reviewedAt: string | null;
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
    changeType: ChangeType;
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
    `- Freeze: ${report.freeze.status} (human reviewed: ${report.freeze.humanReviewed})`,
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
    ...report.cases.map((entry) =>
      `| ${entry.id} | ${entry.changeType} | ${entry.expectedOutcome} | ${entry.firstPass ? "PASS" : "FAIL"} | ${entry.consensus.passed ? "PASS" : "FAIL"} (${entry.consensus.selection.supportingTrials.join(",") || "no quorum"}) | ${entry.stable ? "yes" : "no"} | ${entry.trials.map((trial) => `${trial.actualOutcome}/${trial.actualClassification}:${trial.passed ? "pass" : "fail"}`).join(", ")} |`,
    ),
    "",
  ].join("\n");
}

function sumUsage(trials: TrialResult[]) {
  const usage = trials.flatMap((trial) => trial.response?.usage ? [trial.response.usage] : []);
  return {
    inputTokens: usage.reduce((sum, entry) => sum + entry.inputTokens, 0),
    outputTokens: usage.reduce((sum, entry) => sum + entry.outputTokens, 0),
    totalTokens: usage.reduce((sum, entry) => sum + entry.totalTokens, 0),
  };
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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
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
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: string }).code === "ENOENT";
}

export function relativeSchemaEvolutionReportPath(
  workspaceRoot: string,
  path: string,
): string {
  return relative(workspaceRoot, path).replaceAll("\\", "/");
}
