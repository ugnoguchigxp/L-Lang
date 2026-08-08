import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { relative, resolve } from "node:path";

import type { SemanticResolution } from "./semantic-compiler";
import {
  compileSemanticTddSource,
  type SemanticTddCompileOptions,
} from "./semantic-tdd-compiler";
import { verifySemanticTddSource } from "./semantic-tdd-verify";
import { readSemanticTestLock } from "./semantic-test-lock";

const workspaceRoot = resolve(import.meta.dir, "..");

describe("Semantic TDD compiler transaction", () => {
  test(
    "freezes Test IR before implementation, validates Red, builds, and replays offline",
    async () => {
      const parent = resolve(workspaceRoot, ".semantic", "test-workspaces");
      await mkdir(parent, { recursive: true });
      const testRoot = await mkdtemp(resolve(parent, "semantic-tdd-"));
      const sourcePath = resolve(testRoot, "semantic.ts");
      const lockPath = resolve(testRoot, "semantic.lock");
      const testLockPath = resolve(testRoot, "semantic-test.lock");
      const auditRoot = resolve(testRoot, "audit");
      let implementationResolverCalled = false;
      let planResolverCalled = false;

      try {
        await writeFile(sourcePath, renderSource(testRoot), "utf8");
        const common: Pick<
          SemanticTddCompileOptions,
          | "sourcePath"
          | "workspaceRoot"
          | "lockPath"
          | "testLockPath"
          | "auditRoot"
          | "commandRunner"
        > = {
          sourcePath,
          workspaceRoot,
          lockPath,
          testLockPath,
          auditRoot,
          commandRunner: createRunner(),
        };
        const built = await compileSemanticTddSource({
          ...common,
          mode: "build",
          provider: "fixture:semantic-tdd",
          model: "fixture-model",
          countsAsApiCall: false,
          testCountsAsApiCall: false,
          resolveTestPlan: async (input) => {
            planResolverCalled = true;
            expect(input).not.toHaveProperty("implementation");
            expect(input).not.toHaveProperty("resolvedIr");
            expect(input).not.toHaveProperty("generatedCode");
            return {
              synthesis: {
                outcome: "resolved",
                plan: testPlan(input.contractHash),
                diagnostics: [],
              },
              response: null,
              rawOutput: { fixture: "test-plan" },
            };
          },
          resolveImplementation: async () => {
            implementationResolverCalled = true;
            expect(await readFile(testLockPath, "utf8")).toContain(
              '"freezeMode": "automatic"',
            );
            return resolvedCustomer();
          },
        });

        expect(planResolverCalled).toBe(true);
        expect(implementationResolverCalled).toBe(true);
        expect(built.status).toBe("passed");
        expect(built.testPlanCacheHit).toBe(false);
        expect(built.testApiCalls).toBe(0);
        expect(built.semanticTest.hardPassed).toBe(true);
        expect(built.mutationScore).toBe(1);
        expect(built.preImplementationRedHash).toMatch(/^[a-f0-9]{64}$/);
        expect(built.postImplementationRedHash).toMatch(/^[a-f0-9]{64}$/);
        const frozen = await readSemanticTestLock(testLockPath);
        const entry = Object.values(frozen.entries)[0];
        if (entry === undefined) throw new Error("missing frozen lock entry");
        expect(entry.preImplementationRed.implementationSignature).toBeNull();
        expect(
          entry.postImplementationRed?.implementationSignature,
        ).toMatch(/^[a-f0-9]{64}$/);

        const beforeReadOnlyVerify = {
          lock: await readFile(lockPath, "utf8"),
          testLock: await readFile(testLockPath, "utf8"),
          output: await readFile(
            resolve(testRoot, "is-tdd-customer.generated.ts"),
            "utf8",
          ),
        };
        const verified = await verifySemanticTddSource({
          sourcePath,
          workspaceRoot,
          lockPath,
          testLockPath,
        });
        expect(verified).toMatchObject({
          status: "passed",
          hardObligations: 4,
          mutationScore: 1,
          apiCalls: 0,
          filesWritten: 0,
        });
        expect({
          lock: await readFile(lockPath, "utf8"),
          testLock: await readFile(testLockPath, "utf8"),
          output: await readFile(
            resolve(testRoot, "is-tdd-customer.generated.ts"),
            "utf8",
          ),
        }).toEqual(beforeReadOnlyVerify);

        planResolverCalled = false;
        implementationResolverCalled = false;
        const replayed = await compileSemanticTddSource({
          ...common,
          mode: "replay",
        });
        expect(replayed.status).toBe("passed");
        expect(replayed.testPlanCacheHit).toBe(true);
        expect(replayed.testApiCalls).toBe(0);
        expect(replayed.implementation.apiCalls).toBe(0);
        expect(planResolverCalled).toBe(false);
        expect(implementationResolverCalled).toBe(false);
      } finally {
        await rm(testRoot, { recursive: true, force: true });
      }
    },
    120_000,
  );

  test("fails closed when a workspace lock requires recovery", async () => {
    const parent = resolve(workspaceRoot, ".semantic", "test-workspaces");
    await mkdir(parent, { recursive: true });
    const testRoot = await mkdtemp(resolve(parent, "semantic-tdd-lock-"));
    const sourcePath = resolve(testRoot, "semantic.ts");
    const testLockPath = resolve(testRoot, "semantic-test.lock");
    const lockDirectory = `${testLockPath}.workspace-lock`;
    try {
      await writeFile(sourcePath, renderSource(testRoot), "utf8");
      await mkdir(lockDirectory);
      await expect(
        compileSemanticTddSource({
          sourcePath,
          workspaceRoot,
          mode: "replay",
          lockPath: resolve(testRoot, "semantic.lock"),
          testLockPath,
        }),
      ).rejects.toThrow("workspace is busy or requires recovery");
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  test("does not synthesize an implementation before a Test Plan is available", async () => {
    const parent = resolve(workspaceRoot, ".semantic", "test-workspaces");
    await mkdir(parent, { recursive: true });
    const testRoot = await mkdtemp(resolve(parent, "semantic-tdd-unfrozen-"));
    const sourcePath = resolve(testRoot, "semantic.ts");
    let implementationCalled = false;
    try {
      await writeFile(sourcePath, renderSource(testRoot), "utf8");
      await expect(
        compileSemanticTddSource({
          sourcePath,
          workspaceRoot,
          mode: "build",
          lockPath: resolve(testRoot, "semantic.lock"),
          testLockPath: resolve(testRoot, "semantic-test.lock"),
          resolveImplementation: async () => {
            implementationCalled = true;
            return resolvedCustomer();
          },
        }),
      ).rejects.toThrow("requires a Test Plan resolver on a test lock miss");
      expect(implementationCalled).toBe(false);
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });
});

function createRunner(): NonNullable<
  SemanticTddCompileOptions["commandRunner"]
> {
  return async (command, cwd, stage) => {
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
    rawOutput: { fixture: "implementation" },
  };
}

function testPlan(contractHash: string) {
  return {
    version: 1 as const,
    contractHash,
    obligations: [
      {
        id: "accepted",
        kind: "example" as const,
        sourceClauses: [
          "requirements[0]",
          "requirements[1]",
        ],
        strength: "hard" as const,
        rationale: "All requirements hold.",
        input: {
          status: "active",
          deletedAt: null,
          email: "a@example.com",
        },
        expected: true,
      },
      {
        id: "suspended",
        kind: "example" as const,
        sourceClauses: ["requirements[0]", "exclusions[0]"],
        strength: "hard" as const,
        rationale: "Suspended customers are excluded.",
        input: {
          status: "suspended",
          deletedAt: null,
          email: "a@example.com",
        },
        expected: false,
      },
      {
        id: "deleted",
        kind: "counterfactual" as const,
        sourceClauses: ["exclusions[0]"],
        strength: "hard" as const,
        rationale: "Deletion reverses acceptance.",
        base: {
          status: "active",
          deletedAt: null,
          email: "a@example.com",
        },
        changes: [
          {
            property: ["deletedAt"],
            value: "2026-07-23T00:00:00Z",
          },
        ],
        expectedBefore: true,
        expectedAfter: false,
      },
      {
        id: "missing-email",
        kind: "example" as const,
        sourceClauses: ["requirements[1]"],
        strength: "hard" as const,
        rationale: "A contact email is required.",
        input: { status: "active", deletedAt: null, email: null },
        expected: false,
      },
      {
        id: "email-value-invariant",
        kind: "invariance" as const,
        sourceClauses: ["definition"],
        strength: "exploratory" as const,
        rationale: "One present email can be replaced by another.",
        base: {
          status: "active",
          deletedAt: null,
          email: "a@example.com",
        },
        changes: [{ property: ["email"], value: "b@example.com" }],
      },
    ],
  };
}

function renderSource(testRoot: string): string {
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
    "export type TddCustomer = {",
    '  status: "active" | "suspended";',
    "  deletedAt: string | null;",
    "  email: string | null | undefined;",
    "};",
    "",
    "const Bound = bindConcept<TddCustomer>(ActiveCustomer);",
    "export const isTddCustomer = generatePredicate(Bound);",
    "semanticTest(isTddCustomer, {",
    '  accept: [{ status: "active", deletedAt: null, email: "a@example.com" }],',
    '  reject: [{ status: "suspended", deletedAt: null, email: "a@example.com" }],',
    "});",
    "",
  ].join("\n");
}

function modulePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}
