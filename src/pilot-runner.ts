import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { validatePredicateContext } from "./context-validator";
import { evaluateExpression } from "./cross-schema-benchmark";
import { parsePredicateExpression, type PredicateExpression } from "./ir";
import {
  type PilotCase,
  readPilotFrozenJson,
  readPilotProtocol,
  type PilotProtocol,
} from "./pilot-manifest";
import {
  type PilotCaseResult,
  type PilotReport,
  renderPilotReport,
  summarizePilotCases,
} from "./pilot-report";
import { predicateRequestShape, sha256 } from "./semantic-fingerprint";
import { assertKnownKeys } from "./semantic-limits";
import { scanSemanticSource } from "./semantic-source";

export type PilotModelInput = {
  version: 1;
  caseId: string;
  domain: string;
  specification: string;
  typeScriptSource: string;
  target: {
    functionName: string;
    parameterName: string;
    typeName: string;
  };
};

export type RunPilotFixtureOptions = {
  manifestPath: string;
  reportRoot?: string;
  onModelInput?: (input: PilotModelInput) => void;
};

export async function runPilotFixture(
  options: RunPilotFixtureOptions,
): Promise<{ report: PilotReport; reportDirectory: string }> {
  const protocol = await readPilotProtocol(options.manifestPath);
  const before = await snapshotFrozenInputs(protocol);
  const results: PilotCaseResult[] = [];

  for (const pilotCase of protocol.manifest.cases) {
    const source = await scanSemanticSource(
      resolve(protocol.directory, pilotCase.source),
    );
    const request = predicateRequestShape(source);
    options.onModelInput?.({
      version: 1,
      caseId: pilotCase.id,
      domain: pilotCase.domain,
      specification: request.specification,
      typeScriptSource: request.typeScriptSource,
      target: request.target,
    });
    const fixture = parseFixtureCase(
      await readPilotFrozenJson(
        protocol,
        pilotCase.fixture,
        `Pilot fixture ${pilotCase.id}`,
      ),
      pilotCase.id,
    );
    const hiddenCases = parsePilotHiddenCaseSet(
      await readPilotFrozenJson(
        protocol,
        pilotCase.hiddenCases,
        `Pilot hidden cases ${pilotCase.id}`,
      ),
      pilotCase.id,
    );
    results.push(evaluateFixtureCase(pilotCase, source, fixture, hiddenCases));
  }

  const after = await snapshotFrozenInputs(protocol);
  const workspaceMutations = Object.keys(before).filter(
    (file) => before[file] !== after[file],
  ).length;
  const summary = summarizePilotCases(results);
  const checks = {
    exactCaseCount: summary.total === 8,
    firstPassProjectFit:
      summary.firstPassProjectFitRate >=
      protocol.manifest.thresholds.minFirstPassProjectFitRate,
    unresolvedRate:
      rate(summary.unresolved, summary.total) <=
      protocol.manifest.thresholds.maxUnresolvedRate,
    falseResolutionSafety:
      summary.falseResolutions <=
      protocol.manifest.thresholds.maxFalseResolutions,
    hiddenCaseSafety: results
      .filter((entry) => entry.outcome === "resolved")
      .every((entry) => entry.hiddenCasesPassed === entry.hiddenCases),
    workspaceIntegrity: workspaceMutations === 0,
    shadowMode:
      !protocol.manifest.execution.businessWritesAllowed &&
      !protocol.manifest.execution.externalIoAllowed,
  };
  const passed = Object.values(checks).every(Boolean);
  const report: PilotReport = {
    version: 1,
    pilot: protocol.manifest.id,
    status: passed ? "fixture-passed" : "fixture-failed",
    mode: "fixture",
    provider: "fixture",
    model: "fixture",
    authoritativeInput: {
      manifestHash: protocol.manifestHash,
      freezeStatus: protocol.freeze.status,
    },
    executionMetrics: {
      apiAttempts: 0,
      cooldownCompletions: 0,
      estimatedCost: 0,
      costPerMillionTokens: { input: 0, output: 0 },
    },
    cases: results,
    summary,
    safety: {
      escapedFalseResolutions: 0,
      businessWrites: 0,
      externalIo: 0,
      workspaceMutations,
      cooldownViolations: 0,
      confidentialDataIncidents: 0,
    },
    checks,
  };
  const reportRoot = resolve(
    options.reportRoot ??
      resolve(protocol.directory, "..", "..", ".semantic", "pilots"),
  );
  const reportDirectory = resolve(
    reportRoot,
    `${safeName(protocol.manifest.id)}-fixture-${protocol.manifestHash.slice(0, 12)}`,
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
      renderPilotReport(report),
      "utf8",
    ),
  ]);
  return { report, reportDirectory };
}

