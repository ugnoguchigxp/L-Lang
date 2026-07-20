import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { validatePredicateContext } from "./context-validator";
import { evaluateExpression } from "./cross-schema-benchmark";
import { parsePredicateExpression, type PredicateExpression } from "./ir";
import {
  comparePredicatesOnType,
  predicateSemanticSignature,
  type PredicateEquivalenceRelation,
} from "./predicate-equivalence";
import { scanSemanticSource } from "./semantic-source";

export type ConsensusVote = {
  trial: number;
  outcome: "resolved" | "unresolved" | "error";
  eligible: boolean;
  signature: string | null;
};

export type ConsensusSelection = {
  reached: boolean;
  quorum: number;
  selectedOutcome: "resolved" | "unresolved" | null;
  selectedSignature: string | null;
  supportingTrials: number[];
  groups: Array<{
    outcome: "resolved" | "unresolved";
    signature: string;
    trials: number[];
    count: number;
  }>;
};

export type ReplaySchemaEvolutionConsensusOptions = {
  sourceReportPath: string;
  manifestPath: string;
  outputRoot: string;
  quorum?: number;
};

type HiddenCase = {
  name: string;
  input: Record<string, unknown>;
  expected: boolean;
};

export function selectConsensusVotes(
  votes: ConsensusVote[],
  quorum = 2,
): ConsensusSelection {
  const groups = new Map<string, {
    outcome: "resolved" | "unresolved";
    signature: string;
    trials: number[];
  }>();
  for (const vote of votes) {
    if (!vote.eligible || vote.outcome === "error" || vote.signature === null) continue;
    const key = `${vote.outcome}:${vote.signature}`;
    const group = groups.get(key) ?? {
      outcome: vote.outcome,
      signature: vote.signature,
      trials: [],
    };
    group.trials.push(vote.trial);
    groups.set(key, group);
  }
  const ranked = [...groups.values()]
    .map((group) => ({ ...group, count: group.trials.length }))
    .sort((left, right) =>
      right.count - left.count || left.signature.localeCompare(right.signature),
    );
  const winner = ranked[0];
  const tied = winner !== undefined && ranked[1]?.count === winner.count;
  const reached = winner !== undefined && winner.count >= quorum && !tied;
  return {
    reached,
    quorum,
    selectedOutcome: reached ? winner.outcome : null,
    selectedSignature: reached ? winner.signature : null,
    supportingTrials: reached ? [...winner.trials] : [],
    groups: ranked,
  };
}

