import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compile, hash, type Optimization, optimizations } from "./compiler";
import { decode, encode, generateJson, parseRows, reference } from "./data";
import { createWasm } from "./runtime";

function options(args: string[]) {
  const values = new Map<string, string>();
  const allowed = [
    "--input",
    "--program",
    "--out",
    "--bytes",
    "--samples",
    "--warmup",
    "--iterations",
    "--key",
    "--algorithm",
    "--job-order",
    "--optimization",
    "--selection-branch",
    "--records",
  ];
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!flag || !allowed.includes(flag) || !value || values.has(flag))
      throw new Error(`Invalid option: ${flag}`);
    values.set(flag, value);
  }
  const integer = (
    flag: string,
    fallback: number,
    min: number,
    max: number,
  ) => {
    const n = Number(values.get(flag) ?? fallback);
    if (!Number.isInteger(n) || n < min || n > max)
      throw new Error(`${flag}: expected ${min}..${max}`);
    return n;
  };
  if (
    values.has("--job-order") &&
    !["forward", "reverse"].includes(values.get("--job-order") ?? "")
  )
    throw new Error("--job-order: expected forward or reverse");
  if (values.has("--input") && values.has("--bytes"))
    throw new Error("Choose --input or --bytes");
  if (
    values.has("--records") &&
    (values.has("--input") || values.has("--bytes"))
  )
    throw new Error("Choose only one of --input, --bytes and --records");
  if (
    values.has("--selection-branch") &&
    !["true", "false"].includes(values.get("--selection-branch") ?? "")
  )
    throw new Error("--selection-branch: expected true or false");
  if (
    values.has("--optimization") &&
    !optimizations.includes(values.get("--optimization") as Optimization)
  )
    throw new Error("--optimization: expected none, legacy, O2 or O3");
  return {
    values,
    samples: integer("--samples", 9, 3, 100),
    warmup: integer("--warmup", 10, 1, 1000),
    iterations: integer("--iterations", 5, 1, 100),
    bytes: integer("--bytes", 102400, 2, 3000000),
    records: values.has("--records")
      ? integer("--records", 710, 1, 20000)
      : undefined,
  };
}

function summary(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted[middle];
  const min = sorted[0];
  const max = sorted.at(-1);
  if (median === undefined || min === undefined || max === undefined)
    throw new Error("Empty timing samples");
  return {
    medianMs:
      sorted.length % 2
        ? median
        : ((sorted[middle - 1] ?? median) + median) / 2,
    minMs: min,
    maxMs: max,
    samplesMs: samples,
  };
}

