import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { atomicWriteFile, atomicWriteJson } from "./atomic-file";
import { containedRelativePath } from "./contained-path";
import { measureCollectionCost } from "./llang-collection-cost";
import { CollectionDirectHarness } from "./llang-collection-direct-harness";
import { projectCollectionBottleneckMetrics } from "./llang-collection-bottleneck-metrics";
import {
  decideCollectionBottleneck,
  summarizeCollectionBottleneckSamples,
  type BottleneckCaseDiagnostic,
  type BottleneckDecisionConfig,
  type CollectionBottleneckSample,
} from "./llang-collection-bottleneck-report";
import { parseStrictJsonObject } from "./llang-jsonc";
import { evaluateCollectionProgram } from "./llang-module-collection-evaluator";
import type { CheckedCollectionProgram } from "./llang-module-collection-ir";
import { loadCollectionModuleProgram } from "./llang-module-collection-loader";
import { instantiateCollectionModule } from "./llang-module-collection-runtime";
import {
  emitCollectionModuleWasm,
  type CollectionWasmContract,
} from "./llang-module-collection-wasm";
import { COLLECTION_BINARYEN_VERSION } from "./llang-collection-binaryen-recipe";
import { sha256, stableJson } from "./stable-hash";

type ProgramSpec = Readonly<{
  id: string;
  entry: string;
  root?: string;
  entryName: string;
  inputShape: "values" | "threshold" | "delta" | "scalar" | "string" | "union";
}>;
type SourceCorpus = Readonly<{ programs: ProgramSpec[] }>;
type WorkloadCase = Readonly<{
  id: string;
  programId: string;
  partition: "exploration" | "holdout";
  size: number;
  pattern: string;
}>;
type Workload = Readonly<{
  cases: WorkloadCase[];
  mix: string[];
}>;
type Benchmark = Readonly<{
  seed: number;
  warmup: number;
  samples: number;
  canonicalEnvironment: {
    bun: string;
    binaryen: string;
    platform: string;
    arch: string;
    cpuIncludes: string;
  };
  limits: { childTimeoutMs: number; artifactBytes: number; jsonBytes: number };
  decision: BottleneckDecisionConfig;
}>;
type BuiltProgram = Readonly<{
  spec: ProgramSpec;
  program: CheckedCollectionProgram;
  bytes: Uint8Array;
  contract: CollectionWasmContract;
  wat: string;
  descriptor: Record<string, unknown>;
}>;
type ChildTiming = Readonly<{
  sample: number;
  compileNs: number;
  instantiateNs: number;
  encodeNs: number;
  hostValidationNs: number;
  evaluateNs: number;
  decodeNs: number;
  totalNs: number;
  accountedNs: number;
  unattributedNs: number;
  inputBytes: number;
  outputBytes: number;
}>;
type ChildResult = Readonly<{
  clockOverheadNs: number;
  cold: ChildTiming[];
  cached: ChildTiming[];
}>;

const repo = resolve(import.meta.dir, ".."),
  sourceRoot = join(repo, "benchmarks/collection-binaryen-v1"),
  date = "2026-09-21";

function strictValue(text: string, file: string): unknown {
  parseStrictJsonObject(text, file);
  return JSON.parse(text);
}

async function loadWithSchema<T>(
  valuePath: string,
  schemaPath: string,
): Promise<T> {
  const [valueText, schemaText] = await Promise.all([
      readFile(join(repo, valuePath), "utf8"),
      readFile(join(repo, schemaPath), "utf8"),
    ]),
    value = strictValue(valueText, valuePath),
    schema = strictValue(schemaText, schemaPath),
    ajv = new Ajv2020({ strict: true, allErrors: true }),
    validate = ajv.compile(schema as Record<string, unknown>);
  if (!validate(value))
    throw new Error(
      `INVALID_COLLECTION_BOTTLENECK_INPUT: ${valuePath}: ${ajv.errorsText(validate.errors)}`,
    );
  return value as T;
}

