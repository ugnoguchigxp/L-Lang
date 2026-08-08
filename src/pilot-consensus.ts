import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { validatePredicateContext } from "./context-validator";
import { evaluateExpression } from "./cross-schema-benchmark";
import {
  type ElaborationResult,
  type OpenAIResult,
  parseElaborationResult,
} from "./openai";
import {
  assertPilotFrozen,
  assertPilotReviewApproved,
  readPilotFrozenJson,
  readPilotProtocol,
} from "./pilot-manifest";
import { type PilotHiddenCase, parsePilotHiddenCaseSet } from "./pilot-runner";
import { predicateSemanticSignature } from "./predicate-equivalence";
import { selectConsensusVotes } from "./schema-evolution-consensus";
import {
  assertKnownKeys,
  parseBoundedJsonText,
  SEMANTIC_LIMITS,
} from "./semantic-limits";
import { sha256 } from "./semantic-fingerprint";
import { scanSemanticSource } from "./semantic-source";

export type PilotConsensusReport = {
  version: 1;
  pilot: string;
  status: "passed" | "failed";
  manifestHash: string;
  samples: 3;
  quorum: 2;
  cases: Array<{
    id: string;
    domain: string;
    reached: boolean;
    selectedOutcome: "resolved" | "unresolved" | null;
    supportingSamples: number[];
    votes: Array<{
      sample: number;
      outcome: "resolved" | "unresolved" | "error";
      eligible: boolean;
      signature: string | null;
      error: string | null;
    }>;
    hiddenCases: number;
    hiddenCasesPassed: number;
    falseResolution: boolean;
  }>;
  summary: {
    cases: number;
    quorumReached: number;
    resolved: number;
    unresolved: number;
    noQuorum: number;
    hiddenCases: number;
    hiddenCasesPassed: number;
    falseResolutions: number;
    apiAttempts: number;
    cooldownCompletions: number;
    inputTokens: number;
    outputTokens: number;
    providerLatencyMs: number;
    estimatedCost: number;
  };
  checks: Record<string, boolean>;
  sampleArtifacts: Array<{
    sample: number;
    directory: string;
    reportSha256: string;
    responsesSha256: string;
  }>;
};

type SampleEntry = {
  caseId: string;
  response: OpenAIResult;
  latencyMs: number;
};

type SampleInput = {
  entries: SampleEntry[];
  metrics: {
    apiAttempts: number;
    cooldownCompletions: number;
    estimatedCost: number;
  };
  reportSha256: string;
  responsesSha256: string;
  directory: string;
};

