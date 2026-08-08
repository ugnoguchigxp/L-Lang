import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { runProjectFitFixture } from "./project-fit-runner";
import { createProjectFitTestProtocol } from "./project-fit-test-fixture";

describe("Project Fit v2 fixture A/B harness", () => {
  test("evaluates initial and schema-change stages without exposing oracles", async () => {
    const fixture = await createProjectFitTestProtocol();
    const reportRoot = await mkdtemp(
      resolve(tmpdir(), "l-lang-project-fit-report-"),
    );
    const captured: unknown[] = [];
    try {
      const first = await runProjectFitFixture({
        manifestPath: fixture.manifestPath,
        reportRoot,
        onModelInput: (input) => captured.push(input),
      });
      expect(first.report).toMatchObject({
        version: 2,
        status: "fixture-passed",
        authoritativeInput: { freezeStatus: "draft" },
        stages: {
          initial: {
            arms: {
              typeOnly: { firstPassProjectFit: 0, falseResolutions: 0 },
              projectContext: { firstPassProjectFit: 1, falseResolutions: 0 },
            },
            comparison: { firstPassDelta: 1 },
          },
          schemaChange: {
            arms: {
              typeOnly: { firstPassProjectFit: 0, falseResolutions: 0 },
              projectContext: { firstPassProjectFit: 1, falseResolutions: 0 },
            },
            comparison: { firstPassDelta: 1 },
          },
        },
        safety: { falseResolutions: 0, workspaceMutations: 0 },
      });
      expect(captured).toHaveLength(4);
      expect(
        captured.filter((value) => "projectContext" in (value as object)),
      ).toHaveLength(2);
      for (const input of captured) {
        const serialized = JSON.stringify(input);
        expect(serialized).not.toContain("hiddenCases");
        expect(serialized).not.toContain("HIDDEN_SENTINEL");
        expect(serialized).not.toContain("oracle");
      }

      const firstJson = await readFile(
        resolve(first.reportDirectory, "report.json"),
        "utf8",
      );
      const second = await runProjectFitFixture({
        manifestPath: fixture.manifestPath,
        reportRoot,
      });
      expect(second.reportDirectory).toBe(first.reportDirectory);
      expect(
        await readFile(resolve(second.reportDirectory, "report.json"), "utf8"),
      ).toBe(firstJson);
      const markdown = await readFile(
        resolve(second.reportDirectory, "report.md"),
        "utf8",
      );
      expect(markdown).toContain("## Initial generation");
      expect(markdown).toContain("## Schema change");
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
      await rm(reportRoot, { recursive: true, force: true });
    }
  });

  test("detects mutation of a frozen v2 input", async () => {
    const fixture = await createProjectFitTestProtocol();
    const reportRoot = await mkdtemp(
      resolve(tmpdir(), "l-lang-project-fit-report-"),
    );
    try {
      await expect(
        runProjectFitFixture({
          manifestPath: fixture.manifestPath,
          reportRoot,
          resolveFixture: async (input) => {
            if (input.stage === "initial" && input.arm === "typeOnly") {
              await writeFile(
                resolve(fixture.directory, "initial.input.json"),
                '{"version":2,"mutated":true}\n',
              );
            }
            return trialResult(input.arm);
          },
        }),
      ).rejects.toThrow("mutated frozen benchmark inputs");
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
      await rm(reportRoot, { recursive: true, force: true });
    }
  });

  test("fails closed when aggregate fixture usage exceeds the budget", async () => {
    const fixture = await createProjectFitTestProtocol();
    const reportRoot = await mkdtemp(
      resolve(tmpdir(), "l-lang-project-fit-report-"),
    );
    try {
      await expect(
        runProjectFitFixture({
          manifestPath: fixture.manifestPath,
          reportRoot,
          resolveFixture: async (input) => ({
            ...trialResult(input.arm),
            inputTokens: 10_000,
          }),
        }),
      ).rejects.toThrow("exceeded input token budget");
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
      await rm(reportRoot, { recursive: true, force: true });
    }
  });
});

function trialResult(arm: "typeOnly" | "projectContext") {
  const passed = arm === "projectContext";
  return {
    outcome: passed ? ("resolved" as const) : ("unresolved" as const),
    projectGatePassed: passed,
    hiddenTestsPassed: passed,
    correctionEffort: passed ? 0 : 1,
    inputTokens: passed ? 120 : 100,
    outputTokens: 20,
    latencyMs: passed ? 25 : 20,
  };
}
