import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { sha256, workspaceRelativePath } from "./semantic-fingerprint";
import {
  parseBoundedJsonText,
  readBoundedJsonFile,
} from "./semantic-limits";
import {
  buildStaticJudgmentRequest,
  parseStaticJudgmentResolution,
  type StaticJudgmentRequestInput,
  type StaticJudgmentResolution,
} from "./static-judgment";

export type StaticJudgmentBenchmarkManifest = {
  version: 1;
  profile: "fixture" | "held-out";
  name: string;
  repetitions: number;
  freeze: string;
  thresholds: {
    maxFalseResolutions: number;
    maxUnexpectedUnresolved: number;
    minResolvedAccuracy: number;
    minStabilityRate: number;
  };
  cases: StaticJudgmentBenchmarkCase[];
};

export type StaticJudgmentBenchmarkCase = {
  id: string;
  modelInput: string;
  oracle: string;
  fixture: string;
};

export type StaticJudgmentBenchmarkOracle = {
  version: 1;
  expected:
    | { outcome: "resolved"; value: boolean }
    | { outcome: "unresolved"; value: null };
  reason: string;
};

export type StaticJudgmentBenchmarkFixture = {
  version: 1;
  results: StaticJudgmentResolution[];
};

export type StaticJudgmentBenchmarkFreeze = {
  version: 1;
  status: "draft" | "frozen";
  frozenAt: string | null;
  files: Record<string, string>;
};

export type StaticJudgmentBenchmarkProtocol = {
  directory: string;
  manifestPath: string;
  manifest: StaticJudgmentBenchmarkManifest;
  freezePath: string;
  freeze: StaticJudgmentBenchmarkFreeze;
};

export type StaticJudgmentBenchmarkClassification =
  | "passed"
  | "false-resolution"
  | "unexpected-unresolved";

export type StaticJudgmentBenchmarkRun = {
  caseId: string;
  repetition: number;
  expected: StaticJudgmentBenchmarkOracle["expected"];
  actual: {
    outcome: "resolved" | "unresolved";
    value: boolean | null;
  };
  classification: StaticJudgmentBenchmarkClassification;
};

export type StaticJudgmentBenchmarkReport = {
  version: 1;
  benchmark: string;
  profile: "fixture" | "held-out";
  evidenceEligible: boolean;
  status: "passed" | "failed";
  cases: number;
  repetitions: number;
  runs: number;
  metrics: {
    passed: number;
    falseResolutions: number;
    unexpectedUnresolved: number;
    resolvedAccuracy: number;
    stabilityRate: number;
  };
  results: StaticJudgmentBenchmarkRun[];
  apiCalls: 0;
  persistentFilesWritten: 0;
};

export async function loadStaticJudgmentBenchmark(
  manifestPath: string,
): Promise<StaticJudgmentBenchmarkProtocol> {
  const requestedManifestPath = resolve(manifestPath);
  if ((await lstat(requestedManifestPath)).isSymbolicLink()) {
    throw new Error(
      "Static Judgment benchmark manifest must not use a symbolic link",
    );
  }
  const canonicalManifestPath = await realpath(requestedManifestPath);
  const directory = await realpath(dirname(canonicalManifestPath));
  const manifest = parseStaticJudgmentBenchmarkManifest(
    await readBoundedJsonFile(
      canonicalManifestPath,
      "Static Judgment benchmark manifest",
    ),
  );
  const freezePath = await canonicalProtocolPath(
    directory,
    manifest.freeze,
    "Static Judgment benchmark freeze",
  );
  const freeze = parseStaticJudgmentBenchmarkFreeze(
    await readBoundedJsonFile(
      freezePath,
      "Static Judgment benchmark freeze",
    ),
  );
  return {
    directory,
    manifestPath: canonicalManifestPath,
    manifest,
    freezePath,
    freeze,
  };
}

