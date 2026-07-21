import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import {
  checkSemanticClosure,
  parseSemanticClosureManifest,
} from "./semantic-closure";
import {
  generatedOutputPath,
  predicateSemanticHashes,
  sha256,
  staticJudgmentSemanticHashes,
  workspaceRelativePath,
} from "./semantic-fingerprint";
import type {
  SemanticLock,
  SemanticLockEntry,
  StaticJudgmentLockEntry,
} from "./semantic-lock";
import { scanSemanticSource } from "./semantic-source";
import { scanStaticJudgmentSource } from "./static-judgment-source";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("semantic closure", () => {
  test("strictly parses a non-empty versioned manifest", () => {
    expect(
      parseSemanticClosureManifest({
        version: 1,
        nodes: [{ id: "predicate", source: "predicate/semantic.ts" }],
      }),
    ).toEqual({
      version: 1,
      nodes: [
        { id: "predicate", source: "predicate/semantic.ts", dependsOn: [] },
      ],
    });
    expect(() => parseSemanticClosureManifest({ version: 2, nodes: [] })).toThrow(
      "manifest.version must be 1",
    );
    expect(() => parseSemanticClosureManifest({ version: 1, nodes: [] })).toThrow(
      "nodes must be a non-empty array",
    );
    expect(() =>
      parseSemanticClosureManifest({
        version: 1,
        nodes: [
          {
            id: "predicate",
            source: "predicate/semantic.ts",
            dependOn: [],
          },
        ],
      }),
    ).toThrow("contains unknown field dependOn");
  });

  test("builds a deterministic mixed graph and aggregates open statuses", async () => {
    const fixture = await createClosureFixture();
    const closed = await checkSemanticClosure(fixture);

    expect(closed).toMatchObject({
      status: "closed",
      scope: "artifact",
      approval: "unknown",
      summary: {
        total: 2,
        current: 2,
        stale: 0,
        unlocked: 0,
        integrityError: 0,
      },
      edges: [{ from: "judgment", to: "predicate", kind: "depends-on" }],
    });
    expect(closed.nodes.map((node) => node.id)).toEqual(["judgment", "predicate"]);

    await writeFile(
      fixture.judgmentSourcePath,
      staticJudgmentSource().replace("A calico animal that meows.", "A metal sculpture."),
      "utf8",
    );
    const stale = await checkSemanticClosure(fixture);
    expect(stale.status).toBe("open");
    expect(stale.summary.stale).toBe(1);
    expect(stale.blockers).toEqual([
      expect.objectContaining({ nodeId: "judgment", code: "stale" }),
    ]);

    await writeFile(fixture.judgmentSourcePath, staticJudgmentSource(), "utf8");
    const originalLock = JSON.parse(
      await readFile(fixture.lockPath, "utf8"),
    ) as SemanticLock;
    await writeLock(fixture.lockPath, {
      ...originalLock,
      judgments: {},
    });
    const unlocked = await checkSemanticClosure(fixture);
    expect(unlocked.status).toBe("open");
    expect(unlocked.summary.unlocked).toBe(1);

    await writeLock(fixture.lockPath, originalLock);
    await unlink(fixture.judgmentGeneratedPath);
    const integrityError = await checkSemanticClosure(fixture);
    expect(integrityError.status).toBe("open");
    expect(integrityError.summary.integrityError).toBe(1);
  });

  test("rejects duplicate ids, unknown dependencies, cycles, and workspace escapes", async () => {
    const workspaceRoot = await createWorkspace();
    const cases: Array<{ name: string; nodes: unknown[]; message: string }> = [
      {
        name: "duplicate",
        nodes: [
          { id: "same", source: "a.ts" },
          { id: "same", source: "b.ts" },
        ],
        message: "duplicate node id same",
      },
      {
        name: "unknown",
        nodes: [{ id: "a", source: "a.ts", dependsOn: ["missing"] }],
        message: "depends on unknown node missing",
      },
      {
        name: "cycle",
        nodes: [
          { id: "a", source: "a.ts", dependsOn: ["b"] },
          { id: "b", source: "b.ts", dependsOn: ["a"] },
        ],
        message: "graph contains a cycle",
      },
      {
        name: "escape",
        nodes: [{ id: "escape", source: "../outside.ts" }],
        message: "must be inside the workspace root",
      },
    ];

    for (const testCase of cases) {
      const manifestPath = resolve(workspaceRoot, `${testCase.name}.json`);
      await writeFile(
        manifestPath,
        JSON.stringify({ version: 1, nodes: testCase.nodes }),
        "utf8",
      );
      await expect(
        checkSemanticClosure({ manifestPath, workspaceRoot }),
      ).rejects.toThrow(testCase.message);
    }
  });
});

type ClosureFixture = {
  manifestPath: string;
  workspaceRoot: string;
  lockPath: string;
  judgmentSourcePath: string;
  judgmentGeneratedPath: string;
};

