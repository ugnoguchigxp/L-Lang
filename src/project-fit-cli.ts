import { resolve } from "node:path";

import {
  callOpenAI,
  DEFAULT_OPENAI_MODEL,
  resolveOpenAIConnection,
} from "./openai";
import { runProjectFitLive } from "./project-fit-live";
import { runProjectFitFixture } from "./project-fit-runner";

const [command, manifestPath] = process.argv.slice(2);

if (
  (command !== "fixture" && command !== "benchmark") ||
  manifestPath === undefined
) {
  throw new Error(
    "usage: bun run src/project-fit-cli.ts <fixture|benchmark> <benchmark.json>",
  );
}

const result =
  command === "fixture"
    ? await runProjectFitFixture({
        manifestPath: resolve(manifestPath),
      })
    : await runLive(resolve(manifestPath));

console.log(
  [
    `project fit ${result.report.status}`,
    `benchmark: ${result.report.benchmark}`,
    `freeze: ${result.report.authoritativeInput.freezeStatus}`,
    ...(["initial", "schemaChange"] as const).flatMap((stage) => {
      const summary = result.report.stages[stage];
      return [
        `${stage} type-only first-pass: ${summary.arms.typeOnly.firstPassProjectFit}/${summary.arms.typeOnly.trials}`,
        `${stage} project-context first-pass: ${summary.arms.projectContext.firstPassProjectFit}/${summary.arms.projectContext.trials}`,
      ];
    }),
    `false resolutions: ${result.report.safety.falseResolutions}`,
    `workspace mutations: ${result.report.safety.workspaceMutations}`,
    ...(result.report.gateC === undefined
      ? []
      : [`gate C: ${result.report.gateC.passed ? "passed" : "failed"}`]),
    `report: ${result.reportDirectory}`,
  ].join("\n"),
);

if (
  (command === "fixture" && result.report.status !== "fixture-passed") ||
  (command === "benchmark" && result.report.status !== "passed")
) {
  process.exitCode = 2;
}

async function runLive(manifest: string) {
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  if (apiKey.length === 0) {
    throw new Error(
      "OPENAI_API_KEY is required for the frozen Project Fit benchmark",
    );
  }
  const connection = resolveOpenAIConnection({
    apiKey,
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  });
  const model = process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
  const costPerMillionTokens = {
    input: tokenRate("OPENAI_INPUT_COST_PER_MILLION_TOKENS"),
    output: tokenRate("OPENAI_OUTPUT_COST_PER_MILLION_TOKENS"),
  };
  return runProjectFitLive({
    manifestPath: manifest,
    model,
    provider: connection.provider,
    costPerMillionTokens,
    resolve: (input) => callOpenAI(input, connection),
    cooldownMs: 60_000,
    maxRateLimitRetries: 5,
    onProgress: (message) => console.log(message),
  });
}

function tokenRate(name: string): number {
  const raw = process.env[name];
  const value = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `${name} must be set to a non-negative USD cost per million tokens`,
    );
  }
  return value;
}