export async function aggregatePilotConsensus(input: {
  manifestPath: string;
  sampleDirectories: [string, string, string];
  outputDirectory: string;
}): Promise<{ report: PilotConsensusReport; reportPath: string }> {
  const protocol = await readPilotProtocol(input.manifestPath);
  assertPilotFrozen(protocol.freeze);
  assertPilotReviewApproved(protocol.review, protocol.manifest);
  const samples = await Promise.all(
    input.sampleDirectories.map((directory, index) =>
      readSample(directory, index + 1, protocol.manifestHash),
    ),
  );
  const cases: PilotConsensusReport["cases"] = [];

  for (const pilotCase of protocol.manifest.cases) {
    const source = await scanSemanticSource(
      resolve(protocol.directory, pilotCase.source),
    );
    const hiddenCases = parsePilotHiddenCaseSet(
      await readPilotFrozenJson(
        protocol,
        pilotCase.hiddenCases,
        `Pilot consensus hidden cases ${pilotCase.id}`,
      ),
      pilotCase.id,
    );
    const evaluated = samples.map((sample, index) => {
      const entry = sample.entries.find(
        (candidate) => candidate.caseId === pilotCase.id,
      );
      if (entry === undefined) {
        return {
          sample: index + 1,
          outcome: "error" as const,
          eligible: false,
          signature: null,
          error: "missing completed response",
          elaboration: null,
        };
      }
      return evaluateVote(index + 1, entry.response, source);
    });
    const selection = selectConsensusVotes(
      evaluated.map((vote) => ({
        trial: vote.sample,
        outcome: vote.outcome,
        eligible: vote.eligible,
        signature: vote.signature,
      })),
      2,
    );
    const selectedVote = selection.reached
      ? evaluated.find(
          (vote) =>
            vote.sample === selection.supportingTrials[0] &&
            vote.signature === selection.selectedSignature,
        )
      : undefined;
    const hiddenCasesPassed = scoreSelected(
      selectedVote?.elaboration ?? null,
      hiddenCases,
    );
    const falseResolution =
      selection.selectedOutcome === "resolved" &&
      hiddenCasesPassed !== hiddenCases.length;
    cases.push({
      id: pilotCase.id,
      domain: pilotCase.domain,
      reached: selection.reached,
      selectedOutcome: selection.selectedOutcome,
      supportingSamples: selection.supportingTrials,
      votes: evaluated.map(({ elaboration: _elaboration, ...vote }) => vote),
      hiddenCases: hiddenCases.length,
      hiddenCasesPassed,
      falseResolution,
    });
  }

  const summary = {
    cases: cases.length,
    quorumReached: cases.filter((entry) => entry.reached).length,
    resolved: cases.filter((entry) => entry.selectedOutcome === "resolved")
      .length,
    unresolved: cases.filter((entry) => entry.selectedOutcome === "unresolved")
      .length,
    noQuorum: cases.filter((entry) => !entry.reached).length,
    hiddenCases: sum(cases.map((entry) => entry.hiddenCases)),
    hiddenCasesPassed: sum(cases.map((entry) => entry.hiddenCasesPassed)),
    falseResolutions: cases.filter((entry) => entry.falseResolution).length,
    apiAttempts: sum(samples.map((sample) => sample.metrics.apiAttempts)),
    cooldownCompletions: sum(
      samples.map((sample) => sample.metrics.cooldownCompletions),
    ),
    inputTokens: sum(
      samples.flatMap((sample) =>
        sample.entries.map((entry) => entry.response.usage?.inputTokens ?? 0),
      ),
    ),
    outputTokens: sum(
      samples.flatMap((sample) =>
        sample.entries.map((entry) => entry.response.usage?.outputTokens ?? 0),
      ),
    ),
    providerLatencyMs: sum(
      samples.flatMap((sample) =>
        sample.entries.map((entry) => entry.latencyMs),
      ),
    ),
    estimatedCost: sum(samples.map((sample) => sample.metrics.estimatedCost)),
  };
  const checks = {
    exactCaseCount: summary.cases === 8,
    quorumEveryCase: summary.quorumReached === summary.cases,
    falseResolutionSafety: summary.falseResolutions === 0,
    hiddenCaseSafety: cases
      .filter((entry) => entry.selectedOutcome === "resolved")
      .every((entry) => entry.hiddenCasesPassed === entry.hiddenCases),
    cooldownAfterEveryAttempt:
      summary.apiAttempts === summary.cooldownCompletions,
    workspaceSafety: samples.every(
      (sample) => sample.entries.length === protocol.manifest.cases.length,
    ),
  };
  const report: PilotConsensusReport = {
    version: 1,
    pilot: protocol.manifest.id,
    status: Object.values(checks).every(Boolean) ? "passed" : "failed",
    manifestHash: protocol.manifestHash,
    samples: 3,
    quorum: 2,
    cases,
    summary,
    checks,
    sampleArtifacts: samples.map((sample, index) => ({
      sample: index + 1,
      directory: sample.directory,
      reportSha256: sample.reportSha256,
      responsesSha256: sample.responsesSha256,
    })),
  };
  await mkdir(resolve(input.outputDirectory), { recursive: true });
  const reportPath = resolve(input.outputDirectory, "consensus-report.json");
  await Promise.all([
    atomicWriteJson(reportPath, report),
    atomicWriteText(
      resolve(input.outputDirectory, "consensus-report.md"),
      renderPilotConsensusReport(report),
    ),
  ]);
  return { report, reportPath };
}

