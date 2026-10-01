import { parseProjectContext } from "./project-context";
import { validatePredicateContext } from "./context-validator";
import { parseElaborationResult } from "./elaboration-result";
import type { OpenAIResult } from "./openai";
import type {
  SemanticCompileOptions,
  SemanticResolution,
} from "./semantic-compiler";
import { sha256, stableJson } from "./semantic-fingerprint";
import { SEMANTIC_LIMITS } from "./semantic-limits";
import { createRedCertificate } from "./semantic-red-certificate";
import type { SemanticSource } from "./semantic-source";
import {
  evaluatePredicateExpression,
  evaluateSemanticTestPlan,
} from "./semantic-test-generator";
import type { ValidatedSemanticTestPlan } from "./semantic-test-ir";
import {
  extensionHash,
  extensionInteger,
  extensionKeys,
  extensionNumber,
  extensionRecord,
} from "./semantic-tdd-extension-contract";
import {
  createSingleCandidateSelectionReport,
  parseSemanticTddSelectionReport,
  type SemanticTddSelectionReportV1,
} from "./semantic-tdd-selection-report";

export type BestOfNConfig = {
  version: 1;
  candidates: number;
  maxOutputTokensPerCall: number;
  maxTotalTokens: number;
  timeoutMs: number;
  maxCostUsd: number;
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
};
export type BestOfNRequest = Parameters<
  NonNullable<SemanticCompileOptions["resolve"]>
>[0];
export type BestOfNResolution = {
  elaboration: unknown;
  rawOutput: unknown;
  response: OpenAIResult | null;
};
export type BestOfNTrial = {
  id: string;
  output: unknown;
  rawOutput: unknown;
  response: OpenAIResult | null;
  failure: "provider-error" | "invalid-output" | null;
};
export type SemanticTddBestOfNReport = Omit<
  SemanticTddSelectionReportV1,
  "version"
> & {
  version: 2;
  config: BestOfNConfig;
  request: BestOfNRequest;
  requestHash: string;
  trialsHash: string;
  candidateFailures: {
    id: string;
    stage:
      | "provider-error"
      | "invalid-output"
      | "unresolved"
      | "context-validation"
      | "hard-test"
      | "mutation-test"
      | "eligible";
  }[];
  fixture: boolean;
  trials: BestOfNTrial[];
  resourceFailure: string | null;
  apiCalls: number;
  totalTokens: number;
  estimatedCostUsd: number;
};

export function parseBestOfNConfig(input: unknown): BestOfNConfig {
  const v = extensionRecord(input, "bestOfN");
  extensionKeys(
    v,
    [
      "version",
      "candidates",
      "maxOutputTokensPerCall",
      "maxTotalTokens",
      "timeoutMs",
      "maxCostUsd",
      "inputUsdPerMillionTokens",
      "outputUsdPerMillionTokens",
    ],
    "bestOfN",
  );
  if (v.version !== 1) throw new Error("bestOfN.version must be 1");
  return {
    version: 1,
    candidates: extensionInteger(v.candidates, 1, 5, "bestOfN.candidates"),
    maxOutputTokensPerCall: extensionInteger(
      v.maxOutputTokensPerCall,
      1,
      8192,
      "bestOfN.maxOutputTokensPerCall",
    ),
    maxTotalTokens: extensionInteger(
      v.maxTotalTokens,
      1,
      1_000_000,
      "bestOfN.maxTotalTokens",
    ),
    timeoutMs: extensionInteger(v.timeoutMs, 1, 120_000, "bestOfN.timeoutMs"),
    maxCostUsd: extensionNumber(
      v.maxCostUsd,
      0.000001,
      100,
      "bestOfN.maxCostUsd",
    ),
    inputUsdPerMillionTokens: extensionNumber(
      v.inputUsdPerMillionTokens,
      0.000001,
      1000,
      "bestOfN.inputUsdPerMillionTokens",
    ),
    outputUsdPerMillionTokens: extensionNumber(
      v.outputUsdPerMillionTokens,
      0.000001,
      1000,
      "bestOfN.outputUsdPerMillionTokens",
    ),
  };
}

