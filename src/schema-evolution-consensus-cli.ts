import { resolve } from "node:path";

import { replaySchemaEvolutionConsensus } from "./schema-evolution-consensus";

async function main(): Promise<void> {
  const sourceReport = Bun.argv[2];
  if (sourceReport === undefined) {
    throw new Error(
      "Usage: bun run consensus:replay <schema-evolution-report.json>",
    );
  }
  const workspaceRoot = process.cwd();
  const { report, outputDirectory } = await replaySchemaEvolutionConsensus({
    sourceReportPath: resolve(sourceReport),
    manifestPath: resolve("benchmarks/schema-evolution/benchmark.json"),
    outputRoot: resolve(
      workspaceRoot,
      ".semantic/benchmarks/schema-evolution-consensus",
    ),
    quorum: 2,
  });
  console.log(
    [
      "schema evolution consensus replay completed",
      `status: ${report.status}`,
      `cases: ${report.summary.passedCases}/${report.summary.cases}`,
      `quorum: ${report.summary.casesWithQuorum}/${report.summary.cases}`,
      `false resolutions: ${report.summary.falseResolutionCount}`,
      `rescued: ${report.summary.rescuedCases.join(", ") || "none"}`,
      `source unchanged: ${report.summary.sourceReportUnchanged}`,
      `report: ${resolve(outputDirectory, "report.md")}`,
      `json: ${resolve(outputDirectory, "report.json")}`,
    ].join("\n"),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
