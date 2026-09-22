import { resolve } from "node:path";
import { atomicWriteJson } from "./atomic-file";
import {
  EFFECTS_TRACE_DIFFERENTIAL_DEFAULT_SEED,
  EffectsTraceMismatch,
  EffectsTraceRunnerError,
  runEffectsTraceDifferential,
} from "./llang-effects-trace-differential";

export type EffectsTraceCliOptions = Readonly<{
  seed: number;
  cases: number;
  startCase: number;
  scenarioIndex?: number;
  failureOut?: string;
}>;

type CliResult = Readonly<{
  exitCode: 0 | 1 | 2;
  stream: "stdout" | "stderr";
  value: Readonly<Record<string, unknown>>;
}>;

const OPTIONS = new Set([
  "--seed",
  "--cases",
  "--start-case",
  "--scenario-index",
  "--failure-out",
]);

function valueAt(args: readonly string[], index: number, name: string) {
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

function integer(value: string, name: string) {
  if (!/^\d+$/u.test(value))
    throw new Error(`${name} requires a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is too large`);
  return parsed;
}

export function parseEffectsTraceOptions(
  args: readonly string[],
): EffectsTraceCliOptions {
  let seed = EFFECTS_TRACE_DIFFERENTIAL_DEFAULT_SEED,
    cases = 64,
    startCase = 0,
    scenarioIndex: number | undefined,
    failureOut: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (!option?.startsWith("--"))
      throw new Error(`unexpected positional argument ${String(option)}`);
    if (!OPTIONS.has(option)) throw new Error(`unknown option ${option}`);
    if (seen.has(option)) throw new Error(`duplicate option ${option}`);
    seen.add(option);
    const value = valueAt(args, index, option);
    index++;
    if (option === "--seed") seed = integer(value, option);
    else if (option === "--cases") cases = integer(value, option);
    else if (option === "--start-case") startCase = integer(value, option);
    else if (option === "--scenario-index")
      scenarioIndex = integer(value, option);
    else failureOut = value;
  }
  if (seed > 0xffff_ffff) throw new Error("--seed must be a uint32");
  if (cases < 1 || cases > 512)
    throw new Error("--cases must be between 1 and 512");
  if (startCase > 0xffff_ffff || startCase + cases - 1 > 0xffff_ffff)
    throw new Error("--start-case range must fit uint32");
  if (scenarioIndex !== undefined && scenarioIndex > 7)
    throw new Error("--scenario-index must be between 0 and 7");
  if (scenarioIndex !== undefined && cases !== 1)
    throw new Error("--scenario-index requires --cases 1");
  return {
    seed,
    cases,
    startCase,
    ...(scenarioIndex === undefined ? {} : { scenarioIndex }),
    ...(failureOut === undefined ? {} : { failureOut }),
  };
}

async function saveFailure(path: string | undefined, value: object) {
  if (!path) return undefined;
  const absolute = resolve(path);
  await atomicWriteJson(absolute, value);
  return absolute;
}

export async function runEffectsTraceCli(
  args: readonly string[],
  runner = runEffectsTraceDifferential,
): Promise<CliResult> {
  let options: EffectsTraceCliOptions | undefined;
  try {
    options = parseEffectsTraceOptions(args);
    const result = await runner(options);
    return {
      exitCode: 0,
      stream: "stdout",
      value: { status: "pass", ...result },
    };
  } catch (error) {
    if (
      error instanceof EffectsTraceMismatch ||
      error instanceof EffectsTraceRunnerError
    ) {
      try {
        const failureOut = await saveFailure(
          options?.failureOut,
          error.reproduction,
        );
        return {
          exitCode: error instanceof EffectsTraceMismatch ? 1 : 2,
          stream: "stderr",
          value: {
            status:
              error instanceof EffectsTraceMismatch ? "mismatch" : "error",
            reproduction: error.reproduction,
            ...(failureOut ? { failureOut } : {}),
          },
        };
      } catch (writeError) {
        return {
          exitCode: 2,
          stream: "stderr",
          value: {
            status: "error",
            stage: "artifact-write",
            error: `failed to write reproduction: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
            reproduction: error.reproduction,
          },
        };
      }
    }
    return {
      exitCode: 2,
      stream: "stderr",
      value: {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

if (import.meta.main) {
  const result = await runEffectsTraceCli(process.argv.slice(2)),
    line = JSON.stringify(result.value);
  if (result.stream === "stdout") console.log(line);
  else console.error(line);
  process.exitCode = result.exitCode;
}