export async function collectBestOfNCandidates(input: {
  config: BestOfNConfig;
  request: BestOfNRequest;
  fixture: boolean;
  resolve: (
    request: BestOfNRequest,
    limits: { maxOutputTokens: number; signal: AbortSignal },
  ) => Promise<BestOfNResolution>;
}): Promise<{ trials: BestOfNTrial[]; resourceFailure: string | null }> {
  const config = parseBestOfNConfig(input.config);
  if (
    Buffer.byteLength(stableJson(input.request)) >
    SEMANTIC_LIMITS.externalJsonBytes
  )
    throw new Error("Best-of-N request exceeds size limit");
  const trials: BestOfNTrial[] = [];
  let resourceFailure: string | null = null;
  for (let i = 0; i < config.candidates; i++) {
    const spent = accountTrials(trials, config, input.fixture);
    if (
      !input.fixture &&
      (spent.totalTokens >= config.maxTotalTokens ||
        spent.estimatedCostUsd >= config.maxCostUsd)
    ) {
      resourceFailure =
        spent.totalTokens >= config.maxTotalTokens
          ? "total-token-budget"
          : "cost-budget";
      break;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const resolution = await Promise.race([
        input.resolve(structuredClone(input.request), {
          maxOutputTokens: config.maxOutputTokensPerCall,
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("candidate timeout"));
          }, config.timeoutMs);
        }),
      ]);
      const serialized = JSON.stringify({
        output: resolution.elaboration ?? null,
        rawOutput: resolution.rawOutput ?? null,
        response: resolution.response,
      });
      if (Buffer.byteLength(serialized) > SEMANTIC_LIMITS.externalJsonBytes)
        throw new Error("candidate output exceeds size limit");
      const normalized = JSON.parse(serialized) as {
        output?: unknown;
        rawOutput?: unknown;
        response: unknown;
      };
      const output = normalized.output ?? null;
      const rawOutput = normalized.rawOutput ?? null;
      const response = parseStoredResponse(normalized.response);
      let failure: BestOfNTrial["failure"] = null;
      try {
        parseElaborationResult(output);
      } catch {
        failure = "invalid-output";
      }
      trials.push({
        id: `candidate-${i + 1}`,
        output,
        rawOutput,
        response,
        failure,
      });
      if (!input.fixture) {
        const usage = response?.usage;
        if (usage === null || usage === undefined)
          resourceFailure = "missing-usage";
        else if (usage.outputTokens > config.maxOutputTokensPerCall)
          resourceFailure = "output-token-budget";
        const totals = accountTrials(trials, config, false);
        if (totals.totalTokens > config.maxTotalTokens)
          resourceFailure = "total-token-budget";
        if (totals.estimatedCostUsd > config.maxCostUsd)
          resourceFailure = "cost-budget";
      }
    } catch {
      trials.push({
        id: `candidate-${i + 1}`,
        output: null,
        rawOutput: null,
        response: null,
        failure: "provider-error",
      });
      // A sent live call with unknown usage cannot safely be retried or ignored.
      if (!input.fixture) resourceFailure = "unknown-call-usage";
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
    if (resourceFailure !== null) break;
  }
  return { trials, resourceFailure };
}