async function inputs(): Promise<[Benchmark, Workload, SourceCorpus]> {
  const result = await Promise.all([
    loadWithSchema<Benchmark>(
      "benchmarks/collection-bottleneck-v1/benchmark.json",
      "schemas/collection-bottleneck-benchmark-v1.schema.json",
    ),
    loadWithSchema<Workload>(
      "benchmarks/collection-bottleneck-v1/workload.json",
      "schemas/collection-bottleneck-workload-v1.schema.json",
    ),
    loadWithSchema<SourceCorpus>(
      "benchmarks/collection-binaryen-v1/corpus.json",
      "schemas/collection-binaryen-corpus-v1.schema.json",
    ),
  ]);
  validateWorkload(result[1], result[2]);
  return result;
}

function validateWorkload(workload: Workload, corpus: SourceCorpus): void {
  const ids = new Set(workload.cases.map((item) => item.id)),
    programs = new Set(corpus.programs.map((item) => item.id)),
    expected = new Set([
      "fold",
      "map",
      "filter",
      "closure",
      "sort",
      "composite",
      "string",
      "generic",
      "union",
    ]);
  if (
    ids.size !== workload.cases.length ||
    workload.mix.some((id) => !ids.has(id)) ||
    workload.cases.some((item) => !programs.has(item.programId)) ||
    [...expected].some(
      (id) => !workload.cases.some((item) => item.programId === id),
    )
  )
    throw new Error(
      "INVALID_COLLECTION_BOTTLENECK_WORKLOAD: incomplete matrix",
    );
  for (const programId of [
    "fold",
    "map",
    "filter",
    "closure",
    "sort",
    "composite",
    "string",
  ]) {
    const rows = workload.cases.filter((item) => item.programId === programId),
      sizes = new Set(rows.map((item) => item.size)),
      expectedSizes =
        programId === "sort" || programId === "composite"
          ? [64, 256, 512]
          : programId === "string"
            ? [16, 1024, 16384]
            : [64, 1024, 4096];
    if (
      rows.length !== 3 ||
      [...sizes].sort((left, right) => left - right).join(",") !==
        expectedSizes.join(",") ||
      rows.filter((item) => item.partition === "exploration").length !== 1 ||
      rows.filter((item) => item.partition === "holdout").length !== 2
    )
      throw new Error(`INVALID_COLLECTION_BOTTLENECK_WORKLOAD: ${programId}`);
  }
  for (const programId of ["generic", "union"])
    if (
      workload.cases.filter(
        (item) =>
          item.programId === programId &&
          item.partition === "holdout" &&
          item.size === 1,
      ).length !== 1
    )
      throw new Error(`INVALID_COLLECTION_BOTTLENECK_WORKLOAD: ${programId}`);
  if (
    new Set(
      workload.mix.map(
        (caseId) =>
          workload.cases.find((item) => item.id === caseId)?.programId,
      ),
    ).size !== 9
  )
    throw new Error("INVALID_COLLECTION_BOTTLENECK_WORKLOAD: incomplete mix");
  if (
    workload.mix.some(
      (caseId) =>
        workload.cases.find((item) => item.id === caseId)?.partition !==
        "holdout",
    )
  )
    throw new Error("INVALID_COLLECTION_BOTTLENECK_WORKLOAD: non-holdout mix");
}

function environment() {
  return {
    bun: Bun.version,
    binaryen: COLLECTION_BINARYEN_VERSION,
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    cpu: cpus()[0]?.model ?? "unknown",
  };
}

function canonical(
  current: ReturnType<typeof environment>,
  benchmark: Benchmark,
) {
  const expected = benchmark.canonicalEnvironment;
  return (
    current.bun === expected.bun &&
    current.binaryen === expected.binaryen &&
    current.platform === expected.platform &&
    current.arch === expected.arch &&
    current.cpu.includes(expected.cpuIncludes)
  );
}

