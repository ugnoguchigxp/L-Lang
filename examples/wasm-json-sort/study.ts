import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Optimization } from "./compiler";
import type { run } from "./run";
import { analyzeSelection, selectionFunction } from "./selection-analysis";

type Report = Awaited<ReturnType<typeof run>>;
interface Experiment {
  id: string;
  args: string[];
}

export function optimizationExperiments(): Experiment[] {
  const presets: Optimization[] = ["none", "legacy", "O2", "O3"];
  return ["forward", "reverse"].flatMap((order) =>
    (order === "forward" ? presets : [...presets].reverse()).map((preset) => ({
      id: `${order}-${preset}`,
      args: ["--optimization", preset, "--job-order", order],
    })),
  );
}

export function selectionExperiments(): Experiment[] {
  const variants = [
    { id: "none", args: ["--optimization", "none"] },
    { id: "O2", args: ["--optimization", "O2"] },
    {
      id: "O2-branch",
      args: ["--optimization", "O2", "--selection-branch", "true"],
    },
    { id: "O3", args: ["--optimization", "O3"] },
    {
      id: "O3-branch",
      args: ["--optimization", "O3", "--selection-branch", "true"],
    },
  ];
  return ["forward", "reverse"].flatMap((order) =>
    (order === "forward" ? variants : [...variants].reverse()).map(
      (variant) => ({
        id: `${order}-${variant.id}`,
        args: [
          ...variant.args,
          "--key",
          "age",
          "--algorithm",
          "selection",
          "--job-order",
          order,
        ],
      }),
    ),
  );
}

export function scalingExperiments(): Experiment[] {
  const variants = [
    {
      id: "selection-none",
      args: ["--algorithm", "selection", "--optimization", "none"],
    },
    {
      id: "selection-O3",
      args: ["--algorithm", "selection", "--optimization", "O3"],
    },
    {
      id: "selection-O3-branch",
      args: [
        "--algorithm",
        "selection",
        "--optimization",
        "O3",
        "--selection-branch",
        "true",
      ],
    },
    {
      id: "heap-none",
      args: ["--algorithm", "heap", "--optimization", "none"],
    },
    { id: "heap-O3", args: ["--algorithm", "heap", "--optimization", "O3"] },
  ];
  const sizes = [710, 3550, 7100];
  return ["forward", "reverse"].flatMap((order) =>
    (order === "forward" ? sizes : [...sizes].reverse()).flatMap((records) =>
      (order === "forward" ? variants : [...variants].reverse()).map(
        (variant) => ({
          id: `${order}-${records}-${variant.id}`,
          args: [
            ...variant.args,
            "--records",
            String(records),
            "--key",
            "age",
            "--job-order",
            order,
          ],
        }),
      ),
    ),
  );
}