export function evaluateBestOfN(input: {
  source: SemanticSource;
  validated: ValidatedSemanticTestPlan;
  config: BestOfNConfig;
  request: BestOfNRequest;
  fixture: boolean;
  trials: BestOfNTrial[];
  resourceFailure: string | null;
}): { report: SemanticTddBestOfNReport; selected: SemanticResolution | null } {
  const config = parseBestOfNConfig(input.config);
  const totals = accountTrials(input.trials, config, input.fixture);
  const candidateFailures: SemanticTddBestOfNReport["candidateFailures"] = [];
  const candidates: SemanticTddSelectionReportV1["candidates"] = [];
  const resolutions = new Map<string, SemanticResolution>();
  const reds = new Map<string, string>();
  for (const trial of input.trials) {
    if (trial.failure !== null) {
      candidateFailures.push({ id: trial.id, stage: trial.failure });
      continue;
    }
    const elaboration = parseElaborationResult(trial.output);
    if (elaboration.outcome !== "resolved") {
      candidateFailures.push({ id: trial.id, stage: "unresolved" });
      continue;
    }
    const signature = sha256(stableJson(elaboration.body));
    let hardPassed = false;
    let mutationPassed = false;
    let mutationScore = 0;
    let stage: SemanticTddBestOfNReport["candidateFailures"][number]["stage"] =
      "context-validation";
    let redHash = "0".repeat(64);
    try {
      validatePredicateContext(elaboration.body, input.source);
      const result = evaluateSemanticTestPlan(input.validated.plan, (value) =>
        evaluatePredicateExpression(elaboration.body, value),
      );
      hardPassed = result.hardPassed;
      stage = "hard-test";
      const red = createRedCertificate({
        plan: input.validated.plan,
        testPlanHash: input.validated.testPlanHash,
        typeSchema: input.source.concept.typeSchema,
        hardClauseCoverage: input.validated.hardClauseCoverage,
        implementation: elaboration.body,
      });
      mutationScore = red.certificate.mutationScore;
      mutationPassed = !red.certificate.mutants.some(
        (m) => m.classification === "survived",
      );
      redHash = red.redCertificateHash;
      stage = !hardPassed
        ? "hard-test"
        : !mutationPassed
          ? "mutation-test"
          : "eligible";
    } catch {
      hardPassed = false;
    }
    const single = createSingleCandidateSelectionReport({
      contractHash: input.validated.plan.contractHash,
      testPlanHash: input.validated.testPlanHash,
      redCertificateHash: redHash,
      candidateId: trial.id,
      expression: elaboration.body,
      hardPassed,
      mutationPassed,
      mutationScore,
    });
    const candidate = single.candidates[0];
    if (candidate === undefined) throw new Error("missing candidate metrics");
    candidateFailures.push({ id: trial.id, stage });
    candidates.push(candidate);
    resolutions.set(trial.id, {
      elaboration,
      rawOutput: trial.rawOutput,
      response: trial.response,
    });
    reds.set(trial.id, redHash);
    if (candidate.semanticSignature !== signature)
      throw new Error("candidate signature mismatch");
  }
  const ranked = candidates
    .filter((c) => c.hardPassed && c.mutationPassed)
    .sort(
      (a, b) =>
        b.mutationScore - a.mutationScore ||
        a.irNodeCount - b.irNodeCount ||
        a.irDepth - b.irDepth ||
        compare(a.semanticSignature, b.semanticSignature) ||
        compare(a.id, b.id),
    );
  const winner = input.resourceFailure === null ? ranked[0] : undefined;
  const report: SemanticTddBestOfNReport = {
    version: 2,
    contractHash: input.validated.plan.contractHash,
    testPlanHash: input.validated.testPlanHash,
    redCertificateHash:
      winner === undefined
        ? "0".repeat(64)
        : (reds.get(winner.id) ?? "0".repeat(64)),
    candidates,
    selectedCandidate: winner?.id ?? null,
    outcome: winner === undefined ? "unresolved" : "selected",
    config,
    request: structuredClone(input.request),
    requestHash: sha256(stableJson(input.request)),
    trialsHash: sha256(stableJson(input.trials)),
    candidateFailures,
    fixture: input.fixture,
    trials: structuredClone(input.trials),
    resourceFailure: input.resourceFailure,
    ...totals,
  };
  return {
    report,
    selected:
      winner === undefined ? null : (resolutions.get(winner.id) ?? null),
  };
}

