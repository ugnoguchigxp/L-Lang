import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { resolveContainedFile } from "./contained-path";
import {
  parseCrossSchemaConceptFreeze,
  parseCrossSchemaHiddenCases,
  parseCrossSchemaManifest,
  parseCrossSchemaManualTimes,
  parseCrossSchemaOracle,
  validateCrossSchemaProtocolInputs,
  verifyCrossSchemaFileFreeze,
} from "./cross-schema-benchmark-protocol";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("cross-schema benchmark protocol", () => {
  test("strictly parses every manifest branch before execution", () => {
    const manifest = manifestFixture();
    expect(parseCrossSchemaManifest(manifest)).toMatchObject({
      version: 1,
      name: "fixture",
      trials: 3,
      cases: expect.arrayContaining([
        expect.objectContaining({ id: "case-1", source: "bindings/case-1.ts" }),
      ]),
    });

    const malformed: Array<{
      mutate: (value: Record<string, unknown>) => void;
      message: string;
    }> = [
      {
        mutate: (value) => {
          delete (value.thresholds as Record<string, unknown>)
            .minimumFirstPassCaseRate;
        },
        message: "thresholds is missing minimumFirstPassCaseRate",
      },
      {
        mutate: (value) => {
          const first = (value.cases as Array<Record<string, unknown>>)[0];
          if (first === undefined) throw new Error("fixture case is missing");
          first.unexpected = true;
        },
        message: "cases[0] contains unknown field unexpected",
      },
      {
        mutate: (value) => {
          const first = (value.cases as Array<Record<string, unknown>>)[0];
          if (first === undefined) throw new Error("fixture case is missing");
          first.source = "../outside.ts";
        },
        message: "source must be a normalized relative path",
      },
      {
        mutate: (value) => {
          (value.blindness as Record<string, unknown>).oracleAndCasesSentToModel =
            true;
        },
        message: "oracleAndCasesSentToModel must be false",
      },
      {
        mutate: (value) => {
          (value.thresholds as Record<string, unknown>).minimumStableCaseRate =
            Number.NaN;
        },
        message: "minimumStableCaseRate must be a finite number between 0 and 1",
      },
    ];
    for (const testCase of malformed) {
      const value = manifestFixture();
      testCase.mutate(value);
      expect(() => parseCrossSchemaManifest(value)).toThrow(testCase.message);
    }
  });

  test("strictly parses oracle, hidden cases, freeze, and manual times", () => {
    expect(
      parseCrossSchemaOracle({
        version: 1,
        expectedOutcome: "unresolved",
        body: null,
      }),
    ).toEqual({ expectedOutcome: "unresolved", body: null });
    expect(() =>
      parseCrossSchemaOracle({
        version: 1,
        expectedOutcome: "unresolved",
        body: null,
        unexpected: true,
      }),
    ).toThrow("oracle contains unknown field unexpected");
    expect(() =>
      parseCrossSchemaHiddenCases({
        version: 1,
        tests: [
          { name: "duplicate", input: {}, expected: true },
          { name: "duplicate", input: {}, expected: false },
        ],
      }),
    ).toThrow("must not contain duplicate names");
    expect(
      parseCrossSchemaConceptFreeze({
        version: 1,
        frozenAt: "2026-08-08T00:00:00Z",
        rule: "Frozen before execution.",
        concepts: { "fixture.concept": "a".repeat(64) },
      }).evidenceEligible,
    ).toBe(false);
    expect(() =>
      parseCrossSchemaManualTimes({
        version: 1,
        instructions: "Measure without the oracle.",
        entries: {
          "case-1": {
            manualAuthoringMs: -1,
            manualReviewMs: null,
            semanticAuthoringMs: null,
            semanticReviewMs: null,
          },
        },
      }),
    ).toThrow("manualAuthoringMs must be null or a non-negative finite number");
  });

  test("validates protocol shape and v2 file hashes", async () => {
    const manifest = parseCrossSchemaManifest(manifestFixture());
    const manualTimes = parseCrossSchemaManualTimes(manualTimesFixture());
    expect(() => validateCrossSchemaProtocolInputs(manifest, manualTimes)).not
      .toThrow();

    const root = await temporaryRoot();
    const benchmark = resolve(root, "benchmark.json");
    const input = resolve(root, "input.ts");
    await writeFile(benchmark, "{}\n", "utf8");
    await writeFile(input, "export {};\n", "utf8");
    const freeze = parseCrossSchemaConceptFreeze({
      version: 2,
      status: "frozen",
      frozenAt: "2026-08-08T00:00:00.000Z",
      rule: "Hash every declared evaluation input.",
      concepts: { "fixture.concept": "a".repeat(64) },
      files: {
        "benchmark.json": hash("{}\n"),
        "input.ts": hash("export {};\n"),
      },
    });
    const resolveFile = (path: string, label: string) =>
      resolveContainedFile(root, path, label, {
        containmentLabel: "benchmark directory",
        rejectSymbolicLinks: true,
      });
    await expect(
      verifyCrossSchemaFileFreeze(
        freeze,
        ["benchmark.json", "input.ts"],
        resolveFile,
      ),
    ).resolves.toBeUndefined();

    await writeFile(input, "export const changed = true;\n", "utf8");
    await expect(
      verifyCrossSchemaFileFreeze(
        freeze,
        ["benchmark.json", "input.ts"],
        resolveFile,
      ),
    ).rejects.toThrow("cross-schema frozen input changed: input.ts");
  });
});

function manifestFixture(): Record<string, unknown> {
  return {
    version: 1,
    name: "fixture",
    trials: 3,
    conceptFreeze: "concept-freeze.json",
    manualTimes: "manual/manual-times.json",
    blindness: {
      oracleAndCasesSentToModel: false,
      conceptsFrozenBeforeFirstModelCall: true,
      independentHumanOracleAuthor: false,
      note: "Fixture protocol.",
    },
    thresholds: {
      minimumFirstPassCaseRate: 0.8,
      maximumFalseResolutionRate: 0,
      minimumStableCaseRate: 0.9,
      minimumHiddenTestPassRate: 1,
      targetManualTimeReduction: 0.3,
    },
    cases: Array.from({ length: 9 }, (_, index) => ({
      id: `case-${index + 1}`,
      source: `bindings/case-${index + 1}.ts`,
      oracle: `oracles/case-${index + 1}.json`,
      tests: `cases/case-${index + 1}.json`,
      ...(index < 6 ? { manual: `manual/case-${index + 1}.ts` } : {}),
    })),
  };
}

function manualTimesFixture() {
  return {
    version: 1,
    instructions: "Measure without the oracle.",
    entries: Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [
        `case-${index + 1}`,
        {
          manualAuthoringMs: null,
          manualReviewMs: null,
          semanticAuthoringMs: null,
          semanticReviewMs: null,
        },
      ]),
    ),
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "l-lang-cross-schema-protocol-"));
  roots.push(root);
  return root;
}
