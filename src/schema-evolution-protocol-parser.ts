import { isAbsolute, posix } from "node:path";

import { assertKnownKeys } from "./semantic-limits";

export type SchemaEvolutionChangeType =
  | "add-property"
  | "rename"
  | "representation"
  | "optionality"
  | "remove-role"
  | "ambiguity";

export type SchemaEvolutionBenchmarkManifest = {
  version: 1;
  name: string;
  trials: 3;
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
    changeType: SchemaEvolutionChangeType;
    source: string;
    oracle: string;
    tests: string;
  }>;
};

export type SchemaEvolutionFreezeManifest = {
  version: 1;
  status: "draft" | "frozen";
  instructions: string;
  files: Record<string, string>;
};

export function parseSchemaEvolutionBenchmarkManifest(
  input: unknown,
): SchemaEvolutionBenchmarkManifest {
  const value = recordValue(input, "benchmark");
  assertExactKeys(
    value,
    [
      "version",
      "name",
      "trials",
      "freeze",
      "blindness",
      "thresholds",
      "concepts",
      "cases",
    ],
    ["evaluation", "protocol"],
    "benchmark",
  );
  if (value.version !== 1) throw new Error("benchmark.version must be 1");
  if (value.trials !== 3) throw new Error("benchmark.trials must be 3");
  const name = trimmedString(value.name, "benchmark.name");
  const freeze = relativePathValue(value.freeze, "benchmark.freeze");

  const concepts = arrayValue(value.concepts, "benchmark.concepts").map(
    parseConcept,
  );
  const conceptIds = uniqueValues(
    concepts.map((concept) => concept.id),
    "benchmark concept id",
  );
  const cases = arrayValue(value.cases, "benchmark.cases").map(parseCase);
  uniqueValues(
    cases.map((entry) => entry.id),
    "benchmark case id",
  );
  for (const entry of cases) {
    if (!conceptIds.has(entry.conceptId)) {
      throw new Error(
        `benchmark case ${entry.id} references unknown concept ${entry.conceptId}`,
      );
    }
  }
  uniqueValues(
    [
      "benchmark.json",
      freeze,
      ...concepts.flatMap((concept) => [
        concept.definition,
        concept.baselineSource,
        concept.baselineOracle,
      ]),
      ...cases.flatMap((entry) => [entry.source, entry.oracle, entry.tests]),
    ],
    "benchmark input path",
  );

  const evaluation =
    value.evaluation === undefined
      ? undefined
      : parseEvaluation(value.evaluation);
  const protocol =
    value.protocol === undefined ? undefined : parseProtocol(value.protocol);
  return {
    version: 1,
    name,
    trials: 3,
    freeze,
    blindness: parseBlindness(value.blindness),
    thresholds: parseThresholds(value.thresholds),
    ...(evaluation === undefined ? {} : { evaluation }),
    ...(protocol === undefined ? {} : { protocol }),
    concepts,
    cases,
  };
}

export function parseSchemaEvolutionFreezeManifest(
  input: unknown,
): SchemaEvolutionFreezeManifest {
  const value = recordValue(input, "freeze");
  assertExactKeys(
    value,
    ["version", "status", "instructions", "files"],
    [],
    "freeze",
  );
  if (value.version !== 1) throw new Error("freeze.version must be 1");
  if (value.status !== "draft" && value.status !== "frozen") {
    throw new Error("freeze.status must be draft or frozen");
  }
  const rawFiles = recordValue(value.files, "freeze.files");
  if (Object.keys(rawFiles).length === 0) {
    throw new Error("freeze.files must not be empty");
  }
  const files: Record<string, string> = {};
  for (const [rawPath, rawHash] of Object.entries(rawFiles)) {
    const path = relativePathValue(rawPath, "freeze file path");
    if (path in files) {
      throw new Error(
        `freeze.files contains duplicate normalized path ${path}`,
      );
    }
    files[path] = hashValue(
      rawHash,
      `freeze.files[${JSON.stringify(rawPath)}]`,
    );
  }
  return {
    version: 1,
    status: value.status,
    instructions: trimmedString(value.instructions, "freeze.instructions"),
    files,
  };
}

