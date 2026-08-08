import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import { validatePredicateContext } from "./context-validator";
import { parsePredicateExpression, type PredicateExpression } from "./ir";
import { readBoundedJsonFile } from "./semantic-limits";
import {
  scanBenchmarkSource,
  type BenchmarkSemanticSource,
} from "./semantic-source";
import {
  parseSchemaEvolutionBenchmarkManifest,
  parseSchemaEvolutionFreezeManifest,
  type SchemaEvolutionBenchmarkManifest,
  type SchemaEvolutionChangeType,
  type SchemaEvolutionFreezeManifest,
} from "./schema-evolution-protocol-parser";

export type {
  SchemaEvolutionBenchmarkManifest,
  SchemaEvolutionChangeType,
  SchemaEvolutionFreezeManifest,
} from "./schema-evolution-protocol-parser";

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
  if (basename(manifestPath) !== "benchmark.json") {
    throw new Error("schema evolution manifest must be named benchmark.json");
  }
  const directory = dirname(manifestPath);
  const manifest = parseSchemaEvolutionBenchmarkManifest(
    await readJson(manifestPath, "schema evolution benchmark manifest"),
  );
  const freezePath = await resolveContainedFile(
    directory,
    manifest.freeze,
    "benchmark.freeze",
  );
  const freeze = parseSchemaEvolutionFreezeManifest(
    await readJson(freezePath, "schema evolution freeze manifest"),
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
    const baselineSourcePath = await resolveContainedFile(
      directory,
      concept.baselineSource,
      `${concept.id}.baselineSource`,
    );
    const baselineOraclePath = await resolveContainedFile(
      directory,
      concept.baselineOracle,
      `${concept.id}.baselineOracle`,
    );
    const source = await scanBenchmarkSource(baselineSourcePath);
    const body = parseBaseline(
      await readJson(baselineOraclePath, `${concept.id} baseline oracle`),
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
      const sourcePath = await resolveContainedFile(
        directory,
        entry.source,
        `${entry.id}.source`,
      );
      const oraclePath = await resolveContainedFile(
        directory,
        entry.oracle,
        `${entry.id}.oracle`,
      );
      const testsPath = await resolveContainedFile(
        directory,
        entry.tests,
        `${entry.id}.tests`,
      );
      const source = await scanBenchmarkSource(sourcePath);
      if (source.concept.id !== entry.conceptId) {
        throw new Error(`${entry.id}: source Concept does not match manifest`);
      }
      return {
        id: entry.id,
        conceptId: entry.conceptId,
        changeType: entry.changeType,
        source,
        baselineIr: baseline.body,
        oracle: parseOracle(await readJson(oraclePath, `${entry.id} oracle`)),
        hiddenCases: parseHiddenCases(
          await readJson(testsPath, `${entry.id} hidden cases`),
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
    throw new Error("freeze file set does not exactly match benchmark inputs");
  }
  await verifyFrozenFileHashes(directory, freeze.files);
}

export async function verifyFrozenFileHashes(
  directory: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [path, expected] of Object.entries(files)) {
    const target = await resolveContainedFile(
      directory,
      path,
      `frozen input ${path}`,
    );
    const actual = sha256(await readFile(target));
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

async function readJson(path: string, label: string): Promise<unknown> {
  return readBoundedJsonFile(path, label);
}

async function resolveContainedFile(
  directory: string,
  file: string,
  label: string,
): Promise<string> {
  const lexicalRoot = resolve(directory);
  const lexicalTarget = resolve(lexicalRoot, file);
  const root = await realpath(lexicalRoot);
  const target = await realpath(lexicalTarget);
  const relation = relative(root, target).replaceAll("\\", "/");
  if (relation === ".." || relation.startsWith("../") || isAbsolute(relation)) {
    throw new Error(`${label} must stay inside the benchmark directory`);
  }
  return lexicalTarget;
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
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