export async function verifyStaticJudgmentBenchmarkFreeze(
  protocol: StaticJudgmentBenchmarkProtocol,
): Promise<void> {
  if (protocol.freeze.status !== "frozen") {
    throw new Error("Static Judgment benchmark inputs must be frozen before execution");
  }
  const expectedFiles = [
    basename(protocol.manifestPath),
    ...protocol.manifest.cases.flatMap((testCase) => [
      testCase.modelInput,
      testCase.oracle,
      testCase.fixture,
    ]),
  ].sort();
  const frozenFiles = Object.keys(protocol.freeze.files).sort();
  if (
    expectedFiles.length !== frozenFiles.length ||
    expectedFiles.some((path, index) => path !== frozenFiles[index])
  ) {
    throw new Error(
      "Static Judgment benchmark freeze must exactly cover the manifest, model inputs, Oracles, and fixtures",
    );
  }

  for (const path of expectedFiles) {
    const bytes = await readFrozenProtocolFile(protocol.directory, path);
    const expectedHash = protocol.freeze.files[path];
    if (expectedHash === undefined || sha256(bytes) !== expectedHash) {
      throw new Error(`Static Judgment benchmark frozen input changed: ${path}`);
    }
  }
}

export async function buildStaticJudgmentBenchmarkRequests(
  protocol: StaticJudgmentBenchmarkProtocol,
): Promise<Array<{ caseId: string; request: object }>> {
  await verifyStaticJudgmentBenchmarkFreeze(protocol);
  return Promise.all(
    protocol.manifest.cases.map(async (testCase) => {
      const modelInput = parseStaticJudgmentBenchmarkModelInput(
        await readProtocolJson(
          protocol,
          testCase.modelInput,
          `Static Judgment benchmark case ${testCase.id} model input`,
        ),
        `Static Judgment benchmark case ${testCase.id} model input`,
      );
      return {
        caseId: testCase.id,
        request: buildStaticJudgmentRequest(modelInput),
      };
    }),
  );
}

export async function runStaticJudgmentFixtureBenchmark(
  protocol: StaticJudgmentBenchmarkProtocol,
): Promise<StaticJudgmentBenchmarkReport> {
  await verifyStaticJudgmentBenchmarkFreeze(protocol);
  const results: StaticJudgmentBenchmarkRun[] = [];
  let stableCases = 0;
  let resolvedOracleRuns = 0;
  let correctResolvedRuns = 0;

  for (const testCase of protocol.manifest.cases) {
    parseStaticJudgmentBenchmarkModelInput(
      await readProtocolJson(
        protocol,
        testCase.modelInput,
        `Static Judgment benchmark case ${testCase.id} model input`,
      ),
      `Static Judgment benchmark case ${testCase.id} model input`,
    );
    const oracle = parseStaticJudgmentBenchmarkOracle(
      await readProtocolJson(
        protocol,
        testCase.oracle,
        `Static Judgment benchmark case ${testCase.id} Oracle`,
      ),
      `Static Judgment benchmark case ${testCase.id} Oracle`,
    );
    const fixture = parseStaticJudgmentBenchmarkFixture(
      await readProtocolJson(
        protocol,
        testCase.fixture,
        `Static Judgment benchmark case ${testCase.id} fixture`,
      ),
      protocol.manifest.repetitions,
      `Static Judgment benchmark case ${testCase.id} fixture`,
    );
    const signatures = new Set<string>();
    fixture.results.forEach((actual, index) => {
      const classification = classifyStaticJudgment(actual, oracle.expected);
      const actualSummary = {
        outcome: actual.outcome,
        value: actual.value,
      };
      signatures.add(JSON.stringify(actualSummary));
      if (oracle.expected.outcome === "resolved") {
        resolvedOracleRuns += 1;
        if (
          actual.outcome === "resolved" &&
          actual.value === oracle.expected.value
        ) {
          correctResolvedRuns += 1;
        }
      }
      results.push({
        caseId: testCase.id,
        repetition: index + 1,
        expected: oracle.expected,
        actual: actualSummary,
        classification,
      });
    });
    if (signatures.size === 1) stableCases += 1;
  }

  const passed = countClassification(results, "passed");
  const falseResolutions = countClassification(
    results,
    "false-resolution",
  );
  const unexpectedUnresolved = countClassification(
    results,
    "unexpected-unresolved",
  );
  const resolvedAccuracy =
    resolvedOracleRuns === 0 ? 1 : correctResolvedRuns / resolvedOracleRuns;
  const stabilityRate = stableCases / protocol.manifest.cases.length;
  const thresholds = protocol.manifest.thresholds;
  const status =
    falseResolutions <= thresholds.maxFalseResolutions &&
    unexpectedUnresolved <= thresholds.maxUnexpectedUnresolved &&
    resolvedAccuracy >= thresholds.minResolvedAccuracy &&
    stabilityRate >= thresholds.minStabilityRate
      ? "passed"
      : "failed";

  return {
    version: 1,
    benchmark: protocol.manifest.name,
    profile: protocol.manifest.profile,
    // Fixture observations validate the harness, not live model accuracy.
    evidenceEligible: false,
    status,
    cases: protocol.manifest.cases.length,
    repetitions: protocol.manifest.repetitions,
    runs: results.length,
    metrics: {
      passed,
      falseResolutions,
      unexpectedUnresolved,
      resolvedAccuracy,
      stabilityRate,
    },
    results,
    apiCalls: 0,
    persistentFilesWritten: 0,
  };
}

