import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { explainSemanticSource } from "./semantic-explain";
import { renderSemanticExplanation } from "./semantic-explain-renderer";
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
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("semantic explain", () => {
  test("explains a current Predicate from the lock without changing artifacts", async () => {
    const fixture = await createPredicateFixture({ generated: "export const isReady = () => true;\n" });
    const beforeLock = await readFile(fixture.lockPath, "utf8");
    const beforeGenerated = await readFile(fixture.generatedPath, "utf8");

    const explanation = await explainSemanticSource(fixture);

    expect(explanation.status).toBe("current");
    expect(explanation.kind).toBe("predicate");
    expect(explanation.generated?.state).toBe("verified");
    expect(explanation.resolution).toEqual({
      ir: { kind: "equals", property: ["state"], value: "ready" },
      interpreted: 'customer.state EQUALS "ready"',
    });
    expect(explanation.source.startsWith("/")).toBeFalse();
    expect(await readFile(fixture.lockPath, "utf8")).toBe(beforeLock);
    expect(await readFile(fixture.generatedPath, "utf8")).toBe(beforeGenerated);
  });

  test("reports Predicate hash changes from the latest historical entry", async () => {
    const fixture = await createPredicateFixture();
    const changed = predicateSource()
      .replace('state: "ready" | "waiting"', 'state: "ready" | "waiting" | "blocked"')
      .replace('reject: [{ state: "waiting" }]', 'reject: [{ state: "blocked" }]');
    await writeFile(fixture.sourcePath, changed, "utf8");

    const explanation = await explainSemanticSource(fixture);

    expect(explanation.status).toBe("stale");
    expect(explanation.staleReasons).toContain("sourceHash changed");
    expect(explanation.staleReasons).toContain("typeHash changed");
    expect(explanation.staleReasons).toContain("testHash changed");
    expect(explanation.staleReasons).toContain("promptHash changed");
    expect(explanation.generated).toBeNull();
  });

  test("reports Concept and prompt hash changes without treating provider/model as stale", async () => {
    const fixture = await createPredicateFixture();
    const lock = JSON.parse(await readFile(fixture.lockPath, "utf8")) as SemanticLock;
    const entry = Object.values(lock.entries)[0]!;
    entry.conceptHash = "older-concept";
    entry.promptHash = "older-prompt";
    entry.provider = "different-provider";
    entry.model = "different-model";
    await writeLock(fixture.lockPath, lock);

    const explanation = await explainSemanticSource(fixture);

    expect(explanation.status).toBe("stale");
    expect(explanation.staleReasons).toEqual([
      "conceptHash changed",
      "promptHash changed",
    ]);
  });

  test("distinguishes unlocked, missing, and mismatched Predicate output", async () => {
    const unlocked = await createPredicateFixture({ unlocked: true });
    const unlockedExplanation = await explainSemanticSource(unlocked);
    expect(unlockedExplanation.status).toBe("unlocked");
    expect(unlockedExplanation.lock).toBeNull();
    expect(unlockedExplanation.resolution).toBeNull();

    const missing = await createPredicateFixture();
    const missingExplanation = await explainSemanticSource(missing);
    expect(missingExplanation.status).toBe("integrity-error");
    expect(missingExplanation.generated?.state).toBe("missing");
    expect(missingExplanation.generated?.actualHash).toBeNull();
    expect(renderSemanticExplanation(missingExplanation)).toContain(
      "generated integrity: ERROR (missing)",
    );

    const mismatch = await createPredicateFixture({ generated: "changed output\n" });
    const lock = JSON.parse(await readFile(mismatch.lockPath, "utf8")) as SemanticLock;
    const entry = Object.values(lock.entries)[0]!;
    entry.generatedCodeHash = sha256("expected output\n");
    await writeLock(mismatch.lockPath, lock);
    const mismatchExplanation = await explainSemanticSource(mismatch);
    expect(mismatchExplanation.status).toBe("integrity-error");
    expect(mismatchExplanation.generated?.state).toBe("mismatch");
  });

  test("hashes generated output as bytes", async () => {
    const fixture = await createPredicateFixture();
    const generated = new Uint8Array([0xff, 0x00, 0x80, 0x0a]);
    await writeFile(fixture.generatedPath, generated);
    const lock = JSON.parse(await readFile(fixture.lockPath, "utf8")) as SemanticLock;
    Object.values(lock.entries)[0]!.generatedCodeHash = sha256(generated);
    await writeLock(fixture.lockPath, lock);

    const explanation = await explainSemanticSource(fixture);

    expect(explanation.status).toBe("current");
    expect(explanation.generated).toMatchObject({
      state: "verified",
      expectedHash: sha256(generated),
      actualHash: sha256(generated),
    });
  });

  test("explains Static Judgment and reports value and prompt staleness", async () => {
    const fixture = await createStaticJudgmentFixture({
      generated: "export const mikeIsCat = true as const;\n",
    });
    const current = await explainSemanticSource(fixture);
    expect(current.status).toBe("current");
    expect(current.kind).toBe("static-judgment");
    expect(current.resolution).toEqual({ value: true });
    expect(renderSemanticExplanation(current)).toContain("result: true");

    await writeFile(
      fixture.sourcePath,
      staticJudgmentSource().replace("A calico animal that meows.", "A metal sculpture."),
      "utf8",
    );
    const stale = await explainSemanticSource(fixture);
    expect(stale.status).toBe("stale");
    expect(stale.staleReasons).toEqual([
      "valueHash changed",
      "promptHash changed",
    ]);
    expect(JSON.stringify(stale)).not.toContain("A metal sculpture.");
  });

  test("keeps Predicate and Static Judgment lock namespaces separate", async () => {
    const fixture = await createPredicateFixture({ unlocked: true });
    const source = await scanSemanticSource(fixture.sourcePath);
    const hashes = predicateSemanticHashes(source);
    const judgment: StaticJudgmentLockEntry = {
      fingerprint: "same-symbol-judgment",
      source: workspaceRelativePath(fixture.workspaceRoot, fixture.sourcePath, "source"),
      judgment: source.predicate.name,
      conceptId: source.concept.id,
      conceptHash: hashes.conceptHash,
      valueHash: "value",
      promptHash: hashes.promptHash,
      provider: "fixture",
      model: "model",
      resolvedValue: true,
      generatedCodeHash: "generated",
      response: null,
      createdAt: "2026-07-20T00:00:00.000Z",
    };
    await writeLock(fixture.lockPath, {
      version: 1,
      entries: {},
      judgments: { [judgment.fingerprint]: judgment },
    });

    const explanation = await explainSemanticSource(fixture);
    expect(explanation.status).toBe("unlocked");
  });
});

