import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, relative, resolve } from "node:path";

import { resolveContainedFile } from "./contained-path";
import type { PredicateExpression } from "./ir";
import {
  type FieldDescriptor,
  parseSchemaEvolutionAuthoritativeManifest,
  type SchemaDescriptor,
  type SchemaEvolutionConcept,
  type SchemaEvolutionManifest,
} from "./schema-evolution-authoritative-parser";
import {
  assertFrozenInputs,
  evaluateMaterializedSchemaEvolution,
  type MaterializedSchemaEvolutionOptions,
  verifyFrozenFileHashes,
} from "./schema-evolution-evaluator";
import {
  parseSchemaEvolutionFreezeManifest,
  type SchemaEvolutionFreezeManifest,
} from "./schema-evolution-protocol-parser";
import { readBoundedJsonFile } from "./semantic-limits";

export type SchemaEvolutionBenchmarkOptions = Omit<
  MaterializedSchemaEvolutionOptions,
  "manifestPath" | "requireFrozenInputs" | "parallelTrials"
> & {
  manifestPath: string;
  requireFrozenInputs?: boolean;
};

export async function runSchemaEvolutionBenchmark(
  options: SchemaEvolutionBenchmarkOptions,
) {
  const requestedManifestPath = resolve(options.manifestPath);
  const manifestPath = await resolveContainedFile(
    dirname(requestedManifestPath),
    basename(requestedManifestPath),
    "authoritative schema evolution manifest",
    {
      containmentLabel: "benchmark directory",
      rejectSymbolicLinks: true,
    },
  );
  const directory = dirname(manifestPath);
  const manifest = parseSchemaEvolutionAuthoritativeManifest(
    await readBoundedJsonFile(
      manifestPath,
      "authoritative schema evolution manifest",
    ),
  );
  const freezePath = await resolveContainedFile(
    directory,
    "freeze.json",
    "authoritative schema evolution freeze",
    {
      containmentLabel: "benchmark directory",
      rejectSymbolicLinks: true,
    },
  );
  const freeze = parseSchemaEvolutionFreezeManifest(
    await readBoundedJsonFile(
      freezePath,
      "authoritative schema evolution freeze",
    ),
  );
  if (
    Object.keys(freeze.files).length !== 1 ||
    freeze.files["benchmark.json"] === undefined
  ) {
    throw new Error("freeze must contain exactly benchmark.json");
  }
  await verifyFrozenFileHashes(directory, freeze.files);
  if (options.requireFrozenInputs ?? true) assertFrozenInputs(freeze);
  validateProtocol(manifest);

  const materializedRoot = await mkdtemp(
    resolve(tmpdir(), "l-lang-schema-evolution-"),
  );
  try {
    const generatedManifestPath = await materializeBenchmark(
      materializedRoot,
      resolve(options.workspaceRoot ?? process.cwd()),
      manifest,
      freeze,
    );
    const result = await evaluateMaterializedSchemaEvolution({
      ...options,
      manifestPath: generatedManifestPath,
      requireFrozenInputs: false,
      parallelTrials: true,
    });
    const authoritativeManifestSha256 = sha256(await readFile(manifestPath));
    const report = {
      ...result.report,
      authoritativeInput: {
        manifest: manifestPath,
        sha256: authoritativeManifestSha256,
        freezeStatus: freeze.status,
      },
    };
    await writeFile(
      resolve(result.runDirectory, "report.json"),
      json(report),
      "utf8",
    );
    await writeFile(
      resolve(result.runDirectory, "report.md"),
      `${await readFile(resolve(result.runDirectory, "report.md"), "utf8")}\n## Authoritative input\n\n- Manifest: ${manifestPath}\n- SHA-256: ${authoritativeManifestSha256}\n- Freeze: ${freeze.status}\n`,
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

function validateProtocol(manifest: SchemaEvolutionManifest): void {
  if (manifest.concepts.length !== 4 || manifest.trials !== 3) {
    throw new Error("protocol requires exactly 4 Concepts and 3 samples");
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
    if (ids.has(concept.id))
      throw new Error(`duplicate Concept id: ${concept.id}`);
    ids.add(concept.id);
    validateSchema(concept.baseline, `${concept.id}.baseline`, true);
    for (const change of expectedChanges) {
      validateSchema(concept.cases[change], `${concept.id}.${change}`, false);
      const expected =
        change === "remove-role" || change === "ambiguity"
          ? "unresolved"
          : "resolved";
      if (concept.cases[change].expectedOutcome !== expected) {
        throw new Error(
          `${concept.id}.${change}: expectedOutcome must be ${expected}`,
        );
      }
    }
  }
}

function validateSchema(
  schema: SchemaDescriptor,
  path: string,
  baseline: boolean,
): void {
  if (schema.fields.length < 2)
    throw new Error(`${path}: at least two fields are required`);
  const conditionFields = schema.fields.filter(
    (field) => field.condition !== undefined,
  );
  if (
    (baseline || schema.expectedOutcome === "resolved") &&
    conditionFields.length !== 3
  ) {
    throw new Error(
      `${path}: resolved schemas require exactly three frozen conditions`,
    );
  }
  if (schema.expectedOutcome === "unresolved" && conditionFields.length !== 0) {
    throw new Error(
      `${path}: unresolved schemas must not encode an oracle condition`,
    );
  }
  for (const [index, field] of schema.fields.entries()) {
    if (
      field.path.length === 0 ||
      field.path.some((part) => !/^[$A-Z_a-z][$\w]*$/.test(part))
    ) {
      throw new Error(`${path}.fields[${index}]: invalid property path`);
    }
    if (field.condition !== undefined && !("negative" in field)) {
      throw new Error(
        `${path}.fields[${index}]: condition fields require a negative value`,
      );
    }
  }
}

async function materializeBenchmark(
  root: string,
  workspaceRoot: string,
  manifest: SchemaEvolutionManifest,
  freeze: SchemaEvolutionFreezeManifest,
): Promise<string> {
  const files = new Map<string, string>();
  const concepts = [];
  const cases = [];
  for (const concept of manifest.concepts) {
    const slug = slugify(concept.displayName);
    const definition = `concepts/${slug}.ts`;
    const baselineSource = `baselines/${slug}.semantic.ts`;
    const baselineOracle = `baselines/${slug}.oracle.json`;
    files.set(
      definition,
      renderConcept(
        concept,
        modulePath(
          relative(
            resolve(root, "concepts"),
            resolve(workspaceRoot, "src/dsl"),
          ),
        ),
      ),
    );
    files.set(
      baselineSource,
      renderSource(
        concept,
        concept.baseline,
        "Baseline",
        modulePath(
          relative(resolve(root, "baselines"), resolve(root, "concepts", slug)),
        ),
        modulePath(
          relative(
            resolve(root, "baselines"),
            resolve(workspaceRoot, "src/dsl"),
          ),
        ),
      ),
    );
    files.set(
      baselineOracle,
      json({ version: 1, body: bodyFor(concept.baseline) }),
    );
    concepts.push({
      id: concept.id,
      definition,
      baselineSource,
      baselineOracle,
    });

    for (const [changeType, schema] of Object.entries(concept.cases)) {
      const id = `${slug}-${changeType}`;
      const source = `changes/${slug}/${changeType}.semantic.ts`;
      const oracle = `oracles/${id}.oracle.json`;
      const tests = `cases/${id}.cases.json`;
      files.set(
        source,
        renderSource(
          concept,
          schema,
          pascalCase(changeType),
          modulePath(
            relative(
              resolve(root, "changes", slug),
              resolve(root, "concepts", slug),
            ),
          ),
          modulePath(
            relative(
              resolve(root, "changes", slug),
              resolve(workspaceRoot, "src/dsl"),
            ),
          ),
        ),
      );
      files.set(
        oracle,
        json(
          schema.expectedOutcome === "resolved"
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
              },
        ),
      );
      files.set(tests, json({ version: 1, tests: hiddenCasesFor(schema) }));
      cases.push({
        id,
        conceptId: concept.id,
        changeType,
        source,
        oracle,
        tests,
      });
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
      note: "The model receives only each frozen Concept, evolved TypeScript type, and target predicate.",
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
      maximumFalseResolutionRate:
        manifest.thresholds.maximumFalseResolutionRate,
      maximumWorkspaceMutationCount:
        manifest.thresholds.maximumWorkspaceMutationCount,
      minimumConsensusCaseRate: manifest.thresholds.minimumConsensusCaseRate,
      minimumConsensusQuorumRate:
        manifest.thresholds.minimumConsensusQuorumRate,
    },
    concepts,
    cases,
  };
  files.set("benchmark.json", json(generatedManifest));
  const hashes = Object.fromEntries(
    [...files.entries()].map(([path, content]) => [path, sha256(content)]),
  );
  files.set(
    "freeze.json",
    json({
      version: 1,
      status: freeze.status,
      instructions: freeze.instructions,
      files: hashes,
    }),
  );
  await writeFile(
    resolve(root, "tsconfig.json"),
    json({ extends: resolve(workspaceRoot, "tsconfig.json") }),
    "utf8",
  );
  await Promise.all(
    [...files.entries()].map(async ([path, content]) => {
      const absolute = resolve(root, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf8");
    }),
  );
  return resolve(root, "benchmark.json");
}

function renderConcept(
  concept: SchemaEvolutionConcept,
  dslModule: string,
): string {
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
  concept: SchemaEvolutionConcept,
  schema: SchemaDescriptor,
  suffix: string,
  conceptModule: string,
  dslModule: string,
): string {
  const predicate = `is${concept.exportName}${suffix}`;
  return [
    `import { ${concept.exportName} } from ${JSON.stringify(conceptModule)};`,
    `import { benchmarkProbe, bindConcept, generatePredicate } from ${JSON.stringify(dslModule)};`,
    "",
    renderType(schema),
    "",
    `const Bound = bindConcept<${schema.typeName}>(${concept.exportName});`,
    `export const ${predicate} = generatePredicate(Bound);`,
    `benchmarkProbe(${predicate});`,
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
    const leaf = field.path.at(-1);
    if (leaf === undefined) throw new Error("field path must not be empty");
    node.children.set(leaf, { children: new Map(), field });
  }
  return `export type ${schema.typeName} = ${renderObject(root, 0)};`;
}

type FieldTree = { children: Map<string, FieldTree>; field?: FieldDescriptor };

function renderObject(node: FieldTree, depth: number): string {
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);
  return [
    "{",
    ...[...node.children.entries()].map(
      ([name, child]) =>
        `${childIndent}${name}${child.field?.optional ? "?" : ""}: ${child.field ? child.field.type : renderObject(child, depth + 1)};`,
    ),
    `${indent}}`,
  ].join("\n");
}

function bodyFor(schema: SchemaDescriptor): PredicateExpression {
  const conditions: PredicateExpression[] = [];
  for (const field of schema.fields) {
    if (field.condition === undefined) continue;
    conditions.push(
      field.condition.kind === "present"
        ? { kind: "present", property: field.path }
        : {
            kind: "equals",
            property: field.path,
            value: field.condition.value,
          },
    );
  }
  return { kind: "all", conditions };
}

function hiddenCasesFor(schema: SchemaDescriptor) {
  if (schema.expectedOutcome === "unresolved") return [];
  const positive = fixtureFor(schema.fields, null);
  return [
    { name: "eligible", input: positive, expected: true },
    ...schema.fields.flatMap((field) =>
      field.condition === undefined
        ? []
        : [
            {
              name: `rejects-${field.path.join("-")}`,
              input: fixtureFor(schema.fields, field),
              expected: false,
            },
          ],
    ),
  ];
}

function fixtureFor(
  fields: FieldDescriptor[],
  negativeField: FieldDescriptor | null,
) {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (field === negativeField && field.omitWhenNegative) continue;
    setPath(
      result,
      field.path,
      field === negativeField ? field.negative : field.positive,
    );
  }
  return result;
}

function setPath(
  target: Record<string, unknown>,
  path: string[],
  value: unknown,
): void {
  let current = target;
  for (const part of path.slice(0, -1)) {
    const existing = current[part];
    if (
      typeof existing === "object" &&
      existing !== null &&
      !Array.isArray(existing)
    ) {
      current = existing as Record<string, unknown>;
    } else {
      const child: Record<string, unknown> = {};
      current[part] = child;
      current = child;
    }
  }
  const leaf = path.at(-1);
  if (leaf === undefined) throw new Error("fixture path must not be empty");
  current[leaf] = value;
}

function modulePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

function pascalCase(value: string): string {
  return value
    .split("-")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
