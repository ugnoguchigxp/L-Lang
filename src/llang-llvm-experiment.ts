import { createHash } from "node:crypto";
import { cpus, platform, arch, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020";
import { atomicWriteJson } from "./atomic-file";
import { evaluateCollectionProgram } from "./llang-module-collection-evaluator";
import { loadCollectionModuleProgram } from "./llang-module-collection-loader";
import { instantiateCollectionModule } from "./llang-module-collection-runtime";
import { emitCollectionModuleWasm } from "./llang-module-collection-wasm";
import {
  extractLlvmKernelPlan,
  type LlvmKernelPlanV1,
} from "./llang-llvm-kernel-ir";
import { runNativeKernel } from "./llang-llvm-native-runner";
import {
  assertLlvmSampleMatrix,
  decideLlvmExperiment,
  summarizeLlvmSamples,
  type LlvmExperimentLane as Lane,
  type LlvmExperimentSample,
  type LlvmExperimentSummary,
} from "./llang-llvm-report";
import {
  buildLlvmKernel,
  discoverLlvmToolchain,
  type LlvmBuildArtifact,
  type LlvmOptimization,
  type LlvmToolchain,
} from "./llang-llvm-toolchain";
import {
  emitDirectKernelWasm,
  expectedLlvmKernelBoundaryStatus,
  LlvmKernelWasmHarness,
} from "./llang-llvm-wasm";

type ValueSpec =
  | { kind: "explicit"; values: number[] }
  | { kind: "repeat"; value: number; count: number }
  | { kind: "cycle"; values: number[]; count: number };
type CorpusCase = {
  id: string;
  partition: "correctness" | "exploration" | "holdout";
  input: ValueSpec;
  expected: { status: 0; value: number } | { status: 1; overflowIndex: number };
};
type BoundaryCase = {
  id: string;
  values: number;
  count: number;
  out: number;
  expectedStatus: number;
};
type Corpus = {
  format: "llang-llvm-experiment-corpus";
  version: 1;
  kernel: "checked-sum-i32";
  cases: CorpusCase[];
  wasmBoundaryCases: BoundaryCase[];
};
type BenchmarkConfig = {
  format: "llang-llvm-experiment-benchmark";
  version: 1;
  seed: number;
  warmup: number;
  iterations: number;
  samples: number;
  partitions: ["exploration", "holdout"];
  optimizations: LlvmOptimization[];
  limits: {
    toolTimeoutMs: number;
    nativeTimeoutMs: number;
    outputBytes: number;
    artifactBytes: number;
  };
  decision: {
    maximumMedianRegressionPercent: number;
    requiredImprovementPercent: number;
    maximumArtifactRatio: number;
  };
};
type MeasuredCase = CorpusCase & {
  partition: "exploration" | "holdout";
};
type BuiltLanes = {
  product: ReturnType<typeof emitCollectionModuleWasm>;
  direct: ReturnType<typeof emitDirectKernelWasm>;
  wasm: Map<LlvmOptimization, LlvmBuildArtifact>;
  native: Map<LlvmOptimization, LlvmBuildArtifact>;
};

const repo = resolve(import.meta.dir, "..");
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export async function runLlvmExperiment(
  options: { record?: boolean; benchmark?: boolean } = {},
): Promise<Record<string, unknown>> {
  const temporary = await mkdtemp(join(tmpdir(), "llang-llvm-experiment-"));
  try {
    const [jsonProgram, tsProgram, corpus, benchmark, toolchain] =
        await Promise.all([
          loadCollectionModuleProgram(
            "application/evaluate.llang.jsonc",
            join(repo, "examples/llvm-sum-i32"),
            "evaluate",
          ),
          loadCollectionModuleProgram(
            "application/evaluate.ts",
            join(repo, "examples/llvm-sum-i32"),
            "evaluate",
          ),
          loadJsonWithSchema<Corpus>(
            "benchmarks/llvm-backend-v1/corpus.json",
            "schemas/llvm-experiment-corpus-v1.schema.json",
          ),
          loadJsonWithSchema<BenchmarkConfig>(
            "benchmarks/llvm-backend-v1/benchmark.json",
            "schemas/llvm-experiment-benchmark-v1.schema.json",
          ),
          discoverLlvmToolchain(),
        ]),
      jsonPlan = extractLlvmKernelPlan(jsonProgram),
      tsPlan = extractLlvmKernelPlan(tsProgram);
    if (
      jsonProgram.programHash !== tsProgram.programHash ||
      jsonProgram.loweredHash !== tsProgram.loweredHash ||
      jsonProgram.interfaceHash !== tsProgram.interfaceHash ||
      jsonProgram.layoutHash !== tsProgram.layoutHash ||
      jsonPlan.hash !== tsPlan.hash
    )
      throw new Error("LLVM_DIFFERENTIAL: TypeScript and JSONC plans differ");

    validateLlvmCorpus(corpus);
    const built = await buildLanes(
        jsonProgram,
        jsonPlan,
        toolchain,
        benchmark.optimizations,
        benchmark.limits,
        join(temporary, "first"),
      ),
      verification = await verifyLanes(
        jsonProgram,
        jsonPlan,
        corpus,
        built,
        benchmark,
      ),
      second = await buildLanes(
        jsonProgram,
        jsonPlan,
        toolchain,
        benchmark.optimizations,
        benchmark.limits,
        join(temporary, "second"),
      );
    assertReproducible(built, second);

    const artifactRows = await describeArtifacts(built),
      freeze = {
        format: "llang-llvm-experiment-freeze",
        version: 1,
        createdOn: "2026-09-21",
        baselineRevision: "fc72c1164db17049f2f934119d3376e46e5bf916",
        environment: {
          bun: Bun.version,
          binaryen: "132.0.0",
          typescript: "5.9.3",
          os: platform(),
          architecture: arch(),
          cpu: cpus()[0]?.model ?? "unknown",
        },
        toolchain,
        source: {
          programHash: jsonProgram.programHash,
          loweredHash: jsonProgram.loweredHash,
          interfaceHash: jsonProgram.interfaceHash,
          layoutHash: jsonProgram.layoutHash,
          kernelPlanHash: jsonPlan.hash,
        },
        inputs: {
          corpusHash: hash(
            new Uint8Array(
              await readFile(
                join(repo, "benchmarks/llvm-backend-v1/corpus.json"),
              ),
            ),
          ),
          benchmarkHash: hash(
            new Uint8Array(
              await readFile(
                join(repo, "benchmarks/llvm-backend-v1/benchmark.json"),
              ),
            ),
          ),
        },
        artifacts: artifactRows,
        verification,
      };

    let observation: Record<string, unknown> | undefined,
      decision: Record<string, unknown> | undefined;
    if (options.benchmark) {
      const measured = await benchmarkLanes(
        corpus,
        built,
        jsonProgram,
        benchmark,
      );
      decision = decideLlvmExperiment(
        measured.summary,
        artifactRows,
        benchmark,
      );
      observation = {
        format: "llang-llvm-experiment-observation",
        version: 1,
        createdOn: "2026-09-21",
        environment: freeze.environment,
        source: freeze.source,
        benchmark,
        samples: measured.samples,
        summary: measured.summary,
      };
    }

    await validateGeneratedArtifacts(freeze, observation, decision);

    if (options.record) {
      await writeJson("benchmarks/llvm-backend-v1/freeze.json", freeze);
      if (observation && decision) {
        await writeJson(
          `benchmarks/llvm-backend-v1/observations/${platform()}-${arch()}.json`,
          observation,
        );
        await writeJson("benchmarks/llvm-backend-v1/decision.json", decision);
      }
    }
    return {
      ok: true,
      planHash: jsonPlan.hash,
      verification,
      artifacts: artifactRows,
      ...(observation ? { observation } : {}),
      ...(decision ? { decision } : {}),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function buildLanes(
  program: Awaited<ReturnType<typeof loadCollectionModuleProgram>>,
  plan: LlvmKernelPlanV1,
  toolchain: LlvmToolchain,
  optimizations: LlvmOptimization[],
  limits: BenchmarkConfig["limits"],
  root: string,
): Promise<BuiltLanes> {
  await mkdir(root, { recursive: true });
  const product = emitCollectionModuleWasm(program),
    direct = emitDirectKernelWasm(plan),
    wasm = new Map<LlvmOptimization, LlvmBuildArtifact>(),
    native = new Map<LlvmOptimization, LlvmBuildArtifact>();
  for (const optimization of optimizations) {
    wasm.set(
      optimization,
      await buildLlvmKernel(
        plan,
        toolchain,
        "wasm32",
        optimization,
        join(root, `wasm-${optimization}`),
        limits,
      ),
    );
    native.set(
      optimization,
      await buildLlvmKernel(
        plan,
        toolchain,
        "native-arm64",
        optimization,
        join(root, `native-${optimization}`),
        limits,
      ),
    );
  }
  return { product, direct, wasm, native };
}

async function verifyLanes(
  program: Awaited<ReturnType<typeof loadCollectionModuleProgram>>,
  _plan: LlvmKernelPlanV1,
  corpus: Corpus,
  built: BuiltLanes,
  benchmark: BenchmarkConfig,
) {
  let comparisons = 0;
  for (const item of corpus.cases) {
    const values = expand(item.input),
      expected = item.expected,
      reference = outcome(() => evaluateCollectionProgram(program, { values })),
      product = outcome(() =>
        instantiateCollectionModule(
          built.product.contract,
          built.product.bytes,
        ).evaluate({ values }),
      );
    assertOutcome(item.id, reference, expected);
    assertOutcome(item.id, product, expected);
    comparisons += 2;
    const wasmLanes: Array<readonly [string, Uint8Array]> = [
      ["direct-wasm", built.direct.bytes],
    ];
    for (const [optimization, artifact] of built.wasm)
      wasmLanes.push([
        `llvm-wasm-${optimization}`,
        new Uint8Array(await readFile(artifact.artifactPath)),
      ]);
    for (const [lane, bytes] of wasmLanes) {
      const result = new LlvmKernelWasmHarness(bytes).invoke(values);
      if (
        result.kind !== "return" ||
        result.status !== expected.status ||
        (expected.status === 0 && result.value !== expected.value) ||
        result.inputBefore !== result.inputAfter
      )
        throw new Error(`LLVM_DIFFERENTIAL: ${item.id} ${lane}`);
      comparisons++;
    }
    for (const [optimization, artifact] of built.native) {
      const result = await runNativeKernel(
        artifact.artifactPath,
        values,
        benchmark.limits.nativeTimeoutMs,
      );
      if (
        result.kind !== "return" ||
        result.status !== expected.status ||
        (expected.status === 0 && result.value !== expected.value) ||
        result.inputUnchanged !== true
      )
        throw new Error(
          `LLVM_DIFFERENTIAL: ${item.id} llvm-native-${optimization} ${JSON.stringify(result)}`,
        );
      comparisons++;
    }
  }
  for (const item of corpus.wasmBoundaryCases) {
    const wasmLanes: Array<readonly [string, Uint8Array]> = [
      ["direct-wasm", built.direct.bytes],
    ];
    for (const [optimization, artifact] of built.wasm)
      wasmLanes.push([
        `llvm-wasm-${optimization}`,
        new Uint8Array(await readFile(artifact.artifactPath)),
      ]);
    for (const [lane, bytes] of wasmLanes) {
      const harness = new LlvmKernelWasmHarness(bytes);
      if (
        item.count <= 2 &&
        item.values <= harness.memory.length &&
        item.count * 4 <= harness.memory.length - item.values
      )
        for (let index = 0; index < item.count; index++)
          harness.view.setInt32(item.values + index * 4, index + 1, true);
      const result = harness.invokeRaw(item.values, item.count, item.out);
      if (
        result.kind !== "return" ||
        result.status !== item.expectedStatus ||
        (item.expectedStatus === 2 &&
          result.outputBefore !== result.outputAfter) ||
        (result.inputBefore !== null &&
          result.inputBefore !== result.inputAfter)
      )
        throw new Error(`LLVM_BOUNDARY: ${item.id} ${lane}`);
      comparisons++;
    }
  }
  const oversized = Array(4097).fill(1);
  for (const action of [
    () => evaluateCollectionProgram(program, { values: oversized }),
    () =>
      instantiateCollectionModule(
        built.product.contract,
        built.product.bytes,
      ).evaluate({ values: oversized }),
  ]) {
    const result = outcome(action);
    if (result.status !== 4)
      throw new Error("LLVM_DIFFERENTIAL: 4097 element input was accepted");
    comparisons++;
  }
  return Object.freeze({ cases: corpus.cases.length, comparisons });
}

async function benchmarkLanes(
  corpus: Corpus,
  built: BuiltLanes,
  program: Awaited<ReturnType<typeof loadCollectionModuleProgram>>,
  config: BenchmarkConfig,
): Promise<{
  samples: LlvmExperimentSample[];
  summary: LlvmExperimentSummary[];
}> {
  const samples: LlvmExperimentSample[] = [],
    cases = corpus.cases.filter(
      (item): item is MeasuredCase => item.partition !== "correctness",
    );
  for (const item of cases) {
    const values = expand(item.input),
      lanes: Lane[] = [
        "reference",
        "product-wasm",
        "direct-wasm",
        ...config.optimizations.map(
          (optimization) => `llvm-wasm-${optimization}` as const,
        ),
        ...config.optimizations.map(
          (optimization) => `llvm-native-${optimization}` as const,
        ),
      ];
    for (let sample = 0; sample < config.samples; sample++) {
      const rotated = rotate(lanes, (config.seed + sample) % lanes.length);
      for (const lane of rotated) {
        if (lane === "reference" || lane === "product-wasm") {
          const action =
            lane === "reference"
              ? () => evaluateCollectionProgram(program, { values })
              : () =>
                  instantiateCollectionModule(
                    built.product.contract,
                    built.product.bytes,
                  ).evaluate({ values });
          assertOutcome(item.id, outcome(action), item.expected);
          for (let index = 0; index < config.warmup; index++) action();
          const started = Bun.nanoseconds();
          for (let index = 0; index < config.iterations; index++) action();
          samples.push({
            caseId: item.id,
            partition: item.partition,
            lane,
            sample,
            scope: "end-to-end",
            nsPerIteration: (Bun.nanoseconds() - started) / config.iterations,
          });
          continue;
        }
        if (lane.startsWith("llvm-native-")) {
          const optimization = lane.slice(-2) as LlvmOptimization,
            artifact = built.native.get(optimization);
          if (!artifact) throw new Error(`missing ${lane}`);
          const result = await runNativeKernel(
            artifact.artifactPath,
            values,
            config.limits.nativeTimeoutMs,
            { warmup: config.warmup, iterations: config.iterations },
          );
          if (
            result.kind !== "return" ||
            result.kernelNs === undefined ||
            result.status !== item.expected.status ||
            (item.expected.status === 0 &&
              result.value !== item.expected.value) ||
            result.inputUnchanged !== true
          )
            throw new Error(
              `LLVM_BENCHMARK: ${lane} ${JSON.stringify(result)}`,
            );
          samples.push({
            caseId: item.id,
            partition: item.partition,
            lane,
            sample,
            scope: "kernel",
            nsPerIteration: result.kernelNs / config.iterations,
            nativeBufferBytes: Math.max(4, values.length * 4) + 4,
            ...(result.peakRssBytes === undefined
              ? {}
              : { peakRssBytes: result.peakRssBytes }),
            ...(result.processNs === undefined
              ? {}
              : { processNs: result.processNs }),
          });
          continue;
        }
        const bytes =
            lane === "direct-wasm"
              ? built.direct.bytes
              : new Uint8Array(
                  await readFile(
                    built.wasm.get(lane.slice(-2) as LlvmOptimization)
                      ?.artifactPath ?? "",
                  ),
                ),
          result = new LlvmKernelWasmHarness(bytes).benchmark(
            values,
            config.warmup,
            config.iterations,
          );
        if (
          result.status !== item.expected.status ||
          (item.expected.status === 0 &&
            result.value !== item.expected.value) ||
          !result.inputUnchanged
        )
          throw new Error(`LLVM_BENCHMARK: ${item.id} ${lane}`);
        samples.push({
          caseId: item.id,
          partition: item.partition,
          lane,
          sample,
          scope: "kernel",
          nsPerIteration: result.kernelNs / config.iterations,
          linearMemoryBytes: 2 * 65_536,
        });
      }
    }
  }
  assertLlvmSampleMatrix(
    samples,
    cases.map(({ id, partition }) => ({ id, partition })),
    config.samples,
    config.optimizations,
  );
  return { samples, summary: summarizeLlvmSamples(samples) };
}

async function describeArtifacts(built: BuiltLanes) {
  const rows: {
    lane: string;
    hash: string;
    bytes: number;
    rawIrHash?: string;
    optimizedIrHash?: string;
    phasesMs?: Readonly<Record<string, number>>;
  }[] = [
    {
      lane: "product-wasm",
      hash: hash(built.product.bytes),
      bytes: built.product.bytes.length,
    },
    {
      lane: "direct-wasm",
      hash: hash(built.direct.bytes),
      bytes: built.direct.bytes.length,
    },
  ];
  for (const [optimization, artifact] of built.wasm)
    rows.push({
      lane: `llvm-wasm-${optimization}`,
      hash: artifact.artifactHash,
      bytes: artifact.artifactBytes,
      rawIrHash: artifact.rawIrHash,
      optimizedIrHash: artifact.optimizedIrHash,
      phasesMs: artifact.phasesMs,
    });
  for (const [optimization, artifact] of built.native)
    rows.push({
      lane: `llvm-native-${optimization}`,
      hash: artifact.artifactHash,
      bytes: artifact.artifactBytes,
      rawIrHash: artifact.rawIrHash,
      optimizedIrHash: artifact.optimizedIrHash,
      phasesMs: artifact.phasesMs,
    });
  return rows;
}

function assertReproducible(left: BuiltLanes, right: BuiltLanes): void {
  if (hash(left.product.bytes) !== hash(right.product.bytes))
    throw new Error("LLVM_REPRODUCIBILITY: product Wasm differs");
  if (hash(left.direct.bytes) !== hash(right.direct.bytes))
    throw new Error("LLVM_REPRODUCIBILITY: direct Wasm differs");
  for (const target of ["wasm", "native"] as const) {
    for (const [optimization, artifact] of left[target]) {
      const compared = right[target].get(optimization);
      if (
        !compared ||
        artifact.rawIrHash !== compared.rawIrHash ||
        artifact.optimizedIrHash !== compared.optimizedIrHash ||
        artifact.artifactHash !== compared.artifactHash
      )
        throw new Error(`LLVM_REPRODUCIBILITY: ${target}-${optimization}`);
    }
  }
}

function outcome(action: () => unknown): { status: number; value?: number } {
  try {
    const result = action() as { total?: unknown };
    if (!result || !Number.isInteger(result.total))
      throw new Error("invalid result");
    return { status: 0, value: Number(result.total) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
    if (
      code === "ARITHMETIC_OVERFLOW" ||
      message.includes("ARITHMETIC_OVERFLOW")
    )
      return { status: 1 };
    if (code === "RESOURCE_LIMIT" || message.includes("RESOURCE_LIMIT"))
      return { status: 4 };
    throw error;
  }
}

function assertOutcome(
  id: string,
  actual: { status: number; value?: number },
  expected: CorpusCase["expected"],
) {
  if (
    actual.status !== expected.status ||
    (expected.status === 0 && actual.value !== expected.value)
  )
    throw new Error(
      `LLVM_DIFFERENTIAL: ${id} expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`,
    );
}

function expand(input: ValueSpec): number[] {
  if (input.kind === "explicit") return [...input.values];
  if (input.kind === "repeat") return Array(input.count).fill(input.value);
  return Array.from(
    { length: input.count },
    (_, index) => input.values[index % input.values.length] as number,
  );
}

export function validateLlvmCorpus(corpus: Corpus): void {
  const ids = [
      ...corpus.cases.map((item) => item.id),
      ...corpus.wasmBoundaryCases.map((item) => item.id),
    ],
    requiredCases = new Map<string, CorpusCase["partition"]>([
      ["empty", "correctness"],
      ["single-max", "correctness"],
      ["mixed", "correctness"],
      ["minimum", "correctness"],
      ["positive-overflow", "correctness"],
      ["negative-overflow", "correctness"],
      ["intermediate-overflow", "correctness"],
      ["order-sensitive-valid", "correctness"],
      ["list-4095", "correctness"],
      ["list-4096", "correctness"],
      ["exploration-small", "exploration"],
      ["exploration-medium", "exploration"],
      ["holdout-small", "holdout"],
      ["holdout-medium", "holdout"],
      ["holdout-maximum", "holdout"],
    ]),
    requiredBoundaries = new Set([
      "unaligned",
      "exact-end-output",
      "invalid-input-base",
      "short-input-range",
      "count-over-limit",
      "complete-overlap",
      "one-byte-overlap",
    ]);
  if (new Set(ids).size !== ids.length)
    throw new Error("INVALID_LLVM_CORPUS: duplicate id");
  if (
    corpus.cases.length !== requiredCases.size ||
    corpus.cases.some(
      (item) => requiredCases.get(item.id) !== item.partition,
    ) ||
    corpus.wasmBoundaryCases.length !== requiredBoundaries.size ||
    corpus.wasmBoundaryCases.some((item) => !requiredBoundaries.has(item.id))
  )
    throw new Error("INVALID_LLVM_CORPUS: incomplete frozen case matrix");
  for (const item of corpus.cases) {
    const values = expand(item.input);
    let sum = 0n,
      overflowIndex: number | undefined;
    for (let index = 0; index < values.length; index++) {
      sum += BigInt(values[index] as number);
      if (sum < -2_147_483_648n || sum > 2_147_483_647n) {
        overflowIndex = index;
        break;
      }
    }
    if (
      (overflowIndex === undefined &&
        (item.expected.status !== 0 || item.expected.value !== Number(sum))) ||
      (overflowIndex !== undefined &&
        (item.expected.status !== 1 ||
          item.expected.overflowIndex !== overflowIndex))
    )
      throw new Error(`INVALID_LLVM_CORPUS: incorrect oracle ${item.id}`);
  }
  for (const item of corpus.wasmBoundaryCases)
    if (
      item.expectedStatus !==
      expectedLlvmKernelBoundaryStatus(item.values, item.count, item.out)
    )
      throw new Error(`INVALID_LLVM_CORPUS: incorrect boundary ${item.id}`);
}

function rotate<T>(values: readonly T[], offset: number): T[] {
  return [...values.slice(offset), ...values.slice(0, offset)];
}

async function loadJsonWithSchema<T>(
  dataPath: string,
  schemaPath: string,
): Promise<T> {
  const [data, schema] = await Promise.all([
      readFile(join(repo, dataPath), "utf8").then(JSON.parse),
      readFile(join(repo, schemaPath), "utf8").then(JSON.parse),
    ]),
    validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  if (!validate(data))
    throw new Error(
      `INVALID_LLVM_EXPERIMENT_JSON: ${JSON.stringify(validate.errors)}`,
    );
  return data as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const absolute = join(repo, path);
  await mkdir(dirname(absolute), { recursive: true });
  await atomicWriteJson(absolute, value);
}

async function validateGeneratedArtifacts(
  freeze: unknown,
  observation?: unknown,
  decision?: unknown,
): Promise<void> {
  const names = [
      "llvm-experiment-benchmark-v1.schema.json",
      "llvm-experiment-freeze-v1.schema.json",
      "llvm-experiment-observation-v1.schema.json",
      "llvm-experiment-decision-v1.schema.json",
    ],
    schemas = await Promise.all(
      names.map((name) =>
        readFile(join(repo, "schemas", name), "utf8").then(JSON.parse),
      ),
    ),
    ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const schema of schemas) ajv.addSchema(schema);
  const generated: Array<readonly [string, unknown]> = [["freeze", freeze]];
  if (observation !== undefined) generated.push(["observation", observation]);
  if (decision !== undefined) generated.push(["decision", decision]);
  for (const [name, value] of generated) {
    const schema = schemas.find(
      (candidate) =>
        candidate.$id ===
        `https://l-lang.dev/schemas/llvm-experiment-${name}-v1.schema.json`,
    );
    const validate = ajv.getSchema(schema?.$id);
    if (!validate?.(value))
      throw new Error(
        `INVALID_LLVM_EXPERIMENT_${name.toUpperCase()}: ${JSON.stringify(validate?.errors)}`,
      );
  }
}

if (import.meta.main) {
  const mode = process.argv[2] ?? "verify";
  if (!new Set(["verify", "benchmark", "record"]).has(mode))
    throw new Error(
      "usage: llang-llvm-experiment.ts [verify|benchmark|record]",
    );
  const result = await runLlvmExperiment({
    benchmark: mode !== "verify",
    record: mode === "record",
  });
  console.log(JSON.stringify(result));
}
