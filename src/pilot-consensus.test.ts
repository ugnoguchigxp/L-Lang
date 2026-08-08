import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { aggregatePilotConsensus } from "./pilot-consensus";
import { readPilotProtocol } from "./pilot-manifest";

const manifestPath = resolve(
  import.meta.dir,
  "../pilots/erp-crud-v1/schema-evolution-manifest.json",
);

describe("ERP Pilot Schema Evolution consensus", () => {
  test("selects a type-aware two-of-three majority and scores hidden cases", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "l-lang-pilot-consensus-"));
    try {
      const protocol = await readPilotProtocol(manifestPath);
      const fixture = JSON.parse(
        await readFile(
          resolve(
            protocol.directory,
            "cases/schema-change-fixture-results.json",
          ),
          "utf8",
        ),
      ) as {
        cases: Record<
          string,
          { outcome: string; body: unknown; diagnostics: string[] }
        >;
      };
      const sampleDirectories = await Promise.all(
        [1, 2, 3].map((sample) =>
          writeSample(
            root,
            sample,
            protocol.manifestHash,
            protocol.manifest.cases.map((entry) => ({
              caseId: entry.id,
              fixture: fixture.cases[entry.id],
            })),
          ),
        ),
      );
      const [sampleOne, sampleTwo, sampleThree] = sampleDirectories;
      if (
        sampleOne === undefined ||
        sampleTwo === undefined ||
        sampleThree === undefined
      ) {
        throw new Error("Expected exactly three consensus samples");
      }
      const result = await aggregatePilotConsensus({
        manifestPath,
        sampleDirectories: [sampleOne, sampleTwo, sampleThree],
        outputDirectory: resolve(root, "consensus"),
      });
      expect(result.report).toMatchObject({
        status: "passed",
        samples: 3,
        quorum: 2,
        summary: {
          cases: 8,
          quorumReached: 8,
          hiddenCasesPassed: 16,
          falseResolutions: 0,
          apiAttempts: 24,
          cooldownCompletions: 24,
        },
      });
      expect(
        result.report.cases.every(
          (entry) => entry.supportingSamples.length === 3,
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});

async function writeSample(
  root: string,
  sample: number,
  manifestHash: string,
  cases: Array<{
    caseId: string;
    fixture:
      | { outcome: string; body: unknown; diagnostics: string[] }
      | undefined;
  }>,
): Promise<string> {
  const directory = resolve(root, `sample-${sample}`);
  await mkdir(directory, { recursive: true });
  const responses = cases.map(({ caseId, fixture }, index) => {
    if (fixture === undefined) {
      throw new Error(`Missing consensus fixture for ${caseId}`);
    }
    return {
      caseId,
      status: "completed",
      response: {
        responseId: `response-${sample}-${index}`,
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
      },
      latencyMs: 10,
    };
  });
  await Promise.all([
    writeFile(
      resolve(directory, "report.json"),
      `${JSON.stringify(
        {
          version: 1,
          status: "passed",
          mode: "live",
          authoritativeInput: {
            manifestHash,
            freezeStatus: "frozen",
          },
          executionMetrics: {
            apiAttempts: 8,
            cooldownCompletions: 8,
            estimatedCost: 0,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
    writeFile(
      resolve(directory, "responses.json"),
      `${JSON.stringify(responses, null, 2)}\n`,
      "utf8",
    ),
  ]);
  return directory;
}
