import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  readSchemaEvolutionProtocol,
  verifyFrozenFileHashes,
} from "./schema-evolution-protocol";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("schema evolution protocol boundary", () => {
  test("strictly validates required manifest fields before evaluation", async () => {
    const root = await temporaryRoot();
    const manifest = validManifest();
    delete (manifest as Partial<typeof manifest>).thresholds;
    await writeProtocol(root, manifest, validFreeze());

    await expect(
      readSchemaEvolutionProtocol(resolve(root, "benchmark.json")),
    ).rejects.toThrow("benchmark is missing thresholds");
  });

  test("rejects manifest and freeze paths that leave the benchmark", async () => {
    for (const testCase of [
      {
        manifest: { ...validManifest(), freeze: "../freeze.json" },
        freeze: validFreeze(),
        message: "benchmark.freeze must be a normalized relative path",
      },
      {
        manifest: { ...validManifest(), freeze: "C:\\outside\\freeze.json" },
        freeze: validFreeze(),
        message: "benchmark.freeze must be a normalized relative path",
      },
      {
        manifest: validManifest(),
        freeze: {
          ...validFreeze(),
          files: { "../outside.json": "a".repeat(64) },
        },
        message: "freeze file path must be a normalized relative path",
      },
    ]) {
      const root = await temporaryRoot();
      await writeProtocol(root, testCase.manifest, testCase.freeze);
      await expect(
        readSchemaEvolutionProtocol(resolve(root, "benchmark.json")),
      ).rejects.toThrow(testCase.message);
    }
  });

  test("requires the evaluated manifest to be the frozen benchmark.json", async () => {
    const root = await temporaryRoot();
    await writeProtocol(root, validManifest(), validFreeze());
    const alternate = resolve(root, "alternate.json");
    await writeFile(alternate, `${JSON.stringify(validManifest())}\n`, "utf8");

    await expect(readSchemaEvolutionProtocol(alternate)).rejects.toThrow(
      "manifest must be named benchmark.json",
    );
  });

  test("rejects a frozen input symlink that resolves outside the benchmark", async () => {
    const root = await temporaryRoot();
    const outside = resolve(await temporaryRoot(), "outside.json");
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, resolve(root, "escape.json"));

    await expect(
      verifyFrozenFileHashes(root, { "escape.json": "a".repeat(64) }),
    ).rejects.toThrow("must stay inside the benchmark directory");
  });
});

function validManifest() {
  return {
    version: 1,
    name: "fixture",
    trials: 3,
    freeze: "freeze.json",
    blindness: {
      oracleAndCasesSentToModel: false,
      lockUsed: false,
      generatedCodeMutationAllowed: false,
      note: "Blind fixture.",
    },
    thresholds: {
      minimumFirstPassCaseRate: 0,
      minimumStableCaseRate: 0,
      minimumClassificationAccuracy: 0,
      minimumHiddenTestPassRate: 0,
      maximumFalseResolutionRate: 0,
      maximumWorkspaceMutationCount: 0,
    },
    concepts: [
      {
        id: "fixture.concept",
        definition: "concept.ts",
        baselineSource: "baseline.semantic.ts",
        baselineOracle: "baseline.oracle.json",
      },
    ],
    cases: [
      {
        id: "fixture-add-property",
        conceptId: "fixture.concept",
        changeType: "add-property",
        source: "change.semantic.ts",
        oracle: "change.oracle.json",
        tests: "change.cases.json",
      },
    ],
  };
}

function validFreeze() {
  return {
    version: 1,
    status: "draft",
    instructions: "Fixture inputs.",
    files: { "benchmark.json": "a".repeat(64) },
  };
}

async function writeProtocol(
  root: string,
  manifest: unknown,
  freeze: unknown,
): Promise<void> {
  await Promise.all([
    writeFile(
      resolve(root, "benchmark.json"),
      `${JSON.stringify(manifest)}\n`,
      "utf8",
    ),
    writeFile(
      resolve(root, "freeze.json"),
      `${JSON.stringify(freeze)}\n`,
      "utf8",
    ),
  ]);
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "schema-evolution-protocol-"));
  roots.push(root);
  return root;
}
