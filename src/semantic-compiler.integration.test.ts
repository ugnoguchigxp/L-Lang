import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import {
  compileSemanticSource,
  type SemanticCommandRunner,
  type SemanticResolution,
} from "./semantic-compiler";
import { SemanticSourceError } from "./semantic-source";

const workspaceRoot = resolve(import.meta.dir, "..");

describe("semantic compiler transaction", () => {
  for (const invalidSource of [
    {
      name: "empty accept cases",
      source: renderInvalidSemanticSource("[]", '[{ state: "waiting" }]'),
      expectedError: "semanticTest.accept must contain at least one case",
    },
    {
      name: "empty reject cases",
      source: renderInvalidSemanticSource('[{ state: "ready" }]', "[]"),
      expectedError: "semanticTest.reject must contain at least one case",
    },
    {
      name: "empty accept and reject cases",
      source: renderInvalidSemanticSource("[]", "[]"),
      expectedError: "semanticTest.accept must contain at least one case",
    },
    {
      name: "a research benchmarkProbe",
      source: renderBenchmarkProbeSource(),
      expectedError:
        "benchmarkProbe is restricted to research benchmark runners",
    },
  ]) {
    test(`rejects ${invalidSource.name} before resolution without changing artifacts`, async () => {
      const parent = resolve(workspaceRoot, ".semantic", "test-workspaces");
      await mkdir(parent, { recursive: true });
      const testRoot = await mkdtemp(
        resolve(parent, "invalid-semantic-source-"),
      );
      const sourcePath = resolve(testRoot, "semantic.ts");
      const lockPath = resolve(testRoot, "semantic.lock");
      const finalPath = resolve(testRoot, "is-customer.generated.ts");
      const lockBefore = "sentinel lock\n";
      const outputBefore = "export const sentinel = true;\n";
      let resolverCalled = false;

      try {
        await writeFile(sourcePath, invalidSource.source, "utf8");
        await writeFile(lockPath, lockBefore, "utf8");
        await writeFile(finalPath, outputBefore, "utf8");

        const compilation = compileSemanticSource({
          sourcePath,
          workspaceRoot,
          mode: "build",
          lockPath,
          auditRoot: resolve(testRoot, "audit"),
          resolve: async () => {
            resolverCalled = true;
            return resolvedCustomer();
          },
        });

        await expect(compilation).rejects.toBeInstanceOf(SemanticSourceError);
        await expect(compilation).rejects.toThrow(invalidSource.expectedError);
        expect(resolverCalled).toBe(false);
        expect(await readFile(lockPath, "utf8")).toBe(lockBefore);
        expect(await readFile(finalPath, "utf8")).toBe(outputBefore);
      } finally {
        await rm(testRoot, { recursive: true, force: true });
      }
    });
  }

  test("rejects unsectioned prose before calling the resolver", async () => {
    const parent = resolve(workspaceRoot, ".semantic", "test-workspaces");
    await mkdir(parent, { recursive: true });
    const testRoot = await mkdtemp(resolve(parent, "unsectioned-"));
    const sourcePath = resolve(testRoot, "semantic.ts");
    let resolverCalled = false;

    try {
      await writeFile(sourcePath, renderUnsectionedSource(testRoot), "utf8");
      const compilation = compileSemanticSource({
        sourcePath,
        workspaceRoot,
        mode: "build",
        resolve: async () => {
          resolverCalled = true;
          return resolvedCustomer();
        },
      });

      await expect(compilation).rejects.toBeInstanceOf(SemanticSourceError);
      await expect(compilation).rejects.toThrow(
        "missing required section Definition:",
      );
      expect(resolverCalled).toBe(false);
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  test("rejects a Definition-only Predicate Concept before calling the resolver", async () => {
    const parent = resolve(workspaceRoot, ".semantic", "test-workspaces");
    await mkdir(parent, { recursive: true });
    const testRoot = await mkdtemp(resolve(parent, "definition-only-"));
    const sourcePath = resolve(testRoot, "semantic.ts");
    let resolverCalled = false;

    try {
      await writeFile(sourcePath, renderDefinitionOnlySource(testRoot), "utf8");
      const compilation = compileSemanticSource({
        sourcePath,
        workspaceRoot,
        mode: "build",
        resolve: async () => {
          resolverCalled = true;
          return resolvedCustomer();
        },
      });

      await expect(compilation).rejects.toBeInstanceOf(SemanticSourceError);
      await expect(compilation).rejects.toThrow(
        "must include Requirements: or Exclusions:",
      );
      expect(resolverCalled).toBe(false);
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  test("builds, replays without resolution, rolls back, and records unresolved input", async () => {
    const parent = resolve(workspaceRoot, ".semantic", "test-workspaces");
    await mkdir(parent, { recursive: true });
    const testRoot = await mkdtemp(resolve(parent, "compiler-"));
    const sourcePath = resolve(testRoot, "semantic.ts");
    const lockPath = resolve(testRoot, "semantic.lock");
    const auditRoot = resolve(testRoot, "audit");
    const finalPath = resolve(testRoot, "is-integration-customer.generated.ts");

    try {
      await writeFile(sourcePath, renderIntegrationSource(testRoot), "utf8");
      const stages: string[] = [];
      const runner = createIntegrationRunner(stages);
      const resolution = resolvedCustomer();
      let capturedContextVersion: number | undefined;

      const built = await compileSemanticSource({
        sourcePath,
        workspaceRoot,
        mode: "build",
        provider: "fixture:integration-success",
        model: "gpt-5.4-mini",
        countsAsApiCall: false,
        lockPath,
        auditRoot,
        commandRunner: runner,
        resolve: async (input) => {
          capturedContextVersion = input.projectContext?.version;
          return resolution;
        },
      });
      const firstCode = await readFile(finalPath, "utf8");
      expect(built.cacheHit).toBe(false);
      expect(built.apiCalls).toBe(0);
      expect(capturedContextVersion).toBe(1);
      expect(firstCode).toContain('integrationCustomer.status === "active"');
      expect(stages).toEqual([
        "candidate-typecheck",
        "semantic-test",
        "project-typecheck",
        "full-test",
      ]);

      stages.length = 0;
      const replayed = await compileSemanticSource({
        sourcePath,
        workspaceRoot,
        mode: "replay",
        lockPath,
        auditRoot,
        commandRunner: runner,
      });
      expect(replayed.apiCalls).toBe(0);
      expect(replayed.cacheHit).toBe(true);
      expect(await readFile(finalPath, "utf8")).toBe(firstCode);

      const lockBeforeLockFailure = await readFile(lockPath, "utf8");
      await expect(
        compileSemanticSource({
          sourcePath,
          workspaceRoot,
          mode: "build",
          provider: "fixture:integration-lock-failure",
          model: "gpt-5.4-mini",
          countsAsApiCall: false,
          lockPath,
          auditRoot,
          commandRunner: runner,
          writeLock: async () => {
            throw new Error("simulated lock write failure");
          },
          resolve: async () => resolution,
        }),
      ).rejects.toThrow("simulated lock write failure");
      expect(await readFile(finalPath, "utf8")).toBe(firstCode);
      expect(await readFile(lockPath, "utf8")).toBe(lockBeforeLockFailure);

      for (const failureStage of [
        "candidate-typecheck",
        "semantic-test",
        "project-typecheck",
      ]) {
        await expect(
          compileSemanticSource({
            sourcePath,
            workspaceRoot,
            mode: "build",
            provider: `fixture:integration-${failureStage}-failure`,
            model: "gpt-5.4-mini",
            countsAsApiCall: false,
            lockPath,
            auditRoot,
            commandRunner: createStubFailureRunner(failureStage),
            resolve: async () => resolution,
          }),
        ).rejects.toThrow(`simulated ${failureStage} failure`);
        expect(await readFile(finalPath, "utf8")).toBe(firstCode);
        expect(await readFile(lockPath, "utf8")).toBe(lockBeforeLockFailure);
      }

      const rollbackRunner = createIntegrationRunner([], "full-test");
      await expect(
        compileSemanticSource({
          sourcePath,
          workspaceRoot,
          mode: "build",
          provider: "fixture:integration-rollback",
          model: "gpt-5.4-mini",
          countsAsApiCall: false,
          lockPath,
          auditRoot,
          commandRunner: rollbackRunner,
          resolve: async () => resolution,
        }),
      ).rejects.toThrow("simulated full-test failure");
      expect(await readFile(finalPath, "utf8")).toBe(firstCode);

      await expect(
        compileSemanticSource({
          sourcePath,
          workspaceRoot,
          mode: "build",
          provider: "fixture:integration-unresolved",
          model: "gpt-5.4-mini",
          countsAsApiCall: false,
          lockPath,
          auditRoot,
          commandRunner: runner,
          resolve: async () => unresolvedCustomer(),
        }),
      ).rejects.toThrow("specification was unresolved");
      expect(await readFile(finalPath, "utf8")).toBe(firstCode);

      const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
        entries: Record<
          string,
          {
            conceptId: string;
            conceptHash: string;
            targetTypeName: string;
            contextVersion: number;
            contextHash: string;
            contextSummary: { targetSource: string };
            promotion: { mode: string; validation: { semanticTest: string } };
          }
        >;
      };
      const entries = Object.values(lock.entries);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.conceptId).toBe("customer.active");
      expect(entries[0]?.conceptHash).toMatch(/^[a-f0-9]{64}$/);
      expect(entries[0]).toMatchObject({
        targetTypeName: "IntegrationCustomer",
        contextVersion: 1,
        contextSummary: { targetSource: expect.any(String) },
      });
      expect(entries[0]?.contextHash).toMatch(/^[a-f0-9]{64}$/);
      expect(entries[0]?.promotion).toMatchObject({
        mode: "auto",
        validation: { semanticTest: "passed" },
      });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  }, 120_000);
});

function createIntegrationRunner(
  stages: string[],
  failureStage?: string,
): SemanticCommandRunner {
  return async (command, cwd, stage) => {
    stages.push(stage);
    if (stage === failureStage) {
      throw new Error(`simulated ${stage} failure`);
    }
    if (stage === "full-test") return;

    const child = Bun.spawn(command, {
      cwd,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      throw new Error(
        `${stage} failed: ${await new Response(child.stderr).text()}`,
      );
    }
  };
}

function createStubFailureRunner(failureStage: string): SemanticCommandRunner {
  return async (_command, _cwd, stage) => {
    if (stage === failureStage) {
      throw new Error(`simulated ${stage} failure`);
    }
  };
}

function renderIntegrationSource(testRoot: string): string {
  const conceptModule = modulePath(
    relative(testRoot, resolve(workspaceRoot, "concepts", "active-customer")),
  );
  const dslModule = modulePath(
    relative(testRoot, resolve(workspaceRoot, "src", "dsl")),
  );
  return [
    `import { ActiveCustomer } from ${JSON.stringify(conceptModule)};`,
    `import { bindConcept, generatePredicate, semanticTest } from ${JSON.stringify(dslModule)};`,
    "",
    "export type IntegrationCustomer = {",
    '  status: "active" | "suspended";',
    "  deletedAt: string | null;",
    "  email: string | null | undefined;",
    "};",
    "",
    "const Bound = bindConcept<IntegrationCustomer>(ActiveCustomer);",
    "export const isIntegrationCustomer = generatePredicate(Bound);",
    "semanticTest(isIntegrationCustomer, {",
    '  accept: [{ status: "active", deletedAt: null, email: "a@example.com" }],',
    '  reject: [{ status: "suspended", deletedAt: null, email: "a@example.com" }],',
    "});",
    "",
  ].join("\n");
}

function renderUnsectionedSource(testRoot: string): string {
  const dslModule = modulePath(
    relative(testRoot, resolve(workspaceRoot, "src", "dsl")),
  );
  return [
    `import { concept, generatePredicate, semanticTest } from ${JSON.stringify(dslModule)};`,
    "type Customer = { status: string };",
    "const CustomerConcept = concept<Customer>`A customer described only by prose.`;",
    "export const isCustomer = generatePredicate(CustomerConcept);",
    'semanticTest(isCustomer, { accept: [{ status: "active" }], reject: [{ status: "inactive" }] });',
    "",
  ].join("\n");
}

function renderDefinitionOnlySource(testRoot: string): string {
  const dslModule = modulePath(
    relative(testRoot, resolve(workspaceRoot, "src", "dsl")),
  );
  return [
    `import { concept, generatePredicate, semanticTest } from ${JSON.stringify(dslModule)};`,
    "type Customer = { status: string };",
    "const CustomerConcept = concept<Customer>`Definition:\nA customer.`;",
    "export const isCustomer = generatePredicate(CustomerConcept);",
    'semanticTest(isCustomer, { accept: [{ status: "active" }], reject: [{ status: "inactive" }] });',
    "",
  ].join("\n");
}

function renderInvalidSemanticSource(accept: string, reject: string): string {
  return [
    "type Concept<T> = { readonly input?: T };",
    "type Predicate<T> = (value: T) => boolean;",
    "declare function concept<T>(strings: TemplateStringsArray): Concept<T>;",
    "declare function generatePredicate<T>(concept: Concept<T>): Predicate<T>;",
    "declare function semanticTest<T>(",
    "  predicate: Predicate<T>,",
    "  cases: { accept: readonly T[]; reject: readonly T[] },",
    "): void;",
    ...renderCustomerPredicate(),
    `semanticTest(isCustomer, { accept: ${accept}, reject: ${reject} });`,
    "",
  ].join("\n");
}

function renderBenchmarkProbeSource(): string {
  return [
    "type Concept<T> = { readonly input?: T };",
    "type Predicate<T> = (value: T) => boolean;",
    "declare function concept<T>(strings: TemplateStringsArray): Concept<T>;",
    "declare function generatePredicate<T>(concept: Concept<T>): Predicate<T>;",
    "declare function benchmarkProbe<T>(predicate: Predicate<T>): void;",
    ...renderCustomerPredicate(),
    "benchmarkProbe(isCustomer);",
    "",
  ].join("\n");
}

function renderCustomerPredicate(): string[] {
  return [
    'type Customer = { state: "ready" | "waiting" };',
    "const CustomerConcept = concept<Customer>`",
    "Definition:",
    "A customer that is ready.",
    "",
    "Requirements:",
    "- The customer state is ready.",
    "`;",
    "export const isCustomer = generatePredicate(CustomerConcept);",
  ];
}

function resolvedCustomer(): SemanticResolution {
  return {
    elaboration: {
      outcome: "resolved",
      body: {
        kind: "all",
        conditions: [
          { kind: "equals", property: ["status"], value: "active" },
          { kind: "equals", property: ["deletedAt"], value: null },
          { kind: "present", property: ["email"] },
        ],
      },
      diagnostics: [],
    },
    response: null,
    rawOutput: { fixture: "resolved" },
  };
}

function unresolvedCustomer(): SemanticResolution {
  return {
    elaboration: {
      outcome: "unresolved",
      body: null,
      diagnostics: ["schema roles are ambiguous"],
    },
    response: null,
    rawOutput: { fixture: "unresolved" },
  };
}

function modulePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}