export function renderPilotConsensusReport(
  report: PilotConsensusReport,
): string {
  return [
    `# ${report.pilot} consensus`,
    "",
    `- Status: ${report.status}`,
    `- Manifest SHA-256: ${report.manifestHash}`,
    `- Quorum: ${report.quorum}/${report.samples}`,
    "",
    "| Case | Outcome | Quorum | Supporting samples | Hidden | False resolution |",
    "| --- | --- | ---: | --- | ---: | ---: |",
    ...report.cases.map(
      (entry) =>
        `| ${entry.id} | ${entry.selectedOutcome ?? "no-quorum"} | ${entry.reached} | ${entry.supportingSamples.join(",")} | ${entry.hiddenCasesPassed}/${entry.hiddenCases} | ${entry.falseResolution} |`,
    ),
    "",
    "## Summary",
    "",
    `- Quorum reached: ${report.summary.quorumReached}/${report.summary.cases}`,
    `- Resolved: ${report.summary.resolved}`,
    `- Unresolved: ${report.summary.unresolved}`,
    `- No quorum: ${report.summary.noQuorum}`,
    `- Hidden cases: ${report.summary.hiddenCasesPassed}/${report.summary.hiddenCases}`,
    `- False resolutions: ${report.summary.falseResolutions}`,
    `- API attempts / cooldowns: ${report.summary.apiAttempts}/${report.summary.cooldownCompletions}`,
    `- Input / output tokens: ${report.summary.inputTokens}/${report.summary.outputTokens}`,
    `- Provider latency ms: ${report.summary.providerLatencyMs}`,
    `- Estimated cost: ${report.summary.estimatedCost}`,
    ...Object.entries(report.checks).map(
      ([name, passed]) => `- ${name}: ${passed}`,
    ),
    "",
  ].join("\n");
}

function evaluateVote(
  sample: number,
  response: OpenAIResult,
  source: Awaited<ReturnType<typeof scanSemanticSource>>,
): {
  sample: number;
  outcome: "resolved" | "unresolved" | "error";
  eligible: boolean;
  signature: string | null;
  error: string | null;
  elaboration: ElaborationResult | null;
} {
  try {
    const elaboration = parseElaborationResult(
      parseBoundedJsonText(
        response.outputText,
        `Pilot consensus response sample ${sample}`,
      ),
    );
    if (elaboration.outcome === "unresolved") {
      return {
        sample,
        outcome: "unresolved",
        eligible: true,
        signature: "unresolved",
        error: null,
        elaboration,
      };
    }
    validatePredicateContext(elaboration.body, source);
    return {
      sample,
      outcome: "resolved",
      eligible: true,
      signature: predicateSemanticSignature(
        elaboration.body,
        source.concept.typeSchema,
      ).signature,
      error: null,
      elaboration,
    };
  } catch (error) {
    return {
      sample,
      outcome: "error",
      eligible: false,
      signature: null,
      error: error instanceof Error ? error.message : String(error),
      elaboration: null,
    };
  }
}

function scoreSelected(
  elaboration: ElaborationResult | null,
  hiddenCases: PilotHiddenCase[],
): number {
  if (elaboration === null || elaboration.outcome !== "resolved") return 0;
  return hiddenCases.filter(
    (entry) =>
      evaluateExpression(elaboration.body, entry.input) === entry.expected,
  ).length;
}

