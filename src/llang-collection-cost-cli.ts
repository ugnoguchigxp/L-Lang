import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, release } from "node:os";
import { dirname, resolve } from "node:path";
import {
  deterministicCollectionCost,
  measureCollectionCost,
} from "./llang-collection-cost";
import { loadCollectionModuleProgram } from "./llang-module-collection-loader";
import { stableJson } from "./stable-hash";

type Configuration = {
  entry: string;
  root: string;
  entryName: string;
  input: unknown;
  protocol: { warmup: number; repetitions: number; order: "single-baseline" };
};
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

const [configurationPath, outputPath, mode, verifyFlag, expectedPath] =
  process.argv.slice(2);
if (
  !configurationPath ||
  !outputPath ||
  (mode !== undefined && mode !== "--deterministic") ||
  (verifyFlag !== undefined && verifyFlag !== "--verify") ||
  (verifyFlag === "--verify" && !expectedPath) ||
  process.argv.slice(2).length > 5
)
  throw new Error(
    "usage: llang-collection-cost-cli <benchmark.json> <output.json> [--deterministic [--verify <expected.json>]]",
  );
const configuration = JSON.parse(
  await readFile(resolve(configurationPath), "utf8"),
) as Configuration;
if (
  !configuration ||
  typeof configuration !== "object" ||
  Array.isArray(configuration) ||
  Object.keys(configuration).sort().join(",") !==
    "entry,entryName,input,protocol,root" ||
  typeof configuration.entry !== "string" ||
  typeof configuration.root !== "string" ||
  typeof configuration.entryName !== "string" ||
  !Object.hasOwn(configuration, "input") ||
  !configuration.protocol ||
  typeof configuration.protocol !== "object" ||
  Array.isArray(configuration.protocol) ||
  Object.keys(configuration.protocol).sort().join(",") !==
    "order,repetitions,warmup" ||
  !Number.isSafeInteger(configuration.protocol.warmup) ||
  configuration.protocol.warmup < 0 ||
  !Number.isSafeInteger(configuration.protocol.repetitions) ||
  configuration.protocol.repetitions < 1 ||
  configuration.protocol.order !== "single-baseline"
)
  throw new Error("invalid collection cost configuration");
const program = await loadCollectionModuleProgram(
  configuration.entry,
  configuration.root,
  configuration.entryName,
);
let output: unknown;
if (mode === "--deterministic")
  output = deterministicCollectionCost(
    measureCollectionCost(program, configuration.input),
  );
else {
  for (let index = 0; index < configuration.protocol.warmup; index++)
    measureCollectionCost(program, configuration.input);
  const observations = Array.from(
      { length: configuration.protocol.repetitions },
      () => measureCollectionCost(program, configuration.input),
    ),
    timingKeys = [
      "build",
      "instantiate",
      "encode",
      "hostValidation",
      "wasmValidation",
      "kernel",
      "decode",
      "endToEnd",
    ] as const;
  const first = observations[0];
  if (!first) throw new Error("collection timing produced no observations");
  output = {
    format: "llang-collection-timing-observation",
    version: 1,
    protocol: configuration.protocol,
    environment: {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      osRelease: release(),
      cpu: cpus()[0]?.model ?? "unknown",
    },
    deterministic: deterministicCollectionCost(first),
    samples: observations.map((item) => ({
      timingMs: item.timingMs,
      memory: item.memory,
    })),
    medianTimingMs: Object.fromEntries(
      timingKeys.map((key) => [
        key,
        median(observations.map((item) => item.timingMs[key])),
      ]),
    ),
  };
}
const destination = resolve(outputPath);
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(output, null, 2)}\n`);
if (verifyFlag === "--verify") {
  if (!expectedPath) throw new Error("--verify requires an expected JSON path");
  const expected = JSON.parse(await readFile(resolve(expectedPath), "utf8"));
  if (stableJson(output) !== stableJson(expected))
    throw new Error("collection cost observation does not match expected JSON");
  console.log(`verified ${resolve(expectedPath)}`);
}
console.log(destination);
