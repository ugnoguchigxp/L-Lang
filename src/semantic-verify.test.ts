import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { verifySemanticArtifact } from "./semantic-verify";
import { renderSemanticVerify } from "./semantic-verify-renderer";

describe("semantic verify", () => {
  test("aggregates Closure, deterministic generation, Semantic Tests, and typecheck", async () => {
    const commands: string[][] = [];
    const report = await verifySemanticArtifact({
      manifestPath: "semantic-closure.json",
      workspaceRoot: process.cwd(),
      commandRunner: async (command) => {
        commands.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(report).toMatchObject({
      version: 1,
      status: "passed",
      checks: {
        closure: { status: "passed" },
        deterministicGeneration: {
          status: "passed",
          total: 4,
          passed: 4,
          failed: 0,
          skipped: 0,
        },
        semanticTests: {
          status: "passed",
          total: 4,
          passed: 3,
          failed: 0,
          skipped: 1,
        },
        typecheck: { status: "passed", diagnostic: null },
      },
    });
    expect(commands.filter((command) => command[1] === "test")).toHaveLength(3);
    expect(commands.at(-1)).toEqual(["bun", "run", "typecheck"]);
    const rendered = renderSemanticVerify(report);
    expect(rendered).toContain("persistent files written: 0");
    expect(rendered).toContain("diagnostics:\n  none");
    expect(report.remediation).toEqual([]);
  }, 120_000);

  test("collects test failures and keeps typecheck as a separate check", async () => {
    const report = await verifySemanticArtifact({
      manifestPath: resolve("semantic-closure.json"),
      commandRunner: async (command) =>
        command[1] === "test"
          ? { exitCode: 1, stdout: "", stderr: "semantic failure" }
          : { exitCode: 0, stdout: "", stderr: "" },
    });

    expect(report.status).toBe("failed");
    expect(report.checks.semanticTests).toMatchObject({
      status: "failed",
      failed: 3,
    });
    expect(report.checks.typecheck.status).toBe("passed");
    expect(report.remediation).toContain(
      "Fix the failing Semantic Test cases or regenerate the affected Predicate.",
    );
    expect(renderSemanticVerify(report)).toContain("remediation:");
  }, 120_000);

  test("reports an open manifest without attempting unsafe generation", async () => {
    const report = await verifySemanticArtifact({
      manifestPath: resolve("examples/semantic-closure/open.json"),
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });

    expect(report.status).toBe("failed");
    expect(report.checks.closure.status).toBe("failed");
    expect(report.checks.deterministicGeneration).toMatchObject({
      total: 1,
      skipped: 1,
    });
    expect(report.checks.semanticTests).toMatchObject({
      total: 1,
      skipped: 1,
    });
    expect(report.remediation[0]).toContain("semantic closure");
    expect(renderSemanticVerify(report)).toContain(
      "no lock entry exists for this semantic source",
    );
  }, 10_000);

  test("reports typecheck failures with a direct remediation", async () => {
    const report = await verifySemanticArtifact({
      manifestPath: resolve("semantic-closure.json"),
      commandRunner: async (command) =>
        command[1] === "run"
          ? { exitCode: 1, stdout: "", stderr: "type error" }
          : { exitCode: 0, stdout: "", stderr: "" },
    });

    expect(report.status).toBe("failed");
    expect(report.checks.typecheck).toMatchObject({
      status: "failed",
      diagnostic: "type error",
    });
    expect(report.remediation).toContain(
      "Run bun run typecheck and fix the reported TypeScript errors.",
    );
  }, 120_000);

  test("propagates command startup failures as operational errors", async () => {
    await expect(
      verifySemanticArtifact({
        manifestPath: resolve("semantic-closure.json"),
        commandRunner: async () => {
          throw new Error("spawn unavailable");
        },
      }),
    ).rejects.toThrow("spawn unavailable");
  }, 120_000);

  test("rejects a manifest outside the declared workspace", async () => {
    await expect(
      verifySemanticArtifact({
        manifestPath: "../outside.json",
        workspaceRoot: resolve("examples"),
      }),
    ).rejects.toThrow(
      "Semantic Closure manifest must be inside the workspace root",
    );
  });
});