function parseBlindness(
  input: unknown,
): SchemaEvolutionBenchmarkManifest["blindness"] {
  const value = recordValue(input, "benchmark.blindness");
  assertExactKeys(
    value,
    [
      "oracleAndCasesSentToModel",
      "lockUsed",
      "generatedCodeMutationAllowed",
      "note",
    ],
    [],
    "benchmark.blindness",
  );
  if (
    value.oracleAndCasesSentToModel !== false ||
    value.lockUsed !== false ||
    value.generatedCodeMutationAllowed !== false
  ) {
    throw new Error("benchmark.blindness safety flags must be false");
  }
  return {
    oracleAndCasesSentToModel: false,
    lockUsed: false,
    generatedCodeMutationAllowed: false,
    note: trimmedString(value.note, "benchmark.blindness.note"),
  };
}

function parseThresholds(
  input: unknown,
): SchemaEvolutionBenchmarkManifest["thresholds"] {
  const path = "benchmark.thresholds";
  const value = recordValue(input, path);
  const required = [
    "minimumFirstPassCaseRate",
    "minimumStableCaseRate",
    "minimumClassificationAccuracy",
    "minimumHiddenTestPassRate",
    "maximumFalseResolutionRate",
    "maximumWorkspaceMutationCount",
  ] as const;
  const optional = [
    "minimumConsensusCaseRate",
    "minimumConsensusQuorumRate",
  ] as const;
  assertExactKeys(value, required, optional, path);
  const minimumConsensusCaseRate = optionalUnitInterval(
    value.minimumConsensusCaseRate,
    `${path}.minimumConsensusCaseRate`,
  );
  const minimumConsensusQuorumRate = optionalUnitInterval(
    value.minimumConsensusQuorumRate,
    `${path}.minimumConsensusQuorumRate`,
  );
  return {
    minimumFirstPassCaseRate: unitInterval(
      value.minimumFirstPassCaseRate,
      `${path}.minimumFirstPassCaseRate`,
    ),
    minimumStableCaseRate: unitInterval(
      value.minimumStableCaseRate,
      `${path}.minimumStableCaseRate`,
    ),
    minimumClassificationAccuracy: unitInterval(
      value.minimumClassificationAccuracy,
      `${path}.minimumClassificationAccuracy`,
    ),
    minimumHiddenTestPassRate: unitInterval(
      value.minimumHiddenTestPassRate,
      `${path}.minimumHiddenTestPassRate`,
    ),
    maximumFalseResolutionRate: unitInterval(
      value.maximumFalseResolutionRate,
      `${path}.maximumFalseResolutionRate`,
    ),
    maximumWorkspaceMutationCount: nonNegativeInteger(
      value.maximumWorkspaceMutationCount,
      `${path}.maximumWorkspaceMutationCount`,
    ),
    ...(minimumConsensusCaseRate === undefined
      ? {}
      : { minimumConsensusCaseRate }),
    ...(minimumConsensusQuorumRate === undefined
      ? {}
      : { minimumConsensusQuorumRate }),
  };
}

function parseEvaluation(
  input: unknown,
): NonNullable<SchemaEvolutionBenchmarkManifest["evaluation"]> {
  const path = "benchmark.evaluation";
  const value = recordValue(input, path);
  assertExactKeys(
    value,
    ["primary", "samples", "quorum", "parallel"],
    [],
    path,
  );
  if (value.primary !== "trials" && value.primary !== "consensus") {
    throw new Error(`${path}.primary must be trials or consensus`);
  }
  if (
    value.samples !== 3 ||
    value.quorum !== 2 ||
    typeof value.parallel !== "boolean"
  ) {
    throw new Error(
      `${path} requires 3 samples, quorum 2, and parallel boolean`,
    );
  }
  return {
    primary: value.primary,
    samples: 3,
    quorum: 2,
    parallel: value.parallel,
  };
}

