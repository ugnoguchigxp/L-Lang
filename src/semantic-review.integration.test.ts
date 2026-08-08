import { describe, expect, test } from "bun:test";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { relative, resolve } from "node:path";

import {
  compileSemanticSource,
  type SemanticCommandRunner,
  type SemanticResolution,
} from "./semantic-compiler";
import {
  approveSemanticReview,
  readSemanticReviewCandidate,
} from "./semantic-review";
import type { SemanticLock } from "./semantic-lock";
import {
  compileStaticJudgmentSource,
  type StaticJudgmentCompilerResolution,
} from "./static-judgment-compiler";

const workspaceRoot = resolve(import.meta.dir, "..");

describe("optional semantic review", () => {
  test("keeps artifacts unchanged until Predicate and Static Judgment candidates are approved", async () => {
    const parent = resolve(workspaceRoot, ".semantic", "test-workspaces");
    await mkdir(parent, { recursive: true });
    const testRoot = await mkdtemp(resolve(parent, "review-"));
    const predicateDirectory = resolve(testRoot, "predicate");
    const judgmentDirectory = resolve(testRoot, "judgment");
    const predicateSourcePath = resolve(predicateDirectory, "semantic.ts");
    const judgmentSourcePath = resolve(judgmentDirectory, "semantic.ts");
    const predicateOutputPath = resolve(
      predicateDirectory,
      "is-review-customer.generated.ts",
    );
    const judgmentOutputPath = resolve(
      judgmentDirectory,
      "mike-is-cat.generated.ts",
    );
    const lockPath = resolve(testRoot, "semantic.lock");
    const reviewRoot = resolve(testRoot, "reviews");
    const auditRoot = resolve(testRoot, "audit");

    try {
      await mkdir(predicateDirectory, { recursive: true });
      await mkdir(judgmentDirectory, { recursive: true });
      await writeFile(
        predicateSourcePath,
        renderPredicateSource(predicateDirectory),
        "utf8",
      );
      await writeFile(
        judgmentSourcePath,
        renderStaticJudgmentSource(judgmentDirectory),
        "utf8",
      );
      const stages: string[] = [];
      const runner = createRunner(stages);

      const predicateReview = await compileSemanticSource({
        sourcePath: predicateSourcePath,
        workspaceRoot,
        mode: "build",
        promotion: "review",
        provider: "fixture:review",
        model: "gpt-5.4-mini",
        countsAsApiCall: false,
        lockPath,
        reviewRoot,
        auditRoot,
        commandRunner: runner,
        resolve: async () => predicateResolution(),
      });
      expect(predicateReview.status).toBe("review-required");
      if (predicateReview.status !== "review-required") {
        throw new Error("expected Predicate review candidate");
      }
      expect(stages).toEqual([
        "candidate-typecheck",
        "semantic-test",
        "project-typecheck",
      ]);
      expect(await exists(predicateOutputPath)).toBeFalse();
      expect(await exists(lockPath)).toBeFalse();
      const predicateCandidate = await readSemanticReviewCandidate(
        predicateReview.candidateId,
        { workspaceRoot, reviewRoot },
      );
      expect(predicateCandidate.candidate.kind).toBe("predicate");
      expect(predicateCandidate.diff).toContain("NEW PREDICATE");

      stages.length = 0;
      const parallelReview = await compileSemanticSource({
        sourcePath: predicateSourcePath,
        workspaceRoot,
        mode: "build",
        promotion: "review",
        provider: "fixture:review",
        model: "gpt-5.4-mini",
        countsAsApiCall: false,
        lockPath,
        reviewRoot,
        auditRoot,
        commandRunner: runner,
        resolve: async () => predicateResolution(),
      });
      if (parallelReview.status !== "review-required") {
        throw new Error("expected parallel Predicate review candidate");
      }

      stages.length = 0;
      const predicateApproved = await approveSemanticReview(
        predicateReview.candidateId,
        {
          reviewer: "integration-reviewer",
          workspaceRoot,
          lockPath,
          reviewRoot,
          commandRunner: runner,
        },
      );
      expect(predicateApproved.status).toBe("approved");
      expect(stages).toEqual([
        "candidate-typecheck",
        "semantic-test",
        "project-typecheck",
        "full-test",
      ]);
      expect(await readFile(predicateOutputPath, "utf8")).toContain(
        'reviewCustomer.status === "active"',
      );
      let lock = JSON.parse(await readFile(lockPath, "utf8")) as SemanticLock;
      expect(Object.values(lock.entries)[0]?.promotion).toMatchObject({
        mode: "reviewed",
        candidateId: predicateReview.candidateId,
        reviewer: "integration-reviewer",
      });
      const idempotent = await approveSemanticReview(
        predicateReview.candidateId,
        {
          reviewer: "another-reviewer",
          workspaceRoot,
          lockPath,
          reviewRoot,
          commandRunner: runner,
        },
      );
      expect(idempotent.status).toBe("already-approved");
      await expect(
        approveSemanticReview(parallelReview.candidateId, {
          reviewer: "parallel-reviewer",
          workspaceRoot,
          lockPath,
          reviewRoot,
          commandRunner: runner,
        }),
      ).rejects.toThrow("baseline is stale");

      const reviewedLock = await readFile(lockPath, "utf8");
      const reviewedOutput = await readFile(predicateOutputPath, "utf8");
      const rollbackReview = await compileSemanticSource({
        sourcePath: predicateSourcePath,
        workspaceRoot,
        mode: "build",
        promotion: "review",
        provider: "fixture:review-rollback",
        model: "gpt-5.4-mini",
        countsAsApiCall: false,
        lockPath,
        reviewRoot,
        auditRoot,
        commandRunner: runner,
        resolve: async () => predicateResolution(),
      });
      if (rollbackReview.status !== "review-required") {
        throw new Error("expected rollback-test review candidate");
      }
      await expect(
        approveSemanticReview(rollbackReview.candidateId, {
          reviewer: "integration-reviewer",
          workspaceRoot,
          lockPath,
          reviewRoot,
          commandRunner: createFailureRunner("full-test"),
        }),
      ).rejects.toThrow("simulated full-test failure");
      expect(await readFile(lockPath, "utf8")).toBe(reviewedLock);
      expect(await readFile(predicateOutputPath, "utf8")).toBe(reviewedOutput);

      const staleReview = await compileSemanticSource({
        sourcePath: predicateSourcePath,
        workspaceRoot,
        mode: "build",
        promotion: "review",
        provider: "fixture:review",
        model: "gpt-5.4-mini",
        lockPath,
        reviewRoot,
        auditRoot,
        commandRunner: runner,
      });
      if (staleReview.status !== "review-required") {
        throw new Error("expected stale-test review candidate");
      }
      await writeFile(
        predicateSourcePath,
        `${renderPredicateSource(predicateDirectory)}\n// changed after review build\n`,
        "utf8",
      );
      await expect(
        approveSemanticReview(staleReview.candidateId, {
          reviewer: "integration-reviewer",
          workspaceRoot,
          lockPath,
          reviewRoot,
          commandRunner: runner,
        }),
      ).rejects.toThrow("stale");
      expect(await readFile(lockPath, "utf8")).toBe(reviewedLock);
      expect(await readFile(predicateOutputPath, "utf8")).toBe(reviewedOutput);

      await writeFile(
        predicateSourcePath,
        renderPredicateSource(predicateDirectory),
        "utf8",
      );
      const tamperReview = await compileSemanticSource({
        sourcePath: predicateSourcePath,
        workspaceRoot,
        mode: "build",
        promotion: "review",
        provider: "fixture:review",
        model: "gpt-5.4-mini",
        lockPath,
        reviewRoot,
        auditRoot,
        commandRunner: runner,
      });
      if (tamperReview.status !== "review-required") {
        throw new Error("expected tamper-test review candidate");
      }
      await writeFile(
        resolve(workspaceRoot, tamperReview.candidateDirectory, "candidate.ts"),
        "tampered\n",
        "utf8",
      );
      await expect(
        approveSemanticReview(tamperReview.candidateId, {
          reviewer: "integration-reviewer",
          workspaceRoot,
          lockPath,
          reviewRoot,
          commandRunner: runner,
        }),
      ).rejects.toThrow("candidate.ts hash changed");
      await expect(
        approveSemanticReview(tamperReview.candidateId, {
          reviewer: " ",
          workspaceRoot,
          lockPath,
          reviewRoot,
          commandRunner: runner,
        }),
      ).rejects.toThrow("reviewer");

      stages.length = 0;
      const judgmentReview = await compileStaticJudgmentSource({
        sourcePath: judgmentSourcePath,
        workspaceRoot,
        mode: "build",
        promotion: "review",
        provider: "fixture:review",
        model: "gpt-5.4-mini",
        countsAsApiCall: false,
        lockPath,
        reviewRoot,
        auditRoot,
        commandRunner: runner,
        resolve: async () => staticJudgmentResolution(),
      });
      expect(judgmentReview.status).toBe("review-required");
      if (judgmentReview.status !== "review-required") {
        throw new Error("expected Static Judgment review candidate");
      }
      expect(await exists(judgmentOutputPath)).toBeFalse();
      expect(await readFile(lockPath, "utf8")).toBe(reviewedLock);
      expect(
        (
          await readSemanticReviewCandidate(judgmentReview.candidateId, {
            workspaceRoot,
            reviewRoot,
          })
        ).diff,
      ).toContain("NEW STATIC JUDGMENT");

      stages.length = 0;
      await approveSemanticReview(judgmentReview.candidateId, {
        reviewer: "integration-reviewer",
        workspaceRoot,
        lockPath,
        reviewRoot,
        commandRunner: runner,
      });
      expect(stages).toEqual([
        "candidate-typecheck",
        "project-typecheck",
        "full-test",
      ]);
      expect(await readFile(judgmentOutputPath, "utf8")).toContain(
        "mikeIsCat = true as const",
      );
      lock = JSON.parse(await readFile(lockPath, "utf8"));
      expect(Object.values(lock.judgments ?? {})[0]?.promotion).toMatchObject({
        mode: "reviewed",
        candidateId: judgmentReview.candidateId,
        reviewer: "integration-reviewer",
        validation: { semanticTest: "not-applicable" },
      });
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  }, 180_000);

  test("dispatches review build, diff, and approve through the CLI for both source kinds", async () => {
    const parent = resolve(workspaceRoot, ".semantic", "test-workspaces");
    await mkdir(parent, { recursive: true });
    const testRoot = await mkdtemp(resolve(parent, "review-cli-"));
    try {
      await writeFile(
        resolve(testRoot, "package.json"),
        JSON.stringify({
          type: "module",
          scripts: { typecheck: "bunx tsc --noEmit" },
        }),
        "utf8",
      );
      await writeFile(
        resolve(testRoot, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            types: ["bun"],
          },
          include: ["**/*.ts"],
        }),
        "utf8",
      );
      await writeFile(
        resolve(testRoot, "predicate.ts"),
        localPredicateSource(),
        "utf8",
      );
      await writeFile(
        resolve(testRoot, "judgment.ts"),
        localStaticJudgmentSource(),
        "utf8",
      );
      await writeFile(
        resolve(testRoot, "smoke.test.ts"),
        'import { expect, test } from "bun:test";\ntest("workspace smoke", () => expect(true).toBeTrue());\n',
        "utf8",
      );
      await writeFile(
        resolve(testRoot, "predicate.fixture.json"),
        JSON.stringify(
          openAIResponse({
            outcome: "resolved",
            body: { kind: "equals", property: ["state"], value: "ready" },
            diagnostics: [],
          }),
        ),
        "utf8",
      );
      await writeFile(
        resolve(testRoot, "judgment.fixture.json"),
        JSON.stringify(
          openAIResponse({
            outcome: "resolved",
            value: true,
            diagnostics: [],
          }),
        ),
        "utf8",
      );

      const predicateBuild = await runSemanticCli(testRoot, [
        "build",
        "predicate.ts",
        "--review",
        "--fixture",
        "predicate.fixture.json",
      ]);
      expect(predicateBuild.exitCode).toBe(0);
      expect(predicateBuild.stdout).toContain("semantic review required");
      const predicateId = candidateIdFrom(predicateBuild.stdout);
      expect(
        await exists(resolve(testRoot, "is-ready.generated.ts")),
      ).toBeFalse();
      expect(await exists(resolve(testRoot, "semantic.lock"))).toBeFalse();
      const predicateDiff = await runSemanticCli(testRoot, [
        "diff",
        predicateId,
      ]);
      expect(predicateDiff.exitCode).toBe(0);
      expect(predicateDiff.stdout).toContain("NEW PREDICATE");
      const predicateApprove = await runSemanticCli(testRoot, [
        "approve",
        predicateId,
        "--reviewer",
        "cli-reviewer",
      ]);
      if (predicateApprove.exitCode !== 0) {
        throw new Error(predicateApprove.stderr || predicateApprove.stdout);
      }
      expect(predicateApprove.exitCode).toBe(0);
      expect(predicateApprove.stdout).toContain("semantic review approved");
      expect(
        await exists(resolve(testRoot, "is-ready.generated.ts")),
      ).toBeTrue();

      const judgmentBuild = await runSemanticCli(testRoot, [
        "build",
        "judgment.ts",
        "--review",
        "--fixture",
        "judgment.fixture.json",
      ]);
      expect(judgmentBuild.exitCode).toBe(0);
      expect(judgmentBuild.stdout).toContain("Static Judgment review required");
      const judgmentId = candidateIdFrom(judgmentBuild.stdout);
      expect(
        await exists(resolve(testRoot, "mike-is-cat.generated.ts")),
      ).toBeFalse();
      const judgmentDiff = await runSemanticCli(testRoot, ["diff", judgmentId]);
      expect(judgmentDiff.stdout).toContain("NEW STATIC JUDGMENT");
      const judgmentApprove = await runSemanticCli(testRoot, [
        "approve",
        judgmentId,
        "--reviewer",
        "cli-reviewer",
      ]);
      expect(judgmentApprove.exitCode).toBe(0);
      expect(
        await exists(resolve(testRoot, "mike-is-cat.generated.ts")),
      ).toBeTrue();

      const invalidReview = await runSemanticCli(testRoot, [
        "replay",
        "predicate.ts",
        "--review",
      ]);
      expect(invalidReview.exitCode).toBe(1);
      expect(invalidReview.stderr).toContain("replay does not accept --review");
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  }, 90_000);
});

