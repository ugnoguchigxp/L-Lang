import { describe, expect, test } from "bun:test";
import { access, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { runSemanticTests } from "./semantic-test-runner";

describe("read-only Semantic Test runner", () => {
  test("runs a current Predicate and always removes its temporary test", async () => {
    const sourceDirectory = resolve("examples/active-customer");
    const before = await temporaryTests(sourceDirectory);
    const commands: string[][] = [];
    let temporaryDirectory = "";
    const result = await runSemanticTests({
      sourcePath: "examples/active-customer/semantic.ts",
      workspaceRoot: process.cwd(),
      commandRunner: async (command) => {
        commands.push(command);
        const testPath = command[2];
        if (testPath === undefined) throw new Error("test path is missing");
        temporaryDirectory = dirname(testPath);
        expect(testPath.startsWith(resolve(tmpdir()))).toBe(true);
        expect(testPath.startsWith(sourceDirectory)).toBe(false);
        await expect(stat(testPath)).resolves.toBeDefined();
        return { exitCode: 0, stdout: "passed", stderr: "" };
      },
    });

    expect(result).toMatchObject({
      version: 1,
      status: "passed",
      source: "examples/active-customer/semantic.ts",
      predicate: "isActiveCustomer",
      diagnostic: null,
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.slice(0, 2)).toEqual(["bun", "test"]);
    await expect(access(temporaryDirectory)).rejects.toThrow();
    expect(await temporaryTests(sourceDirectory)).toEqual(before);
  }, 15_000);

  test("reports a test failure without retaining a temporary file", async () => {
    const sourceDirectory = resolve("examples/active-customer");
    const before = await temporaryTests(sourceDirectory);
    const result = await runSemanticTests({
      sourcePath: resolve(sourceDirectory, "semantic.ts"),
      commandRunner: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "expected true but received false",
      }),
    });

    expect(result.status).toBe("failed");
    expect(result.diagnostic).toContain("expected true");
    expect(await temporaryTests(sourceDirectory)).toEqual(before);
  });

  test("reports an empty failed command", async () => {
    const sourceDirectory = resolve("examples/active-customer");
    const before = await temporaryTests(sourceDirectory);
    const empty = await runSemanticTests({
      sourcePath: resolve(sourceDirectory, "semantic.ts"),
      commandRunner: async () => ({ exitCode: 9, stdout: "", stderr: "" }),
    });
    expect(empty).toMatchObject({
      status: "failed",
      diagnostic: "Semantic Test failed with exit code 9",
    });
    expect(await temporaryTests(sourceDirectory)).toEqual(before);
  });

  test("cleans up after command errors", async () => {
    const sourceDirectory = resolve("examples/active-customer");
    const before = await temporaryTests(sourceDirectory);
    let temporaryDirectory = "";
    await expect(
      runSemanticTests({
        sourcePath: resolve(sourceDirectory, "semantic.ts"),
        commandRunner: async (command) => {
          const testPath = command[2];
          if (testPath === undefined) throw new Error("test path is missing");
          temporaryDirectory = dirname(testPath);
          throw new Error("test process unavailable");
        },
      }),
    ).rejects.toThrow("test process unavailable");
    await expect(access(temporaryDirectory)).rejects.toThrow();
    expect(await temporaryTests(sourceDirectory)).toEqual(before);
  });

  test("rejects Static Judgment without invoking a command", async () => {
    let calls = 0;
    await expect(
      runSemanticTests({
        sourcePath: resolve("examples/static-judgment/semantic.ts"),
        commandRunner: async () => {
          calls += 1;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    ).rejects.toThrow("Static Judgment has no runtime Semantic Test contract");
    expect(calls).toBe(0);
  });

  test("rejects a source outside the declared workspace", async () => {
    await expect(
      runSemanticTests({
        sourcePath: "../outside.ts",
        workspaceRoot: resolve("examples"),
      }),
    ).rejects.toThrow("semantic source must be inside the workspace root");
  });
});

async function temporaryTests(directory: string): Promise<string[]> {
  return (await readdir(directory))
    .filter((name) => name.endsWith(".semantic.test.ts"))
    .sort();
}