type Fixture = {
  sourcePath: string;
  workspaceRoot: string;
  lockPath: string;
  generatedPath: string;
};

async function createPredicateFixture(options: {
  generated?: string;
  unlocked?: boolean;
} = {}): Promise<Fixture> {
  const workspaceRoot = await createWorkspace();
  const sourcePath = resolve(workspaceRoot, "predicate/semantic.ts");
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, predicateSource(), "utf8");
  const source = await scanSemanticSource(sourcePath);
  const hashes = predicateSemanticHashes(source);
  const generatedPath = generatedOutputPath(sourcePath, source.predicate.name);
  const generated = options.generated;
  const entry: SemanticLockEntry = {
    fingerprint: "predicate-lock",
    source: "predicate/semantic.ts",
    concept: source.concept.name,
    conceptId: source.concept.id,
    conceptSource: "predicate/semantic.ts",
    predicate: source.predicate.name,
    provider: "fixture",
    model: "model",
    ...hashes,
    resolvedIr: { kind: "equals", property: ["state"], value: "ready" },
    generatedCodeHash: sha256(generated ?? "expected output\n"),
    response: null,
    createdAt: "2026-07-20T00:00:00.000Z",
  };
  const lockPath = resolve(workspaceRoot, "semantic.lock");
  await writeLock(lockPath, {
    version: 1,
    entries: options.unlocked ? {} : { [entry.fingerprint]: entry },
  });
  if (generated !== undefined) await writeFile(generatedPath, generated, "utf8");
  return { sourcePath, workspaceRoot, lockPath, generatedPath };
}

async function createStaticJudgmentFixture(options: {
  generated?: string;
} = {}): Promise<Fixture> {
  const workspaceRoot = await createWorkspace();
  const sourcePath = resolve(workspaceRoot, "judgment/semantic.ts");
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, staticJudgmentSource(), "utf8");
  const source = await scanStaticJudgmentSource(sourcePath);
  const hashes = staticJudgmentSemanticHashes(source);
  const generatedPath = generatedOutputPath(sourcePath, source.judgment.name);
  const generated = options.generated;
  const entry: StaticJudgmentLockEntry = {
    fingerprint: "judgment-lock",
    source: "judgment/semantic.ts",
    judgment: source.judgment.name,
    conceptId: source.concept.id,
    ...hashes,
    provider: "fixture",
    model: "model",
    resolvedValue: true,
    generatedCodeHash: sha256(generated ?? "expected output\n"),
    response: null,
    createdAt: "2026-07-20T00:00:00.000Z",
  };
  const lockPath = resolve(workspaceRoot, "semantic.lock");
  await writeLock(lockPath, {
    version: 1,
    entries: {},
    judgments: { [entry.fingerprint]: entry },
  });
  if (generated !== undefined) await writeFile(generatedPath, generated, "utf8");
  return { sourcePath, workspaceRoot, lockPath, generatedPath };
}

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(resolve(tmpdir(), "semantic-explain-"));
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
