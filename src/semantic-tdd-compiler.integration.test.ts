import { scanSemanticSource } from "./semantic-source";
import { runPropertyTest } from "./semantic-property-test";
import { sha256, stableJson } from "./semantic-fingerprint";
import type { SemanticTddBestOfNReport } from "./semantic-tdd-best-of-n";
import { verifySemanticArtifact } from "./semantic-verify";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  test("freezes Test IR before implementation, validates Red, builds, and replays offline", async () => {
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
      expect(entry.postImplementationRed?.implementationSignature).toMatch(
        /^[a-f0-9]{64}$/,
      );

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
  }, 120_000);

  test("opt-in Best-of-N persists/replays all candidates, rejects tampering, and leaves artifacts unchanged on all-failed selection", async () => {
    const parent = resolve(workspaceRoot, ".semantic", "test-workspaces");
    await mkdir(parent, { recursive: true });
    const testRoot = await mkdtemp(resolve(parent, "semantic-tdd-best-of-n-"));
    const sourcePath = resolve(testRoot, "semantic.ts");
    const lockPath = resolve(testRoot, "semantic.lock");
    const testLockPath = resolve(testRoot, "semantic-test.lock");
    const common = {
      sourcePath,
      workspaceRoot,
      lockPath,
      testLockPath,
      auditRoot: resolve(testRoot, "audit"),
      commandRunner: createRunner(),
    };
    const config = {
      version: 1 as const,
      candidates: 3,
      maxOutputTokensPerCall: 200,
      maxTotalTokens: 10000,
      timeoutMs: 1000,
      maxCostUsd: 1,
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 2,
    };
    try {
      await writeFile(sourcePath, renderSource(testRoot));
      const requests: unknown[] = [];
      const built = await compileSemanticTddSource({
        ...common,
        mode: "build",
        bestOfN: config,
        countsAsApiCall: false,
        testCountsAsApiCall: false,
        resolveTestPlan: async (input) => ({
          synthesis: {
            outcome: "resolved",
            plan: testPlan(input.contractHash),
            diagnostics: [],
          },
          response: null,
          rawOutput: {},
        }),
        resolveBestOfN: async (request) => {
          requests.push(structuredClone(request));
          expect(request.specification).toContain("Frozen Semantic Test Plan");
          if (requests.length === 1)
            return {
              elaboration: {
                outcome: "resolved",
                body: { kind: "equals", property: ["status"], value: "active" },
                diagnostics: [],
              },
              response: null,
              rawOutput: {},
            };
          return resolvedCustomer();
        },
      });
      expect(requests).toHaveLength(3);
      expect(requests[0]).toEqual(requests[2]);
      expect(built.selectionReport.version).toBe(2);
      expect(built.selectionReport.selectedCandidate).toBe("candidate-2");
      expect((await verifySemanticTddSource(common)).status).toBe("passed");
      const lockBefore = await readFile(lockPath, "utf8");
      const artifactPath = resolve(testRoot, "is-tdd-customer.generated.ts");
      const artifactBefore = await readFile(artifactPath, "utf8");
      const frozenBefore = await readFile(testLockPath, "utf8");
      const manifestPath = resolve(testRoot, "closure.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          version: 1,
          nodes: [
            {
              id: "tdd",
              source: relative(workspaceRoot, sourcePath),
              dependsOn: [],
            },
          ],
        }),
      );
      const verifyProject = (propertyReportPath?: string) =>
        verifySemanticArtifact({
          manifestPath,
          workspaceRoot,
          lockPath,
          testLockPath,
          ...(propertyReportPath === undefined ? {} : { propertyReportPath }),
          commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        });
      expect(
        (await verifyProject()).checks.deterministicGeneration.status,
      ).toBe("passed");

      const propertyPath = resolve(testRoot, "property.json");
      const currentSource = await scanSemanticSource(sourcePath);
      const currentEntry = Object.values(
        (await readSemanticTestLock(testLockPath)).entries,
      )[0];
      if (currentEntry === undefined) throw new Error("missing frozen plan");
      const implementation = resolvedCustomer().elaboration.body;
      if (implementation === null) throw new Error("missing implementation");
      const property = runPropertyTest({
        schema: currentSource.concept.typeSchema,
        expression: implementation,
        plan: currentEntry.plan,
        config: {
          version: 2,
          seed: 42,
          cases: 64,
          maxGeneratedNodes: 1024,
          maxShrinkSteps: 128,
          maxArrayLength: 4,
          timeoutMs: 10000,
          domains: [
            { path: ["deletedAt"], values: ["", "synthetic"] },
            { path: ["email"], values: ["", "synthetic"] },
          ],
          expected: implementation,
        },
      });
      await writeFile(propertyPath, JSON.stringify(property));
      expect(
        (await verifyProject(propertyPath)).checks.deterministicGeneration
          .status,
      ).toBe("passed");
      expect(await readFile(lockPath, "utf8")).toBe(lockBefore);
      expect(await readFile(testLockPath, "utf8")).toBe(frozenBefore);
      expect(await readFile(artifactPath, "utf8")).toBe(artifactBefore);
      const wrongPlan = runPropertyTest({
        schema: property.schema,
        expression: property.expression,
        config: property.config,
        plan: { ...property.plan, contractHash: "b".repeat(64) },
      });
      await writeFile(propertyPath, JSON.stringify(wrongPlan));
      expect(
        (await verifyProject(propertyPath)).checks.deterministicGeneration
          .status,
      ).toBe("failed");
      await writeFile(
        propertyPath,
        JSON.stringify({ ...property, sequenceHash: "0".repeat(64) }),
      );
      await expect(verifyProject(propertyPath)).rejects.toThrow(
        "replay mismatch",
      );

      const tampered = JSON.parse(frozenBefore);
      for (const entry of Object.values(
        tampered.entries as Record<
          string,
          { selectionReport: { selectedCandidate: string } }
        >,
      ))
        entry.selectionReport.selectedCandidate = "candidate-3";
      await writeFile(testLockPath, JSON.stringify(tampered));
      expect(
        (await verifyProject()).checks.deterministicGeneration.status,
      ).toBe("failed");
      await expect(verifySemanticTddSource(common)).rejects.toThrow(
        "replay mismatch",
      );
      await expect(
        compileSemanticTddSource({ ...common, mode: "replay" }),
      ).rejects.toThrow("replay mismatch");
      const contextTampered = JSON.parse(frozenBefore) as {
        entries: Record<string, { selectionReport: SemanticTddBestOfNReport }>;
      };
      for (const entry of Object.values(contextTampered.entries)) {
        const context = entry.selectionReport.request.projectContext;
        if (context === undefined) throw new Error("missing Project Context");
        context.target.typeDeclaration += "\n";
        entry.selectionReport.requestHash = sha256(
          stableJson(entry.selectionReport.request),
        );
      }
      await writeFile(testLockPath, JSON.stringify(contextTampered));
      await expect(verifySemanticTddSource(common)).rejects.toThrow(
        "Project Context snapshot mismatch",
      );
      await expect(
        compileSemanticTddSource({ ...common, mode: "replay" }),
      ).rejects.toThrow("Project Context snapshot mismatch");
      await writeFile(testLockPath, frozenBefore);
      const replay = await compileSemanticTddSource({
        ...common,
        mode: "replay",
        resolveBestOfN: async () => {
          throw new Error("must not call API");
        },
      });
      expect(replay.implementation.apiCalls).toBe(0);
      expect(replay.selectionReport).toEqual(built.selectionReport);
      await expect(
        compileSemanticTddSource({
          ...common,
          mode: "build",
          bestOfN: config,
          countsAsApiCall: false,
          resolveBestOfN: async () => ({
            elaboration: {
              outcome: "unresolved",
              body: null,
              diagnostics: ["fixture unresolved"],
            },
            response: null,
            rawOutput: {},
          }),
        }),
      ).rejects.toThrow("Best-of-N unresolved");
      expect(await readFile(lockPath, "utf8")).toBe(lockBefore);
      expect(await readFile(artifactPath, "utf8")).toBe(artifactBefore);
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  }, 60000);

  test("a property report matches its node when another node has identical schema and IR", async () => {
    const parent = resolve(workspaceRoot, ".semantic", "test-workspaces");
    await mkdir(parent, { recursive: true });
    const testRoot = await mkdtemp(resolve(parent, "property-two-nodes-"));
    const lockPath = resolve(testRoot, "semantic.lock");
    const testLockPath = resolve(testRoot, "semantic-test.lock");
    try {
      const paths: string[] = [];
      for (const name of ["first", "second"]) {
        const root = resolve(testRoot, name);
        await mkdir(root);
        const sourcePath = resolve(root, "semantic.ts");
        paths.push(sourcePath);
        await writeFile(sourcePath, renderSource(root));
        await compileSemanticTddSource({
          sourcePath,
          workspaceRoot,
          lockPath,
          testLockPath,
          auditRoot: resolve(root, "audit"),
          mode: "build",
          commandRunner: createRunner(),
          countsAsApiCall: false,
          testCountsAsApiCall: false,
          resolveImplementation: async () => resolvedCustomer(),
          resolveTestPlan: async (input) => {
            const plan = testPlan(input.contractHash);
            for (const row of plan.obligations)
              row.rationale += ` ${name}-node plan.`;
            return {
              synthesis: { outcome: "resolved", plan, diagnostics: [] },
              response: null,
              rawOutput: {},
            };
          },
        });
      }
      const first = paths[0];
      if (first === undefined) throw new Error("missing source");
      const source = await scanSemanticSource(first);
      const entry = Object.values(
        (await readSemanticTestLock(testLockPath)).entries,
      ).find((e) => e.source === relative(workspaceRoot, first));
      const expression = resolvedCustomer().elaboration.body;
      if (entry === undefined || expression === null)
        throw new Error("missing current state");
      const property = runPropertyTest({
        schema: source.concept.typeSchema,
        expression,
        plan: entry.plan,
        config: {
          version: 2,
          seed: 42,
          cases: 64,
          maxGeneratedNodes: 1024,
          maxShrinkSteps: 128,
          maxArrayLength: 4,
          timeoutMs: 10000,
          domains: [
            { path: ["deletedAt"], values: ["", "synthetic"] },
            { path: ["email"], values: ["", "synthetic"] },
          ],
          expected: expression,
        },
      });
      const propertyReportPath = resolve(testRoot, "property.json");
      await writeFile(propertyReportPath, JSON.stringify(property));
      const manifestPath = resolve(testRoot, "closure.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          version: 1,
          nodes: paths.map((source, i) => ({
            id: `node-${i}`,
            source: relative(workspaceRoot, source),
            dependsOn: [],
          })),
        }),
      );
      const before = await Promise.all([
        readFile(lockPath, "utf8"),
        readFile(testLockPath, "utf8"),
      ]);
      const report = await verifySemanticArtifact({
        manifestPath,
        workspaceRoot,
        lockPath,
        testLockPath,
        propertyReportPath,
        commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      });
      expect(report.status).toBe("passed");
      expect(report.checks.deterministicGeneration.passed).toBe(2);
      expect(
        await Promise.all([
          readFile(lockPath, "utf8"),
          readFile(testLockPath, "utf8"),
        ]),
      ).toEqual(before);
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  }, 60000);

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
        sourceClauses: ["requirements[0]", "requirements[1]"],
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
