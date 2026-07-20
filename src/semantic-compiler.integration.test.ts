import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import {
  compileSemanticSource,
  type SemanticCommandRunner,
  type SemanticResolution,
} from "./semantic-compiler";

const workspaceRoot = resolve(import.meta.dir, "..");

describe("semantic compiler transaction", () => {
  test(
    "builds, replays without resolution, rolls back, and records unresolved input",
    async () => {
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
          resolve: async () => resolution,
        });
        const firstCode = await readFile(finalPath, "utf8");
        expect(built.cacheHit).toBe(false);
        expect(built.apiCalls).toBe(0);
        expect(firstCode).toContain('integrationCustomer.status === "active"');
        expect(stages).toEqual([
          "project-typecheck",
          "candidate-typecheck",
          "semantic-test",
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
          entries: Record<string, { conceptId: string; conceptHash: string }>;
        };
        const entries = Object.values(lock.entries);
        expect(entries).toHaveLength(1);
        expect(entries[0]?.conceptId).toBe("customer.active");
        expect(entries[0]?.conceptHash).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        await rm(testRoot, { recursive: true, force: true });
      }
    },
    30_000,
  );
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
      throw new Error(`${stage} failed: ${await new Response(child.stderr).text()}`);
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
