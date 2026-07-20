import { resolve } from "node:path";

import {
  relativeReportPath,
  runCrossSchemaBenchmark,
} from "./cross-schema-benchmark";
import {
  callOpenAI,
  DEFAULT_OPENAI_MODEL,
  resolveOpenAIConnection,
} from "./openai";

async function main(): Promise<void> {
  const workspaceRoot = process.cwd();
  const manifestPath = resolve(
    Bun.argv[2] ?? "benchmarks/cross-schema/benchmark.json",
  );
  const model = process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
  const connection = resolveOpenAIConnection({
    apiKey: process.env.OPENAI_API_KEY ?? "",
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  });

  if (connection.apiKey.length === 0) {
    throw new Error("OPENAI_API_KEY is required");
  }

  const { report, runDirectory } = await runCrossSchemaBenchmark({
    manifestPath,
    outputRoot: resolve(workspaceRoot, ".semantic/benchmarks"),
    model,
    provider: connection.provider,
    resolve: (input) => callOpenAI(input, connection),
    onProgress: (message) => console.log(message),
  });

  console.log(
    [
      "cross-schema benchmark completed",
      `status: ${report.status}`,
      `provider/model: ${report.provider}/${report.model}`,
      `trials: ${report.protocol.totalTrials}`,
      `trial pass rate: ${percent(report.summary.trialPassRate)}`,
      `first-pass case rate: ${percent(report.summary.firstPassCaseRate)}`,
      `stable case rate: ${percent(report.summary.stableCaseRate)}`,
      `false-resolution rate: ${percent(report.summary.falseResolutionRate)}`,
      `hidden-test pass rate: ${percent(report.summary.hiddenTestPassRate)}`,
      `human time: ${report.humanTimeComparison.status}`,
      `report: ${relativeReportPath(workspaceRoot, resolve(runDirectory, "report.md"))}`,
      `json: ${relativeReportPath(workspaceRoot, resolve(runDirectory, "report.json"))}`,
    ].join("\n"),
  );
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
