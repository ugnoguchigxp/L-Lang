import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  parseSemanticArguments,
  type SemanticCommand,
  semanticCommands,
} from "./semantic-arguments";

const workspaceRoot = resolve(import.meta.dir, "..");

describe("semantic CLI arguments", () => {
  test("parses every supported command without performing I/O", () => {
    expect(parseSemanticArguments(["build", "semantic.ts"])).toMatchObject({
      command: "build",
      target: "semantic.ts",
      review: false,
      json: false,
    });
    expect(
      parseSemanticArguments([
        "check",
        "semantic.ts",
        "--fixture",
        "response.json",
        "--samples",
        "3",
        "--quorum",
        "2",
      ]),
    ).toMatchObject({
      command: "check",
      fixturePath: "response.json",
      samples: 3,
      quorum: 2,
    });
    expect(
      parseSemanticArguments([
        "tdd-build",
        "semantic.ts",
        "--test-fixture",
        "test-plan.json",
        "--fixture",
        "implementation.json",
      ]),
    ).toMatchObject({
      command: "tdd-build",
      testFixturePath: "test-plan.json",
      fixturePath: "implementation.json",
    });
    expect(
      parseSemanticArguments(["tdd-test", "semantic.ts", "--json"]),
    ).toMatchObject({ command: "tdd-test", json: true });
  });

  test("enforces the complete command and option matrix", () => {
    const allowed: Record<SemanticCommand, readonly string[]> = {
      build: ["--fixture", "--review"],
      replay: [],
      test: [],
      check: ["--fixture", "--samples", "--quorum"],
      diff: [],
      approve: ["--reviewer"],
      explain: ["--json"],
      closure: ["--json"],
      verify: ["--json"],
      "tdd-build": ["--fixture", "--test-fixture"],
      "tdd-plan": ["--test-fixture"],
      "tdd-replay": [],
      "tdd-test": ["--json"],
    };
    const options: Record<string, readonly string[]> = {
      "--fixture": ["--fixture", "fixture.json"],
      "--test-fixture": ["--test-fixture", "test-fixture.json"],
      "--reviewer": ["--reviewer", "reviewer"],
      "--review": ["--review"],
      "--json": ["--json"],
      "--samples": ["--samples", "3"],
      "--quorum": ["--quorum", "2"],
    };

    for (const command of semanticCommands) {
      for (const [option, tokens] of Object.entries(options)) {
        const parse = () =>
          parseSemanticArguments([command, "target", ...tokens]);
        if (allowed[command].includes(option)) {
          expect(parse).not.toThrow();
        } else {
          expect(parse).toThrow(`${command} does not accept ${option}`);
        }
      }
    }
  });

  for (const testCase of [
    {
      name: "unknown option",
      argv: ["build", "semantic.ts", "--ficture"],
      error: "build does not accept --ficture",
    },
    {
      name: "duplicate value option",
      argv: [
        "build",
        "semantic.ts",
        "--fixture",
        "a.json",
        "--fixture",
        "b.json",
      ],
      error: "build does not accept duplicate --fixture",
    },
    {
      name: "duplicate flag",
      argv: ["build", "semantic.ts", "--review", "--review"],
      error: "build does not accept duplicate --review",
    },
    {
      name: "missing value",
      argv: ["build", "semantic.ts", "--fixture"],
      error: "--fixture requires a value",
    },
    {
      name: "option consumed as value",
      argv: ["build", "semantic.ts", "--fixture", "--review"],
      error: "--fixture requires a value",
    },
    {
      name: "extra positional argument",
      argv: ["replay", "semantic.ts", "extra.ts"],
      error: "replay does not accept positional argument extra.ts",
    },
    {
      name: "option forbidden for command",
      argv: ["replay", "semantic.ts", "--fixture", "response.json"],
      error: "replay does not accept --fixture and never calls an API",
    },
    {
      name: "missing reviewer",
      argv: ["approve", "review-1"],
      error: "semantic approve requires --reviewer <id>",
    },
    {
      name: "unused TDD reviewer",
      argv: ["tdd-build", "semantic.ts", "--reviewer", "alice"],
      error: "tdd-build does not accept --reviewer",
    },
    {
      name: "invalid integer",
      argv: ["check", "semantic.ts", "--samples", "3.5"],
      error: "--samples requires an integer",
    },
    {
      name: "zero samples",
      argv: ["check", "semantic.ts", "--samples", "0"],
      error: "--samples must be a positive integer",
    },
    {
      name: "too many samples",
      argv: ["check", "semantic.ts", "--samples", "10", "--quorum", "6"],
      error: "--samples must be between 1 and 9",
    },
    {
      name: "unsafe integer",
      argv: ["check", "semantic.ts", "--samples", "999999999999999999999"],
      error: "--samples requires a safe integer",
    },
    {
      name: "quorum greater than samples",
      argv: ["check", "semantic.ts", "--samples", "2", "--quorum", "3"],
      error: "--quorum cannot exceed --samples",
    },
    {
      name: "non-majority quorum",
      argv: ["check", "semantic.ts", "--samples", "4", "--quorum", "2"],
      error: "--quorum must be a strict majority of --samples",
    },
  ]) {
    test(`rejects ${testCase.name}`, () => {
      expect(() => parseSemanticArguments(testCase.argv)).toThrow(
        testCase.error,
      );
    });
  }

  test("rejects invalid arguments before resolving the target or connecting to an API", async () => {
    for (const testCase of [
      {
        argv: ["build", "does-not-exist.ts", "--ficture"],
        error: "build does not accept --ficture",
      },
      {
        argv: ["build", "does-not-exist.ts", "--fixture", "--review"],
        error: "--fixture requires a value",
      },
      {
        argv: ["replay", "does-not-exist.ts", "extra.ts"],
        error: "replay does not accept positional argument extra.ts",
      },
      {
        argv: ["approve", "does-not-exist"],
        error: "semantic approve requires --reviewer <id>",
      },
    ]) {
      const result = await runCli(testCase.argv);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(testCase.error);
      expect(result.stderr).not.toContain("ENOENT");
      expect(result.stderr).not.toContain("OPENAI_API_KEY");
    }
  });
});

async function runCli(
  args: string[],
): Promise<{ exitCode: number; stderr: string }> {
  const child = Bun.spawn(
    ["bun", "run", resolve(import.meta.dir, "semantic-cli.ts"), ...args],
    {
      cwd: workspaceRoot,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  return {
    exitCode: await child.exited,
    stderr: await new Response(child.stderr).text(),
  };
}