export async function executePilotAttemptWithRetry<T>(input: {
  execute: () => Promise<T>;
  cooldownMs: 60_000;
  maxRateLimitRetries: number;
  wait?: (milliseconds: number) => Promise<void>;
  onAttempt?: (attempt: number) => void;
}): Promise<T> {
  if (
    !Number.isSafeInteger(input.maxRateLimitRetries) ||
    input.maxRateLimitRetries < 0
  ) {
    throw new Error("Pilot maxRateLimitRetries must be a non-negative integer");
  }
  const wait =
    input.wait ??
    ((milliseconds) =>
      new Promise<void>((done) => setTimeout(done, milliseconds)));
  let rateLimitRetries = 0;
  let attempt = 0;
  while (true) {
    attempt += 1;
    input.onAttempt?.(attempt);
    try {
      return await input.execute();
    } catch (error) {
      if (
        !isRateLimitError(error) ||
        rateLimitRetries >= input.maxRateLimitRetries
      ) {
        throw error;
      }
      rateLimitRetries += 1;
    } finally {
      await wait(input.cooldownMs);
    }
  }
}

type FixtureCase = {
  outcome: "resolved" | "unresolved" | "error";
  body: PredicateExpression | null;
  diagnostics: string[];
  correctionEffort: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  baselineWorkMs: number;
  semanticWorkMs: number;
};

export type PilotHiddenCase = {
  name: string;
  input: Record<string, unknown>;
  expected: boolean;
};