export async function run(args: string[]) {
  const { values, samples, warmup, iterations, bytes, records } = options(args);
  const source = await readFile(
    resolve(values.get("--program") ?? join(import.meta.dir, "sort.jsonc")),
    "utf8",
  );
  const readStart = performance.now();
  const json =
    values.has("--bytes") || records !== undefined
      ? generateJson(bytes, records)
      : await readFile(
          resolve(values.get("--input") ?? join(import.meta.dir, "data.json")),
          "utf8",
        );
  const inputReadOrGenerateMs = performance.now() - readStart;
  const rows = parseRows(json);
  const output = resolve(
    values.get("--out") ??
      `artifacts/wasm-json-sort/${new Date().toISOString().replaceAll(":", "-")}`,
  );
  // A run is a new evidence directory; never overwrite an earlier run.
  await mkdir(resolve(output, ".."), { recursive: true });
  await mkdir(output);
  const optimization = values.get("--optimization") as Optimization | undefined;
  const built = await compile(source, output, {
    ...(optimization ? { optimization } : {}),
    selectionBranch: values.get("--selection-branch") === "true",
  });
  const jobs = built.manifest.program.jobs.filter(
    (job) =>
      (!values.has("--key") || job.key === values.get("--key")) &&
      (!values.has("--algorithm") ||
        job.algorithm === values.get("--algorithm")),
  );
  if (!jobs.length) throw new Error("No matching jobs");
  if (values.get("--job-order") === "reverse") jobs.reverse();
  const importStart = performance.now();
  const generated = await import(
    pathToFileURL(join(output, "sort.generated.ts")).href
  );
  const generatedTypescriptImportMs = performance.now() - importStart;
  const wasm = await createWasm(built.bytes, rows.length);
  await writeFile(join(output, "input.json"), json);
  const measure = (fn: () => unknown) => {
    const start = performance.now();
    const result = fn();
    return { ms: performance.now() - start, result };
  };
  const phase = (fn: () => unknown) => {
    const times: number[] = [];
    for (let i = 0; i < warmup; i++) fn();
    for (let s = 0; s < samples; s++) {
      let elapsed = 0;
      for (let i = 0; i < iterations; i++) elapsed += measure(fn).ms;
      times.push(elapsed / iterations);
    }
    return summary(times);
  };
  const parseAndValidate = phase(() => parseRows(json));
  const results = [];
  for (const job of jobs) {
    const tsSort = generated[job.exportName] as (data: Int32Array) => void;
    if (typeof tsSort !== "function")
      throw new Error("Missing generated TypeScript export");
    const encoded = encode(rows, job.key);
    const expectedKeys = Int32Array.from(encoded).sort();
    const referenceRows = reference(rows, job.key);
    const expectedJson = JSON.stringify(referenceRows);
    const tsBuffer = new Int32Array(encoded.length);
    const preprocessing = phase(() => encode(rows, job.key));
    const tsCopy = phase(() => tsBuffer.set(encoded));
    const wasmCopy = phase(() => wasm.load(encoded));
    const reconstruction = phase(() => decode(rows, expectedKeys));
    const serialization = phase(() => JSON.stringify(referenceRows));
    function pipeline(engine: "typescript" | "wasm") {
      const input = parseRows(json);
      const data = encode(input, job.key);
      let sorted: Int32Array;
      if (engine === "typescript") {
        tsBuffer.set(data);
        tsSort(tsBuffer);
        sorted = tsBuffer;
      } else {
        wasm.load(data);
        wasm.sort(job.exportName, data.length);
        sorted = wasm.view(data.length);
      }
      return JSON.stringify(decode(input, sorted));
    }
    const kernel = { typescript: [] as number[], wasm: [] as number[] };
    const endToEnd = { typescript: [] as number[], wasm: [] as number[] };
    for (let i = 0; i < warmup; i++) {
      assert.equal(pipeline("typescript"), expectedJson);
      assert.equal(pipeline("wasm"), expectedJson);
    }
    for (let sample = 0; sample < samples; sample++) {
      const engines =
        sample % 2
          ? (["wasm", "typescript"] as const)
          : (["typescript", "wasm"] as const);
      for (const engine of engines) {
        let coreMs = 0;
        let totalMs = 0;
        for (let i = 0; i < iterations; i++) {
          if (engine === "typescript") {
            tsBuffer.set(encoded); // Fresh unsorted data, outside kernel timer.
            coreMs += measure(() => tsSort(tsBuffer)).ms;
            assert.deepEqual(tsBuffer, expectedKeys);
          } else {
            wasm.load(encoded);
            coreMs += measure(() =>
              wasm.sort(job.exportName, encoded.length),
            ).ms;
            assert.deepEqual(wasm.view(encoded.length), expectedKeys);
          }
          const total = measure(() => pipeline(engine));
          totalMs += total.ms;
          assert.equal(total.result, expectedJson); // Outside timer, every iteration.
        }
        kernel[engine].push(coreMs / iterations);
        endToEnd[engine].push(totalMs / iterations);
      }
    }
    const tsOutput = pipeline("typescript");
    const wasmOutput = pipeline("wasm");
    assert.equal(tsOutput, expectedJson);
    assert.equal(wasmOutput, expectedJson);
    await Promise.all([
      writeFile(
        join(output, `${job.exportName}.typescript.json`),
        `${tsOutput}\n`,
      ),
      writeFile(join(output, `${job.exportName}.wasm.json`), `${wasmOutput}\n`),
    ]);
    const result = {
      ...job,
      verified: true,
      typescriptResultHash: hash(`${tsOutput}\n`),
      wasmResultHash: hash(`${wasmOutput}\n`),
      oracleHash: hash(`${expectedJson}\n`),
      phases: {
        preprocessing,
        tsCopy,
        wasmCopy,
        reconstruction,
        serialization,
      },
      kernel: {
        typescript: summary(kernel.typescript),
        wasm: summary(kernel.wasm),
      },
      endToEnd: {
        typescript: summary(endToEnd.typescript),
        wasm: summary(endToEnd.wasm),
      },
    };
    results.push(result);
    console.error(`${job.key}/${job.algorithm}: results match`);
  }
  const sourceHashes: Record<string, string> = {};
  for (const file of [
    "run.ts",
    "compiler.ts",
    "runtime.ts",
    "data.ts",
    "algorithms.ts",
    "sort.wat",
    "selection-analysis.ts",
  ]) {
    const content = await readFile(join(import.meta.dir, file), "utf8");
    sourceHashes[file] = hash(content);
    await mkdir(join(output, "sources"), { recursive: true });
    await writeFile(join(output, "sources", file), content);
  }
  const report = {
    timestamp: new Date().toISOString(),
    scope:
      "Experimental example compiler; not the standard L-Lang Predicate profile",
    environment: {
      bun: Bun.version,
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model,
    },
    input: {
      bytes: Buffer.byteLength(json),
      records: rows.length,
      hash: hash(json),
      synthetic: !values.has("--input"),
    },
    protocol: {
      samples,
      warmup,
      iterations,
      order: "alternating TS/Wasm by sample",
      jobOrder: values.get("--job-order") ?? "forward",
      units: "milliseconds per sort",
      kernel:
        "pre-encoded i32 keys; copy excluded; Wasm call boundary included",
      endToEnd:
        "JSON parse + validation + rank encoding + copy + sort + reconstruction + stringify; file IO/build/startup excluded",
    },
    startup: {
      inputReadOrGenerateMs,
      binaryenImportMs: built.binaryenImportMs,
      generationMs: built.generationMs,
      optimizationMs: built.optimizationMs,
      selectionBranchMs: built.selectionBranchMs,
      generatedTypescriptImportMs,
      wasmCompileMs: wasm.compileMs,
      wasmInstantiateMs: wasm.instantiateMs,
    },
    manifest: built.manifest,
    sourceHashes,
    parseAndValidate,
    results,
  };
  await writeFile(
    join(output, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const lines = [
    "# JSON sort experiment",
    "",
    `Input: ${report.input.bytes} bytes / ${rows.length} records. Bun ${Bun.version}, ${platform()} ${arch()}.`,
    `Optimization: ${built.manifest.optimization}; optimize=${built.manifest.optimizationLevel}, shrink=${built.manifest.shrinkLevel}. Wasm: ${built.manifest.wasmBytes} bytes.`,
    "",
    "Generated TypeScript and Wasm from the experimental example compiler. All outputs checked against an independent object-sort oracle.",
    "",
    "Median milliseconds per sort; build/startup and file IO excluded. Kernel uses ranked integer keys, not raw JSON/string comparison.",
    "",
    "| Key | Algorithm | TS kernel | Wasm kernel | TS end-to-end | Wasm end-to-end |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
    ...results.map(
      (r) =>
        `| ${r.key} | ${r.algorithm} | ${r.kernel.typescript.medianMs.toFixed(4)} | ${r.kernel.wasm.medianMs.toFixed(4)} | ${r.endToEnd.typescript.medianMs.toFixed(4)} | ${r.endToEnd.wasm.medianMs.toFixed(4)} |`,
    ),
    "",
    `Samples: ${samples}; iterations/sample: ${iterations}; warmup: ${warmup}. Raw samples, phase timings, hashes and startup timings: report.json.`,
    "",
  ];
  await writeFile(join(output, "report.md"), lines.join("\n"));
  console.log(lines.join("\n"));
  console.log(`Evidence: ${output}`);
  return report;
}

if (import.meta.main) {
  run(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
