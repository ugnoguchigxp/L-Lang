import { resolve } from "node:path";
import { atomicWriteJson } from "./atomic-file";
import {
  COLLECTION_DIFFERENTIAL_DEFAULT_SEED,
  CollectionDifferentialMismatch,
  CollectionDifferentialRunnerError,
  runCollectionDifferential,
} from "./llang-collection-differential";

export type CollectionDifferentialCliOptions = Readonly<{
  seed: number;
  cases: number;
  startCase: number;
  inputIndex?: number;
  failureOut?: string;
}>;

type CollectionDifferentialCliResult = Readonly<{
  exitCode: 0 | 1 | 2;
  stream: "stdout" | "stderr";
  value: Readonly<Record<string, unknown>>;
}>;

type CollectionDifferentialRunner = typeof runCollectionDifferential;
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

export function parseCollectionDifferentialOptions(
  args: readonly string[],
): CollectionDifferentialCliOptions {
  let seed = COLLECTION_DIFFERENTIAL_DEFAULT_SEED,
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

async function saveFailure(
  failureOut: string | undefined,
  reproduction: object,
): Promise<
  Readonly<{ ok: true; path?: string }> | Readonly<{ ok: false; error: string }>
> {
  if (!failureOut) return { ok: true };
  const path = resolve(failureOut);
  try {
    await atomicWriteJson(path, reproduction);
    return { ok: true, path };
  } catch (error) {
    return {
      ok: false,
      error: `failed to write reproduction: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function runCollectionDifferentialCli(
  args: readonly string[],
  runner: CollectionDifferentialRunner = runCollectionDifferential,
): Promise<CollectionDifferentialCliResult> {
  let parsed: CollectionDifferentialCliOptions | undefined;
  try {
    parsed = parseCollectionDifferentialOptions(args);
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
    if (
      error instanceof CollectionDifferentialMismatch ||
      error instanceof CollectionDifferentialRunnerError
    ) {
      const saved = await saveFailure(parsed?.failureOut, error.reproduction);
      if (!saved.ok)
        return {
          exitCode: 2,
          stream: "stderr",
          value: {
            status: "error",
            error: saved.error,
            reproduction: error.reproduction,
          },
        };
      if (error instanceof CollectionDifferentialMismatch)
        return {
          exitCode: 1,
          stream: "stderr",
          value: {
            status: "mismatch",
            reproduction: error.reproduction,
            ...(saved.path ? { failureOut: saved.path } : {}),
          },
        };
      return {
        exitCode: 2,
        stream: "stderr",
        value: {
          status: "error",
          error: error.message,
          reproduction: error.reproduction,
          ...(saved.path ? { failureOut: saved.path } : {}),
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
  const result = await runCollectionDifferentialCli(process.argv.slice(2));
  const line = JSON.stringify(result.value);
  if (result.stream === "stdout") console.log(line);
  else console.error(line);
  process.exitCode = result.exitCode;
}
