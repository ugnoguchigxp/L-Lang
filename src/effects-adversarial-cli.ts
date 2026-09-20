import { resolve } from "node:path";

import {
  analyzeEffectsResultPackage,
  fixtureEffectsBenchmark,
  planEffectsBenchmark,
  reproduceEffectsResultPackage,
  runEffectsBenchmark,
  verifyEffectsResultPackage,
} from "./effects-adversarial-benchmark";
import {
  readEffectsAdversarialStudy,
  verifyEffectsStudyFreeze,
  writeEffectsStudyFreeze,
} from "./effects-adversarial-study";
import { fingerprintFor } from "./stable-hash";

export function parseEffectsBenchmarkCliFlags(
  flags: readonly string[],
  valueFlags: readonly string[],
  booleanFlags: readonly string[] = [],
) {
  const values: Record<string, string> = {};
  const booleans = new Set<string>();
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index] as string;
    if (valueFlags.includes(flag)) {
      if (flag in values) throw new Error(`duplicate option: ${flag}`);
      const value = flags[index + 1];
      if (!value || value.startsWith("--"))
        throw new Error(`${flag} requires a value`);
      values[flag] = value;
      index += 1;
    } else if (booleanFlags.includes(flag)) {
      if (booleans.has(flag)) throw new Error(`duplicate option: ${flag}`);
      booleans.add(flag);
    } else {
      throw new Error(`unknown option: ${flag}`);
    }
  }
  return Object.freeze({ values: Object.freeze(values), booleans });
}

function requiredOption(
  values: Readonly<Record<string, string>>,
  name: string,
) {
  const value = values[name];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

async function main() {
  const [command, target, ...flags] = Bun.argv.slice(2);
  if (!command || !target)
    throw new Error(
      "usage: effects:benchmark <validate|plan|fixture|freeze|run|analyze|verify|reproduce> <path> [--out-dir path]",
    );
  if (command === "validate") {
    parseEffectsBenchmarkCliFlags(flags, []);
    const study = await readEffectsAdversarialStudy(resolve(target));
    const result = await verifyEffectsStudyFreeze(study.path);
    console.log(
      JSON.stringify({
        status: "valid",
        studyId: study.document.id,
        studyHash: study.studyHash,
        freezeHash: result.freeze.freezeHash,
        evidenceEligible: result.freeze.evidenceEligible,
      }),
    );
    return;
  }
  if (command === "plan") {
    parseEffectsBenchmarkCliFlags(flags, []);
    console.log(JSON.stringify(await planEffectsBenchmark(resolve(target))));
    return;
  }
  if (command === "freeze") {
    const parsed = parseEffectsBenchmarkCliFlags(
      flags,
      ["--out", "--review", "--external-timestamp"],
      ["--owner-run-approval"],
    );
    const output = parsed.values["--out"]
      ? resolve(parsed.values["--out"])
      : undefined;
    console.log(
      JSON.stringify(
        await writeEffectsStudyFreeze(resolve(target), output, {
          ...(parsed.values["--review"]
            ? { reviewPath: resolve(parsed.values["--review"]) }
            : {}),
          ...(parsed.values["--external-timestamp"]
            ? { externalTimestamp: parsed.values["--external-timestamp"] }
            : {}),
          ownerRunApproval: parsed.booleans.has("--owner-run-approval"),
        }),
      ),
    );
    return;
  }
  if (command === "fixture" || command === "run") {
    const parsed = parseEffectsBenchmarkCliFlags(
      flags,
      ["--out-dir"],
      command === "run" ? ["--resume"] : [],
    );
    const input = {
      studyPath: resolve(target),
      outputDirectory: resolve(requiredOption(parsed.values, "--out-dir")),
      resume: parsed.booleans.has("--resume"),
    };
    const result =
      command === "fixture"
        ? await fixtureEffectsBenchmark(input)
        : await runEffectsBenchmark(input);
    console.log(
      JSON.stringify({
        status: "complete",
        outputDirectory: result.outputDirectory,
        resultHash: result.resultPackage.resultHash,
        trials: result.resultPackage.observations.length,
        evidenceEligible: result.resultPackage.evidenceEligible,
        apiCalls: 0,
      }),
    );
    return;
  }
  if (command === "analyze") {
    parseEffectsBenchmarkCliFlags(flags, []);
    const result = await analyzeEffectsResultPackage(resolve(target));
    console.log(
      JSON.stringify({
        status: "analyzed",
        resultPath: result.resultPath,
        analysisHash: fingerprintFor(result.analysis),
        evidenceEligible: result.analysis.evidenceEligible,
      }),
    );
    return;
  }
  if (command === "verify") {
    const parsed = parseEffectsBenchmarkCliFlags(flags, ["--freeze"]);
    console.log(
      JSON.stringify(
        await verifyEffectsResultPackage(
          resolve(target),
          parsed.values["--freeze"]
            ? resolve(parsed.values["--freeze"])
            : undefined,
        ),
      ),
    );
    return;
  }
  if (command === "reproduce") {
    const parsed = parseEffectsBenchmarkCliFlags(flags, [
      "--out-dir",
      "--freeze",
    ]);
    console.log(
      JSON.stringify(
        await reproduceEffectsResultPackage({
          packagePath: resolve(target),
          outputDirectory: resolve(requiredOption(parsed.values, "--out-dir")),
          ...(parsed.values["--freeze"]
            ? { externalFreezePath: resolve(parsed.values["--freeze"]) }
            : {}),
        }),
      ),
    );
    return;
  }
  throw new Error(`unknown effects benchmark command: ${command}`);
}

if (import.meta.main)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
