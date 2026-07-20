import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { relative, resolve } from "node:path";

import type { SemanticCommandRunner } from "./semantic-compiler";
import {
  compileStaticJudgmentSource,
  type StaticJudgmentCompilerResolution,
} from "./static-judgment-compiler";

const workspaceRoot = resolve(import.meta.dir, "..");

describe("Static Judgment compiler transaction", () => {
  test(
    "builds true and false constants, replays, rejects stale and unresolved input, and rolls back failures",
    async () => {
      const parent = resolve(workspaceRoot, ".semantic/test-workspaces");
      await mkdir(parent, { recursive: true });
      const testRoot = await mkdtemp(resolve(parent, "static-compiler-"));
      const sourcePath = resolve(testRoot, "semantic.ts");
      const lockPath = resolve(testRoot, "semantic.lock");
      const auditRoot = resolve(testRoot, "audit");
      const finalPath = resolve(testRoot, "mike-is-cat.generated.ts");

      try {
        await writeSource(sourcePath, testRoot, "A small calico animal that meows.");
        const stages: string[] = [];
        const runner = createRunner(stages);
        const built = await compileStaticJudgmentSource({
          sourcePath,
          workspaceRoot,
          mode: "build",
          provider: "fixture:true",
          model: "gpt-5.4-mini",
          countsAsApiCall: false,
          lockPath,
          auditRoot,
          commandRunner: runner,
          resolve: async () => resolved(true),
        });
        const trueCode = await readFile(finalPath, "utf8");
        expect(built.resolvedValue).toBe(true);
        expect(built.apiCalls).toBe(0);
        expect(built.cacheHit).toBe(false);
        expect(trueCode).toContain("mikeIsCat = true as const");
        expect(trueCode).not.toMatch(/OPENAI|fetch|api-key|calico/);
        expect(stages).toEqual([
          "candidate-typecheck",
          "project-typecheck",
          "full-test",
        ]);

        stages.length = 0;
        const replayedTrue = await compileStaticJudgmentSource({
          sourcePath,
          workspaceRoot,
          mode: "replay",
          lockPath,
          auditRoot,
          commandRunner: runner,
        });
        expect(replayedTrue.apiCalls).toBe(0);
        expect(replayedTrue.cacheHit).toBe(true);
        expect(replayedTrue.generatedCodeHash).toBe(built.generatedCodeHash);
        expect(await readFile(finalPath, "utf8")).toBe(trueCode);

        await writeSource(
          sourcePath,
          testRoot,
          "A battery-powered mechanical cat-shaped toy.",
        );
        const builtFalse = await compileStaticJudgmentSource({
          sourcePath,
          workspaceRoot,
          mode: "build",
          provider: "fixture:false",
          model: "gpt-5.4-mini",
          countsAsApiCall: false,
          lockPath,
          auditRoot,
          commandRunner: runner,
          resolve: async () => resolved(false),
        });
        const falseCode = await readFile(finalPath, "utf8");
        expect(builtFalse.resolvedValue).toBe(false);
        expect(falseCode).toContain("mikeIsCat = false as const");

        const replayedFalse = await compileStaticJudgmentSource({
          sourcePath,
          workspaceRoot,
          mode: "replay",
          lockPath,
          auditRoot,
          commandRunner: runner,
        });
        expect(replayedFalse.resolvedValue).toBe(false);
        expect(await readFile(finalPath, "utf8")).toBe(falseCode);

        const lockBeforeFailures = await readFile(lockPath, "utf8");
        const parsedLock = JSON.parse(lockBeforeFailures) as {
          entries: Record<string, unknown>;
          judgments: Record<string, unknown>;
        };
        expect(Object.keys(parsedLock.entries)).toHaveLength(0);
        expect(Object.keys(parsedLock.judgments)).toHaveLength(2);

        await writeSource(sourcePath, testRoot, "An animal is visible in the distance.");
        await expect(compileStaticJudgmentSource({
          sourcePath,
          workspaceRoot,
          mode: "replay",
          lockPath,
          auditRoot,
          commandRunner: runner,
        })).rejects.toThrow("no lock entry matches");
        expect(await readFile(finalPath, "utf8")).toBe(falseCode);

        await expect(compileStaticJudgmentSource({
          sourcePath,
          workspaceRoot,
          mode: "build",
          provider: "fixture:unresolved",
          model: "gpt-5.4-mini",
          countsAsApiCall: false,
          lockPath,
          auditRoot,
          commandRunner: runner,
          resolve: async () => unresolved(),
        })).rejects.toThrow("was unresolved");
        expect(await readFile(finalPath, "utf8")).toBe(falseCode);
        expect(await readFile(lockPath, "utf8")).toBe(lockBeforeFailures);

        await expect(compileStaticJudgmentSource({
          sourcePath,
          workspaceRoot,
          mode: "build",
          provider: "fixture:full-test-failure",
          model: "gpt-5.4-mini",
          countsAsApiCall: false,
          lockPath,
          auditRoot,
          commandRunner: createRunner([], "full-test"),
          resolve: async () => resolved(true),
        })).rejects.toThrow("simulated full-test failure");
        expect(await readFile(finalPath, "utf8")).toBe(falseCode);
        expect(await readFile(lockPath, "utf8")).toBe(lockBeforeFailures);

        await expect(compileStaticJudgmentSource({
          sourcePath,
          workspaceRoot,
          mode: "build",
          provider: "fixture:lock-failure",
          model: "gpt-5.4-mini",
          countsAsApiCall: false,
          lockPath,
          auditRoot,
          commandRunner: runner,
          writeLock: async () => {
            throw new Error("simulated lock write failure");
          },
          resolve: async () => resolved(true),
        })).rejects.toThrow("simulated lock write failure");
        expect(await readFile(finalPath, "utf8")).toBe(falseCode);
        expect(await readFile(lockPath, "utf8")).toBe(lockBeforeFailures);

        await expect(compileStaticJudgmentSource({
          sourcePath,
          workspaceRoot,
          mode: "build",
          provider: "fixture:candidate-failure",
          model: "gpt-5.4-mini",
          countsAsApiCall: false,
          lockPath,
          auditRoot,
          commandRunner: createRunner([], "candidate-typecheck"),
          resolve: async () => resolved(true),
        })).rejects.toThrow("simulated candidate-typecheck failure");
        expect(await readFile(finalPath, "utf8")).toBe(falseCode);
        expect(await readFile(lockPath, "utf8")).toBe(lockBeforeFailures);

        expect(
          (await readdir(testRoot)).filter((name) => name.includes(".candidate.ts")),
        ).toEqual([]);
      } finally {
        await rm(testRoot, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

function createRunner(
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

async function writeSource(
  path: string,
  testRoot: string,
  description: string,
): Promise<void> {
  const conceptModule = modulePath(
    relative(testRoot, resolve(workspaceRoot, "examples/static-judgment/cat")),
  );
  const dslModule = modulePath(
    relative(testRoot, resolve(workspaceRoot, "src/dsl")),
  );
  await writeFile(path, [
    `import { judgeStatic, staticValue } from ${JSON.stringify(dslModule)};`,
    `import { Cat } from ${JSON.stringify(conceptModule)};`,
    "",
    `const mike = staticValue(${JSON.stringify(description)});`,
    "export const mikeIsCat = judgeStatic(mike, Cat);",
    "",
  ].join("\n"), "utf8");
}

function resolved(value: boolean): StaticJudgmentCompilerResolution {
  return {
    judgment: { outcome: "resolved", value, diagnostics: [] },
    response: null,
    rawOutput: { fixture: value },
  };
}

function unresolved(): StaticJudgmentCompilerResolution {
  return {
    judgment: {
      outcome: "unresolved",
      value: null,
      diagnostics: ["the animal species is not visible"],
    },
    response: null,
    rawOutput: { fixture: "unresolved" },
  };
}

function modulePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}