function evaluateFixtureCase(
  pilotCase: PilotCase,
  source: Awaited<ReturnType<typeof scanSemanticSource>>,
  fixture: FixtureCase,
  hiddenCases: PilotHiddenCase[],
): PilotCaseResult {
  if (fixture.outcome !== "resolved" || fixture.body === null) {
    return {
      id: pilotCase.id,
      domain: pilotCase.domain,
      outcome: fixture.outcome,
      contextValid: null,
      hiddenCases: hiddenCases.length,
      hiddenCasesPassed: 0,
      firstPassProjectFit: false,
      falseResolution: false,
      correctionEffort: fixture.correctionEffort,
      inputTokens: fixture.inputTokens,
      outputTokens: fixture.outputTokens,
      latencyMs: fixture.latencyMs,
      baselineWorkMs: fixture.baselineWorkMs,
      semanticWorkMs: fixture.semanticWorkMs,
      error:
        fixture.outcome === "error"
          ? fixture.diagnostics.join("; ") || "fixture error"
          : null,
    };
  }
  const body = fixture.body;
  let contextValid = true;
  let error: string | null = null;
  try {
    validatePredicateContext(body, source);
  } catch (caught) {
    contextValid = false;
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const hiddenCasesPassed = hiddenCases.filter(
    (entry) => evaluateExpression(body, entry.input) === entry.expected,
  ).length;
  const hiddenPassed = hiddenCasesPassed === hiddenCases.length;
  const firstPassProjectFit =
    contextValid && hiddenPassed && fixture.correctionEffort === 0;
  return {
    id: pilotCase.id,
    domain: pilotCase.domain,
    outcome: fixture.outcome,
    contextValid,
    hiddenCases: hiddenCases.length,
    hiddenCasesPassed,
    firstPassProjectFit,
    falseResolution: !hiddenPassed,
    correctionEffort: fixture.correctionEffort,
    inputTokens: fixture.inputTokens,
    outputTokens: fixture.outputTokens,
    latencyMs: fixture.latencyMs,
    baselineWorkMs: fixture.baselineWorkMs,
    semanticWorkMs: fixture.semanticWorkMs,
    error,
  };
}

function parseFixtureCase(input: unknown, caseId: string): FixtureCase {
  const root = recordValue(input, "Pilot fixtures");
  assertExactKeys(root, ["version", "cases"], "Pilot fixtures");
  if (root.version !== 1) {
    throw new Error("Pilot fixtures.version must be 1");
  }
  const cases = recordValue(root.cases, "Pilot fixtures.cases");
  const value = recordValue(cases[caseId], `Pilot fixtures.cases.${caseId}`);
  assertExactKeys(
    value,
    [
      "outcome",
      "body",
      "diagnostics",
      "correctionEffort",
      "inputTokens",
      "outputTokens",
      "latencyMs",
      "baselineWorkMs",
      "semanticWorkMs",
    ],
    `Pilot fixtures.cases.${caseId}`,
  );
  if (
    value.outcome !== "resolved" &&
    value.outcome !== "unresolved" &&
    value.outcome !== "error"
  ) {
    throw new Error(`Pilot fixture ${caseId}.outcome is invalid`);
  }
  const body =
    value.outcome === "resolved"
      ? parsePredicateExpression(value.body, `Pilot fixture ${caseId}.body`)
      : nullValue(value.body, `Pilot fixture ${caseId}.body`);
  return {
    outcome: value.outcome,
    body,
    diagnostics: stringList(
      value.diagnostics,
      `Pilot fixture ${caseId}.diagnostics`,
    ),
    correctionEffort: nonNegativeInteger(
      value.correctionEffort,
      `Pilot fixture ${caseId}.correctionEffort`,
    ),
    inputTokens: nonNegativeInteger(
      value.inputTokens,
      `Pilot fixture ${caseId}.inputTokens`,
    ),
    outputTokens: nonNegativeInteger(
      value.outputTokens,
      `Pilot fixture ${caseId}.outputTokens`,
    ),
    latencyMs: nonNegativeNumber(
      value.latencyMs,
      `Pilot fixture ${caseId}.latencyMs`,
    ),
    baselineWorkMs: nonNegativeNumber(
      value.baselineWorkMs,
      `Pilot fixture ${caseId}.baselineWorkMs`,
    ),
    semanticWorkMs: nonNegativeNumber(
      value.semanticWorkMs,
      `Pilot fixture ${caseId}.semanticWorkMs`,
    ),
  };
}

export function parsePilotHiddenCaseSet(
  input: unknown,
  caseId: string,
): PilotHiddenCase[] {
  const root = recordValue(input, "Pilot hidden cases");
  assertExactKeys(root, ["version", "cases"], "Pilot hidden cases");
  if (root.version !== 1) {
    throw new Error("Pilot hidden cases.version must be 1");
  }
  const cases = recordValue(root.cases, "Pilot hidden cases.cases");
  const values = cases[caseId];
  if (!Array.isArray(values) || values.length < 2 || values.length > 32) {
    throw new Error(
      `Pilot hidden cases ${caseId} must contain between 2 and 32 items`,
    );
  }
  return values.map((entry, index) => {
    const path = `Pilot hidden cases ${caseId}[${index}]`;
    const value = recordValue(entry, path);
    assertExactKeys(value, ["name", "input", "expected"], path);
    if (typeof value.expected !== "boolean") {
      throw new Error(`${path}.expected must be a boolean`);
    }
    return {
      name: trimmedString(value.name, `${path}.name`),
      input: recordValue(value.input, `${path}.input`),
      expected: value.expected,
    };
  });
}

async function snapshotFrozenInputs(
  protocol: PilotProtocol,
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    Object.keys(protocol.freeze.files).map(async (file) => [
      file,
      sha256(await readFile(resolve(protocol.directory, file))),
    ]),
  );
  return Object.fromEntries(entries);
}

function isRateLimitError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 429
  );
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

function nullValue(input: unknown, path: string): null {
  if (input !== null) throw new Error(`${path} must be null`);
  return null;
}

function stringList(input: unknown, path: string): string[] {
  if (
    !Array.isArray(input) ||
    !input.every((entry) => typeof entry === "string")
  ) {
    throw new Error(`${path} must be an array of strings`);
  }
  return input;
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

function rate(value: number, total: number): number {
  return total === 0 ? 0 : value / total;
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}
