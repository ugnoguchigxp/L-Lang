import { resolve } from "node:path";

import { aggregatePilotConsensus } from "./pilot-consensus";

const [manifestPath, sampleOne, sampleTwo, sampleThree, outputDirectory] =
  process.argv.slice(2);

if (
  manifestPath === undefined ||
  sampleOne === undefined ||
  sampleTwo === undefined ||
  sampleThree === undefined ||
  outputDirectory === undefined
) {
  throw new Error(
    "usage: bun run src/pilot-consensus-cli.ts <manifest> <sample-1-dir> <sample-2-dir> <sample-3-dir> <output-dir>",
  );
}

const result = await aggregatePilotConsensus({
  manifestPath: resolve(manifestPath),
  sampleDirectories: [
    resolve(sampleOne),
    resolve(sampleTwo),
    resolve(sampleThree),
  ],
  outputDirectory: resolve(outputDirectory),
});

console.log(
  [
    `pilot consensus ${result.report.status}`,
    `quorum: ${result.report.summary.quorumReached}/${result.report.summary.cases}`,
    `hidden cases: ${result.report.summary.hiddenCasesPassed}/${result.report.summary.hiddenCases}`,
    `false resolutions: ${result.report.summary.falseResolutions}`,
    `API attempts/cooldowns: ${result.report.summary.apiAttempts}/${result.report.summary.cooldownCompletions}`,
    `estimated cost: ${result.report.summary.estimatedCost}`,
    `report: ${result.reportPath}`,
  ].join("\n"),
);

if (result.report.status !== "passed") {
  process.exitCode = 2;
}
