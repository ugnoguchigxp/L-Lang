import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { sha256, workspaceRelativePath } from "./semantic-fingerprint";
import { parseBoundedJsonText, readBoundedJsonFile } from "./semantic-limits";
import {
  buildStaticJudgmentRequest,
  type StaticJudgmentResolution,
} from "./static-judgment";
import {
  parseStaticJudgmentBenchmarkFixture,
  parseStaticJudgmentBenchmarkFreeze,
  parseStaticJudgmentBenchmarkManifest,
  parseStaticJudgmentBenchmarkModelInput,
  parseStaticJudgmentBenchmarkOracle,
  type StaticJudgmentBenchmarkFreeze,
  type StaticJudgmentBenchmarkManifest,
  type StaticJudgmentBenchmarkOracle,
} from "./static-judgment-benchmark-parser";

export {
  parseStaticJudgmentBenchmarkFixture,
  parseStaticJudgmentBenchmarkFreeze,
  parseStaticJudgmentBenchmarkManifest,
  parseStaticJudgmentBenchmarkModelInput,
  parseStaticJudgmentBenchmarkOracle,
  type StaticJudgmentBenchmarkCase,
  type StaticJudgmentBenchmarkFixture,
  type StaticJudgmentBenchmarkFreeze,
  type StaticJudgmentBenchmarkManifest,
  type StaticJudgmentBenchmarkOracle,
} from "./static-judgment-benchmark-parser";

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
    await readBoundedJsonFile(freezePath, "Static Judgment benchmark freeze"),
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
    throw new Error(
      "Static Judgment benchmark inputs must be frozen before execution",
    );
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
      throw new Error(
        `Static Judgment benchmark frozen input changed: ${path}`,
      );
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
  const falseResolutions = countClassification(results, "false-resolution");
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