async function buildPrograms(corpus: SourceCorpus): Promise<BuiltProgram[]> {
  const result: BuiltProgram[] = [];
  for (const spec of corpus.programs) {
    const programRoot = resolve(sourceRoot, spec.root ?? ".");
    containedRelativePath(repo, programRoot, "corpus root", "repository");
    const program = await loadCollectionModuleProgram(
        spec.entry,
        programRoot,
        spec.entryName,
      ),
      emitted = emitCollectionModuleWasm(program),
      first = projectCollectionBottleneckMetrics(program, emitted.wat),
      second = projectCollectionBottleneckMetrics(program, emitted.wat);
    if (stableJson(first) !== stableJson(second))
      throw new Error("COLLECTION_BOTTLENECK_METRICS: nondeterministic");
    result.push(
      Object.freeze({
        spec,
        program,
        bytes: emitted.bytes,
        contract: emitted.contract,
        wat: emitted.wat,
        descriptor: {
          programId: spec.id,
          programHash: program.programHash,
          loweredHash: program.loweredHash,
          interfaceHash: program.interfaceHash,
          layoutHash: program.layoutHash,
          wasmHash: sha256(emitted.bytes),
          wasmBytes: emitted.bytes.length,
          memoryInitialPages: emitted.contract.memory.initial,
          memoryMaximumPages: emitted.contract.memory.maximum,
          metrics: first.metrics,
          metricsHash: first.metricsHash,
        },
      }),
    );
  }
  return result.sort((left, right) =>
    left.spec.id.localeCompare(right.spec.id),
  );
}

function materialize(spec: ProgramSpec, item: WorkloadCase): unknown {
  if (spec.inputShape === "scalar") return { value: 1_234_567 };
  if (spec.inputShape === "string") return { value: "x".repeat(item.size) };
  if (spec.inputShape === "union") return { tag: "Value", text: "x" };
  const values = Array.from({ length: item.size }, (_, index) => {
    switch (item.pattern) {
      case "ascending":
        return index % 1000;
      case "reverse":
        return (item.size - index) % 1000;
      case "alternating":
        return index % 2 === 0 ? index % 500 : -(index % 500);
      case "duplicates":
        return index % 7;
      default:
        return (index % 21) - 10;
    }
  });
  if (spec.inputShape === "threshold") return { values, threshold: 0 };
  if (spec.inputShape === "delta") return { values, delta: 3 };
  return { values };
}

function verifyAndDescribeCases(
  built: readonly BuiltProgram[],
  workload: Workload,
): BottleneckCaseDiagnostic[] {
  const byId = new Map(built.map((item) => [item.spec.id, item])),
    diagnostics: BottleneckCaseDiagnostic[] = [];
  for (const item of workload.cases) {
    const program = byId.get(item.programId);
    if (!program) throw new Error("COLLECTION_BOTTLENECK: missing program");
    const input = materialize(program.spec, item),
      reference = evaluateCollectionProgram(program.program, input),
      actual = instantiateCollectionModule(
        program.contract,
        program.bytes,
      ).evaluate(input);
    if (stableJson(reference) !== stableJson(actual))
      throw new Error(`COLLECTION_BOTTLENECK_CORRECTNESS: ${item.id}`);
    const cost = measureCollectionCost(program.program, input).metrics;
    diagnostics.push(
      Object.freeze({
        caseId: item.id,
        programId: item.programId,
        size: item.size,
        arenaPeakBytes: cost.arenaPeakBytes,
        allocationCalls: cost.allocationCalls,
        allocationBytes: cost.alignedBytes,
        copyCalls: cost.copyCalls,
        copyBytes: cost.copyBytes,
        metricsHash: String(program.descriptor.metricsHash),
      }),
    );
  }
  const fold = byId.get("fold");
  if (!fold) throw new Error("COLLECTION_BOTTLENECK: missing fold program");
  const overflowInput = { values: [2_147_483_647, 1, -1] },
    referenceFault = captureFault(() =>
      evaluateCollectionProgram(fold.program, overflowInput),
    ),
    runtimeFault = captureFault(() =>
      instantiateCollectionModule(fold.contract, fold.bytes).evaluate(
        overflowInput,
      ),
    ),
    harness = new CollectionDirectHarness(fold.contract, fold.bytes),
    length = harness.encodeInput(overflowInput),
    direct = harness.invoke(64, length);
  if (
    referenceFault !== "ARITHMETIC_OVERFLOW" ||
    runtimeFault !== referenceFault ||
    direct.kind !== "trap" ||
    direct.faultCode !== 3 ||
    direct.inputHashBefore !== direct.inputHashAfter
  )
    throw new Error("COLLECTION_BOTTLENECK_CORRECTNESS: fault mismatch");
  return diagnostics.sort((left, right) =>
    left.caseId.localeCompare(right.caseId),
  );
}