export async function study(stage: string, root: string) {
  if (!["optimization", "selection", "scaling"].includes(stage))
    throw new Error("Expected stage: optimization, selection or scaling");
  const experiments =
    stage === "optimization"
      ? optimizationExperiments()
      : stage === "selection"
        ? selectionExperiments()
        : scalingExperiments();
  const protocol =
    stage === "scaling"
      ? ["--samples", "9", "--warmup", "10", "--iterations", "3"]
      : ["--samples", "15", "--warmup", "30", "--iterations", "10"];
  await mkdir(resolve(root, ".."), { recursive: true });
  await mkdir(root); // Preserve every earlier study.
  await writeFile(
    join(root, "study-source.ts"),
    await readFile(import.meta.filename),
  );
  await writeFile(
    join(root, "plan.json"),
    `${JSON.stringify({ stage, protocol, experiments }, null, 2)}\n`,
  );
  const reports: { id: string; report: Report }[] = [];
  for (const experiment of experiments) {
    const output = join(root, experiment.id);
    const args = [
      process.execPath,
      join(import.meta.dir, "run.ts"),
      ...protocol,
      ...experiment.args,
      "--out",
      output,
    ];
    console.error(`Running ${stage}: ${experiment.id}`);
    const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    await writeFile(join(root, `${experiment.id}.log`), `${stdout}\n${stderr}`);
    if (exitCode !== 0)
      throw new Error(`${experiment.id} failed (${exitCode}): ${stderr}`);
    const report: Report = JSON.parse(
      await readFile(join(output, "report.json"), "utf8"),
    );
    reports.push({ id: experiment.id, report });
    const wat = await readFile(join(output, "sort.generated.wat"), "utf8");
    const selection = selectionFunction(wat, "sort_age_selection");
    await writeFile(
      join(output, "selection.function.wat.txt"),
      `${selection.text}\n`,
    );
    await writeFile(
      join(output, "selection-analysis.json"),
      `${JSON.stringify(analyzeSelection(wat, "sort_age_selection"), null, 2)}\n`,
    );
    for (const result of report.results) {
      assert.equal(result.typescriptResultHash, result.oracleHash);
      assert.equal(result.wasmResultHash, result.oracleHash);
      for (const engine of ["typescript", "wasm"] as const) {
        const { hash } = await import("./compiler");
        const bytes = await readFile(
          join(output, `${result.exportName}.${engine}.json`),
        );
        assert.equal(hash(bytes), result.oracleHash);
      }
    }
    console.error(
      `Verified ${experiment.id}: ${report.results.length} jobs; ${report.manifest.wasmBytes} bytes`,
    );
  }
  const first = reports[0]?.report;
  if (!first) throw new Error("No reports");
  const oracles = new Map<string, string>();
  for (const { report } of reports) {
    if (stage !== "scaling") assert.equal(report.input.hash, first.input.hash);
    assert.equal(report.manifest.sourceHash, first.manifest.sourceHash);
    assert.equal(report.manifest.typescriptHash, first.manifest.typescriptHash);
    assert.deepEqual(report.sourceHashes, first.sourceHashes);
    for (const result of report.results) {
      const key = `${report.input.hash}:${result.exportName}`;
      const previous = oracles.get(key);
      if (previous !== undefined) assert.equal(result.oracleHash, previous);
      oracles.set(key, result.oracleHash);
    }
  }
  const summary = reports.map(({ id, report }) => ({
    id,
    environment: report.environment,
    input: report.input,
    protocol: report.protocol,
    manifest: report.manifest,
    startup: report.startup,
    results: report.results.map(
      ({ key, algorithm, kernel, endToEnd, oracleHash }) => ({
        key,
        algorithm,
        kernel,
        endToEnd,
        oracleHash,
      }),
    ),
  }));
  await writeFile(
    join(root, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  const lines = [
    `# ${stage} study`,
    "",
    "Same source and generated TypeScript; input fixed within each record count. Independent sequential processes. Kernel/end-to-end values are median ms per operation.",
    "",
    "| Run | Records | Algorithm | Wasm bytes | Generate ms | Optimize ms | TS / Wasm kernel | TS / Wasm total |",
    "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |",
    ...reports.map(({ id, report }) => {
      const result =
        report.results.find(
          (r) => r.key === "age" && r.algorithm === "selection",
        ) ?? report.results[0];
      if (!result) throw new Error("Missing selection result");
      const pair = (metric: typeof result.kernel) =>
        `${metric.typescript.medianMs.toFixed(4)} / ${metric.wasm.medianMs.toFixed(4)}`;
      return `| ${id} | ${report.input.records} | ${result.algorithm} | ${report.manifest.wasmBytes} | ${report.startup.generationMs.toFixed(2)} | ${report.startup.optimizationMs.toFixed(2)} | ${pair(result.kernel)} | ${pair(result.endToEnd)} |`;
    }),
    "",
  ];
  await writeFile(join(root, "summary.md"), lines.join("\n"));
  console.log(lines.join("\n"));
  console.log(`Evidence: ${root}`);
}

if (import.meta.main) {
  const stage = process.argv[2] ?? "optimization";
  const root = resolve(
    process.argv[3] ??
      `artifacts/wasm-json-sort/${stage}-${new Date().toISOString().replaceAll(":", "-")}`,
  );
  study(stage, root).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
