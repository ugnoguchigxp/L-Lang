import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  buildProjectContext,
  PROJECT_CONTEXT_LIMITS,
  parseProjectContext,
} from "./project-context";
import { sha256 } from "./semantic-fingerprint";
import type { SemanticLock, SemanticLockEntry } from "./semantic-lock";
import { scanSemanticSource } from "./semantic-source";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("ProjectContext", () => {
  test("is deterministic and collects only reachable related types", async () => {
    const fixture = await projectFixture();
    const source = await scanSemanticSource(fixture.sourcePath);
    const first = await buildProjectContext({
      source,
      workspaceRoot: fixture.root,
      lock: emptyLock(),
    });
    const second = await buildProjectContext({
      source,
      workspaceRoot: fixture.root,
      lock: emptyLock(),
    });

    expect(second).toEqual(first);
    expect(first.context.relatedTypes).toEqual([
      {
        source: "types.ts",
        typeName: "Owner",
        declaration: "export type Owner = { id: string };",
      },
    ]);
    expect(first.summary.relatedTypeSources).toEqual(["types.ts"]);
  });

  test("includes only current, integrity-verified bindings for the same Concept", async () => {
    const fixture = await projectFixture();
    const source = await scanSemanticSource(fixture.sourcePath);
    const generated = "export function isPrior(): boolean { return true; }\n";
    const priorSource = "export {};\n";
    await writeFile(resolve(fixture.root, "prior.semantic.ts"), priorSource);
    await writeFile(resolve(fixture.root, "is-prior.generated.ts"), generated);
    const current = bindingEntry({
      conceptId: source.concept.id,
      conceptHash: source.concept.hash,
      sourceHash: sha256(priorSource),
      generatedCodeHash: sha256(generated),
    });
    const otherConcept = bindingEntry({
      fingerprint: "2".repeat(64),
      conceptId: "other",
      conceptHash: source.concept.hash,
      generatedCodeHash: sha256(generated),
    });
    const stale = bindingEntry({
      fingerprint: "3".repeat(64),
      conceptId: source.concept.id,
      conceptHash: "4".repeat(64),
      generatedCodeHash: sha256(generated),
    });
    const integrityError = bindingEntry({
      fingerprint: "5".repeat(64),
      conceptId: source.concept.id,
      conceptHash: source.concept.hash,
      source: "integrity.semantic.ts",
      predicate: "isIntegrity",
      sourceHash: sha256(priorSource),
      generatedCodeHash: "6".repeat(64),
    });
    await writeFile(
      resolve(fixture.root, "integrity.semantic.ts"),
      priorSource,
    );
    await writeFile(
      resolve(fixture.root, "is-integrity.generated.ts"),
      generated,
    );
    const staleSource = bindingEntry({
      fingerprint: "c".repeat(64),
      conceptId: source.concept.id,
      conceptHash: source.concept.hash,
      source: "changed.semantic.ts",
      predicate: "isChanged",
      sourceHash: sha256("original source\n"),
      generatedCodeHash: sha256(generated),
    });
    await writeFile(
      resolve(fixture.root, "changed.semantic.ts"),
      "changed source\n",
    );
    await writeFile(
      resolve(fixture.root, "is-changed.generated.ts"),
      generated,
    );
    const missingArtifact = bindingEntry({
      fingerprint: "d".repeat(64),
      conceptId: source.concept.id,
      conceptHash: source.concept.hash,
      source: "missing.semantic.ts",
      predicate: "isMissing",
      sourceHash: sha256(priorSource),
      generatedCodeHash: sha256(generated),
    });
    await writeFile(resolve(fixture.root, "missing.semantic.ts"), priorSource);
    const built = await buildProjectContext({
      source,
      workspaceRoot: fixture.root,
      lock: {
        version: 1,
        entries: {
          [current.fingerprint]: current,
          [otherConcept.fingerprint]: otherConcept,
          [stale.fingerprint]: stale,
          [integrityError.fingerprint]: integrityError,
          [staleSource.fingerprint]: staleSource,
          [missingArtifact.fingerprint]: missingArtifact,
        },
      },
    });

    expect(built.context.verifiedBindings).toHaveLength(1);
    expect(built.context.verifiedBindings[0]).toMatchObject({
      conceptId: source.concept.id,
      targetTypeName: "PriorRecord",
    });
  });

  test("strictly parses model-visible Context and rejects contamination", async () => {
    const fixture = await projectFixture();
    const built = await buildProjectContext({
      source: await scanSemanticSource(fixture.sourcePath),
      workspaceRoot: fixture.root,
      lock: emptyLock(),
    });

    expect(parseProjectContext(structuredClone(built.context))).toEqual(
      built.context,
    );
    expect(() =>
      parseProjectContext({
        ...structuredClone(built.context),
        hiddenCases: [],
      }),
    ).toThrow("unknown field hiddenCases");
    expect(() =>
      parseProjectContext({
        ...structuredClone(built.context),
        target: {
          ...built.context.target,
          source: "secrets/api-key.ts",
        },
      }),
    ).toThrow("forbidden source path");
    expect(() =>
      parseProjectContext({
        ...structuredClone(built.context),
        target: {
          ...built.context.target,
          typeDeclaration: "type Different = { state: string };",
        },
      }),
    ).toThrow("expected type WorkItem");
  });

  test("changes its hash when a related declaration changes", async () => {
    const fixture = await projectFixture();
    const before = await buildProjectContext({
      source: await scanSemanticSource(fixture.sourcePath),
      workspaceRoot: fixture.root,
      lock: emptyLock(),
    });
    await writeFile(
      resolve(fixture.root, "types.ts"),
      "export type Owner = { id: string; displayName?: string };\n",
    );
    const after = await buildProjectContext({
      source: await scanSemanticSource(fixture.sourcePath),
      workspaceRoot: fixture.root,
      lock: emptyLock(),
    });
    expect(after.contextHash).not.toBe(before.contextHash);
  });

  test("rejects secret-like reachable paths and declaration budget overflow", async () => {
    const fixture = await projectFixture("secret-token.ts");
    await expect(
      buildProjectContext({
        source: await scanSemanticSource(fixture.sourcePath),
        workspaceRoot: fixture.root,
        lock: emptyLock(),
      }),
    ).rejects.toThrow("forbidden secret-like path");

    const oversized = await projectFixture();
    await writeFile(
      resolve(oversized.root, "types.ts"),
      `export type Owner = { value: "${"x".repeat(PROJECT_CONTEXT_LIMITS.declarationBytes)}" };\n`,
    );
    await expect(
      buildProjectContext({
        source: await scanSemanticSource(oversized.sourcePath),
        workspaceRoot: oversized.root,
        lock: emptyLock(),
      }),
    ).rejects.toThrow("declaration");
  });

  test("rejects class implementations from model-visible type context", async () => {
    const fixture = await projectFixture();
    await writeFile(
      resolve(fixture.root, "types.ts"),
      [
        "export class Owner {",
        '  id = "owner";',
        '  implementationDetail(): string { return "do not expose"; }',
        "}",
        "",
      ].join("\n"),
    );

    await expect(
      buildProjectContext({
        source: await scanSemanticSource(fixture.sourcePath),
        workspaceRoot: fixture.root,
        lock: emptyLock(),
      }),
    ).rejects.toThrow(
      "type alias or interface without implementation code",
    );
  });
});

