import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { OpenAIRequestInput, OpenAIResult } from "./openai";
import { runPilotLive } from "./pilot-live";
import { writePilotFreeze } from "./pilot-manifest";

const sourceDirectory = resolve(import.meta.dir, "../pilots/erp-crud-v1");

describe("Private Pilot live runner", () => {
  test("does not allow a draft review to freeze live inputs", async () => {
    const fixture = await createLiveFixture();
    try {
      await makeReviewDraft(fixture.manifestPath);
      await expect(
        writePilotFreeze({
          manifestPath: fixture.manifestPath,
          status: "frozen",
        }),
      ).rejects.toThrow("review must be approved");
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  test("runs eight shadow cases, hides scoring inputs, and records every cooldown", async () => {
    const fixture = await createLiveFixture();
    const waits: number[] = [];
    const captured: OpenAIRequestInput[] = [];
    try {
      await approveAndFreeze(fixture);
      const result = await runPilotLive({
        ...liveOptions(fixture.manifestPath),
        outputRoot: resolve(fixture.directory, "reports"),
        wait: async (milliseconds) => {
          waits.push(milliseconds);
        },
        resolve: async (input) => {
          captured.push(input);
          return fixtureResponse(
            requiredFixture(fixture, captured.length - 1),
            captured.length,
          );
        },
      });

      expect(result.report).toMatchObject({
        version: 1,
        status: "passed",
        mode: "live",
        summary: {
          total: 8,
          firstPassProjectFit: 8,
          falseResolutions: 0,
          hiddenCasesPassed: 25,
        },
        executionMetrics: {
          apiAttempts: 8,
          cooldownCompletions: 8,
          estimatedCost: 0,
        },
        safety: {
          businessWrites: 0,
          externalIo: 0,
          cooldownViolations: 0,
        },
      });
      expect(waits).toEqual(Array.from({ length: 8 }, () => 60_000));
      expect(captured).toHaveLength(8);
      const serialized = JSON.stringify(captured);
      expect(serialized).not.toContain("hiddenCases");
      expect(serialized).not.toContain("baseline");
      expect(serialized).not.toContain("expected");
      expect(
        await readFile(
          resolve(result.reportDirectory, "responses.json"),
          "utf8",
        ),
      ).toContain("fixture-response-8");
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }, 20_000);

  test("retries HTTP 429 with a cooldown after every API attempt", async () => {
    const fixture = await createLiveFixture();
    const waits: number[] = [];
    let attempts = 0;
    try {
      await approveAndFreeze(fixture);
      const result = await runPilotLive({
        ...liveOptions(fixture.manifestPath),
        outputRoot: resolve(fixture.directory, "reports"),
        maxRateLimitRetries: 1,
        wait: async (milliseconds) => {
          waits.push(milliseconds);
        },
        resolve: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("OpenAI API returned status 429");
          }
          const caseIndex = attempts - 2;
          return fixtureResponse(requiredFixture(fixture, caseIndex), attempts);
        },
      });
      expect(result.report.status).toBe("passed");
      expect(attempts).toBe(9);
      expect(waits).toEqual(Array.from({ length: 9 }, () => 60_000));
      expect(result.report.executionMetrics.cooldownCompletions).toBe(9);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }, 20_000);

  test("refuses to duplicate an uncertain pending API call", async () => {
    const fixture = await createLiveFixture();
    let calls = 0;
    try {
      await approveAndFreeze(fixture);
      const options = {
        ...liveOptions(fixture.manifestPath),
        outputRoot: resolve(fixture.directory, "reports"),
        runId: "uncertain",
        wait: async () => {},
        resolve: async () => {
          calls += 1;
          throw new Error("terminal transport failure");
        },
      };
      await expect(runPilotLive(options)).rejects.toThrow(
        "terminal transport failure",
      );
      await expect(runPilotLive(options)).rejects.toThrow(
        "uncertain pending API call",
      );
      expect(calls).toBe(1);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }, 20_000);
});

async function createLiveFixture(): Promise<{
  directory: string;
  manifestPath: string;
  caseIds: string[];
  fixtureCases: Record<string, FixtureResult>;
}> {
  const directory = await mkdtemp(
    resolve(import.meta.dir, "../pilots/.pilot-live-test-"),
  );
  await cp(sourceDirectory, directory, { recursive: true });
  const manifestPath = resolve(directory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    cases: Array<{ id: string; owner: string }>;
  };
  const caseIds = manifest.cases.map((entry) => entry.id);
  const fixtures = JSON.parse(
    await readFile(resolve(directory, "cases/fixture-results.json"), "utf8"),
  ) as { cases: Record<string, FixtureResult> };
  return {
    directory,
    manifestPath,
    caseIds,
    fixtureCases: fixtures.cases,
  };
}

async function makeReviewDraft(manifestPath: string): Promise<void> {
  const reviewPath = resolve(manifestPath, "../review.json");
  const review = JSON.parse(await readFile(reviewPath, "utf8")) as {
    status: string;
    reviewer: {
      name: string | null;
      role: string | null;
      independentFromImplementation: boolean;
    };
    reviewedAt: string | null;
  };
  review.status = "draft";
  review.reviewer = {
    name: null,
    role: null,
    independentFromImplementation: false,
  };
  review.reviewedAt = null;
  await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
}

async function approveAndFreeze(fixture: {
  manifestPath: string;
  caseIds: string[];
}): Promise<void> {
  const directory = resolve(fixture.manifestPath, "..");
  const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8")) as {
    cases: Array<{ id: string; owner: string }>;
  };
  for (const [index, pilotCase] of manifest.cases.entries()) {
    pilotCase.owner = `erp-owner-${index + 1}`;
  }
  await writeFile(
    fixture.manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  const review = {
    version: 1,
    status: "approved",
    reviewer: {
      name: "Independent ERP Reviewer",
      role: "ERP Domain Reviewer",
      independentFromImplementation: true,
    },
    reviewedAt: "2026-07-24T00:00:00.000Z",
    decisions: {
      businessDefinitionsApproved: true,
      baselinesApproved: true,
      hiddenCasesApproved: true,
      schemaChangesApproved: true,
      syntheticDataOnly: true,
      advisoryOnly: true,
      budgetApproved: true,
      stopAuthorityConfirmed: true,
      goNoGoAuthorityConfirmed: true,
    },
    cases: manifest.cases.map((entry) => ({
      caseId: entry.id,
      owner: entry.owner,
      risk: "low",
      approved: true,
    })),
  };
  await writeFile(
    resolve(directory, "review.json"),
    `${JSON.stringify(review, null, 2)}\n`,
    "utf8",
  );
  await writePilotFreeze({
    manifestPath: fixture.manifestPath,
    status: "frozen",
  });
}

function liveOptions(manifestPath: string) {
  return {
    manifestPath,
    runId: "test-run",
    model: "fixture-model",
    provider: "fixture-provider",
    costPerMillionTokens: { input: 0, output: 0 },
    cooldownMs: 60_000 as const,
    maxRateLimitRetries: 0,
  };
}

function fixtureResponse(
  fixture: FixtureResult,
  sequence: number,
): OpenAIResult {
  return {
    responseId: `fixture-response-${sequence}`,
    model: "fixture-model",
    outputText: JSON.stringify({
      outcome: fixture.outcome,
      body: fixture.body,
      diagnostics: fixture.diagnostics,
    }),
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    },
  };
}

function requiredFixture(
  fixture: {
    caseIds: string[];
    fixtureCases: Record<string, FixtureResult>;
  },
  index: number,
): FixtureResult {
  const caseId = fixture.caseIds[index];
  const result =
    caseId === undefined ? undefined : fixture.fixtureCases[caseId];
  if (result === undefined) {
    throw new Error(`Missing fixture result at index ${index}`);
  }
  return result;
}

type FixtureResult = {
  outcome: "resolved" | "unresolved" | "error";
  body: unknown;
  diagnostics: string[];
};