export function renderStaticJudgmentBenchmarkReport(
  report: StaticJudgmentBenchmarkReport,
): string {
  return [
    "Static Judgment blind benchmark",
    `benchmark: ${report.benchmark}`,
    `profile: ${report.profile}`,
    `evidence eligible: ${report.evidenceEligible}`,
    `status: ${report.status}`,
    `cases: ${report.cases}`,
    `runs: ${report.runs}`,
    `passed: ${report.metrics.passed}`,
    `false resolutions: ${report.metrics.falseResolutions}`,
    `unexpected unresolved: ${report.metrics.unexpectedUnresolved}`,
    `resolved accuracy: ${report.metrics.resolvedAccuracy.toFixed(4)}`,
    `stability rate: ${report.metrics.stabilityRate.toFixed(4)}`,
    "api calls: 0",
    "persistent files written: 0",
  ].join("\n");
}

export function parseStaticJudgmentBenchmarkManifest(
  input: unknown,
): StaticJudgmentBenchmarkManifest {
  const path = "Static Judgment benchmark manifest";
  const value = recordValue(input, path);
  assertExactKeys(
    value,
    [
      "version",
      "profile",
      "name",
      "repetitions",
      "freeze",
      "thresholds",
      "cases",
    ],
    path,
  );
  if (value.version !== 1) throw new Error(`${path}.version must be 1`);
  if (value.profile !== "fixture" && value.profile !== "held-out") {
    throw new Error(`${path}.profile must be fixture or held-out`);
  }
  const name = portableId(value.name, `${path}.name`);
  const repetitions = boundedInteger(
    value.repetitions,
    1,
    5,
    `${path}.repetitions`,
  );
  const freeze = relativePath(value.freeze, `${path}.freeze`);
  const thresholdsValue = recordValue(value.thresholds, `${path}.thresholds`);
  assertExactKeys(
    thresholdsValue,
    [
      "maxFalseResolutions",
      "maxUnexpectedUnresolved",
      "minResolvedAccuracy",
      "minStabilityRate",
    ],
    `${path}.thresholds`,
  );
  const thresholds = {
    maxFalseResolutions: boundedInteger(
      thresholdsValue.maxFalseResolutions,
      0,
      1_000,
      `${path}.thresholds.maxFalseResolutions`,
    ),
    maxUnexpectedUnresolved: boundedInteger(
      thresholdsValue.maxUnexpectedUnresolved,
      0,
      1_000,
      `${path}.thresholds.maxUnexpectedUnresolved`,
    ),
    minResolvedAccuracy: unitInterval(
      thresholdsValue.minResolvedAccuracy,
      `${path}.thresholds.minResolvedAccuracy`,
    ),
    minStabilityRate: unitInterval(
      thresholdsValue.minStabilityRate,
      `${path}.thresholds.minStabilityRate`,
    ),
  };
  if (thresholds.maxFalseResolutions !== 0) {
    throw new Error(
      `${path}.thresholds.maxFalseResolutions must be 0`,
    );
  }
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    throw new Error(`${path}.cases must be a non-empty array`);
  }
  if (value.cases.length > 64) {
    throw new Error(`${path}.cases must contain at most 64 cases`);
  }
  if (value.profile === "held-out" && value.cases.length !== 48) {
    throw new Error(`${path}.cases must contain exactly 48 held-out cases`);
  }
  const ids = new Set<string>();
  const files = new Set<string>([freeze]);
  const cases = value.cases.map((inputCase, index) => {
    const casePath = `${path}.cases[${index}]`;
    const item = recordValue(inputCase, casePath);
    assertExactKeys(item, ["id", "modelInput", "oracle", "fixture"], casePath);
    const id = portableId(item.id, `${casePath}.id`);
    if (ids.has(id)) throw new Error(`${path} contains duplicate case id ${id}`);
    ids.add(id);
    const result = {
      id,
      modelInput: relativePath(item.modelInput, `${casePath}.modelInput`),
      oracle: relativePath(item.oracle, `${casePath}.oracle`),
      fixture: relativePath(item.fixture, `${casePath}.fixture`),
    };
    for (const file of [result.modelInput, result.oracle, result.fixture]) {
      if (files.has(file)) {
        throw new Error(`${path} reuses protocol file ${file}`);
      }
      files.add(file);
    }
    return result;
  });
  return {
    version: 1,
    profile: value.profile,
    name,
    repetitions,
    freeze,
    thresholds,
    cases,
  };
}