export async function replaySchemaEvolutionConsensus(
  options: ReplaySchemaEvolutionConsensusOptions,
) {
  const sourceReportPath = resolve(options.sourceReportPath);
  const manifestPath = resolve(options.manifestPath);
  const sourceReportBytes = await readFile(sourceReportPath);
  const sourceReportHash = sha256(sourceReportBytes);
  const sourceReport = parseSourceReport(JSON.parse(sourceReportBytes.toString("utf8")) as unknown);
  const manifest = parseManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
  if (sourceReport.protocol.totalTrials !== 54 || sourceReport.cases.length !== 18) {
    throw new Error("consensus replay requires a complete 18-case/54-trial source report");
  }
  const manifestDirectory = dirname(manifestPath);
  const quorum = options.quorum ?? 2;
  const caseReports = [];

  for (const entry of manifest.cases) {
    const source = await scanSemanticSource(resolve(manifestDirectory, entry.source));
    const oracle = parseOracle(
      JSON.parse(await readFile(resolve(manifestDirectory, entry.oracle), "utf8")) as unknown,
    );
    const hiddenCases = parseHiddenCases(
      JSON.parse(await readFile(resolve(manifestDirectory, entry.tests), "utf8")) as unknown,
    );
    const original = sourceReport.cases.find((candidate) => candidate.id === entry.id);
    if (original === undefined || original.trials.length !== 3) {
      throw new Error(`${entry.id}: source report does not contain exactly 3 trials`);
    }
    const votes = original.trials.map((trial) => evaluateVote(
      trial,
      source,
      hiddenCases,
      oracle.body,
    ));
    const selection = selectConsensusVotes(votes, quorum);
    const representative = selection.selectedOutcome === "resolved"
      ? votes.find((vote) =>
          vote.outcome === "resolved" &&
          vote.signature === selection.selectedSignature &&
          vote.body !== null
        )
      : undefined;
    const selectedBody = representative?.body ?? null;
    const relationToOracle: PredicateEquivalenceRelation | null =
      selectedBody !== null && oracle.body !== null
        ? comparePredicatesOnType(selectedBody, oracle.body, source.concept.typeSchema).relation
        : null;
    const selectedHiddenTestsPassed = representative?.hiddenTestsPassed ??
      (selection.selectedOutcome === "unresolved" ? null : false);
    const outcomeCorrect = selection.reached && selection.selectedOutcome === oracle.expectedOutcome;
    const semanticMatch = oracle.expectedOutcome === "unresolved"
      ? selection.selectedOutcome === "unresolved"
      : relationToOracle === "exact" || relationToOracle === "equivalent";
    const passed =
      outcomeCorrect &&
      semanticMatch &&
      (oracle.expectedOutcome === "unresolved" || selectedHiddenTestsPassed === true);
    caseReports.push({
      id: entry.id,
      conceptId: entry.conceptId,
      changeType: entry.changeType,
      original: {
        firstPass: original.firstPass,
        stable: original.stable,
        passedTrials: original.trials.filter((trial) => trial.passed).length,
      },
      expectedOutcome: oracle.expectedOutcome,
      votes,
      selection,
      selectedBody,
      relationToOracle,
      selectedHiddenTestsPassed,
      outcomeCorrect,
      semanticMatch,
      falseResolution:
        oracle.expectedOutcome === "unresolved" && selection.selectedOutcome === "resolved",
      rescued: passed && original.trials.some((trial) => !trial.passed),
      passed,
    });
  }

  const originalHashAfter = sha256(await readFile(sourceReportPath));
  if (originalHashAfter !== sourceReportHash) {
    throw new Error("source report changed during consensus replay");
  }
  const summary = {
    cases: caseReports.length,
    casesWithQuorum: caseReports.filter((entry) => entry.selection.reached).length,
    passedCases: caseReports.filter((entry) => entry.passed).length,
    outcomeAccuracy: ratio(
      caseReports.filter((entry) => entry.outcomeCorrect).length,
      caseReports.length,
    ),
    semanticAccuracy: ratio(
      caseReports.filter((entry) => entry.semanticMatch).length,
      caseReports.length,
    ),
    falseResolutionCount: caseReports.filter((entry) => entry.falseResolution).length,
    rescuedCases: caseReports.filter((entry) => entry.rescued).map((entry) => entry.id),
    equivalentVotes: caseReports.flatMap((entry) => entry.votes)
      .filter((vote) => vote.relationToOracle === "equivalent").length,
    sourceReportUnchanged: true,
  };
  const report = {
    version: 1,
    method: "type-aware-consensus-v1",
    status:
      summary.passedCases === 18 &&
      summary.casesWithQuorum === 18 &&
      summary.falseResolutionCount === 0
        ? "passed"
        : "failed",
    sourceReport: sourceReportPath,
    sourceReportSha256: sourceReportHash,
    sourceBenchmarkStatus: sourceReport.status,
    samplesPerCase: 3,
    quorum,
    selectionPolicy: {
      contextValidationRequired: true,
      hiddenCasesUsedForSelection: false,
      oracleUsedForSelection: false,
      hiddenCasesUsedForFinalScoring: true,
    },
    summary,
    cases: caseReports,
    completedAt: new Date().toISOString(),
  };
  const sourceRunId = basename(dirname(sourceReportPath));
  const replayId = `${new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14)}-type-aware-consensus-v1`;
  const outputDirectory = resolve(options.outputRoot, sourceRunId, replayId);
  await mkdir(outputDirectory, { recursive: true });
  await writeJson(resolve(outputDirectory, "report.json"), report);
  await writeFile(resolve(outputDirectory, "report.md"), renderReport(report), "utf8");
  return { report, outputDirectory };
}

