import {
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { sha256 } from "./semantic-fingerprint";

export async function createProjectFitTestProtocol(): Promise<{
  directory: string;
  manifestPath: string;
}> {
  const directory = await mkdtemp(resolve(tmpdir(), "l-lang-project-fit-"));
  const manifest = validProjectFitManifest();
  const files: Record<string, unknown> = {
    "initial.input.json": modelInput(
      "Select an eligible fixture record.",
      "FixtureRecord",
      "type FixtureRecord = { ready: boolean };",
    ),
    "initial.context.json": projectContext(
      "FixtureRecord",
      "type FixtureRecord = { ready: boolean };",
      "ready",
    ),
    "initial.oracle.json": oracle("ready"),
    "initial.type-only.fixture.json": fixture(false),
    "initial.project-context.fixture.json": fixture(true),
    "schema-change.input.json": modelInput(
      "Select an eligible fixture record.",
      "UpdatedFixtureRecord",
      'type UpdatedFixtureRecord = { state: "ready" | "blocked" };',
    ),
    "schema-change.context.json": projectContext(
      "UpdatedFixtureRecord",
      'type UpdatedFixtureRecord = { state: "ready" | "blocked" };',
      "state",
    ),
    "schema-change.oracle.json": oracle("state"),
    "schema-change.type-only.fixture.json": fixture(false),
    "schema-change.project-context.fixture.json": fixture(true),
  };
  for (const [file, value] of Object.entries(files)) {
    await writeFile(
      resolve(directory, file),
      `${JSON.stringify(value, null, 2)}\n`,
      "utf8",
    );
  }
  const manifestPath = resolve(directory, "benchmark.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  const frozenFiles = ["benchmark.json", ...Object.keys(files)].sort();
  const hashes = Object.fromEntries(
    await Promise.all(
      frozenFiles.map(async (file) => [
        file,
        sha256(await readFile(resolve(directory, file))),
      ]),
    ),
  );
  await writeFile(
    resolve(directory, "freeze.json"),
    `${JSON.stringify(
      {
        version: 2,
        status: "draft",
        instructions: "Fixture inputs are immutable.",
        files: hashes,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { directory, manifestPath };
}

export function validProjectFitManifest(): Record<string, unknown> {
  return {
    version: 2,
    name: "project-fit-fixture",
    trials: 1,
    freeze: "freeze.json",
    budget: {
      maxApiCalls: 4,
      maxInputTokens: 2_000,
      maxOutputTokensPerCall: 200,
      maxTotalOutputTokens: 800,
      maxEstimatedCost: 1,
    },
    thresholds: {
      minProjectContextFirstPassCases: 1,
      minFirstPassDeltaCases: 1,
      maxFalseResolutionDelta: 0,
      maxUnresolvedRateRegression: 0.1,
      maxLatencyDeltaMs: 1_000,
    },
    cases: [
      {
        id: "case-1",
        domain: "fixture",
        stages: {
          initial: stageFiles("initial"),
          schemaChange: stageFiles("schema-change"),
        },
      },
    ],
  };
}

function stageFiles(prefix: string): Record<string, unknown> {
  return {
    modelInput: `${prefix}.input.json`,
    projectContext: `${prefix}.context.json`,
    oracle: `${prefix}.oracle.json`,
    fixtures: {
      typeOnly: `${prefix}.type-only.fixture.json`,
      projectContext: `${prefix}.project-context.fixture.json`,
    },
  };
}

function modelInput(
  intent: string,
  typeName: string,
  typeScriptSource: string,
): Record<string, unknown> {
  return {
    version: 2,
    intent,
    target: {
      functionName: "isEligibleFixture",
      parameterName: "fixture",
      typeName,
      typeScriptSource,
    },
  };
}

function projectContext(
  typeName: string,
  typeDeclaration: string,
  property: string,
): Record<string, unknown> {
  return {
    version: 1,
    target: {
      source: "work/fixture.semantic.ts",
      symbol: "isEligibleFixture",
      typeName,
      typeDeclaration,
    },
    relatedTypes: [],
    verifiedBindings: [
      {
        conceptId: "fixture.eligible",
        source: "work/prior-fixture.semantic.ts",
        targetTypeName: typeName,
        typeSchemaHash: "1".repeat(64),
        resolvedIr: {
          kind: "equals",
          property: [property],
          value: property === "ready" ? true : "ready",
        },
        generatedCodeHash: "2".repeat(64),
      },
    ],
    compilerContext: {
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
    },
  };
}

function oracle(property: string): Record<string, unknown> {
  return {
    version: 2,
    hiddenCases: [
      {
        name: "HIDDEN_SENTINEL",
        input: { [property]: property === "ready" ? true : "ready" },
        expected: true,
      },
      {
        name: "not-ready",
        input: { [property]: property === "ready" ? false : "blocked" },
        expected: false,
      },
    ],
  };
}

function fixture(projectGatePassed: boolean): Record<string, unknown> {
  return {
    version: 2,
    trials: [
      {
        outcome: projectGatePassed ? "resolved" : "unresolved",
        projectGatePassed,
        hiddenTestsPassed: projectGatePassed,
        correctionEffort: projectGatePassed ? 0 : 1,
        inputTokens: projectGatePassed ? 120 : 100,
        outputTokens: 20,
        latencyMs: projectGatePassed ? 25 : 20,
      },
    ],
  };
}
