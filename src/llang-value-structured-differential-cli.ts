import { resolve } from "node:path";
import { atomicWriteJson } from "./atomic-file";
import {
  runValueStructuredDifferential,
  VALUE_STRUCTURED_DIFFERENTIAL_DEFAULT_SEED,
  ValueStructuredDifferentialMismatch,
  ValueStructuredDifferentialRunnerError,
} from "./llang-value-structured-differential";

export type ValueStructuredDifferentialCliOptions = Readonly<{
  seed: number;
  cases: number;
  startCase: number;
  inputIndex?: number;
  failureOut?: string;
}>;

type ValueStructuredDifferentialCliResult = Readonly<{
  exitCode: 0 | 1 | 2;
  stream: "stdout" | "stderr";
  value: Readonly<Record<string, unknown>>;
}>;

type StructuredDifferentialRunner = typeof runValueStructuredDifferential;
const OPTIONS = new Set([
  "--seed",
  "--cases",
  "--start-case",
  "--input-index",
  "--failure-out",
]);

function optionValue(
  args: readonly string[],
  index: number,
  name: string,
): string {
  const value = args[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

function integer(value: string, name: string): number {
  if (!/^\d+$/u.test(value))
    throw new Error(`${name} requires a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is too large`);
  return parsed;
}

export function parseValueStructuredDifferentialOptions(
  args: readonly string[],
): ValueStructuredDifferentialCliOptions {
  let seed = VALUE_STRUCTURED_DIFFERENTIAL_DEFAULT_SEED,
    cases = 64,
    startCase = 0,
    inputIndex: number | undefined,
    failureOut: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (!option?.startsWith("--"))
      throw new Error(`unexpected positional argument ${String(option)}`);
    if (!OPTIONS.has(option)) throw new Error(`unknown option ${option}`);
    if (seen.has(option)) throw new Error(`duplicate option ${option}`);
    seen.add(option);
    const value = optionValue(args, index, option);
    index++;
    if (option === "--seed") seed = integer(value, option);
    else if (option === "--cases") cases = integer(value, option);
    else if (option === "--start-case") startCase = integer(value, option);
    else if (option === "--input-index") inputIndex = integer(value, option);
    else failureOut = value;
  }
  if (seed > 0xffff_ffff) throw new Error("--seed must be a uint32");
  if (cases < 1 || cases > 512)
    throw new Error("--cases must be between 1 and 512");
  if (startCase > 0xffff_ffff || startCase + cases - 1 > 0xffff_ffff)
    throw new Error("--start-case range must fit uint32");
  if (inputIndex !== undefined && inputIndex > 7)
    throw new Error("--input-index must be between 0 and 7");
  if (inputIndex !== undefined && cases !== 1)
    throw new Error("--input-index requires --cases 1");
  return {
    seed,
    cases,
    startCase,
    ...(inputIndex === undefined ? {} : { inputIndex }),
    ...(failureOut === undefined ? {} : { failureOut }),
  };
}

export async function runValueStructuredDifferentialCli(
  args: readonly string[],
  runner: StructuredDifferentialRunner = runValueStructuredDifferential,
): Promise<ValueStructuredDifferentialCliResult> {
  let parsed: ValueStructuredDifferentialCliOptions | undefined;
  try {
    parsed = parseValueStructuredDifferentialOptions(args);
    const result = await runner({
      seed: parsed.seed,
      cases: parsed.cases,
      startCase: parsed.startCase,
      ...(parsed.inputIndex === undefined
        ? {}
        : { inputIndex: parsed.inputIndex }),
    });
    return {
      exitCode: 0,
      stream: "stdout",
      value: { status: "pass", ...result },
    };
  } catch (error) {
    if (error instanceof ValueStructuredDifferentialMismatch) {
      const failureOut = parsed?.failureOut
        ? resolve(parsed.failureOut)
        : undefined;
      if (failureOut) {
        try {
          await atomicWriteJson(failureOut, error.reproduction);
        } catch (writeError) {
          return {
            exitCode: 2,
            stream: "stderr",
            value: {
              status: "error",
              error: `failed to write reproduction: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
              reproduction: error.reproduction,
            },
          };
        }
      }
      return {
        exitCode: 1,
        stream: "stderr",
        value: {
          status: "mismatch",
          reproduction: error.reproduction,
          ...(failureOut ? { failureOut } : {}),
        },
      };
    }
    if (error instanceof ValueStructuredDifferentialRunnerError) {
      const failureOut = parsed?.failureOut
        ? resolve(parsed.failureOut)
        : undefined;
      if (failureOut) {
        try {
          await atomicWriteJson(failureOut, error.reproduction);
        } catch (writeError) {
          return {
            exitCode: 2,
            stream: "stderr",
            value: {
              status: "error",
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
          error: error.message,
          reproduction: error.reproduction,
          ...(failureOut ? { failureOut } : {}),
        },
      };
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
  const result = await runValueStructuredDifferentialCli(process.argv.slice(2));
  const line = JSON.stringify(result.value);
  if (result.stream === "stdout") console.log(line);
  else console.error(line);
  process.exitCode = result.exitCode;
}
