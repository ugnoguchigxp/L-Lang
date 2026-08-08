import {
  loadStaticJudgmentBenchmark,
  renderStaticJudgmentBenchmarkReport,
  runStaticJudgmentFixtureBenchmark,
} from "./static-judgment-benchmark";

export type StaticJudgmentBenchmarkCliArguments = {
  command: "fixture";
  manifestPath: string;
  json: boolean;
};

export function parseStaticJudgmentBenchmarkCliArguments(
  argv: readonly string[],
): StaticJudgmentBenchmarkCliArguments {
  const [command, manifestPath, ...options] = argv;
  if (command !== "fixture" || manifestPath === undefined) {
    throw new Error(
      "usage: static-judgment-benchmark fixture <manifest> [--json]",
    );
  }
  if (options.length > 1 || (options.length === 1 && options[0] !== "--json")) {
    throw new Error(`fixture does not accept ${options.join(" ")}`);
  }
  return {
    command,
    manifestPath,
    json: options[0] === "--json",
  };
}

export async function runStaticJudgmentBenchmarkCli(
  argv: readonly string[],
): Promise<number> {
  const arguments_ = parseStaticJudgmentBenchmarkCliArguments(argv);
  const protocol = await loadStaticJudgmentBenchmark(arguments_.manifestPath);
  const report = await runStaticJudgmentFixtureBenchmark(protocol);
  process.stdout.write(
    arguments_.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${renderStaticJudgmentBenchmarkReport(report)}\n`,
  );
  return report.status === "passed" ? 0 : 2;
}

if (import.meta.main) {
  try {
    process.exitCode = await runStaticJudgmentBenchmarkCli(
      process.argv.slice(2),
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
