import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";

import type { PredicateExpression } from "./ir";
import {
  assertHumanReviewedFreeze,
  runSchemaEvolutionBenchmark,
  verifyFrozenFileHashes,
  type SchemaEvolutionBenchmarkOptions,
} from "./schema-evolution-benchmark";

type FieldDescriptor = {
  path: string[];
  type: string;
  optional?: boolean;
  omitWhenNegative?: boolean;
  positive: unknown;
  condition?:
    | { kind: "equals"; value: string | number | boolean | null }
    | { kind: "present" };
  negative?: unknown;
};

type SchemaDescriptor = {
  typeName: string;
  expectedOutcome: "resolved" | "unresolved";
  fields: FieldDescriptor[];
};

type V2Concept = {
  id: string;
  exportName: string;
  displayName: string;
  specification: string;
  baseline: SchemaDescriptor;
  cases: Record<
    "add-property" | "rename" | "representation" | "optionality" | "remove-role" | "ambiguity",
    SchemaDescriptor
  >;
};

type V2Manifest = {
  version: 2;
  name: string;
  trials: 3;
  concepts: V2Concept[];
  thresholds: {
    minimumConsensusCaseRate: number;
    minimumConsensusQuorumRate: number;
    maximumFalseResolutionRate: number;
    maximumWorkspaceMutationCount: number;
  };
};

type V2Freeze = {
  version: 1;
  status: "draft" | "human-reviewed";
  humanReviewed: boolean;
  reviewer: string | null;
  reviewedAt: string | null;
  instructions: string;
  files: Record<string, string>;
};

export type RunSchemaEvolutionV2Options = Omit<
  SchemaEvolutionBenchmarkOptions,
  "manifestPath" | "requireHumanReview" | "parallelTrials"
> & {
  manifestPath: string;
  requireHumanReview?: boolean;
};

export async function runSchemaEvolutionV2(options: RunSchemaEvolutionV2Options) {
  const manifestPath = resolve(options.manifestPath);
  const directory = dirname(manifestPath);
  const manifest = parseV2Manifest(
    JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
  );
  const freeze = parseV2Freeze(
    JSON.parse(await readFile(resolve(directory, "freeze.json"), "utf8")) as unknown,
  );
  if (Object.keys(freeze.files).length !== 1 || freeze.files["benchmark.json"] === undefined) {
    throw new Error("v2 freeze must contain exactly benchmark.json");
  }
  await verifyFrozenFileHashes(directory, freeze.files);
  if (options.requireHumanReview ?? true) assertHumanReviewedFreeze(freeze);
  validateV2Protocol(manifest);

  const materializedRoot = await mkdtemp(resolve(tmpdir(), "l-lang-schema-evolution-v2-"));
  try {
    const generatedManifestPath = await materializeBenchmark(
      materializedRoot,
      resolve(options.workspaceRoot ?? process.cwd()),
      manifest,
      freeze,
    );
    const result = await runSchemaEvolutionBenchmark({
      ...options,
      manifestPath: generatedManifestPath,
      requireHumanReview: false,
      parallelTrials: true,
    });
    const authoritativeManifestSha256 = sha256(await readFile(manifestPath));
    const report = {
      ...result.report,
      authoritativeInput: {
        manifest: manifestPath,
        sha256: authoritativeManifestSha256,
        reviewStatus: freeze.status,
        reviewer: freeze.reviewer,
        reviewedAt: freeze.reviewedAt,
      },
    };
    await writeFile(
      resolve(result.runDirectory, "report.json"),
      json(report),
      "utf8",
    );
    await writeFile(
      resolve(result.runDirectory, "report.md"),
      `${await readFile(resolve(result.runDirectory, "report.md"), "utf8")}\n## Authoritative v2 input\n\n- Manifest: ${manifestPath}\n- SHA-256: ${authoritativeManifestSha256}\n- Review: ${freeze.status}\n`,
      "utf8",
    );
    return {
      report,
      runDirectory: result.runDirectory,
      authoritativeManifest: manifestPath,
      authoritativeManifestSha256,
    };
  } finally {
    await rm(materializedRoot, { recursive: true, force: true });
  }
}

function validateV2Protocol(manifest: V2Manifest): void {
  if (manifest.concepts.length !== 4 || manifest.trials !== 3) {
    throw new Error("v2 protocol requires exactly 4 new Concepts and 3 samples");
  }
  const ids = new Set<string>();
  const expectedChanges = [
    "add-property",
    "rename",
    "representation",
    "optionality",
    "remove-role",
    "ambiguity",
  ] as const;
  for (const concept of manifest.concepts) {
    if (ids.has(concept.id)) throw new Error(`duplicate v2 Concept id: ${concept.id}`);
    ids.add(concept.id);
    validateSchema(concept.baseline, `${concept.id}.baseline`, true);
    for (const change of expectedChanges) {
      validateSchema(concept.cases[change], `${concept.id}.${change}`, false);
      const expected = change === "remove-role" || change === "ambiguity"
        ? "unresolved"
        : "resolved";
      if (concept.cases[change].expectedOutcome !== expected) {
        throw new Error(`${concept.id}.${change}: expectedOutcome must be ${expected}`);
      }
    }
  }
}