export function parseStaticJudgmentBenchmarkModelInput(
  input: unknown,
  path = "Static Judgment benchmark model input",
): StaticJudgmentRequestInput {
  const value = recordValue(input, path);
  assertExactKeys(
    value,
    [
      "version",
      "model",
      "conceptId",
      "conceptSpecification",
      "staticValue",
      "judgmentName",
    ],
    path,
  );
  if (value.version !== 1) throw new Error(`${path}.version must be 1`);
  return {
    model: nonEmptyString(value.model, `${path}.model`),
    conceptId: nonEmptyString(value.conceptId, `${path}.conceptId`),
    conceptSpecification: nonEmptyString(
      value.conceptSpecification,
      `${path}.conceptSpecification`,
    ),
    staticValue: nonEmptyString(value.staticValue, `${path}.staticValue`),
    judgmentName: portableId(value.judgmentName, `${path}.judgmentName`),
  };
}

export function parseStaticJudgmentBenchmarkOracle(
  input: unknown,
  path = "Static Judgment benchmark Oracle",
): StaticJudgmentBenchmarkOracle {
  const value = recordValue(input, path);
  assertExactKeys(value, ["version", "expected", "reason"], path);
  if (value.version !== 1) throw new Error(`${path}.version must be 1`);
  const expectedPath = `${path}.expected`;
  const expectedValue = recordValue(value.expected, expectedPath);
  assertExactKeys(expectedValue, ["outcome", "value"], expectedPath);
  const expected =
    expectedValue.outcome === "resolved" &&
    typeof expectedValue.value === "boolean"
      ? {
          outcome: "resolved" as const,
          value: expectedValue.value,
        }
      : expectedValue.outcome === "unresolved" && expectedValue.value === null
        ? { outcome: "unresolved" as const, value: null }
        : undefined;
  if (expected === undefined) {
    throw new Error(
      `${expectedPath} must be resolved with a boolean or unresolved with null`,
    );
  }
  return {
    version: 1,
    expected,
    reason: nonEmptyString(value.reason, `${path}.reason`),
  };
}

export function parseStaticJudgmentBenchmarkFixture(
  input: unknown,
  repetitions: number,
  path = "Static Judgment benchmark fixture",
): StaticJudgmentBenchmarkFixture {
  const value = recordValue(input, path);
  assertExactKeys(value, ["version", "results"], path);
  if (value.version !== 1) throw new Error(`${path}.version must be 1`);
  if (
    !Array.isArray(value.results) ||
    value.results.length !== repetitions
  ) {
    throw new Error(`${path}.results must contain exactly ${repetitions} items`);
  }
  return {
    version: 1,
    results: value.results.map((result) =>
      parseStaticJudgmentResolution(result),
    ),
  };
}

