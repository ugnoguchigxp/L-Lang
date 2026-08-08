import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

import { type PredicateExpression, parsePredicateExpression } from "./ir";
import {
  assertKnownKeys,
  readBoundedJsonFile,
  SEMANTIC_LIMITS,
} from "./semantic-limits";

export type BenchmarkManifest = {
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

export type CrossSchemaOracle =
  | { expectedOutcome: "resolved"; body: PredicateExpression }
  | { expectedOutcome: "unresolved"; body: null };

export type CrossSchemaHiddenCase = {
  name: string;
  input: Record<string, unknown>;
  expected: boolean;
};

export type CrossSchemaManualTimes = Record<
  string,
  {
    manualAuthoringMs: number | null;
    manualReviewMs: number | null;
    semanticAuthoringMs: number | null;
    semanticReviewMs: number | null;
  }
>;

export type CrossSchemaConceptFreeze =
  | {
      version: 1;
      frozenAt: string;
      rule: string;
      concepts: Record<string, string>;
      files: null;
      evidenceEligible: false;
    }
  | {
      version: 2;
      status: "frozen";
      frozenAt: string;
      rule: string;
      concepts: Record<string, string>;
      files: Record<string, string>;
      evidenceEligible: true;
    };

export async function readCrossSchemaJson(
  path: string,
  label: string,
): Promise<unknown> {
  return readBoundedJsonFile(path, label);
}

export function parseCrossSchemaManifest(input: unknown): BenchmarkManifest {
  const path = "cross-schema benchmark";
  const value = recordValue(input, path);
  assertExactKeys(
    value,
    [
      "version",
      "name",
      "trials",
      "conceptFreeze",
      "manualTimes",
      "blindness",
      "thresholds",
      "cases",
    ],
    [],
    path,
  );
  if (value.version !== 1) throw new Error(`${path}.version must be 1`);
  const trials = positiveInteger(value.trials, `${path}.trials`);
  if (trials > 9) throw new Error(`${path}.trials must be at most 9`);
  const cases = parseCases(value.cases);
  const ids = cases.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${path}.cases must not contain duplicate ids`);
  }
  return {
    version: 1,
    name: portableId(value.name, `${path}.name`),
    trials,
    conceptFreeze: relativePathValue(
      value.conceptFreeze,
      `${path}.conceptFreeze`,
    ),
    manualTimes: relativePathValue(value.manualTimes, `${path}.manualTimes`),
    blindness: blindnessValue(value.blindness),
    thresholds: thresholdsValue(value.thresholds),
    cases,
  };
}

export function parseCrossSchemaOracle(input: unknown): CrossSchemaOracle {
  const path = "cross-schema oracle";
  const value = recordValue(input, path);
  assertExactKeys(value, ["version", "expectedOutcome", "body"], [], path);
  if (value.version !== 1) throw new Error(`${path}.version must be 1`);
  if (value.expectedOutcome === "unresolved" && value.body === null) {
    return { expectedOutcome: "unresolved", body: null };
  }
  if (value.expectedOutcome === "resolved" && value.body !== null) {
    return {
      expectedOutcome: "resolved",
      body: parsePredicateExpression(value.body, `${path}.body`),
    };
  }
  throw new Error(`${path} outcome/body is invalid`);
}

export function parseCrossSchemaHiddenCases(
  input: unknown,
): CrossSchemaHiddenCase[] {
  const path = "cross-schema hidden cases";
  const value = recordValue(input, path);
  assertExactKeys(value, ["version", "tests"], [], path);
  if (value.version !== 1) throw new Error(`${path}.version must be 1`);
  if (!Array.isArray(value.tests) || value.tests.length > 128) {
    throw new Error(`${path}.tests must be an array with at most 128 items`);
  }
  const tests = value.tests.map((item, index) => {
    const itemPath = `${path}.tests[${index}]`;
    const test = recordValue(item, itemPath);
    assertExactKeys(test, ["name", "input", "expected"], [], itemPath);
    if (typeof test.expected !== "boolean") {
      throw new Error(`${itemPath}.expected must be a boolean`);
    }
    return {
      name: trimmedString(test.name, `${itemPath}.name`),
      input: recordValue(test.input, `${itemPath}.input`),
      expected: test.expected,
    };
  });
  const names = tests.map((test) => test.name);
  if (new Set(names).size !== names.length) {
    throw new Error(`${path}.tests must not contain duplicate names`);
  }
  return tests;
}

export function parseCrossSchemaConceptFreeze(
  input: unknown,
): CrossSchemaConceptFreeze {
  const path = "cross-schema concept freeze";
  const value = recordValue(input, path);
  if (value.version === 1) {
    assertExactKeys(
      value,
      ["version", "frozenAt", "rule", "concepts"],
      [],
      path,
    );
    return {
      version: 1,
      frozenAt: dateString(value.frozenAt, `${path}.frozenAt`),
      rule: boundedString(value.rule, `${path}.rule`),
      concepts: hashRecord(value.concepts, `${path}.concepts`),
      files: null,
      evidenceEligible: false,
    };
  }
  if (value.version === 2) {
    assertExactKeys(
      value,
      ["version", "status", "frozenAt", "rule", "concepts", "files"],
      [],
      path,
    );
    if (value.status !== "frozen") {
      throw new Error(`${path}.status must be frozen`);
    }
    return {
      version: 2,
      status: "frozen",
      frozenAt: dateString(value.frozenAt, `${path}.frozenAt`),
      rule: boundedString(value.rule, `${path}.rule`),
      concepts: hashRecord(value.concepts, `${path}.concepts`),
      files: fileHashRecord(value.files, `${path}.files`),
      evidenceEligible: true,
    };
  }
  throw new Error(`${path}.version must be 1 or 2`);
}

export function parseCrossSchemaManualTimes(
  input: unknown,
): CrossSchemaManualTimes {
  const path = "cross-schema manual times";
  const value = recordValue(input, path);
  assertExactKeys(value, ["version", "instructions", "entries"], [], path);
  if (value.version !== 1) throw new Error(`${path}.version must be 1`);
  boundedString(value.instructions, `${path}.instructions`);
  const entries = recordValue(value.entries, `${path}.entries`);
  if (Object.keys(entries).length > 128) {
    throw new Error(`${path}.entries contains too many items`);
  }
  return Object.fromEntries(
    Object.entries(entries).map(([id, input]) => {
      portableId(id, `${path}.entries id`);
      const entryPath = `${path}.entries.${id}`;
      const entry = recordValue(input, entryPath);
      assertExactKeys(
        entry,
        [
          "manualAuthoringMs",
          "manualReviewMs",
          "semanticAuthoringMs",
          "semanticReviewMs",
        ],
        [],
        entryPath,
      );
      return [
        id,
        {
          manualAuthoringMs: nullableDuration(
            entry.manualAuthoringMs,
            `${entryPath}.manualAuthoringMs`,
          ),
          manualReviewMs: nullableDuration(
            entry.manualReviewMs,
            `${entryPath}.manualReviewMs`,
          ),
          semanticAuthoringMs: nullableDuration(
            entry.semanticAuthoringMs,
            `${entryPath}.semanticAuthoringMs`,
          ),
          semanticReviewMs: nullableDuration(
            entry.semanticReviewMs,
            `${entryPath}.semanticReviewMs`,
          ),
        },
      ];
    }),
  );
}

export function validateCrossSchemaProtocolInputs(
  manifest: BenchmarkManifest,
  manualTimes: CrossSchemaManualTimes,
): void {
  if (manifest.trials !== 3 || manifest.cases.length !== 9) {
    throw new Error(
      "cross-schema protocol requires exactly 9 cases and 3 trials",
    );
  }
  if (!manifest.blindness.conceptsFrozenBeforeFirstModelCall) {
    throw new Error("cross-schema concepts must be frozen before model calls");
  }
  const expectedManualIds = manifest.cases
    .filter((entry) => entry.manual !== undefined)
    .map((entry) => entry.id)
    .sort();
  const actualManualIds = Object.keys(manualTimes).sort();
  if (stableJson(expectedManualIds) !== stableJson(actualManualIds)) {
    throw new Error(
      "cross-schema manual times must contain exactly the cases with manual implementations",
    );
  }
}

export function requiredCrossSchemaFreezeFiles(
  manifestPath: string,
  manifest: BenchmarkManifest,
): string[] {
  return [
    basename(manifestPath),
    ...manifest.cases.flatMap((entry) => [
      entry.source,
      entry.oracle,
      entry.tests,
      ...(entry.manual === undefined ? [] : [entry.manual]),
    ]),
  ].sort();
}

export async function verifyCrossSchemaFileFreeze(
  freeze: CrossSchemaConceptFreeze,
  requiredFiles: string[],
  resolveFile: (path: string, label: string) => Promise<string>,
): Promise<void> {
  if (freeze.version === 1) return;
  const actualFiles = Object.keys(freeze.files).sort();
  if (stableJson(actualFiles) !== stableJson([...requiredFiles].sort())) {
    throw new Error(
      "cross-schema freeze.files must contain exactly the declared evaluation inputs",
    );
  }
  for (const path of requiredFiles) {
    const absolute = await resolveFile(
      path,
      `cross-schema frozen input ${path}`,
    );
    const actual = createHash("sha256")
      .update(await readFile(absolute))
      .digest("hex");
    if (actual !== freeze.files[path]) {
      throw new Error(`cross-schema frozen input changed: ${path}`);
    }
  }
}

function parseCases(input: unknown): BenchmarkManifest["cases"] {
  const path = "cross-schema benchmark.cases";
  if (!Array.isArray(input) || input.length === 0 || input.length > 64) {
    throw new Error(`${path} must contain between 1 and 64 items`);
  }
  return input.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const value = recordValue(item, itemPath);
    assertExactKeys(
      value,
      ["id", "source", "oracle", "tests"],
      ["manual"],
      itemPath,
    );
    return {
      id: portableId(value.id, `${itemPath}.id`),
      source: relativePathValue(value.source, `${itemPath}.source`),
      oracle: relativePathValue(value.oracle, `${itemPath}.oracle`),
      tests: relativePathValue(value.tests, `${itemPath}.tests`),
      ...(value.manual === undefined
        ? {}
        : { manual: relativePathValue(value.manual, `${itemPath}.manual`) }),
    };
  });
}

function blindnessValue(input: unknown): BenchmarkManifest["blindness"] {
  const path = "cross-schema benchmark.blindness";
  const value = recordValue(input, path);
  assertExactKeys(
    value,
    [
      "oracleAndCasesSentToModel",
      "conceptsFrozenBeforeFirstModelCall",
      "independentHumanOracleAuthor",
      "note",
    ],
    [],
    path,
  );
  if (value.oracleAndCasesSentToModel !== false) {
    throw new Error(`${path}.oracleAndCasesSentToModel must be false`);
  }
  if (
    typeof value.conceptsFrozenBeforeFirstModelCall !== "boolean" ||
    typeof value.independentHumanOracleAuthor !== "boolean"
  ) {
    throw new Error(`${path} flags must be booleans`);
  }
  return {
    oracleAndCasesSentToModel: false,
    conceptsFrozenBeforeFirstModelCall:
      value.conceptsFrozenBeforeFirstModelCall,
    independentHumanOracleAuthor: value.independentHumanOracleAuthor,
    note: boundedString(value.note, `${path}.note`),
  };
}

function thresholdsValue(input: unknown): BenchmarkManifest["thresholds"] {
  const path = "cross-schema benchmark.thresholds";
  const value = recordValue(input, path);
  assertExactKeys(
    value,
    [
      "minimumFirstPassCaseRate",
      "maximumFalseResolutionRate",
      "minimumStableCaseRate",
      "minimumHiddenTestPassRate",
      "targetManualTimeReduction",
    ],
    [],
    path,
  );
  return {
    minimumFirstPassCaseRate: unitInterval(
      value.minimumFirstPassCaseRate,
      `${path}.minimumFirstPassCaseRate`,
    ),
    maximumFalseResolutionRate: unitInterval(
      value.maximumFalseResolutionRate,
      `${path}.maximumFalseResolutionRate`,
    ),
    minimumStableCaseRate: unitInterval(
      value.minimumStableCaseRate,
      `${path}.minimumStableCaseRate`,
    ),
    minimumHiddenTestPassRate: unitInterval(
      value.minimumHiddenTestPassRate,
      `${path}.minimumHiddenTestPassRate`,
    ),
    targetManualTimeReduction: unitInterval(
      value.targetManualTimeReduction,
      `${path}.targetManualTimeReduction`,
    ),
  };
}

function hashRecord(input: unknown, path: string): Record<string, string> {
  const value = recordValue(input, path);
  if (Object.keys(value).length === 0 || Object.keys(value).length > 64) {
    throw new Error(`${path} must contain between 1 and 64 entries`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([id, hash]) => [
      portableId(id, `${path} id`),
      hashValue(hash, `${path}.${id}`),
    ]),
  );
}

function fileHashRecord(input: unknown, path: string): Record<string, string> {
  const value = recordValue(input, path);
  if (Object.keys(value).length === 0 || Object.keys(value).length > 256) {
    throw new Error(`${path} must contain between 1 and 256 entries`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([file, hash]) => [
      relativePathValue(file, `${path} path`),
      hashValue(hash, `${path}.${file}`),
    ]),
  );
}

function nullableDuration(input: unknown, path: string): number | null {
  if (input === null) return null;
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) {
    throw new Error(`${path} must be null or a non-negative finite number`);
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
    throw new Error(`${path} must be a finite number between 0 and 1`);
  }
  return input;
}

function positiveInteger(input: unknown, path: string): number {
  if (!Number.isSafeInteger(input) || Number(input) < 1) {
    throw new Error(`${path} must be a positive safe integer`);
  }
  return Number(input);
}

function portableId(input: unknown, path: string): string {
  const value = trimmedString(input, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${path} must be a portable identifier`);
  }
  return value;
}

function relativePathValue(input: unknown, path: string): string {
  const value = trimmedString(input, path);
  const segments = value.split("/");
  if (
    isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`${path} must be a normalized relative path`);
  }
  return value;
}

function hashValue(input: unknown, path: string): string {
  const value = trimmedString(input, path);
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${path} must be a lowercase SHA-256 hash`);
  }
  return value;
}

function dateString(input: unknown, path: string): string {
  const value = trimmedString(input, path);
  if (Number.isNaN(Date.parse(value)))
    throw new Error(`${path} must be an ISO date`);
  return value;
}

function boundedString(input: unknown, path: string): string {
  const value = trimmedString(input, path);
  if (value.length > SEMANTIC_LIMITS.diagnosticCharacters) {
    throw new Error(`${path} is too long`);
  }
  return value;
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

function recordValue(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${path} must be an object`);
  }
  return input as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  assertKnownKeys(value, [...required, ...optional], path);
  const missing = required.find((key) => !(key in value));
  if (missing !== undefined) throw new Error(`${path} is missing ${missing}`);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