export function parseBestOfNReport(input: unknown): SemanticTddBestOfNReport {
  const v = extensionRecord(input, "selectionReport");
  extensionKeys(
    v,
    [
      "version",
      "contractHash",
      "testPlanHash",
      "redCertificateHash",
      "candidates",
      "selectedCandidate",
      "outcome",
      "config",
      "request",
      "requestHash",
      "trialsHash",
      "candidateFailures",
      "fixture",
      "trials",
      "resourceFailure",
      "apiCalls",
      "totalTokens",
      "estimatedCostUsd",
    ],
    "selectionReport",
  );
  const {
    config,
    request,
    requestHash,
    trialsHash,
    candidateFailures,
    fixture,
    trials,
    resourceFailure,
    apiCalls,
    totalTokens,
    estimatedCostUsd,
    ...baseInput
  } = v;
  if (baseInput.version !== 2 || typeof fixture !== "boolean")
    throw new Error("invalid Best-of-N report version/fixture");
  const parsedConfig = parseBestOfNConfig(config);
  if (
    !Array.isArray(trials) ||
    trials.length < 1 ||
    trials.length > parsedConfig.candidates
  )
    throw new Error("invalid candidate trial count");
  const parsedTrials = trials.map((t, index): BestOfNTrial => {
    const trial = extensionRecord(t, "trial");
    extensionKeys(
      trial,
      ["id", "output", "rawOutput", "response", "failure"],
      "trial",
    );
    if (trial.id !== `candidate-${index + 1}`)
      throw new Error("invalid trial ID/order");
    if (
      trial.failure !== null &&
      trial.failure !== "provider-error" &&
      trial.failure !== "invalid-output"
    )
      throw new Error("invalid trial failure");
    if (trial.failure === null) parseElaborationResult(trial.output);
    const response = parseStoredResponse(trial.response);
    if (
      Buffer.byteLength(JSON.stringify(trial)) >
      SEMANTIC_LIMITS.externalJsonBytes
    )
      throw new Error("trial exceeds size limit");
    return {
      id: trial.id as string,
      output: trial.output,
      rawOutput: trial.rawOutput,
      response,
      failure: trial.failure,
    };
  });
  if (
    resourceFailure !== null &&
    ![
      "missing-usage",
      "output-token-budget",
      "total-token-budget",
      "cost-budget",
      "unknown-call-usage",
    ].includes(String(resourceFailure))
  )
    throw new Error("invalid resource failure");
  if (
    resourceFailure === null &&
    parsedTrials.length !== parsedConfig.candidates
  )
    throw new Error("incomplete candidate collection");
  if (
    !Array.isArray(candidateFailures) ||
    candidateFailures.length !== parsedTrials.length
  )
    throw new Error("invalid candidate failure classifications");
  const parsedFailures = candidateFailures.map((input, index) => {
    const v = extensionRecord(input, "candidate failure");
    extensionKeys(v, ["id", "stage"], "candidate failure");
    if (
      v.id !== parsedTrials[index]?.id ||
      ![
        "provider-error",
        "invalid-output",
        "unresolved",
        "context-validation",
        "hard-test",
        "mutation-test",
        "eligible",
      ].includes(String(v.stage))
    )
      throw new Error("invalid candidate failure stage");
    return {
      id: v.id as string,
      stage:
        v.stage as SemanticTddBestOfNReport["candidateFailures"][number]["stage"],
    };
  });
  if (
    Buffer.byteLength(stableJson(request)) > SEMANTIC_LIMITS.externalJsonBytes
  )
    throw new Error("Best-of-N request exceeds size limit");
  const req = extensionRecord(request, "selection request");
  const mandatory = [
    "specification",
    "typeScriptSource",
    "functionName",
    "parameterName",
    "typeName",
  ];
  extensionKeys(
    req,
    [
      ...mandatory,
      ...(Object.hasOwn(req, "projectContext") ? ["projectContext"] : []),
    ],
    "selection request",
  );
  for (const key of mandatory)
    if (typeof req[key] !== "string")
      throw new Error("invalid selection request");
  if (extensionHash(requestHash, "requestHash") !== sha256(stableJson(request)))
    throw new Error("selection request hash mismatch");
  if (
    extensionHash(trialsHash, "trialsHash") !== sha256(stableJson(parsedTrials))
  )
    throw new Error("candidate evidence hash mismatch");
  const totals = accountTrials(parsedTrials, parsedConfig, fixture);
  if (
    apiCalls !== totals.apiCalls ||
    totalTokens !== totals.totalTokens ||
    estimatedCostUsd !== totals.estimatedCostUsd
  )
    throw new Error("selection resource accounting mismatch");
  if (
    resourceFailure === null &&
    !fixture &&
    (parsedTrials.some(
      (t) =>
        t.response?.usage === null ||
        t.response === null ||
        (t.response?.usage?.outputTokens ?? 0) >
          parsedConfig.maxOutputTokensPerCall,
    ) ||
      totals.totalTokens > parsedConfig.maxTotalTokens ||
      totals.estimatedCostUsd > parsedConfig.maxCostUsd)
  )
    throw new Error("selection resource budget invalid");
  // v1's structural checks allow an empty metric list only for an unresolved v2 collection.
  const base =
    Array.isArray(baseInput.candidates) &&
    baseInput.candidates.length === 0 &&
    baseInput.outcome === "unresolved" &&
    baseInput.selectedCandidate === null
      ? {
          version: 1 as const,
          contractHash: extensionHash(baseInput.contractHash, "contractHash"),
          testPlanHash: extensionHash(baseInput.testPlanHash, "testPlanHash"),
          redCertificateHash: extensionHash(
            baseInput.redCertificateHash,
            "redCertificateHash",
          ),
          candidates: [],
          selectedCandidate: null,
          outcome: "unresolved" as const,
        }
      : parseSemanticTddSelectionReport({ ...baseInput, version: 1 });
  return {
    ...base,
    version: 2,
    config: parsedConfig,
    request: request as BestOfNRequest,
    requestHash: requestHash as string,
    trialsHash: trialsHash as string,
    candidateFailures: parsedFailures,
    fixture,
    trials: parsedTrials,
    resourceFailure: resourceFailure as string | null,
    ...totals,
  };
}

