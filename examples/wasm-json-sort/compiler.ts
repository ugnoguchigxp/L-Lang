import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parse,
  type ParseError,
  printParseErrorCode,
  visit,
} from "jsonc-parser";
import { type Algorithm, algorithms } from "./algorithms";
import { keys, type SortKey } from "./data";
import { restoreSelectionBranch } from "./selection-analysis";

export interface Job {
  key: SortKey;
  algorithm: Algorithm;
  exportName: string;
}
export interface Program {
  optimize: boolean;
  jobs: Job[];
}
export const optimizations = ["none", "legacy", "O2", "O3"] as const;
export type Optimization = (typeof optimizations)[number];
export interface BuildOptions {
  optimization?: Optimization;
  selectionBranch?: boolean;
}
export const hash = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

export function parseProgram(source: string): Program {
  const errors: ParseError[] = [];
  const value = parse(source, errors, { allowTrailingComma: true });
  if (errors.length)
    throw new Error(errors.map((e) => printParseErrorCode(e.error)).join(", "));
  if (
    value?.language !== "L-Lang-experimental" ||
    value.version !== 1 ||
    value.profile !== "json-sort-i32-v1" ||
    typeof value.optimize !== "boolean" ||
    !Array.isArray(value.jobs) ||
    value.jobs.length < 1 ||
    value.jobs.length > 15 ||
    Object.keys(value).some(
      (key) =>
        !["language", "version", "profile", "optimize", "jobs"].includes(key),
    )
  ) {
    throw new Error("Invalid experimental sorting program");
  }
  const objectKeys: Set<string>[] = [];
  visit(
    source,
    {
      onObjectBegin: () => {
        objectKeys.push(new Set());
      },
      onObjectProperty: (key) => {
        const current = objectKeys.at(-1);
        if (!current || current.has(key))
          throw new Error("Duplicate program field");
        current.add(key);
      },
      onObjectEnd: () => {
        objectKeys.pop();
      },
    },
    { allowTrailingComma: true },
  );
  const seen = new Set<string>();
  const jobs: Job[] = value.jobs.map(
    (job: { key: SortKey; algorithm: Algorithm }) => {
      if (
        !job ||
        !keys.includes(job.key) ||
        !algorithms.includes(job.algorithm) ||
        Object.keys(job).some((key) => key !== "key" && key !== "algorithm")
      ) {
        throw new Error("Invalid sorting job");
      }
      const exportName = `sort_${job.key}_${job.algorithm}`;
      if (seen.has(exportName)) throw new Error("Duplicate sorting job");
      seen.add(exportName);
      return { ...job, exportName };
    },
  );
  return { optimize: value.optimize, jobs };
}

// A small example compiler with fixed algorithm templates, not the production
// Predicate compiler, an arbitrary TypeScript compiler, or LLM code generation.
export async function compile(
  source: string,
  output: string,
  options: BuildOptions = {},
) {
  const program = parseProgram(source);
  const optimization =
    options.optimization ?? (program.optimize ? "legacy" : "none");
  if (!optimizations.includes(optimization))
    throw new Error("Invalid optimization preset");
  const optimizeLevel =
    optimization === "none" ? 0 : optimization === "O3" ? 3 : 2;
  const shrinkLevel = optimization === "legacy" ? 1 : 0;
  const importStart = performance.now();
  const { default: binaryen } = await import("binaryen");
  const binaryenImportMs = performance.now() - importStart;
  const start = performance.now();
  const template = await readFile(
    join(import.meta.dir, "algorithms.ts"),
    "utf8",
  );
  const wat = await readFile(join(import.meta.dir, "sort.wat"), "utf8");
  const ts = `// Generated from experimental sort.jsonc; do not edit.\n${template}\n${program.jobs
    .map((job) => `export const ${job.exportName} = sorts.${job.algorithm};`)
    .join("\n")}\n`;
  let moduleText = wat;
  for (const algorithm of algorithms) {
    moduleText = moduleText.replace(
      `(func (export "${algorithm}")`,
      `(func $${algorithm}`,
    );
  }
  moduleText = `${moduleText.trim().slice(0, -1)}\n${program.jobs
    .map(
      (job) =>
        `(func (export "${job.exportName}") (param $n i32) (call $${job.algorithm} (local.get $n)))`,
    )
    .join("\n")}\n)`;
  let module = binaryen.parseText(moduleText);
  const previousLevel = binaryen.getOptimizeLevel();
  const previousShrinkLevel = binaryen.getShrinkLevel();
  const beforeOptimization = module.emitText();
  let bytes: Uint8Array;
  let optimizedWat: string;
  let optimizationMs = 0;
  let selectionBranchMs = 0;
  try {
    binaryen.setOptimizeLevel(optimizeLevel);
    binaryen.setShrinkLevel(shrinkLevel);
    if (optimization !== "none") {
      const optimizationStart = performance.now();
      module.optimize();
      optimizationMs = performance.now() - optimizationStart;
    }
    if (options.selectionBranch) {
      const job = program.jobs.find((job) => job.algorithm === "selection");
      if (!job || optimization === "none")
        throw new Error(
          "Selection branch experiment requires an optimized selection job",
        );
      const branchStart = performance.now();
      const rewritten = restoreSelectionBranch(
        module.emitText(),
        job.exportName,
      );
      const replacement = binaryen.parseText(rewritten);
      module.dispose();
      module = replacement;
      selectionBranchMs = performance.now() - branchStart;
    }
    if (!module.validate()) throw new Error("Invalid generated Wasm");
    bytes = new Uint8Array(module.emitBinary());
    optimizedWat = module.emitText();
  } finally {
    binaryen.setOptimizeLevel(previousLevel);
    binaryen.setShrinkLevel(previousShrinkLevel);
    module.dispose();
  }
  if (!WebAssembly.validate(bytes)) throw new Error("Invalid Wasm bytes");
  const generationMs = performance.now() - start;
  await mkdir(output, { recursive: true });
  const manifest = {
    profile: "json-sort-i32-v1",
    productionLlangProfile: false,
    program,
    sourceHash: hash(source),
    templateHash: hash(template),
    watTemplateHash: hash(wat),
    typescriptHash: hash(ts),
    wasmHash: hash(bytes),
    wasmBytes: bytes.length,
    binaryen: "132.0.0",
    optimization,
    optimizationLevel: optimizeLevel,
    shrinkLevel,
    optimizationPassApplied: optimization !== "none",
    selectionBranch: options.selectionBranch ?? false,
  };
  await Promise.all([
    writeFile(join(output, "source.jsonc"), source),
    writeFile(join(output, "sort.generated.ts"), ts),
    writeFile(join(output, "sort.wasm"), bytes),
    writeFile(join(output, "sort.generated.wat"), optimizedWat),
    writeFile(join(output, "sort.before-optimization.wat"), beforeOptimization),
    writeFile(
      join(output, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    ),
  ]);
  return {
    bytes,
    manifest,
    binaryenImportMs,
    generationMs,
    optimizationMs,
    selectionBranchMs,
  };
}