function evaluateVote(
  trial: SourceTrial,
  source: Awaited<ReturnType<typeof scanSemanticSource>>,
  hiddenCases: HiddenCase[],
  oracleBody: PredicateExpression | null,
) {
  if (trial.actualOutcome === "unresolved") {
    return {
      trial: trial.trial,
      outcome: "unresolved" as const,
      eligible: true,
      signature: "unresolved",
      body: null,
      contextValid: null,
      hiddenTestsPassed: null,
      relationToOracle: null,
      rewrites: [] as string[],
      error: null,
    };
  }
  if (trial.actualOutcome !== "resolved" || trial.actualBody === null) {
    return {
      trial: trial.trial,
      outcome: "error" as const,
      eligible: false,
      signature: null,
      body: null,
      contextValid: null,
      hiddenTestsPassed: null,
      relationToOracle: null,
      rewrites: [] as string[],
      error: trial.error ?? "trial has no resolved body",
    };
  }
  try {
    const body = parsePredicateExpression(trial.actualBody, `trial ${trial.trial}.actualBody`);
    validatePredicateContext(body, source);
    const hiddenTestsPassed = hiddenCases.every((hiddenCase) =>
      evaluateExpression(body, hiddenCase.input) === hiddenCase.expected,
    );
    const semantic = predicateSemanticSignature(body, source.concept.typeSchema);
    return {
      trial: trial.trial,
      outcome: "resolved" as const,
      eligible: true,
      signature: semantic.signature,
      body,
      contextValid: true,
      hiddenTestsPassed,
      relationToOracle:
        oracleBody === null
          ? null
          : comparePredicatesOnType(body, oracleBody, source.concept.typeSchema).relation,
      rewrites: semantic.rewrites,
      error: hiddenTestsPassed ? null : "hidden semantic tests failed (scoring only)",
    };
  } catch (error) {
    return {
      trial: trial.trial,
      outcome: "resolved" as const,
      eligible: false,
      signature: null,
      body: null,
      contextValid: false,
      hiddenTestsPassed: false,
      relationToOracle: null,
      rewrites: [] as string[],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

type SourceTrial = {
  trial: number;
  actualOutcome: "resolved" | "unresolved" | "error";
  actualBody: unknown;
  passed: boolean;
  error: string | null;
};

function parseSourceReport(input: unknown) {
  const value = record(input, "source report");
  const protocol = record(value.protocol, "source report.protocol");
  if (!Array.isArray(value.cases) || typeof value.status !== "string") {
    throw new Error("source report is invalid");
  }
  return {
    status: value.status,
    protocol: { totalTrials: number(protocol.totalTrials, "protocol.totalTrials") },
    cases: value.cases.map((item, index) => {
      const entry = record(item, `source report.cases[${index}]`);
      if (typeof entry.id !== "string" || !Array.isArray(entry.trials)) {
        throw new Error(`source report.cases[${index}] is invalid`);
      }
      return {
        id: entry.id,
        firstPass: Boolean(entry.firstPass),
        stable: Boolean(entry.stable),
        trials: entry.trials.map((trial, trialIndex) => {
          const value = record(trial, `${entry.id}.trials[${trialIndex}]`);
          if (
            typeof value.trial !== "number" ||
            !["resolved", "unresolved", "error"].includes(String(value.actualOutcome))
          ) {
            throw new Error(`${entry.id}.trials[${trialIndex}] is invalid`);
          }
          return {
            trial: value.trial,
            actualOutcome: value.actualOutcome,
            actualBody: value.actualBody,
            passed: Boolean(value.passed),
            error: typeof value.error === "string" ? value.error : null,
          } as SourceTrial;
        }),
      };
    }),
  };
}

function parseManifest(input: unknown) {
  const value = record(input, "manifest");
  if (value.version !== 1 || !Array.isArray(value.cases)) {
    throw new Error("manifest is invalid");
  }
  return {
    cases: value.cases.map((item, index) => {
      const entry = record(item, `manifest.cases[${index}]`);
      for (const key of ["id", "conceptId", "changeType", "source", "oracle", "tests"]) {
        if (typeof entry[key] !== "string") throw new Error(`manifest case ${key} is invalid`);
      }
      return entry as {
        id: string;
        conceptId: string;
        changeType: string;
        source: string;
        oracle: string;
        tests: string;
      };
    }),
  };
}

function parseOracle(input: unknown): {
  expectedOutcome: "resolved" | "unresolved";
  body: PredicateExpression | null;
} {
  const value = record(input, "oracle");
  if (value.expectedOutcome === "unresolved" && value.body === null) {
    return { expectedOutcome: "unresolved", body: null };
  }
  if (value.expectedOutcome === "resolved") {
    return {
      expectedOutcome: "resolved",
      body: parsePredicateExpression(value.body, "oracle.body"),
    };
  }
  throw new Error("oracle is invalid");
}

function parseHiddenCases(input: unknown): HiddenCase[] {
  const value = record(input, "hidden cases");
  if (!Array.isArray(value.tests)) throw new Error("hidden cases are invalid");
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
  status: string;
  sourceReport: string;
  sourceReportSha256: string;
  quorum: number;
  samplesPerCase: number;
  summary: {
    passedCases: number;
    cases: number;
    casesWithQuorum: number;
    falseResolutionCount: number;
    rescuedCases: string[];
    equivalentVotes: number;
    sourceReportUnchanged: boolean;
  };
  cases: Array<{
    id: string;
    expectedOutcome: string;
    selection: ConsensusSelection;
    relationToOracle: PredicateEquivalenceRelation | null;
    passed: boolean;
  }>;
}): string {
  return [
    "# Type-aware Schema Evolution Consensus Replay",
    "",
    `- Status: ${report.status}`,
    `- Source report: ${report.sourceReport}`,
    `- Source SHA-256: ${report.sourceReportSha256}`,
    `- Consensus: ${report.quorum}/${report.samplesPerCase}`,
    `- Passed cases: ${report.summary.passedCases}/${report.summary.cases}`,
    `- Cases with quorum: ${report.summary.casesWithQuorum}/${report.summary.cases}`,
    `- False resolutions: ${report.summary.falseResolutionCount}`,
    `- Equivalent non-exact votes: ${report.summary.equivalentVotes}`,
    `- Source report unchanged: ${report.summary.sourceReportUnchanged}`,
    `- Rescued cases: ${report.summary.rescuedCases.join(", ") || "none"}`,
    "",
    "| Case | Expected | Selected | Supporting trials | Relation | Result |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.cases.map((entry) =>
      `| ${entry.id} | ${entry.expectedOutcome} | ${entry.selection.selectedOutcome ?? "none"} | ${entry.selection.supportingTrials.join(", ")} | ${entry.relationToOracle ?? "n/a"} | ${entry.passed ? "PASS" : "FAIL"} |`,
    ),
    "",
  ].join("\n");
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function number(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