async function projectFixture(typeFile = "types.ts"): Promise<{
  root: string;
  sourcePath: string;
}> {
  const root = await mkdtemp(resolve(tmpdir(), "l-lang-project-context-"));
  roots.push(root);
  await writeFile(
    resolve(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
      },
      include: ["*.ts"],
    }),
  );
  await writeFile(
    resolve(root, typeFile),
    "export type Owner = { id: string };\n",
  );
  const sourcePath = resolve(root, "semantic.ts");
  await writeFile(
    sourcePath,
    [
      `import type { Owner } from "./${typeFile.replace(/\.ts$/, "")}";`,
      "declare function concept<T>(parts: TemplateStringsArray): unknown;",
      "declare function generatePredicate(value: unknown): unknown;",
      "declare function semanticTest(value: unknown, cases: { accept: unknown[]; reject: unknown[] }): void;",
      "type WorkItem = { state: \"ready\" | \"blocked\"; owner: Owner };",
      "const Eligible = concept<WorkItem>`",
      "Definition:",
      "A work item that is ready.",
      "",
      "Requirements:",
      "- State is ready.",
      "`;",
      "const isEligible = generatePredicate(Eligible);",
      'semanticTest(isEligible, { accept: [{ state: "ready", owner: { id: "1" } }], reject: [{ state: "blocked", owner: { id: "1" } }] });',
      "",
    ].join("\n"),
  );
  return { root, sourcePath };
}

function emptyLock(): SemanticLock {
  return { version: 1, entries: {} };
}

function bindingEntry(
  overrides: Partial<SemanticLockEntry> & {
    conceptId: string;
    conceptHash: string;
    generatedCodeHash: string;
  },
): SemanticLockEntry {
  const {
    conceptId,
    conceptHash,
    generatedCodeHash,
    ...optionalOverrides
  } = overrides;
  return {
    fingerprint: "1".repeat(64),
    source: "prior.semantic.ts",
    concept: "Eligible",
    conceptId,
    conceptHash,
    conceptSource: "prior.semantic.ts",
    predicate: "isPrior",
    targetTypeName: "PriorRecord",
    provider: "fixture",
    model: "fixture",
    sourceHash: "7".repeat(64),
    typeHash: "8".repeat(64),
    testHash: "9".repeat(64),
    promptHash: "a".repeat(64),
    contextVersion: 1,
    contextHash: "b".repeat(64),
    contextSummary: {
      version: 1,
      targetSource: "prior.semantic.ts",
      relatedTypeSources: [],
      verifiedBindingSources: [],
    },
    resolvedIr: { kind: "equals", property: ["state"], value: "ready" },
    generatedCodeHash,
    response: null,
    createdAt: "2026-07-24T00:00:00.000Z",
    promotion: {
      mode: "auto",
      promotedAt: "2026-07-24T00:00:00.000Z",
      validation: {
        candidateTypecheck: "passed",
        projectTypecheck: "passed",
        semanticTest: "passed",
        fullTest: "passed",
      },
    },
    ...optionalOverrides,
  };
}