function captureFault(operation: () => unknown): string {
  try {
    operation();
    return "NO_FAULT";
  } catch (error) {
    return error instanceof Error
      ? (error.message.split(":")[0] ?? error.name)
      : String(error);
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > limit) throw new Error("COLLECTION_BOTTLENECK_OUTPUT_LIMIT");
    chunks.push(chunk);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function parseChild(candidate: unknown, samples: number): ChildResult {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    throw new Error("COLLECTION_BOTTLENECK_PROTOCOL: expected object");
  const value = candidate as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(",") !== "cached,clockOverheadNs,cold" ||
    !Number.isSafeInteger(value.clockOverheadNs) ||
    (value.clockOverheadNs as number) < 0 ||
    !Array.isArray(value.cold) ||
    !Array.isArray(value.cached) ||
    value.cold.length !== samples ||
    value.cached.length !== samples
  )
    throw new Error("COLLECTION_BOTTLENECK_PROTOCOL: invalid result");
  const timings = (rows: unknown[]) =>
    rows.map((candidateRow, index) => {
      if (
        !candidateRow ||
        typeof candidateRow !== "object" ||
        Array.isArray(candidateRow)
      )
        throw new Error("COLLECTION_BOTTLENECK_PROTOCOL: invalid timing");
      const row = candidateRow as Record<string, unknown>,
        keys = [
          "accountedNs",
          "compileNs",
          "decodeNs",
          "encodeNs",
          "evaluateNs",
          "hostValidationNs",
          "inputBytes",
          "instantiateNs",
          "outputBytes",
          "sample",
          "totalNs",
          "unattributedNs",
        ],
        accounted =
          (row.compileNs as number) +
          (row.instantiateNs as number) +
          (row.encodeNs as number) +
          (row.hostValidationNs as number) +
          (row.evaluateNs as number) +
          (row.decodeNs as number);
      if (
        Object.keys(row).sort().join(",") !== keys.sort().join(",") ||
        row.sample !== index ||
        Object.values(row).some(
          (item) => !Number.isSafeInteger(item) || (item as number) < 0,
        ) ||
        (row.totalNs as number) <= 0 ||
        row.accountedNs !== accounted ||
        row.unattributedNs !==
          (row.totalNs as number) - (row.accountedNs as number)
      )
        throw new Error("COLLECTION_BOTTLENECK_PROTOCOL: invalid timing");
      return row as ChildTiming;
    });
  return {
    clockOverheadNs: value.clockOverheadNs as number,
    cold: timings(value.cold),
    cached: timings(value.cached),
  };
}

