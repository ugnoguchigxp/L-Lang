import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import {
  compileSemanticSource,
  type SemanticCommandRunner,
  type SemanticResolution,
} from "./semantic-compiler";
import {
  approveSemanticEvolution,
  checkSemanticEvolution,
} from "./semantic-evolution";

const workspaceRoot = resolve(import.meta.dir, "..");

describe("schema evolution transaction", () => {
  test(
    "keeps approved artifacts unchanged until approval and rejects stale, unresolved, and failed candidates",
    async () => {
      const parent = resolve(workspaceRoot, ".semantic", "test-workspaces");
      await mkdir(parent, { recursive: true });
      const testRoot = await mkdtemp(resolve(parent, "evolution-"));
      const sourcePath = resolve(testRoot, "semantic.ts");
      const lockPath = resolve(testRoot, "semantic.lock");
      const auditRoot = resolve(testRoot, "audit");
      const evolutionRoot = resolve(testRoot, "evolution");
      const finalPath = resolve(testRoot, "is-evolving-customer.generated.ts");
      const runner = createRunner();

      try {
        await writeFile(sourcePath, renderSource("baseline", testRoot), "utf8");
        await compileSemanticSource({
          sourcePath,
          workspaceRoot,
          mode: "build",
          provider: "fixture:baseline",
          model: "gpt-5.4-mini",
          countsAsApiCall: false,
          lockPath,
          auditRoot,
          commandRunner: runner,
          resolve: async () => resolvedBaseline(),
        });
        const approvedCodeBefore = await readFile(finalPath, "utf8");
        const lockBefore = await readFile(lockPath, "utf8");

        await writeFile(sourcePath, renderSource("renamed", testRoot), "utf8");
        const checked = await checkSemanticEvolution({
          sourcePath,
          workspaceRoot,
          provider: "fixture:evolution",
          model: "gpt-5.4-mini",
          countsAsApiCall: false,
          samples: 3,
          quorum: 2,
          lockPath,
          evolutionRoot,
          commandRunner: runner,
          resolve: async () => resolvedRenamed(),
        });
        if (checked.status !== "candidate-created") {
          throw new Error("expected an evolution candidate");
        }
        expect(checked.candidate.status).toBe("ready");
        expect(checked.candidate.consensus).toMatchObject({
          samples: 3,
          quorum: 2,
          reached: true,
          selectedOutcome: "resolved",
          supportingSamples: [1, 2, 3],
        });
        expect(checked.candidate.diff.classification).toBe("compatible");
        expect(checked.candidate.diff.logicalShapeChanged).toBe(false);
        expect(checked.candidate.diff.leafChanges).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ changes: expect.arrayContaining(["property", "value"]) }),
          ]),
        );
        expect(await readFile(finalPath, "utf8")).toBe(approvedCodeBefore);
        expect(await readFile(lockPath, "utf8")).toBe(lockBefore);
        expect(
          await readFile(resolve(checked.candidateDirectory, "diff.txt"), "utf8"),
        ).toContain("Semantic change: COMPATIBLE");

        const approved = await approveSemanticEvolution(checked.candidate.id, {
          workspaceRoot,
          lockPath,
          evolutionRoot,
          commandRunner: runner,
        });
        expect(approved.candidate.status).toBe("approved");
        expect(await readFile(finalPath, "utf8")).toContain(
          "evolvingCustomer.enabled === true",
        );
        const lockAfterApprove = await readFile(lockPath, "utf8");
        expect(Object.keys(JSON.parse(lockAfterApprove).entries)).toHaveLength(2);
        const replayed = await compileSemanticSource({
          sourcePath,
          workspaceRoot,
          mode: "replay",
          lockPath,
          auditRoot,
          commandRunner: runner,
        });
        expect(replayed.fingerprint).toBe(checked.candidate.proposedFingerprint);

        await writeFile(sourcePath, renderSource("added-property", testRoot), "utf8");
        const staleCheck = await checkSemanticEvolution({
          sourcePath,
          workspaceRoot,
          provider: "fixture:evolution",
          model: "gpt-5.4-mini",
          countsAsApiCall: false,
          lockPath,
          evolutionRoot,
          commandRunner: runner,
          resolve: async () => resolvedRenamed(),
        });
        if (staleCheck.status !== "candidate-created") {
          throw new Error("expected a stale-test candidate");
        }
        expect(staleCheck.candidate.diff.summary).toBe("The Predicate IR is unchanged.");
        await writeFile(
          sourcePath,
          `${renderSource("added-property", testRoot)}\n// changed after semantic check\n`,
          "utf8",
        );
        await expect(
          approveSemanticEvolution(staleCheck.candidate.id, {
            workspaceRoot,
            lockPath,
            evolutionRoot,
            commandRunner: runner,
          }),
        ).rejects.toThrow("candidate is stale");
        expect(await readFile(lockPath, "utf8")).toBe(lockAfterApprove);

        const unresolvedCheck = await checkSemanticEvolution({
          sourcePath,
          workspaceRoot,
          provider: "fixture:unresolved",
          model: "gpt-5.4-mini",
          countsAsApiCall: false,
          lockPath,
          evolutionRoot,
          commandRunner: runner,
          resolve: async () => unresolved(),
        });
        if (unresolvedCheck.status !== "candidate-created") {
          throw new Error("expected an unresolved candidate");
        }
        expect(unresolvedCheck.candidate.status).toBe("unresolved");
        expect(unresolvedCheck.candidate.diff.classification).toBe("unresolved");
        await expect(
          approveSemanticEvolution(unresolvedCheck.candidate.id, {
            workspaceRoot,
            lockPath,
            evolutionRoot,
            commandRunner: runner,
          }),
        ).rejects.toThrow("candidate is not approvable: unresolved");

        const rollbackCheck = await checkSemanticEvolution({
          sourcePath,
          workspaceRoot,
          provider: "fixture:rollback",
          model: "gpt-5.4-mini",
          countsAsApiCall: false,
          lockPath,
          evolutionRoot,
          commandRunner: runner,
          resolve: async () => resolvedRenamed(),
        });
        if (rollbackCheck.status !== "candidate-created") {
          throw new Error("expected a rollback-test candidate");
        }
        const approvedCode = await readFile(finalPath, "utf8");
        await expect(
          approveSemanticEvolution(rollbackCheck.candidate.id, {
            workspaceRoot,
            lockPath,
            evolutionRoot,
            commandRunner: createRunner("full-test"),
          }),
        ).rejects.toThrow("simulated full-test failure");
        expect(await readFile(finalPath, "utf8")).toBe(approvedCode);
        expect(await readFile(lockPath, "utf8")).toBe(lockAfterApprove);
      } finally {
        await rm(testRoot, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

function createRunner(failureStage?: string): SemanticCommandRunner {
  return async (command, cwd, stage) => {
    if (stage === failureStage) throw new Error(`simulated ${stage} failure`);
    if (stage === "project-typecheck" || stage === "full-test") return;
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

function renderSource(
  version: "baseline" | "renamed" | "added-property",
  testRoot: string,
): string {
  const conceptModule = modulePath(
    relative(testRoot, resolve(workspaceRoot, "concepts", "active-customer")),
  );
  const dslModule = modulePath(
    relative(testRoot, resolve(workspaceRoot, "src", "dsl")),
  );
  const imports = [
    `import { ActiveCustomer } from ${JSON.stringify(conceptModule)};`,
    `import { bindConcept, generatePredicate, semanticTest } from ${JSON.stringify(dslModule)};`,
    "",
  ];
  if (version === "baseline") {
    return [
      ...imports,
      "export type EvolvingCustomer = {",
      '  status: "active" | "suspended";',
      "  deletedAt: string | null;",
      "  email: string | null;",
      "};",
      "",
      "const Bound = bindConcept<EvolvingCustomer>(ActiveCustomer);",
      "export const isEvolvingCustomer = generatePredicate(Bound);",
      "semanticTest(isEvolvingCustomer, {",
      '  accept: [{ status: "active", deletedAt: null, email: "a@example.com" }],',
      '  reject: [{ status: "suspended", deletedAt: null, email: "a@example.com" }],',
      "});",
      "",
    ].join("\n");
  }
  return [
    ...imports,
    "export type EvolvingCustomer = {",
    "  enabled: boolean;",
    "  blockedAt: string | null;",
    "  contactAddress: string | null;",
    ...(version === "added-property" ? ["  notes?: string;"] : []),
    "};",
    "",
    "const Bound = bindConcept<EvolvingCustomer>(ActiveCustomer);",
    "export const isEvolvingCustomer = generatePredicate(Bound);",
    "semanticTest(isEvolvingCustomer, {",
    '  accept: [{ enabled: true, blockedAt: null, contactAddress: "a@example.com" }],',
    '  reject: [{ enabled: false, blockedAt: null, contactAddress: "a@example.com" }],',
    "});",
    "",
  ].join("\n");
}

function resolvedBaseline(): SemanticResolution {
  return resolved([
    { kind: "equals", property: ["status"], value: "active" },
    { kind: "equals", property: ["deletedAt"], value: null },
    { kind: "present", property: ["email"] },
  ]);
}

function resolvedRenamed(): SemanticResolution {
  return resolved([
    { kind: "equals", property: ["enabled"], value: true },
    { kind: "equals", property: ["blockedAt"], value: null },
    { kind: "present", property: ["contactAddress"] },
  ]);
}

function resolved(
  conditions: Array<
    | { kind: "equals"; property: string[]; value: string | boolean | null }
    | { kind: "present"; property: string[] }
  >,
): SemanticResolution {
  return {
    elaboration: { outcome: "resolved", body: { kind: "all", conditions }, diagnostics: [] },
    response: null,
    rawOutput: { fixture: "resolved" },
  };
}

function unresolved(): SemanticResolution {
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
