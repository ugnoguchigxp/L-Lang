import { resolve } from "node:path";

import { relativeSchemaEvolutionReportPath } from "./schema-evolution-benchmark";
import { runSchemaEvolutionV2 } from "./schema-evolution-v2";
import {
  callOpenAI,
  DEFAULT_OPENAI_MODEL,
  resolveOpenAIConnection,
} from "./openai";

async function main(): Promise<void> {
  const workspaceRoot = process.cwd();
  const manifestPath = resolve(
    Bun.argv[2] ?? "benchmarks/schema-evolution-v2/benchmark.json",
  );
  const model = process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
  const connection = resolveOpenAIConnection({
    apiKey: process.env.OPENAI_API_KEY ?? "",
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  });
  const { report, runDirectory, authoritativeManifestSha256 } =
    await runSchemaEvolutionV2({
      manifestPath,
      workspaceRoot,
      outputRoot: resolve(workspaceRoot, ".semantic/benchmarks/schema-evolution-v2"),
      provider: connection.provider,
      model,
      resolve: async (input) => {
        if (connection.apiKey.length === 0) throw new Error("OPENAI_API_KEY is required");
        return callOpenAI(input, connection);
      },
      requireHumanReview: true,
      onProgress: (message) => console.log(message),
    });
  console.log([
    "schema evolution v2 benchmark completed",
    `status: ${report.status}`,
    `provider/model: ${report.provider}/${report.model}`,
    `single first-pass: ${percent(report.summary.firstPassCaseRate)}`,
    `consensus pass: ${percent(report.summary.consensusCasePassRate)}`,
    `consensus quorum: ${percent(report.summary.consensusQuorumRate)}`,
    `consensus false-resolution: ${percent(report.summary.consensusFalseResolutionRate)}`,
    `workspace mutations: ${report.summary.workspaceMutationCount}`,
    `frozen manifest sha256: ${authoritativeManifestSha256}`,
    `report: ${relativeSchemaEvolutionReportPath(workspaceRoot, resolve(runDirectory, "report.md"))}`,
    `json: ${relativeSchemaEvolutionReportPath(workspaceRoot, resolve(runDirectory, "report.json"))}`,
  ].join("\n"));
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