async function createClosureFixture(): Promise<ClosureFixture> {
  const workspaceRoot = await createWorkspace();
  const predicateSourcePath = resolve(workspaceRoot, "predicate/semantic.ts");
  const judgmentSourcePath = resolve(workspaceRoot, "judgment/semantic.ts");
  await mkdir(dirname(predicateSourcePath), { recursive: true });
  await mkdir(dirname(judgmentSourcePath), { recursive: true });
  await writeFile(predicateSourcePath, predicateSource(), "utf8");
  await writeFile(judgmentSourcePath, staticJudgmentSource(), "utf8");

  const predicate = await scanSemanticSource(predicateSourcePath);
  const judgment = await scanStaticJudgmentSource(judgmentSourcePath);
  const predicateGeneratedPath = generatedOutputPath(
    predicateSourcePath,
    predicate.predicate.name,
  );
  const judgmentGeneratedPath = generatedOutputPath(
    judgmentSourcePath,
    judgment.judgment.name,
  );
  const predicateGenerated = "export const isReady = () => true;\n";
  const judgmentGenerated = "export const mikeIsCat = true as const;\n";
  await writeFile(predicateGeneratedPath, predicateGenerated, "utf8");
  await writeFile(judgmentGeneratedPath, judgmentGenerated, "utf8");

  const predicateHashes = predicateSemanticHashes(predicate);
  const judgmentHashes = staticJudgmentSemanticHashes(judgment);
  const predicateEntry: SemanticLockEntry = {
    fingerprint: sha256("closure-predicate"),
    source: workspaceRelativePath(
      workspaceRoot,
      predicateSourcePath,
      "predicate source",
    ),
    concept: predicate.concept.name,
    conceptId: predicate.concept.id,
    conceptSource: workspaceRelativePath(
      workspaceRoot,
      predicate.concept.definitionPath,
      "predicate concept",
    ),
    predicate: predicate.predicate.name,
    provider: "fixture",
    model: "model",
    ...predicateHashes,
    resolvedIr: { kind: "equals", property: ["state"], value: "ready" },
    generatedCodeHash: sha256(predicateGenerated),
    response: null,
    createdAt: "2026-07-21T00:00:00.000Z",
  };
  const judgmentEntry: StaticJudgmentLockEntry = {
    fingerprint: sha256("closure-judgment"),
    source: workspaceRelativePath(
      workspaceRoot,
      judgmentSourcePath,
      "judgment source",
    ),
    judgment: judgment.judgment.name,
    conceptId: judgment.concept.id,
    ...judgmentHashes,
    provider: "fixture",
    model: "model",
    resolvedValue: true,
    generatedCodeHash: sha256(judgmentGenerated),
    response: null,
    createdAt: "2026-07-21T00:00:00.000Z",
  };
  const lockPath = resolve(workspaceRoot, "semantic.lock");
  await writeLock(lockPath, {
    version: 1,
    entries: { [predicateEntry.fingerprint]: predicateEntry },
    judgments: { [judgmentEntry.fingerprint]: judgmentEntry },
  });
  const manifestPath = resolve(workspaceRoot, "semantic-closure.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        version: 1,
        nodes: [
          {
            id: "predicate",
            source: "predicate/semantic.ts",
            dependsOn: [],
          },
          {
            id: "judgment",
            source: "judgment/semantic.ts",
            dependsOn: ["predicate"],
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return {
    manifestPath,
    workspaceRoot,
    lockPath,
    judgmentSourcePath,
    judgmentGeneratedPath,
  };
}

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(resolve(tmpdir(), "semantic-closure-"));
  temporaryRoots.push(workspaceRoot);
  await writeFile(
    resolve(workspaceRoot, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
      },
      include: ["**/*.ts"],
    }),
    "utf8",
  );
  return workspaceRoot;
}

async function writeLock(path: string, lock: SemanticLock): Promise<void> {
  await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}

function predicateSource(): string {
  return `
declare function concept<T>(strings: TemplateStringsArray): unknown;
declare function generatePredicate<T>(concept: unknown): (value: T) => boolean;
declare function semanticTest<T>(predicate: (value: T) => boolean, cases: { accept: T[]; reject: T[] }): void;

type Customer = { state: "ready" | "waiting" };
const ReadyCustomer = concept<Customer>\`A ready customer has state ready.\`;
export const isReady = generatePredicate<Customer>(ReadyCustomer);
semanticTest(isReady, { accept: [{ state: "ready" }], reject: [{ state: "waiting" }] });
`.trimStart();
}

function staticJudgmentSource(): string {
  return `
declare function defineConcept(id: string): (strings: TemplateStringsArray) => unknown;
declare function staticValue(value: string): unknown;
declare function judgeStatic(value: unknown, concept: unknown): boolean;

const Cat = defineConcept("animal.cat")\`A domesticated biological cat.\`;
const mike = staticValue(\`A calico animal that meows.\`);
export const mikeIsCat = judgeStatic(mike, Cat);
`.trimStart();
}