function validateSchema(schema: SchemaDescriptor, path: string, baseline: boolean): void {
  if (schema.fields.length < 2) throw new Error(`${path}: at least two fields are required`);
  const conditionFields = schema.fields.filter((field) => field.condition !== undefined);
  if ((baseline || schema.expectedOutcome === "resolved") && conditionFields.length !== 3) {
    throw new Error(`${path}: resolved schemas require exactly three frozen conditions`);
  }
  if (schema.expectedOutcome === "unresolved" && conditionFields.length !== 0) {
    throw new Error(`${path}: unresolved schemas must not encode an oracle condition`);
  }
  for (const [index, field] of schema.fields.entries()) {
    if (field.path.length === 0 || field.path.some((part) => !/^[$A-Z_a-z][$\w]*$/.test(part))) {
      throw new Error(`${path}.fields[${index}]: invalid property path`);
    }
    if (field.condition !== undefined && !("negative" in field)) {
      throw new Error(`${path}.fields[${index}]: condition fields require a negative value`);
    }
  }
}

async function materializeBenchmark(
  root: string,
  workspaceRoot: string,
  manifest: V2Manifest,
  freeze: V2Freeze,
): Promise<string> {
  const files = new Map<string, string>();
  const concepts = [];
  const cases = [];
  for (const concept of manifest.concepts) {
    const slug = slugify(concept.displayName);
    const definition = `concepts/${slug}.ts`;
    const baselineSource = `baselines/${slug}.semantic.ts`;
    const baselineOracle = `baselines/${slug}.oracle.json`;
    files.set(definition, renderConcept(concept, modulePath(relative(resolve(root, "concepts"), resolve(workspaceRoot, "src/dsl")))));
    files.set(
      baselineSource,
      renderSource(concept, concept.baseline, "Baseline", modulePath(relative(resolve(root, "baselines"), resolve(root, "concepts", slug))), modulePath(relative(resolve(root, "baselines"), resolve(workspaceRoot, "src/dsl")))),
    );
    files.set(baselineOracle, json({ version: 1, body: bodyFor(concept.baseline) }));
    concepts.push({ id: concept.id, definition, baselineSource, baselineOracle });

    for (const [changeType, schema] of Object.entries(concept.cases)) {
      const id = `${slug}-${changeType}`;
      const source = `changes/${slug}/${changeType}.semantic.ts`;
      const oracle = `oracles/${id}.oracle.json`;
      const tests = `cases/${id}.cases.json`;
      files.set(
        source,
        renderSource(concept, schema, pascalCase(changeType), modulePath(relative(resolve(root, "changes", slug), resolve(root, "concepts", slug))), modulePath(relative(resolve(root, "changes", slug), resolve(workspaceRoot, "src/dsl")))),
      );
      files.set(
        oracle,
        json(schema.expectedOutcome === "resolved"
          ? {
              version: 1,
              expectedOutcome: "resolved",
              expectedClassification: "compatible",
              body: bodyFor(schema),
            }
          : {
              version: 1,
              expectedOutcome: "unresolved",
              expectedClassification: "unresolved",
              body: null,
            }),
      );
      files.set(tests, json({ version: 1, tests: hiddenCasesFor(schema) }));
      cases.push({ id, conceptId: concept.id, changeType, source, oracle, tests });
    }
  }
  const generatedManifest = {
    version: 1,
    name: manifest.name,
    trials: 3,
    freeze: "freeze.json",
    blindness: {
      oracleAndCasesSentToModel: false,
      lockUsed: false,
      generatedCodeMutationAllowed: false,
      note: "V2 sends only each frozen Concept, evolved TypeScript type, and target predicate.",
    },
    evaluation: { primary: "consensus", samples: 3, quorum: 2, parallel: true },
    protocol: {
      concepts: 4,
      cases: 24,
      resolvedCases: 16,
      unresolvedCases: 8,
      casesPerChangeType: 4,
    },
    thresholds: {
      minimumFirstPassCaseRate: 0,
      minimumStableCaseRate: 0,
      minimumClassificationAccuracy: 0,
      minimumHiddenTestPassRate: 0,
      maximumFalseResolutionRate: manifest.thresholds.maximumFalseResolutionRate,
      maximumWorkspaceMutationCount: manifest.thresholds.maximumWorkspaceMutationCount,
      minimumConsensusCaseRate: manifest.thresholds.minimumConsensusCaseRate,
      minimumConsensusQuorumRate: manifest.thresholds.minimumConsensusQuorumRate,
    },
    concepts,
    cases,
  };
  files.set("benchmark.json", json(generatedManifest));
  const hashes = Object.fromEntries(
    [...files.entries()].map(([path, content]) => [path, sha256(content)]),
  );
  files.set("freeze.json", json({
    version: 1,
    status: freeze.status,
    humanReviewed: freeze.humanReviewed,
    reviewer: freeze.reviewer,
    reviewedAt: freeze.reviewedAt,
    instructions: freeze.instructions,
    files: hashes,
  }));
  await writeFile(
    resolve(root, "tsconfig.json"),
    json({ extends: resolve(workspaceRoot, "tsconfig.json") }),
    "utf8",
  );
  await Promise.all([...files.entries()].map(async ([path, content]) => {
    const absolute = resolve(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }));
  return resolve(root, "benchmark.json");
}

function renderConcept(concept: V2Concept, dslModule: string): string {
  return [
    `import { defineConcept } from ${JSON.stringify(dslModule)};`,
    "",
    `export const ${concept.exportName} = defineConcept(${JSON.stringify(concept.id)})\``,
    concept.specification.trim(),
    "`;",
    "",
  ].join("\n");
}

function renderSource(
  concept: V2Concept,
  schema: SchemaDescriptor,
  suffix: string,
  conceptModule: string,
  dslModule: string,
): string {
  const predicate = `isV2${concept.exportName.replace(/^V2/, "")}${suffix}`;
  return [
    `import { ${concept.exportName} } from ${JSON.stringify(conceptModule)};`,
    `import { bindConcept, generatePredicate, semanticTest } from ${JSON.stringify(dslModule)};`,
    "",
    renderType(schema),
    "",
    `const Bound = bindConcept<${schema.typeName}>(${concept.exportName});`,
    `export const ${predicate} = generatePredicate(Bound);`,
    `semanticTest(${predicate}, { accept: [], reject: [] });`,
    "",
  ].join("\n");
}

function renderType(schema: SchemaDescriptor): string {
  const root: FieldTree = { children: new Map() };
  for (const field of schema.fields) {
    let node = root;
    for (const part of field.path.slice(0, -1)) {
      const child = node.children.get(part) ?? { children: new Map() };
      node.children.set(part, child);
      node = child;
    }
    node.children.set(field.path.at(-1)!, { children: new Map(), field });
  }
  return `export type ${schema.typeName} = ${renderObject(root, 0)};`;
}

type FieldTree = { children: Map<string, FieldTree>; field?: FieldDescriptor };

function renderObject(node: FieldTree, depth: number): string {
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);
  return [
    "{",
    ...[...node.children.entries()].map(([name, child]) =>
      `${childIndent}${name}${child.field?.optional ? "?" : ""}: ${child.field ? child.field.type : renderObject(child, depth + 1)};`,
    ),
    `${indent}}`,
  ].join("\n");
}

