import { writeFile } from "node:fs/promises";
import { readVerifiedEffectsExecutionSnapshot } from "../../src/llang-effects-bundle-inspection";
import { readEffectsRequirementContract } from "../../src/llang-effects-requirement-contract";
import { stableJson } from "../../src/stable-hash";

const [, , manifestPath, requirementsPath, outputPath] = process.argv;
if (!manifestPath || !requirementsPath || !outputPath)
  throw new Error(
    "usage: create-trust-boundary <module-build.json> <requirements.json> <output.json>",
  );
const snapshot = await readVerifiedEffectsExecutionSnapshot(manifestPath),
  requirements = await readEffectsRequirementContract(
    requirementsPath,
    snapshot.bundleIdentityHash,
    snapshot.graph,
  ),
  operations = [
    ...new Set(
      snapshot.graph.program.nodes.flatMap((node) =>
        node.kind === "task"
          ? node.tasks.map((task) => `${task.operation}@${task.version}`)
          : [`${node.operation}@${node.version}`],
      ),
    ),
  ].sort(),
  sources = operations.map((operation, index) => ({
    id: `source-${index}`,
    operation,
    responsePath: [],
    classification: "untrusted-data",
  })),
  sinks = operations.map((operation, index) => ({
    id: `sink-${index}`,
    operation,
    requestPath: [],
    classification: "external-output",
  })),
  boundary = {
    format: "llang-effects-trust-boundary",
    version: 1,
    id: "module-io-pipeline-boundary",
    revision: 1,
    requirements: {
      id: requirements.document.id,
      revision: requirements.document.revision,
      commitmentHash: requirements.commitmentHash,
    },
    sources,
    sinks,
    allowedFlows: sources
      .flatMap((source) =>
        sinks.map((sink) => ({
          source: source.id,
          sink: sink.id,
          purpose: "pipeline-processing",
        })),
      )
      .sort((left, right) =>
        `${left.source}\0${left.sink}\0${left.purpose}`.localeCompare(
          `${right.source}\0${right.sink}\0${right.purpose}`,
        ),
      ),
    rules: {
      denyUnlistedFlows: true,
      denyDataDerivedAuthority: true,
      rawExternalDataInAudit: false,
    },
  };
await writeFile(outputPath, `${stableJson(boundary)}\n`, { flag: "wx" });
console.log(
  JSON.stringify({
    ok: true,
    output: outputPath.split(/[\\/]/).at(-1),
    sources: sources.length,
    sinks: sinks.length,
  }),
);