export function parseStaticJudgmentBenchmarkFreeze(
  input: unknown,
): StaticJudgmentBenchmarkFreeze {
  const path = "Static Judgment benchmark freeze";
  const value = recordValue(input, path);
  assertExactKeys(value, ["version", "status", "frozenAt", "files"], path);
  if (value.version !== 1) throw new Error(`${path}.version must be 1`);
  if (value.status !== "draft" && value.status !== "frozen") {
    throw new Error(`${path}.status must be draft or frozen`);
  }
  if (
    value.frozenAt !== null &&
    !isIsoTimestamp(value.frozenAt)
  ) {
    throw new Error(`${path}.frozenAt must be null or an ISO-8601 timestamp`);
  }
  if (value.status === "draft" && value.frozenAt !== null) {
    throw new Error(`${path}.frozenAt must be null while status is draft`);
  }
  if (value.status === "frozen" && value.frozenAt === null) {
    throw new Error(`${path}.frozenAt is required while status is frozen`);
  }
  const filesValue = recordValue(value.files, `${path}.files`);
  const files = Object.create(null) as Record<string, string>;
  for (const [file, hash] of Object.entries(filesValue)) {
    const normalized = relativePath(file, `${path}.files key`);
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error(`${path}.files.${normalized} must be a SHA-256 hash`);
    }
    files[normalized] = hash;
  }
  return {
    version: 1,
    status: value.status,
    frozenAt: value.frozenAt,
    files,
  };
}

function classifyStaticJudgment(
  actual: StaticJudgmentResolution,
  expected: StaticJudgmentBenchmarkOracle["expected"],
): StaticJudgmentBenchmarkClassification {
  if (actual.outcome === expected.outcome && actual.value === expected.value) {
    return "passed";
  }
  return actual.outcome === "resolved"
    ? "false-resolution"
    : "unexpected-unresolved";
}

function countClassification(
  results: StaticJudgmentBenchmarkRun[],
  classification: StaticJudgmentBenchmarkClassification,
): number {
  return results.filter((result) => result.classification === classification)
    .length;
}

async function readProtocolJson(
  protocol: StaticJudgmentBenchmarkProtocol,
  path: string,
  label: string,
): Promise<unknown> {
  const canonicalPath = await canonicalProtocolPath(
    protocol.directory,
    path,
    label,
  );
  const bytes = await readFile(canonicalPath);
  const expectedHash = protocol.freeze.files[path];
  if (expectedHash === undefined || sha256(bytes) !== expectedHash) {
    throw new Error(`Static Judgment benchmark frozen input changed: ${path}`);
  }
  return parseBoundedJsonText(bytes.toString("utf8"), label);
}

async function readFrozenProtocolFile(
  directory: string,
  path: string,
): Promise<Uint8Array> {
  return readFile(
    await canonicalProtocolPath(
      directory,
      path,
      `Static Judgment benchmark frozen file ${path}`,
    ),
  );
}

async function canonicalProtocolPath(
  directory: string,
  path: string,
  label: string,
): Promise<string> {
  const absolutePath = resolveProtocolPath(directory, path, label);
  const canonicalPath = await realpath(absolutePath);
  workspaceRelativePath(directory, canonicalPath, label);
  if (canonicalPath !== absolutePath) {
    throw new Error(`${label} must not use a symbolic link`);
  }
  return canonicalPath;
}

function resolveProtocolPath(
  directory: string,
  path: string,
  label: string,
): string {
  const absolutePath = resolve(directory, path);
  workspaceRelativePath(directory, absolutePath, label);
  return absolutePath;
}

function recordValue(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${path} must be an object`);
  }
  return input as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(
      `${path} must contain exactly ${sortedExpected.join(", ")}`,
    );
  }
}

function nonEmptyString(input: unknown, path: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return input;
}

function portableId(input: unknown, path: string): string {
  const value = nonEmptyString(input, path);
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${path} must be a portable identifier`);
  }
  return value;
}

function relativePath(input: unknown, path: string): string {
  const value = nonEmptyString(input, path).replaceAll("\\", "/");
  const segments = value.split("/");
  if (
    isAbsolute(value) ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9._-]+$/.test(segment),
    )
  ) {
    throw new Error(`${path} must be a safe relative path`);
  }
  return value;
}

function isIsoTimestamp(input: unknown): input is string {
  if (
    typeof input !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)
  ) {
    return false;
  }
  const timestamp = Date.parse(input);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === input;
}

function boundedInteger(
  input: unknown,
  minimum: number,
  maximum: number,
  path: string,
): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < minimum ||
    input > maximum
  ) {
    throw new Error(`${path} must be an integer from ${minimum} to ${maximum}`);
  }
  return input;
}

function unitInterval(input: unknown, path: string): number {
  if (
    typeof input !== "number" ||
    !Number.isFinite(input) ||
    input < 0 ||
    input > 1
  ) {
    throw new Error(`${path} must be a number from 0 to 1`);
  }
  return input;
}