async function measure(
  program: BuiltProgram,
  input: unknown,
  expected: unknown,
  benchmark: Benchmark,
  parent: string,
): Promise<ChildResult> {
  const temporary = await mkdtemp(join(parent, "case-"));
  try {
    const wasm = join(temporary, "input.wasm"),
      contract = join(temporary, "contract.json"),
      inputPath = join(temporary, "input.json"),
      expectedPath = join(temporary, "expected.json"),
      request = join(temporary, "request.json"),
      output = join(temporary, "output.json");
    await Promise.all([
      writeFile(wasm, program.bytes, { flag: "wx", mode: 0o600 }),
      writeFile(contract, stableJson(program.contract), {
        flag: "wx",
        mode: 0o600,
      }),
      writeFile(inputPath, stableJson(input), { flag: "wx", mode: 0o600 }),
      writeFile(expectedPath, stableJson({ value: expected }), {
        flag: "wx",
        mode: 0o600,
      }),
      writeFile(
        request,
        stableJson({ warmup: benchmark.warmup, samples: benchmark.samples }),
        {
          flag: "wx",
          mode: 0o600,
        },
      ),
    ]);
    const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "llang-collection-bottleneck-child.ts"),
          wasm,
          contract,
          inputPath,
          expectedPath,
          request,
          output,
        ],
        {
          cwd: temporary,
          env: process.env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      ),
      timed = { out: false },
      timer = setTimeout(() => {
        timed.out = true;
        child.kill("SIGKILL");
      }, benchmark.limits.childTimeoutMs);
    let stdout: Uint8Array, stderr: Uint8Array, exit: number;
    try {
      [stdout, stderr, exit] = await Promise.all([
        readBounded(child.stdout, 64 * 1024),
        readBounded(child.stderr, 64 * 1024),
        child.exited,
      ]);
    } catch (error) {
      child.kill("SIGKILL");
      await child.exited;
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (timed.out) throw new Error("COLLECTION_BOTTLENECK_TIMEOUT");
    if (exit !== 0)
      throw new Error(
        `COLLECTION_BOTTLENECK_CHILD: ${new TextDecoder().decode(stderr).slice(0, 4096)}`,
      );
    if (stdout.length)
      throw new Error("COLLECTION_BOTTLENECK_PROTOCOL: unexpected stdout");
    const info = await lstat(output);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > benchmark.limits.jsonBytes
    )
      throw new Error("COLLECTION_BOTTLENECK_PROTOCOL: invalid output");
    return parseChild(
      strictValue(await readFile(output, "utf8"), output),
      benchmark.samples,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function benchmarkCases(
  built: readonly BuiltProgram[],
  workload: Workload,
  benchmark: Benchmark,
): Promise<CollectionBottleneckSample[]> {
  const temporary = await mkdtemp(
      join(tmpdir(), "llang-collection-bottleneck-"),
    ),
    byId = new Map(built.map((item) => [item.spec.id, item])),
    samples: CollectionBottleneckSample[] = [];
  try {
    for (const item of workload.cases) {
      const program = byId.get(item.programId);
      if (!program) throw new Error("COLLECTION_BOTTLENECK: missing program");
      const input = materialize(program.spec, item),
        expected = evaluateCollectionProgram(program.program, input);
      const measured = await measure(
        program,
        input,
        expected,
        benchmark,
        temporary,
      );
      measured.cold.forEach((cold, index) => {
        const cached = measured.cached[index];
        if (
          !cached ||
          cold.inputBytes !== cached.inputBytes ||
          cold.outputBytes !== cached.outputBytes
        )
          throw new Error(
            "COLLECTION_BOTTLENECK_PROTOCOL: cold/cached mismatch",
          );
        samples.push({
          caseId: item.id,
          programId: item.programId,
          partition: item.partition,
          size: item.size,
          sample: cold.sample,
          clockOverheadNs: measured.clockOverheadNs,
          compileNs: cold.compileNs,
          instantiateNs: cold.instantiateNs,
          encodeNs: cold.encodeNs,
          hostValidationNs: cold.hostValidationNs,
          evaluateNs: cold.evaluateNs,
          decodeNs: cold.decodeNs,
          totalNs: cold.totalNs,
          accountedNs: cold.accountedNs,
          unattributedNs: cold.unattributedNs,
          cachedInstantiateNs: cached.instantiateNs,
          cachedEncodeNs: cached.encodeNs,
          cachedHostValidationNs: cached.hostValidationNs,
          cachedEvaluateNs: cached.evaluateNs,
          cachedDecodeNs: cached.decodeNs,
          cachedTotalNs: cached.totalNs,
          cachedUnattributedNs: cached.unattributedNs,
          inputBytes: cold.inputBytes,
          outputBytes: cold.outputBytes,
        });
      });
    }
    return samples;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function hashFile(relative: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(join(repo, relative)))
    .digest("hex");
}

async function validateGenerated(
  value: unknown,
  schemaPath: string,
): Promise<void> {
  const schema = strictValue(
      await readFile(join(repo, schemaPath), "utf8"),
      schemaPath,
    ),
    ajv = new Ajv2020({ strict: true, allErrors: true }),
    validate = ajv.compile(schema as Record<string, unknown>);
  if (!validate(value))
    throw new Error(
      `INVALID_COLLECTION_BOTTLENECK_OUTPUT: ${ajv.errorsText(validate.errors)}`,
    );
}

export async function publishCollectionBottleneckEntries(
  root: string,
  entries: ReadonlyArray<{ path: string; value: unknown }>,
  write: (path: string, value: unknown) => Promise<void> = atomicWriteJson,
) {
  const snapshots = new Map<string, Uint8Array | undefined>(),
    targets = new Set<string>();
  for (const entry of entries) {
    const path = resolve(root, entry.path);
    containedRelativePath(
      root,
      path,
      "publication artifact",
      "publication root",
    );
    if (targets.has(path))
      throw new Error("COLLECTION_BOTTLENECK_RECORD: duplicate artifact");
    targets.add(path);
    await mkdir(dirname(path), { recursive: true });
    const [parentInfo, targetInfo] = await Promise.all([
      lstat(dirname(path)),
      lstat(path).catch((error: unknown) => {
        if (hasErrorCode(error, "ENOENT")) return undefined;
        throw error;
      }),
    ]);
    if (
      !parentInfo.isDirectory() ||
      parentInfo.isSymbolicLink() ||
      (targetInfo && (!targetInfo.isFile() || targetInfo.isSymbolicLink()))
    )
      throw new Error("COLLECTION_BOTTLENECK_RECORD: unsafe artifact path");
    snapshots.set(
      path,
      await readFile(path).catch((error: unknown) => {
        if (hasErrorCode(error, "ENOENT")) return undefined;
        throw error;
      }),
    );
  }
  const written: string[] = [];
  try {
    for (const entry of entries) {
      const path = resolve(root, entry.path);
      written.push(path);
      await write(path, entry.value);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const path of written.reverse()) {
      try {
        const prior = snapshots.get(path);
        if (prior) await atomicWriteFile(path, prior);
        else
          await unlink(path).catch((unlinkError: unknown) => {
            if (!hasErrorCode(unlinkError, "ENOENT")) throw unlinkError;
          });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length)
      throw new AggregateError(
        [error, ...rollbackErrors],
        "COLLECTION_BOTTLENECK_RECORD: publication and rollback failed",
      );
    throw error;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String(error.code) === code
  );
}

export async function runCollectionBottleneckExperiment(
  options: Readonly<{ benchmark?: boolean; record?: boolean }> = {},
): Promise<Record<string, unknown>> {
  const [benchmark, workload, corpus] = await inputs(),
    current = environment();
  if ((options.benchmark || options.record) && !canonical(current, benchmark))
    throw new Error(
      "COLLECTION_BOTTLENECK_ENVIRONMENT: benchmark requires Bun 1.4.2 on Apple M4 darwin-arm64",
    );
  const [built, reversed] = await Promise.all([
      buildPrograms(corpus),
      buildPrograms({
        ...corpus,
        programs: [...corpus.programs].reverse(),
      }),
    ]),
    firstDescriptors = built.map((item) => item.descriptor),
    reversedDescriptors = reversed.map((item) => item.descriptor);
  if (
    [...built, ...reversed].some(
      (item) => item.bytes.length > benchmark.limits.artifactBytes,
    )
  )
    throw new Error("COLLECTION_BOTTLENECK_ARTIFACT_LIMIT");
  if (stableJson(firstDescriptors) !== stableJson(reversedDescriptors))
    throw new Error(
      "COLLECTION_BOTTLENECK_REPRODUCIBILITY: order changed evidence",
    );
  const diagnostics = verifyAndDescribeCases(built, workload),
    reversedDiagnostics = verifyAndDescribeCases(reversed, {
      ...workload,
      cases: [...workload.cases].reverse(),
    });
  if (stableJson(diagnostics) !== stableJson(reversedDiagnostics))
    throw new Error(
      "COLLECTION_BOTTLENECK_REPRODUCIBILITY: order changed case evidence",
    );
  const deterministic = {
    sourceCorpusHash: await hashFile(
      "benchmarks/collection-binaryen-v1/corpus.json",
    ),
    sourceFreezeHash: await hashFile(
      "benchmarks/collection-binaryen-v1/freeze.json",
    ),
    benchmarkHash: await hashFile(
      "benchmarks/collection-bottleneck-v1/benchmark.json",
    ),
    workloadHash: await hashFile(
      "benchmarks/collection-bottleneck-v1/workload.json",
    ),
    programs: firstDescriptors,
    cases: diagnostics,
  };
  if (!options.benchmark && !options.record) return { deterministic };
  const samples = await benchmarkCases(built, workload, benchmark),
    summary = summarizeCollectionBottleneckSamples(samples),
    decision = {
      ...decideCollectionBottleneck(
        summary,
        diagnostics,
        workload.mix,
        benchmark.decision,
      ),
      createdOn: date,
      canonical: canonical(current, benchmark),
    },
    observation = {
      format: "llang-collection-bottleneck-observation",
      version: 1,
      createdOn: date,
      canonical: canonical(current, benchmark),
      environment: current,
      ...deterministic,
      samples,
      summary,
    };
  await validateGenerated(
    observation,
    "schemas/collection-bottleneck-observation-v1.schema.json",
  );
  await validateGenerated(
    decision,
    "schemas/collection-bottleneck-decision-v1.schema.json",
  );
  if (options.record)
    await publishCollectionBottleneckEntries(repo, [
      {
        path: "benchmarks/collection-bottleneck-v1/observations/darwin-arm64.json",
        value: observation,
      },
      {
        path: "benchmarks/collection-bottleneck-v1/decision.json",
        value: decision,
      },
    ]);
  return { deterministic, observation, decision };
}

type RecordedObservation = Readonly<{
  canonical: boolean;
  cases: BottleneckCaseDiagnostic[];
  samples: CollectionBottleneckSample[];
  summary: ReturnType<typeof summarizeCollectionBottleneckSamples>;
}>;

export function validateRecordedMatrix(
  observation: RecordedObservation,
  benchmark: Benchmark,
  workload: Workload,
): void {
  const expected = new Map(workload.cases.map((item) => [item.id, item])),
    diagnosticIds = new Set(observation.cases.map((item) => item.caseId));
  if (
    observation.samples.length !== workload.cases.length * benchmark.samples ||
    observation.cases.length !== workload.cases.length ||
    diagnosticIds.size !== workload.cases.length
  )
    throw new Error("COLLECTION_BOTTLENECK_REPORT: incomplete matrix");
  for (const item of workload.cases) {
    const rows = observation.samples.filter((row) => row.caseId === item.id),
      diagnostic = observation.cases.find((row) => row.caseId === item.id);
    if (
      rows.length !== benchmark.samples ||
      rows.some(
        (row) =>
          row.programId !== item.programId ||
          row.partition !== item.partition ||
          row.size !== item.size,
      ) ||
      !diagnostic ||
      diagnostic.programId !== item.programId ||
      diagnostic.size !== item.size
    )
      throw new Error(
        `COLLECTION_BOTTLENECK_REPORT: invalid matrix case ${item.id}`,
      );
  }
  if (
    observation.samples.some((row) => !expected.has(row.caseId)) ||
    observation.cases.some((row) => !expected.has(row.caseId))
  )
    throw new Error("COLLECTION_BOTTLENECK_REPORT: unknown matrix case");
}

export async function regenerateCollectionBottleneckDecision(): Promise<
  Record<string, unknown>
> {
  const [observation, benchmark, workload] = await Promise.all([
    loadWithSchema<RecordedObservation>(
      "benchmarks/collection-bottleneck-v1/observations/darwin-arm64.json",
      "schemas/collection-bottleneck-observation-v1.schema.json",
    ),
    loadWithSchema<Benchmark>(
      "benchmarks/collection-bottleneck-v1/benchmark.json",
      "schemas/collection-bottleneck-benchmark-v1.schema.json",
    ),
    loadWithSchema<Workload>(
      "benchmarks/collection-bottleneck-v1/workload.json",
      "schemas/collection-bottleneck-workload-v1.schema.json",
    ),
  ]);
  validateWorkload(
    workload,
    await loadWithSchema<SourceCorpus>(
      "benchmarks/collection-binaryen-v1/corpus.json",
      "schemas/collection-binaryen-corpus-v1.schema.json",
    ),
  );
  validateRecordedMatrix(observation, benchmark, workload);
  const summary = summarizeCollectionBottleneckSamples(observation.samples);
  if (stableJson(summary) !== stableJson(observation.summary))
    throw new Error("COLLECTION_BOTTLENECK_REPORT: recorded summary differs");
  return {
    ...decideCollectionBottleneck(
      summary,
      observation.cases,
      workload.mix,
      benchmark.decision,
    ),
    createdOn: date,
    canonical: observation.canonical,
  };
}

if (import.meta.main) {
  const [command, ...extra] = process.argv.slice(2);
  if (
    !command ||
    extra.length ||
    !["verify", "benchmark", "record", "report"].includes(command)
  )
    throw new Error(
      "usage: llang-collection-bottleneck-experiment <verify|benchmark|record|report>",
    );
  if (command === "report") {
    const regenerated = await regenerateCollectionBottleneckDecision(),
      recorded = await loadWithSchema<Record<string, unknown>>(
        "benchmarks/collection-bottleneck-v1/decision.json",
        "schemas/collection-bottleneck-decision-v1.schema.json",
      );
    if (stableJson(regenerated) !== stableJson(recorded))
      throw new Error("COLLECTION_BOTTLENECK_REPORT: decision differs");
    console.log(stableJson(regenerated));
  } else {
    const result = await runCollectionBottleneckExperiment({
      benchmark: command !== "verify",
      record: command === "record",
    });
    if (command === "verify") {
      const [recorded, recordedDecision, regeneratedDecision] =
        await Promise.all([
          loadWithSchema<RecordedObservation>(
            "benchmarks/collection-bottleneck-v1/observations/darwin-arm64.json",
            "schemas/collection-bottleneck-observation-v1.schema.json",
          ),
          loadWithSchema<Record<string, unknown>>(
            "benchmarks/collection-bottleneck-v1/decision.json",
            "schemas/collection-bottleneck-decision-v1.schema.json",
          ),
          regenerateCollectionBottleneckDecision(),
        ]);
      if (
        stableJson(result.deterministic) !==
        stableJson({
          sourceCorpusHash: (recorded as unknown as Record<string, unknown>)
            .sourceCorpusHash,
          sourceFreezeHash: (recorded as unknown as Record<string, unknown>)
            .sourceFreezeHash,
          benchmarkHash: (recorded as unknown as Record<string, unknown>)
            .benchmarkHash,
          workloadHash: (recorded as unknown as Record<string, unknown>)
            .workloadHash,
          programs: (recorded as unknown as Record<string, unknown>).programs,
          cases: recorded.cases,
        })
      )
        throw new Error(
          "COLLECTION_BOTTLENECK_VERIFY: deterministic evidence differs",
        );
      if (stableJson(recordedDecision) !== stableJson(regeneratedDecision))
        throw new Error("COLLECTION_BOTTLENECK_VERIFY: decision differs");
    }
    if (command === "benchmark") console.log(stableJson(result.observation));
    else
      console.log(
        JSON.stringify(
          {
            command,
            deterministicHash: sha256(stableJson(result.deterministic)),
            outcome:
              (result.decision as { outcome?: string } | undefined)?.outcome ??
              "verified",
          },
          null,
          2,
        ),
      );
  }
}
