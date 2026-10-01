import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { runTddExtensionDemo } from "./semantic-tdd-extension-demo";

test("CLI fixture demo builds, verifies, replays selection and detects/replays a property defect without API calls", async () => {
  const parent = resolve(import.meta.dir, "../.semantic/test-workspaces");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, "extension-cli-"));
  const output = resolve(root, "run");
  try {
    await runTddExtensionDemo(output);
    const lock = JSON.parse(
      await readFile(resolve(output, "semantic-test.lock"), "utf8"),
    );
    const entries = Object.values(lock.entries) as {
      selectionReport: {
        version: number;
        trials: unknown[];
        selectedCandidate: string;
        apiCalls: number;
      };
    }[];
    expect(entries[0]?.selectionReport).toMatchObject({
      version: 2,
      selectedCandidate: "candidate-2",
      apiCalls: 0,
    });
    expect(entries[0]?.selectionReport.trials).toHaveLength(3);
    const failure = JSON.parse(
      await readFile(resolve(output, "property-fail.json"), "utf8"),
    );
    expect(failure.status).toBe("failed");
    expect(failure.counterexample.shrinkComplete).toBe(true);
    expect(failure.counterexample.expected).not.toBe(
      failure.counterexample.actual,
    );
    const pass = JSON.parse(
      await readFile(resolve(output, "property-pass.json"), "utf8"),
    );
    expect(pass.status).toBe("passed");
    await expect(runTddExtensionDemo(output)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
