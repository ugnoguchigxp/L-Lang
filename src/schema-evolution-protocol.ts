import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { validatePredicateContext } from "./context-validator";
import {
  parsePredicateExpression,
  type PredicateExpression,
} from "./ir";
import {
  scanBenchmarkSource,
  type BenchmarkSemanticSource,
} from "./semantic-source";

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

export type SchemaEvolutionOracle =
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

export type SchemaEvolutionHiddenCase = {
  name: string;
  input: Record<string, unknown>;
  expected: boolean;
};

export type PreparedSchemaEvolutionCase = {
  id: string;
  conceptId: string;
  changeType: SchemaEvolutionChangeType;
  source: BenchmarkSemanticSource;
  baselineIr: PredicateExpression;
  oracle: SchemaEvolutionOracle;
  hiddenCases: SchemaEvolutionHiddenCase[];
};

export async function readSchemaEvolutionProtocol(
  manifestPathInput: string,
): Promise<{
  directory: string;
  manifest: SchemaEvolutionBenchmarkManifest;
  freeze: SchemaEvolutionFreezeManifest;
}> {
  const manifestPath = resolve(manifestPathInput);
  const directory = dirname(manifestPath);
  const manifest = parseManifest(await readJson(manifestPath));
  const freeze = parseFreeze(
    await readJson(resolve(directory, manifest.freeze)),
  );
  return { directory, manifest, freeze };
}

export async function prepareSchemaEvolutionCases(
  manifest: SchemaEvolutionBenchmarkManifest,
  directory: string,
): Promise<PreparedSchemaEvolutionCase[]> {
  const baselines = new Map<
    string,
    {
      source: BenchmarkSemanticSource;
      body: PredicateExpression;
    }
  >();
  for (const concept of manifest.concepts) {
    const source = await scanBenchmarkSource(
      resolve(directory, concept.baselineSource),
    );
    const body = parseBaseline(
      await readJson(resolve(directory, concept.baselineOracle)),
    );
    validatePredicateContext(body, source);
    baselines.set(concept.id, { source, body });
  }
  return Promise.all(
    manifest.cases.map(async (entry) => {
      const baseline = baselines.get(entry.conceptId);
      if (baseline === undefined) {
        throw new Error(`${entry.id}: baseline is missing`);
      }
      const source = await scanBenchmarkSource(
        resolve(directory, entry.source),
      );
      if (source.concept.id !== entry.conceptId) {
        throw new Error(
          `${entry.id}: source Concept does not match manifest`,
        );
      }
      return {
        id: entry.id,
        conceptId: entry.conceptId,
        changeType: entry.changeType,
        source,
        baselineIr: baseline.body,
        oracle: parseOracle(
          await readJson(resolve(directory, entry.oracle)),
        ),
        hiddenCases: parseHiddenCases(
          await readJson(resolve(directory, entry.tests)),
        ),
      };
    }),
  );
}

export function validateSchemaEvolutionProtocol(
  manifest: SchemaEvolutionBenchmarkManifest,
  cases: PreparedSchemaEvolutionCase[],
): void {
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
  const changeTypes: SchemaEvolutionChangeType[] = [
    "add-property",
    "rename",
    "representation",
    "optionality",
    "remove-role",
    "ambiguity",
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
  const resolved = cases.filter(
    (entry) => entry.oracle.expectedOutcome === "resolved",
  );
  if (
    resolved.length !== protocol.resolvedCases ||
    cases.length - resolved.length !== protocol.unresolvedCases
  ) {
    throw new Error(
      `protocol requires exactly ${protocol.resolvedCases} resolved and ${protocol.unresolvedCases} unresolved cases`,
    );
  }
  for (const entry of cases) {
    if (entry.oracle.expectedOutcome === "resolved") {
      validatePredicateContext(entry.oracle.body, entry.source);
      if (entry.hiddenCases.length === 0) {
        throw new Error(`${entry.id}: hidden cases required`);
      }
    } else if (entry.hiddenCases.length !== 0) {
      throw new Error(
        `${entry.id}: unresolved case must not contain behavioral oracle cases`,
      );
    }
  }
}

export function assertFrozenInputs(freeze: {
  status: "draft" | "frozen";
}): void {
  if (freeze.status !== "frozen") {
    throw new Error("benchmark inputs must be frozen before live execution");
  }
}

export async function verifySchemaEvolutionFreeze(
  directory: string,
  manifest: SchemaEvolutionBenchmarkManifest,
  freeze: SchemaEvolutionFreezeManifest,
): Promise<void> {
  const required = new Set([
    "benchmark.json",
    ...manifest.concepts.flatMap((entry) => [
      entry.definition,
      entry.baselineSource,
      entry.baselineOracle,
    ]),
    ...manifest.cases.flatMap((entry) => [
      entry.source,
      entry.oracle,
      entry.tests,
    ]),
  ]);
  const frozen = new Set(Object.keys(freeze.files));
  if (stableJson([...required].sort()) !== stableJson([...frozen].sort())) {
    throw new Error(
      "freeze file set does not exactly match benchmark inputs",
    );
  }
  await verifyFrozenFileHashes(directory, freeze.files);
}

export async function verifyFrozenFileHashes(
  directory: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [path, expected] of Object.entries(files)) {
    const actual = sha256(await readFile(resolve(directory, path)));
    if (actual !== expected) {
      throw new Error(`frozen input hash mismatch: ${path}`);
    }
  }
}

export function relativeSchemaEvolutionReportPath(
  workspaceRoot: string,
  path: string,
): string {
  return relative(workspaceRoot, path).replaceAll("\\", "/");
}

function parseManifest(input: unknown): SchemaEvolutionBenchmarkManifest {
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
  return input as SchemaEvolutionBenchmarkManifest;
}

function parseFreeze(input: unknown): SchemaEvolutionFreezeManifest {
  const value = record(input, "freeze");
  if (
    value.version !== 1 ||
    (value.status !== "draft" && value.status !== "frozen") ||
    typeof value.instructions !== "string"
  ) {
    throw new Error("freeze manifest is invalid");
  }
  const files = record(value.files, "freeze.files");
  for (const [path, hash] of Object.entries(files)) {
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error(`invalid frozen hash: ${path}`);
    }
  }
  return input as SchemaEvolutionFreezeManifest;
}

function parseBaseline(input: unknown): PredicateExpression {
  const value = record(input, "baseline oracle");
  if (value.version !== 1) {
    throw new Error("baseline oracle version must be 1");
  }
  return parsePredicateExpression(value.body, "baseline oracle.body");
}

function parseOracle(input: unknown): SchemaEvolutionOracle {
  const value = record(input, "oracle");
  if (value.version !== 1) throw new Error("oracle version must be 1");
  if (
    value.expectedOutcome === "unresolved" &&
    value.expectedClassification === "unresolved" &&
    value.body === null
  ) {
    return {
      expectedOutcome: "unresolved",
      expectedClassification: "unresolved",
      body: null,
    };
  }
  if (
    value.expectedOutcome === "resolved" &&
    value.expectedClassification === "compatible"
  ) {
    return {
      expectedOutcome: "resolved",
      expectedClassification: "compatible",
      body: parsePredicateExpression(value.body, "oracle.body"),
    };
  }
  throw new Error("oracle outcome, classification, or body is invalid");
}

function parseHiddenCases(input: unknown): SchemaEvolutionHiddenCase[] {
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

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
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
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson(object[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