function bodyFor(schema: SchemaDescriptor): PredicateExpression {
  const conditions: PredicateExpression[] = [];
  for (const field of schema.fields) {
    if (field.condition === undefined) continue;
    conditions.push(field.condition.kind === "present"
      ? { kind: "present", property: field.path }
      : { kind: "equals", property: field.path, value: field.condition.value });
  }
  return { kind: "all", conditions };
}

function hiddenCasesFor(schema: SchemaDescriptor) {
  if (schema.expectedOutcome === "unresolved") return [];
  const positive = fixtureFor(schema.fields, null);
  return [
    { name: "eligible", input: positive, expected: true },
    ...schema.fields.flatMap((field) => field.condition === undefined
      ? []
      : [{
          name: `rejects-${field.path.join("-")}`,
          input: fixtureFor(schema.fields, field),
          expected: false,
        }]),
  ];
}

function fixtureFor(fields: FieldDescriptor[], negativeField: FieldDescriptor | null) {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (field === negativeField && field.omitWhenNegative) continue;
    setPath(result, field.path, field === negativeField ? field.negative : field.positive);
  }
  return result;
}

function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let current = target;
  for (const part of path.slice(0, -1)) {
    const existing = current[part];
    if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
      current = existing as Record<string, unknown>;
    } else {
      const child: Record<string, unknown> = {};
      current[part] = child;
      current = child;
    }
  }
  current[path.at(-1)!] = value;
}

function parseV2Manifest(input: unknown): V2Manifest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("v2 benchmark manifest must be an object");
  }
  const value = input as Record<string, unknown>;
  if (value.version !== 2 || value.trials !== 3 || !Array.isArray(value.concepts)) {
    throw new Error("v2 benchmark manifest is invalid");
  }
  return input as V2Manifest;
}

function parseV2Freeze(input: unknown): V2Freeze {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("v2 freeze must be an object");
  }
  const value = input as Record<string, unknown>;
  if (value.version !== 1 || typeof value.files !== "object" || value.files === null) {
    throw new Error("v2 freeze is invalid");
  }
  return input as V2Freeze;
}

function modulePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-|-$/g, "");
}

function pascalCase(value: string): string {
  return value.split("-").map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join("");
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