function accountTrials(
  trials: BestOfNTrial[],
  config: BestOfNConfig,
  fixture: boolean,
): { apiCalls: number; totalTokens: number; estimatedCostUsd: number } {
  if (fixture) return { apiCalls: 0, totalTokens: 0, estimatedCostUsd: 0 };
  let totalTokens = 0;
  let estimatedCostUsd = 0;
  for (const trial of trials) {
    const usage = trial.response?.usage;
    if (usage === null || usage === undefined) continue;
    totalTokens += usage.totalTokens;
    estimatedCostUsd +=
      (usage.inputTokens * config.inputUsdPerMillionTokens +
        usage.outputTokens * config.outputUsdPerMillionTokens) /
      1_000_000;
  }
  return { apiCalls: trials.length, totalTokens, estimatedCostUsd };
}

function parseStoredResponse(input: unknown): OpenAIResult | null {
  if (input === null) return null;
  const v = extensionRecord(input, "candidate response");
  extensionKeys(
    v,
    ["responseId", "model", "outputText", "usage"],
    "candidate response",
  );
  for (const key of ["responseId", "model", "outputText"])
    if (typeof v[key] !== "string")
      throw new Error("invalid candidate response");
  let usage: OpenAIResult["usage"] = null;
  if (v.usage !== null) {
    const u = extensionRecord(v.usage, "usage");
    extensionKeys(u, ["inputTokens", "outputTokens", "totalTokens"], "usage");
    usage = {
      inputTokens: extensionInteger(
        u.inputTokens,
        0,
        1_000_000_000,
        "inputTokens",
      ),
      outputTokens: extensionInteger(
        u.outputTokens,
        0,
        1_000_000_000,
        "outputTokens",
      ),
      totalTokens: extensionInteger(
        u.totalTokens,
        0,
        1_000_000_000,
        "totalTokens",
      ),
    };
    if (usage.totalTokens !== usage.inputTokens + usage.outputTokens)
      throw new Error("invalid usage total");
  }
  return {
    responseId: v.responseId as string,
    model: v.model as string,
    outputText: v.outputText as string,
    usage,
  };
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function bestOfNRequest(
  request: BestOfNRequest,
  validated: ValidatedSemanticTestPlan,
): BestOfNRequest {
  return {
    ...request,
    specification: `${request.specification}\n\nFrozen Semantic Test Plan (same for every independent candidate):\n${stableJson(validated.plan)}`,
  };
}

export function verifyBestOfNSelection(
  report: SemanticTddBestOfNReport,
  source: SemanticSource,
  validated: ValidatedSemanticTestPlan,
  expression: import("./ir").PredicateExpression,
  projectContext?: import("./project-context").ProjectContext,
): void {
  const parsed = parseBestOfNReport(report);
  const expectedRequest = bestOfNRequest(
    {
      specification: source.concept.specification,
      typeScriptSource: source.concept.typeDeclaration,
      functionName: source.predicate.name,
      parameterName: source.predicate.parameterName,
      typeName: source.concept.typeName,
    },
    validated,
  );
  for (const key of [
    "specification",
    "typeScriptSource",
    "functionName",
    "parameterName",
    "typeName",
  ] as const) {
    if (parsed.request[key] !== expectedRequest[key])
      throw new Error("Best-of-N input snapshot mismatch");
  }
  if (
    projectContext !== undefined &&
    stableJson(parsed.request.projectContext) !== stableJson(projectContext)
  )
    throw new Error("Best-of-N Project Context snapshot mismatch");
  const replay = evaluateBestOfN({ source, validated, ...parsed });
  if (
    stableJson(replay.report) !== stableJson(parsed) ||
    replay.selected?.elaboration.outcome !== "resolved" ||
    stableJson(replay.selected.elaboration.body) !== stableJson(expression)
  )
    throw new Error("Best-of-N selection replay mismatch");
}