function createRunner(stages: string[]): SemanticCommandRunner {
  return async (command, cwd, stage) => {
    stages.push(stage);
    if (stage === "project-typecheck" || stage === "full-test") return;
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

function createFailureRunner(failureStage: string): SemanticCommandRunner {
  return async (_command, _cwd, stage) => {
    if (stage === failureStage) {
      throw new Error(`simulated ${stage} failure`);
    }
  };
}

function renderPredicateSource(sourceDirectory: string): string {
  const conceptModule = modulePath(
    relative(
      sourceDirectory,
      resolve(workspaceRoot, "concepts", "active-customer"),
    ),
  );
  const dslModule = modulePath(
    relative(sourceDirectory, resolve(workspaceRoot, "src", "dsl")),
  );
  return [
    `import { ActiveCustomer } from ${JSON.stringify(conceptModule)};`,
    `import { bindConcept, generatePredicate, semanticTest } from ${JSON.stringify(dslModule)};`,
    "",
    "export type ReviewCustomer = {",
    '  status: "active" | "suspended";',
    "  deletedAt: string | null;",
    "  email: string | null | undefined;",
    "};",
    "",
    "const Bound = bindConcept<ReviewCustomer>(ActiveCustomer);",
    "export const isReviewCustomer = generatePredicate(Bound);",
    "semanticTest(isReviewCustomer, {",
    '  accept: [{ status: "active", deletedAt: null, email: "a@example.com" }],',
    '  reject: [{ status: "suspended", deletedAt: null, email: "a@example.com" }],',
    "});",
    "",
  ].join("\n");
}

function renderStaticJudgmentSource(sourceDirectory: string): string {
  const conceptModule = modulePath(
    relative(
      sourceDirectory,
      resolve(workspaceRoot, "examples/static-judgment/cat"),
    ),
  );
  const dslModule = modulePath(
    relative(sourceDirectory, resolve(workspaceRoot, "src", "dsl")),
  );
  return [
    `import { judgeStatic, staticValue } from ${JSON.stringify(dslModule)};`,
    `import { Cat } from ${JSON.stringify(conceptModule)};`,
    "",
    'const mike = staticValue("A small calico animal that meows.");',
    "export const mikeIsCat = judgeStatic(mike, Cat);",
    "",
  ].join("\n");
}

function predicateResolution(): SemanticResolution {
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

function staticJudgmentResolution(): StaticJudgmentCompilerResolution {
  return {
    judgment: { outcome: "resolved", value: true, diagnostics: [] },
    response: null,
    rawOutput: { fixture: true },
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function modulePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

async function runSemanticCli(
  cwd: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(
    ["bun", "run", resolve(workspaceRoot, "src/semantic-cli.ts"), ...args],
    {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function candidateIdFrom(output: string): string {
  const match = output.match(/^candidate: (review-[0-9]{14}-[a-f0-9]{8})$/m);
  if (match?.[1] === undefined)
    throw new Error(`candidate id missing from:\n${output}`);
  return match[1];
}

function openAIResponse(body: unknown): object {
  return {
    id: "resp_review_fixture",
    model: "gpt-5.4-mini",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: JSON.stringify(body),
            annotations: [],
          },
        ],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
  };
}

function localPredicateSource(): string {
  return `
declare function concept<T>(strings: TemplateStringsArray): unknown;
declare function generatePredicate<T>(concept: unknown): (value: T) => boolean;
declare function semanticTest<T>(predicate: (value: T) => boolean, cases: { accept: T[]; reject: T[] }): void;

export type Customer = { state: "ready" | "waiting" };
const ReadyCustomer = concept<Customer>\`Definition:\nA ready customer has state ready.\n\nRequirements:\n- state is ready.\n\nExclusions:\n- state is waiting.\n\nOut of scope:\n- Other customer attributes.\n\nLeave unresolved when:\n- The state role is not represented unambiguously.\`;
export const isReady = generatePredicate<Customer>(ReadyCustomer);
semanticTest(isReady, { accept: [{ state: "ready" }], reject: [{ state: "waiting" }] });
`.trimStart();
}

function localStaticJudgmentSource(): string {
  return `
declare function defineConcept(id: string): (strings: TemplateStringsArray) => unknown;
declare function staticValue(value: string): unknown;
declare function judgeStatic(value: unknown, concept: unknown): boolean;

const Cat = defineConcept("animal.cat")\`Definition:\nA domesticated biological cat.\`;
const mike = staticValue(\`A calico animal that meows.\`);
export const mikeIsCat = judgeStatic(mike, Cat);
`.trimStart();
}
