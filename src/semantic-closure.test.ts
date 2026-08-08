import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { buildProjectContext } from "./project-context";
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
    expect(() =>
      parseSemanticClosureManifest({ version: 2, nodes: [] }),
    ).toThrow("manifest.version must be 1");
    expect(() =>
      parseSemanticClosureManifest({ version: 1, nodes: [] }),
    ).toThrow("nodes must be a non-empty array");
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
    const closed = await checkSemanticClosure({
      manifestPath: "semantic-closure.json",
      workspaceRoot: fixture.workspaceRoot,
      lockPath: "semantic.lock",
    });

    expect(closed).toMatchObject({
      status: "closed",
      scope: "artifact",
      summary: {
        total: 2,
        current: 2,
        stale: 0,
        unlocked: 0,
        integrityError: 0,
        verificationRequired: 0,
        dependencyOpen: 0,
      },
      projectFit: { verified: 2, required: 0, legacy: 0 },
      edges: [{ from: "judgment", to: "predicate", kind: "depends-on" }],
    });
    expect(closed.nodes.map((node) => node.id)).toEqual([
      "judgment",
      "predicate",
    ]);
    expect(closed.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "predicate",
          projectFit: {
            context: "verified",
            validation: "verified",
            satisfied: true,
          },
        }),
        expect.objectContaining({
          id: "judgment",
          projectFit: {
            context: "not-applicable",
            validation: "verified",
            satisfied: true,
          },
        }),
      ]),
    );

    const originalLock = JSON.parse(
      await readFile(fixture.lockPath, "utf8"),
    ) as SemanticLock;
    const legacyLock = structuredClone(originalLock);
    const legacyEntry = Object.values(legacyLock.entries)[0];
    if (legacyEntry === undefined) throw new Error("fixture entry is missing");
    delete legacyEntry.promotion;
    await writeLock(fixture.lockPath, legacyLock);
    const legacy = await checkSemanticClosure(fixture);
    expect(legacy).toMatchObject({
      status: "open",
      summary: { verificationRequired: 1, dependencyOpen: 1 },
      projectFit: { verified: 1, required: 1, legacy: 1 },
    });
    expect(legacy.blockers).toEqual([
      expect.objectContaining({
        nodeId: "judgment",
        code: "dependency-open",
      }),
      expect.objectContaining({
        nodeId: "predicate",
        code: "verification-required",
      }),
    ]);
    await writeLock(fixture.lockPath, originalLock);

    await writeFile(
      fixture.judgmentSourcePath,
      staticJudgmentSource().replace(
        "A calico animal that meows.",
        "A metal sculpture.",
      ),
      "utf8",
    );
    const stale = await checkSemanticClosure(fixture);
    expect(stale.status).toBe("open");
    expect(stale.summary.stale).toBe(1);
    expect(stale.blockers).toEqual([
      expect.objectContaining({ nodeId: "judgment", code: "stale" }),
    ]);

    await writeFile(fixture.judgmentSourcePath, staticJudgmentSource(), "utf8");
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
  }, 15_000);

  test("rejects duplicate ids, unknown dependencies, cycles, and workspace escapes", async () => {
    const workspaceRoot = await createWorkspace();
    await expect(
      checkSemanticClosure({
        manifestPath: "../outside.json",
        workspaceRoot,
      }),
    ).rejects.toThrow(
      "Semantic Closure manifest must resolve inside the workspace root",
    );

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

    const outsideRoot = await createWorkspace();
    const outsideSource = resolve(outsideRoot, "outside.ts");
    const linkedSource = resolve(workspaceRoot, "linked.ts");
    await writeFile(outsideSource, "export {};\n", "utf8");
    await symlink(outsideSource, linkedSource);
    const linkedManifest = resolve(workspaceRoot, "linked.json");
    await writeFile(
      linkedManifest,
      JSON.stringify({
        version: 1,
        nodes: [{ id: "linked", source: "linked.ts" }],
      }),
      "utf8",
    );
    await expect(
      checkSemanticClosure({ manifestPath: linkedManifest, workspaceRoot }),
    ).rejects.toThrow(
      "Semantic Closure node linked source must resolve inside the workspace root",
    );
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

  const builtContext = await buildProjectContext({
    source: predicate,
    workspaceRoot,
    lock: { version: 1, entries: {} },
  });
  const predicateHashes = predicateSemanticHashes(predicate, builtContext);
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
    targetTypeName: predicate.concept.typeName,
    provider: "fixture",
    model: "model",
    ...predicateHashes,
    contextSummary: builtContext.summary,
    resolvedIr: { kind: "equals", property: ["state"], value: "ready" },
    generatedCodeHash: sha256(predicateGenerated),
    response: null,
    createdAt: "2026-07-21T00:00:00.000Z",
    promotion: {
      mode: "auto",
      promotedAt: "2026-07-21T00:00:00.000Z",
      validation: {
        candidateTypecheck: "passed",
        projectTypecheck: "passed",
        semanticTest: "passed",
        fullTest: "passed",
      },
    },
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
    promotion: {
      mode: "auto",
      promotedAt: "2026-07-21T00:00:00.000Z",
      validation: {
        candidateTypecheck: "passed",
        projectTypecheck: "passed",
        semanticTest: "not-applicable",
        fullTest: "passed",
      },
    },
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
const ReadyCustomer = concept<Customer>\`Definition:\nA ready customer has state ready.\n\nRequirements:\n- state is ready.\n\nExclusions:\n- state is waiting.\n\nOut of scope:\n- Other customer attributes.\n\nLeave unresolved when:\n- The state role is not represented unambiguously.\`;
export const isReady = generatePredicate<Customer>(ReadyCustomer);
semanticTest(isReady, { accept: [{ state: "ready" }], reject: [{ state: "waiting" }] });
`.trimStart();
}

function staticJudgmentSource(): string {
  return `
declare function defineConcept(id: string): (strings: TemplateStringsArray) => unknown;
declare function staticValue(value: string): unknown;
declare function judgeStatic(value: unknown, concept: unknown): boolean;

const Cat = defineConcept("animal.cat")\`Definition:\nA domesticated biological cat.\`;
const mike = staticValue(\`A calico animal that meows.\`);
export const mikeIsCat = judgeStatic(mike, Cat);
`.trimStart();
}
