import { describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { OpenAIRequestInput, OpenAIResult } from "./openai";
import { runProjectFitLive } from "./project-fit-live";
import { createProjectFitTestProtocol } from "./project-fit-test-fixture";

describe("Project Fit v2 live A/B runner", () => {
  test("runs both gates, keeps oracles hidden, and passes limits to all calls", async () => {
    const fixture = await createProjectFitTestProtocol();
    const captured: OpenAIRequestInput[] = [];
    try {
      await freezeProtocol(fixture.directory);
      const result = await runProjectFitLive({
        ...liveOptions(fixture.manifestPath),
        outputRoot: resolve(fixture.directory, "reports"),
        resolve: async (input) => {
          captured.push(input);
          return responseFor(input, captured.length);
        },
      });

      expect(result.report).toMatchObject({
        version: 2,
        status: "passed",
        gateC: {
          evidence: "live",
          passed: true,
          stages: {
            initial: { status: "passed" },
            schemaChange: { status: "passed" },
          },
          checks: {
            initialGeneration: true,
            schemaChange: true,
            estimatedCostBudget: true,
          },
        },
      });
      expect(captured).toHaveLength(4);
      expect(
        captured.every((input) => input.maxOutputTokens === 200),
      ).toBeTrue();
      expect(
        captured.filter((input) => input.projectContext !== undefined),
      ).toHaveLength(2);
      expect(JSON.stringify(captured)).not.toContain("HIDDEN_SENTINEL");
      expect(result.report.gateC?.stages.initial.checks).not.toHaveProperty(
        "inputTokenBudget",
      );
      expect(result.report.gateC?.checks).not.toHaveProperty(
        "totalInputTokenBudget",
      );
      expect(result.report.gateC?.checks).not.toHaveProperty(
        "totalOutputTokenBudget",
      );
      expect(
        result.report.stages.initial.arms.projectContext.inputTokens,
      ).toBeGreaterThan(0);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  test("requires frozen inputs and safe preflight budgets before resolving", async () => {
    for (const testCase of [
      {
        prepare: async () => {},
        rates: { input: 1, output: 1 },
        error: "must be frozen",
      },
      {
        prepare: freezeProtocol,
        rates: { input: 1_000, output: 1_000 },
        error: "can exceed the estimated cost budget",
      },
    ]) {
      const fixture = await createProjectFitTestProtocol();
      let calls = 0;
      try {
        await testCase.prepare(fixture.directory);
        await expect(
          runProjectFitLive({
            ...liveOptions(fixture.manifestPath),
            costPerMillionTokens: testCase.rates,
            resolve: async () => {
              calls += 1;
              throw new Error("must not run");
            },
          }),
        ).rejects.toThrow(testCase.error);
        expect(calls).toBe(0);
      } finally {
        await rm(fixture.directory, { recursive: true, force: true });
      }
    }
  });

  test("fails closed when usage is absent or exceeds the per-call limit", async () => {
    for (const testCase of [
      { usage: null, error: "response usage is required" },
      {
        usage: { inputTokens: 100, outputTokens: 201, totalTokens: 301 },
        error: "exceeded the per-call output token limit of 200",
      },
      {
        usage: { inputTokens: 2_001, outputTokens: 20, totalTokens: 2_021 },
        error: "exceeded the input token budget",
      },
    ]) {
      const fixture = await createProjectFitTestProtocol();
      let calls = 0;
      try {
        await freezeProtocol(fixture.directory);
        await expect(
          runProjectFitLive({
            ...liveOptions(fixture.manifestPath),
            outputRoot: resolve(fixture.directory, "reports"),
            runId: "invalid-usage",
            resolve: async () => {
              calls += 1;
              return {
                responseId: `response-${calls}`,
                model: "fixture-model",
                outputText: JSON.stringify({
                  outcome: "unresolved",
                  body: null,
                  diagnostics: [],
                }),
                usage: testCase.usage,
              };
            },
          }),
        ).rejects.toThrow(testCase.error);
        expect(calls).toBe(1);
      } finally {
        await rm(fixture.directory, { recursive: true, force: true });
      }
    }
  });

  test("does not run schema-change calls when the initial gate fails", async () => {
    const fixture = await createProjectFitTestProtocol();
    const captured: OpenAIRequestInput[] = [];
    try {
      await freezeProtocol(fixture.directory);
      const result = await runProjectFitLive({
        ...liveOptions(fixture.manifestPath),
        outputRoot: resolve(fixture.directory, "reports"),
        resolve: async (input) => {
          captured.push(input);
          return unresolvedResponse(captured.length);
        },
      });
      expect(result.report.status).toBe("failed");
      expect(result.report.gateC?.stages.initial.status).toBe("failed");
      expect(result.report.gateC?.stages.schemaChange.status).toBe("not-run");
      expect(captured).toHaveLength(2);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  test("cools down after every API attempt and retries a 429 in the same task", async () => {
    const fixture = await createProjectFitTestProtocol();
    const waits: number[] = [];
    let attempts = 0;
    try {
      await freezeProtocol(fixture.directory);
      const result = await runProjectFitLive({
        ...liveOptions(fixture.manifestPath),
        outputRoot: resolve(fixture.directory, "reports"),
        cooldownMs: 60_000,
        maxRateLimitRetries: 1,
        wait: async (milliseconds) => {
          waits.push(milliseconds);
        },
        resolve: async (input) => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("OpenAI API returned status 429");
          }
          return responseFor(input, attempts);
        },
      });

      expect(result.report.status).toBe("passed");
      expect(attempts).toBe(5);
      expect(waits).toEqual([60_000, 60_000, 60_000, 60_000, 60_000]);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  test("resumes completed calls without duplicates and preserves latency", async () => {
    const fixture = await createProjectFitTestProtocol();
    const outputRoot = resolve(fixture.directory, "reports");
    let calls = 0;
    try {
      await freezeProtocol(fixture.directory);
      await expect(
        runProjectFitLive({
          ...liveOptions(fixture.manifestPath),
          outputRoot,
          runId: "resume",
          resolve: async (input) => {
            calls += 1;
            return responseFor(input, calls);
          },
          onCheckpoint: (completed) => {
            if (completed === 2) throw new Error("controlled interruption");
          },
        }),
      ).rejects.toThrow("controlled interruption");
      expect(calls).toBe(2);

      const resumed = await runProjectFitLive({
        ...liveOptions(fixture.manifestPath),
        outputRoot,
        runId: "resume",
        resolve: async (input) => {
          calls += 1;
          return responseFor(input, calls);
        },
      });
      expect(resumed.report.status).toBe("passed");
      expect(calls).toBe(4);
      expect(
        resumed.report.stages.initial.arms.typeOnly.latencyMs,
      ).toBeGreaterThan(0);
      const responses = JSON.parse(
        await readFile(
          resolve(resumed.reportDirectory, "responses.json"),
          "utf8",
        ),
      ) as unknown[];
      expect(responses).toHaveLength(4);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  test("refuses a checkpoint with an uncertain pending API call", async () => {
    const fixture = await createProjectFitTestProtocol();
    const outputRoot = resolve(fixture.directory, "reports");
    let calls = 0;
    try {
      await freezeProtocol(fixture.directory);
      await expect(
        runProjectFitLive({
          ...liveOptions(fixture.manifestPath),
          outputRoot,
          runId: "pending",
          resolve: async () => {
            calls += 1;
            throw new Error("upstream failed");
          },
        }),
      ).rejects.toThrow("upstream failed");
      expect(calls).toBe(1);

      await expect(
        runProjectFitLive({
          ...liveOptions(fixture.manifestPath),
          outputRoot,
          runId: "pending",
          resolve: async () => {
            calls += 1;
            return unresolvedResponse(calls);
          },
        }),
      ).rejects.toThrow("uncertain pending API call");
      expect(calls).toBe(1);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  test("rejects metadata changes and completed run reuse", async () => {
    const fixture = await createProjectFitTestProtocol();
    const outputRoot = resolve(fixture.directory, "reports");
    try {
      await freezeProtocol(fixture.directory);
      let completed = 0;
      await expect(
        runProjectFitLive({
          ...liveOptions(fixture.manifestPath),
          outputRoot,
          runId: "metadata",
          resolve: async (input) => responseFor(input, ++completed),
          onCheckpoint: () => {
            throw new Error("stop");
          },
        }),
      ).rejects.toThrow("stop");
      await expect(
        runProjectFitLive({
          ...liveOptions(fixture.manifestPath),
          model: "different-model",
          outputRoot,
          runId: "metadata",
          resolve: async (input) => responseFor(input, 2),
        }),
      ).rejects.toThrow("metadata does not match");

      await runProjectFitLive({
        ...liveOptions(fixture.manifestPath),
        outputRoot,
        runId: "complete",
        resolve: async (input) => responseFor(input, ++completed),
      });
      await expect(
        runProjectFitLive({
          ...liveOptions(fixture.manifestPath),
          outputRoot,
          runId: "complete",
          resolve: async (input) => responseFor(input, ++completed),
        }),
      ).rejects.toThrow("already complete");
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});

function liveOptions(manifestPath: string) {
  return {
    manifestPath,
    model: "fixture-model",
    provider: "fixture",
    costPerMillionTokens: { input: 1, output: 1 },
  };
}

async function freezeProtocol(directory: string): Promise<void> {
  const freezePath = resolve(directory, "freeze.json");
  const freeze = JSON.parse(await readFile(freezePath, "utf8")) as {
    status: string;
  };
  freeze.status = "frozen";
  await writeFile(freezePath, `${JSON.stringify(freeze, null, 2)}\n`);
}

function responseFor(input: OpenAIRequestInput, index: number): OpenAIResult {
  if (input.projectContext === undefined) return unresolvedResponse(index);
  const typeSource = input.typeScriptSource;
  const body = typeSource.includes("state:")
    ? { kind: "equals", property: ["state"], value: "ready" }
    : { kind: "equals", property: ["ready"], value: true };
  return {
    responseId: `response-${index}`,
    model: "fixture-model",
    outputText: JSON.stringify({
      outcome: "resolved",
      body,
      diagnostics: [],
    }),
    usage: { inputTokens: 120, outputTokens: 20, totalTokens: 140 },
  };
}

function unresolvedResponse(index: number): OpenAIResult {
  return {
    responseId: `response-${index}`,
    model: "fixture-model",
    outputText: JSON.stringify({
      outcome: "unresolved",
      body: null,
      diagnostics: ["Project convention is unavailable."],
    }),
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
  };
}