async function readSample(
  directoryInput: string,
  sample: number,
  manifestHash: string,
): Promise<SampleInput> {
  const directory = resolve(directoryInput);
  const reportData = await readFile(resolve(directory, "report.json"));
  const responsesData = await readFile(resolve(directory, "responses.json"));
  const report = recordValue(
    parseBoundedJsonText(
      reportData.toString("utf8"),
      `Pilot sample ${sample} report`,
      SEMANTIC_LIMITS.externalJsonBytes,
    ),
    `Pilot sample ${sample} report`,
  );
  const authoritative = recordValue(
    report.authoritativeInput,
    `Pilot sample ${sample} authoritativeInput`,
  );
  if (
    report.version !== 1 ||
    report.mode !== "live" ||
    report.status !== "passed" ||
    authoritative.manifestHash !== manifestHash ||
    authoritative.freezeStatus !== "frozen"
  ) {
    throw new Error(`Pilot sample ${sample} is not a matching passed live run`);
  }
  const metrics = recordValue(
    report.executionMetrics,
    `Pilot sample ${sample} executionMetrics`,
  );
  const parsedResponses = parseBoundedJsonText(
    responsesData.toString("utf8"),
    `Pilot sample ${sample} responses`,
    SEMANTIC_LIMITS.externalJsonBytes,
  );
  if (!Array.isArray(parsedResponses)) {
    throw new Error(`Pilot sample ${sample} responses must be an array`);
  }
  return {
    entries: parsedResponses.map((entry, index) =>
      parseSampleEntry(entry, sample, index),
    ),
    metrics: {
      apiAttempts: nonNegativeInteger(
        metrics.apiAttempts,
        `Pilot sample ${sample} apiAttempts`,
      ),
      cooldownCompletions: nonNegativeInteger(
        metrics.cooldownCompletions,
        `Pilot sample ${sample} cooldownCompletions`,
      ),
      estimatedCost: nonNegativeNumber(
        metrics.estimatedCost,
        `Pilot sample ${sample} estimatedCost`,
      ),
    },
    reportSha256: sha256(reportData),
    responsesSha256: sha256(responsesData),
    directory,
  };
}

function parseSampleEntry(
  input: unknown,
  sample: number,
  index: number,
): SampleEntry {
  const path = `Pilot sample ${sample} responses[${index}]`;
  const value = recordValue(input, path);
  assertExactKeys(value, ["caseId", "status", "response", "latencyMs"], path);
  if (value.status !== "completed") {
    throw new Error(`${path}.status must be completed`);
  }
  const responseValue = recordValue(value.response, `${path}.response`);
  assertExactKeys(
    responseValue,
    ["responseId", "model", "outputText", "usage"],
    `${path}.response`,
  );
  const usage = recordValue(responseValue.usage, `${path}.response.usage`);
  assertExactKeys(
    usage,
    ["inputTokens", "outputTokens", "totalTokens"],
    `${path}.response.usage`,
  );
  return {
    caseId: trimmedString(value.caseId, `${path}.caseId`),
    response: {
      responseId: trimmedString(
        responseValue.responseId,
        `${path}.response.responseId`,
      ),
      model: trimmedString(responseValue.model, `${path}.response.model`),
      outputText: trimmedString(
        responseValue.outputText,
        `${path}.response.outputText`,
      ),
      usage: {
        inputTokens: nonNegativeInteger(
          usage.inputTokens,
          `${path}.response.usage.inputTokens`,
        ),
        outputTokens: nonNegativeInteger(
          usage.outputTokens,
          `${path}.response.usage.outputTokens`,
        ),
        totalTokens: nonNegativeInteger(
          usage.totalTokens,
          `${path}.response.usage.totalTokens`,
        ),
      },
    },
    latencyMs: nonNegativeNumber(value.latencyMs, `${path}.latencyMs`),
  };
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicWriteText(path: string, value: string): Promise<void> {
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  await writeFile(temporary, value, "utf8");
  await rename(temporary, path);
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

function nonNegativeInteger(input: unknown, path: string): number {
  if (!Number.isSafeInteger(input) || Number(input) < 0) {
    throw new Error(`${path} must be a non-negative safe integer`);
  }
  return Number(input);
}

function nonNegativeNumber(input: unknown, path: string): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) {
    throw new Error(`${path} must be a non-negative finite number`);
  }
  return input;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