function parseProtocol(
  input: unknown,
): NonNullable<SchemaEvolutionBenchmarkManifest["protocol"]> {
  const path = "benchmark.protocol";
  const value = recordValue(input, path);
  const keys = [
    "concepts",
    "cases",
    "resolvedCases",
    "unresolvedCases",
    "casesPerChangeType",
  ] as const;
  assertExactKeys(value, keys, [], path);
  return {
    concepts: positiveInteger(value.concepts, `${path}.concepts`),
    cases: positiveInteger(value.cases, `${path}.cases`),
    resolvedCases: nonNegativeInteger(
      value.resolvedCases,
      `${path}.resolvedCases`,
    ),
    unresolvedCases: nonNegativeInteger(
      value.unresolvedCases,
      `${path}.unresolvedCases`,
    ),
    casesPerChangeType: positiveInteger(
      value.casesPerChangeType,
      `${path}.casesPerChangeType`,
    ),
  };
}

function parseConcept(
  input: unknown,
  index: number,
): SchemaEvolutionBenchmarkManifest["concepts"][number] {
  const path = `benchmark.concepts[${index}]`;
  const value = recordValue(input, path);
  assertExactKeys(
    value,
    ["id", "definition", "baselineSource", "baselineOracle"],
    [],
    path,
  );
  return {
    id: trimmedString(value.id, `${path}.id`),
    definition: relativePathValue(value.definition, `${path}.definition`),
    baselineSource: relativePathValue(
      value.baselineSource,
      `${path}.baselineSource`,
    ),
    baselineOracle: relativePathValue(
      value.baselineOracle,
      `${path}.baselineOracle`,
    ),
  };
}

function parseCase(
  input: unknown,
  index: number,
): SchemaEvolutionBenchmarkManifest["cases"][number] {
  const path = `benchmark.cases[${index}]`;
  const value = recordValue(input, path);
  assertExactKeys(
    value,
    ["id", "conceptId", "changeType", "source", "oracle", "tests"],
    [],
    path,
  );
  return {
    id: trimmedString(value.id, `${path}.id`),
    conceptId: trimmedString(value.conceptId, `${path}.conceptId`),
    changeType: changeTypeValue(value.changeType, `${path}.changeType`),
    source: relativePathValue(value.source, `${path}.source`),
    oracle: relativePathValue(value.oracle, `${path}.oracle`),
    tests: relativePathValue(value.tests, `${path}.tests`),
  };
}

function changeTypeValue(
  input: unknown,
  path: string,
): SchemaEvolutionChangeType {
  if (
    input !== "add-property" &&
    input !== "rename" &&
    input !== "representation" &&
    input !== "optionality" &&
    input !== "remove-role" &&
    input !== "ambiguity"
  ) {
    throw new Error(`${path} is invalid`);
  }
  return input;
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

function arrayValue(input: unknown, path: string): unknown[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error(`${path} must be a non-empty array`);
  }
  return input;
}

function recordValue(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${path} must be an object`);
  }
  return input as Record<string, unknown>;
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

function relativePathValue(input: unknown, path: string): string {
  const value = trimmedString(input, path).replaceAll("\\", "/");
  if (
    isAbsolute(value) ||
    /^[A-Za-z]:\//u.test(value) ||
    value === "." ||
    value === ".." ||
    value.startsWith("../") ||
    value.endsWith("/") ||
    posix.normalize(value) !== value
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

function positiveInteger(input: unknown, path: string): number {
  const value = nonNegativeInteger(input, path);
  if (value === 0) throw new Error(`${path} must be positive`);
  return value;
}

function nonNegativeInteger(input: unknown, path: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    throw new Error(`${path} must be a non-negative safe integer`);
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

function optionalUnitInterval(
  input: unknown,
  path: string,
): number | undefined {
  return input === undefined ? undefined : unitInterval(input, path);
}

function uniqueValues(values: string[], label: string): Set<string> {
  const result = new Set<string>();
  for (const value of values) {
    if (result.has(value)) throw new Error(`${label} is duplicated: ${value}`);
    result.add(value);
  }
  return result;
}
