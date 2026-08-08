import { describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertProjectFitFrozen,
  parseProjectFitFreeze,
  parseProjectFitManifest,
  parseProjectFitModelInput,
  parseProjectFitOracle,
  readProjectFitFrozenJson,
  readProjectFitProtocol,
} from "./project-fit-manifest";
import {
  createProjectFitTestProtocol,
  validProjectFitManifest,
} from "./project-fit-test-fixture";

describe("Project Fit v2 manifest and freeze", () => {
  test("strictly parses the only supported protocol version", () => {
    const manifest = parseProjectFitManifest(validProjectFitManifest());
    expect(manifest).toMatchObject({
      version: 2,
      name: "project-fit-fixture",
      trials: 1,
      budget: {
        maxApiCalls: 4,
        maxOutputTokensPerCall: 200,
        maxTotalOutputTokens: 800,
      },
      cases: [
        {
          id: "case-1",
          domain: "fixture",
          stages: {
            initial: {},
            schemaChange: {},
          },
        },
      ],
    });
    expect(() =>
      parseProjectFitManifest({
        ...validProjectFitManifest(),
        version: 1,
      })
    ).toThrow("version must be 2");
    expect(
      parseProjectFitFreeze({
        version: 2,
        status: "draft",
        instructions: "Fixture inputs are immutable.",
        files: { "benchmark.json": "a".repeat(64) },
      }),
    ).toMatchObject({ version: 2, status: "draft" });
  });

  test("enforces two-stage call and output budgets", () => {
    const insufficientCalls = validProjectFitManifest();
    (insufficientCalls.budget as Record<string, unknown>).maxApiCalls = 3;
    expect(() => parseProjectFitManifest(insufficientCalls)).toThrow(
      "requires at least 4 API calls",
    );

    const impossibleOutput = validProjectFitManifest();
    (
      impossibleOutput.budget as Record<string, unknown>
    ).maxTotalOutputTokens = 799;
    expect(() => parseProjectFitManifest(impossibleOutput)).toThrow(
      "cannot cover 4 calls at 200 tokens per call",
    );

    const legacyBudget = validProjectFitManifest();
    (legacyBudget.budget as Record<string, unknown>).maxOutputTokens = 800;
    expect(() => parseProjectFitManifest(legacyBudget)).toThrow(
      "unknown field maxOutputTokens",
    );

    const legacyTokenGate = validProjectFitManifest();
    (
      legacyTokenGate.thresholds as Record<string, unknown>
    ).maxInputTokenDelta = 1_000;
    expect(() => parseProjectFitManifest(legacyTokenGate)).toThrow(
      "unknown field maxInputTokenDelta",
    );
  });

  test("rejects malformed cases and paths", () => {
    const duplicate = validProjectFitManifest();
    const cases = duplicate.cases as unknown[];
    cases.push(structuredClone(cases[0]));
    (duplicate.budget as Record<string, unknown>).maxApiCalls = 8;
    (duplicate.budget as Record<string, unknown>).maxTotalOutputTokens = 1_600;
    expect(() => parseProjectFitManifest(duplicate)).toThrow(
      "duplicate case case-1",
    );

    const pathEscapeManifest = validProjectFitManifest();
    const first = (
      pathEscapeManifest.cases as Array<Record<string, unknown>>
    )[0] as {
      stages: { initial: Record<string, unknown> };
    };
    first.stages.initial.oracle = "../oracle.json";
    expect(() => parseProjectFitManifest(pathEscapeManifest)).toThrow(
      "normalized relative path",
    );

    const missingStage = validProjectFitManifest();
    const missing = (missingStage.cases as Array<Record<string, unknown>>)[0] as {
      stages: Record<string, unknown>;
    };
    delete missing.stages.schemaChange;
    expect(() => parseProjectFitManifest(missingStage)).toThrow(
      "is missing schemaChange",
    );
  });

  test("strictly parses v2 model inputs and hidden oracles", () => {
    expect(
      parseProjectFitModelInput({
        version: 2,
        intent: "Select ready records.",
        target: {
          functionName: "isReady",
          parameterName: "record",
          typeName: "Record",
          typeScriptSource: "type Record = { ready: boolean };",
        },
      }),
    ).toMatchObject({ version: 2, target: { functionName: "isReady" } });
    expect(() =>
      parseProjectFitModelInput({
        version: 1,
        intent: "old",
        target: {},
      })
    ).toThrow("version must be 2");
    expect(
      parseProjectFitOracle({
        version: 2,
        hiddenCases: [
          { name: "ready", input: { ready: true }, expected: true },
        ],
      }),
    ).toMatchObject({ version: 2 });
    expect(() =>
      parseProjectFitOracle({ version: 1, hiddenCases: [] })
    ).toThrow("version must be 2");
  });

  test("verifies every frozen two-stage input and detects mutation", async () => {
    const fixture = await createProjectFitTestProtocol();
    try {
      const protocol = await readProjectFitProtocol(fixture.manifestPath);
      expect(protocol.freeze.version).toBe(2);
      expect(Object.keys(protocol.freeze.files)).toHaveLength(11);
      expect(() => assertProjectFitFrozen(protocol.freeze)).toThrow(
        "must be frozen",
      );
      await readProjectFitFrozenJson(
        protocol,
        protocol.manifest.cases[0]?.stages.schemaChange.oracle ?? "",
        "schema oracle",
      );

      await writeFile(
        resolve(fixture.directory, "initial.input.json"),
        '{"version":2,"mutated":true}\n',
      );
      await expect(readProjectFitProtocol(fixture.manifestPath)).rejects.toThrow(
        "frozen input changed",
      );
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  test("rejects a freeze list that does not exactly cover the protocol", async () => {
    const fixture = await createProjectFitTestProtocol();
    try {
      const freezePath = resolve(fixture.directory, "freeze.json");
      const freeze = JSON.parse(await readFile(freezePath, "utf8")) as {
        files: Record<string, string>;
      };
      delete freeze.files["schema-change.oracle.json"];
      await writeFile(freezePath, `${JSON.stringify(freeze, null, 2)}\n`);
      await expect(readProjectFitProtocol(fixture.manifestPath)).rejects.toThrow(
        "must exactly match manifest inputs",
      );
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});
