import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { executePilotAttemptWithRetry, runPilotFixture } from "./pilot-runner";

const manifestPath = resolve(
  import.meta.dir,
  "../pilots/erp-crud-v1/manifest.json",
);

describe("Private Pilot fixture runner", () => {
  test("scores all ERP cases without exposing tests, hidden cases, or baselines", async () => {
    const reportRoot = await mkdtemp(resolve(tmpdir(), "l-lang-pilot-report-"));
    const captured: unknown[] = [];
    try {
      const result = await runPilotFixture({
        manifestPath,
        reportRoot,
        onModelInput: (input) => captured.push(input),
      });
      expect(result.report).toMatchObject({
        version: 1,
        status: "fixture-passed",
        summary: {
          total: 8,
          firstPassProjectFit: 8,
          falseResolutions: 0,
        },
        safety: {
          businessWrites: 0,
          externalIo: 0,
          workspaceMutations: 0,
          cooldownViolations: 0,
        },
      });
      expect(captured).toHaveLength(8);
      for (const input of captured) {
        const serialized = JSON.stringify(input);
        expect(serialized).not.toContain("semanticTest");
        expect(serialized).not.toContain("hidden");
        expect(serialized).not.toContain("baseline");
        expect(serialized).not.toContain("expected");
      }
      expect(
        await readFile(resolve(result.reportDirectory, "report.md"), "utf8"),
      ).toContain("First-pass project fit: 8/8");
    } finally {
      await rm(reportRoot, { recursive: true, force: true });
    }
  }, 15_000);

  test("applies cooldown after success, rate limit, and terminal error", async () => {
    const waits: number[] = [];
    let calls = 0;
    const value = await executePilotAttemptWithRetry({
      execute: async () => {
        calls += 1;
        if (calls === 1)
          throw Object.assign(new Error("rate limited"), { status: 429 });
        return "ok";
      },
      cooldownMs: 60_000,
      maxRateLimitRetries: 1,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });
    expect(value).toBe("ok");
    expect(waits).toEqual([60_000, 60_000]);

    const terminalWaits: number[] = [];
    await expect(
      executePilotAttemptWithRetry({
        execute: async () => {
          throw new Error("terminal");
        },
        cooldownMs: 60_000,
        maxRateLimitRetries: 0,
        wait: async (milliseconds) => {
          terminalWaits.push(milliseconds);
        },
      }),
    ).rejects.toThrow("terminal");
    expect(terminalWaits).toEqual([60_000]);
  });
});
