import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import {
  publishCollectionBottleneckEntries,
  runCollectionBottleneckExperiment,
} from "./llang-collection-bottleneck-experiment";
import { COLLECTION_BINARYEN_VERSION } from "./llang-collection-binaryen-recipe";
import type { BottleneckCaseDiagnostic } from "./llang-collection-bottleneck-report";
import { parseStrictJsonObject } from "./llang-jsonc";
import { evaluateCollectionProgram } from "./llang-module-collection-evaluator";
import type { CheckedCollectionProgram } from "./llang-module-collection-ir";
import { loadCollectionModuleProgram } from "./llang-module-collection-loader";
import { instantiateCollectionModule } from "./llang-module-collection-runtime";
import {
  emitCollectionModuleWasm,
  type CollectionWasmContract,
} from "./llang-module-collection-wasm";
import {
  decideCollectionStability,
  summarizeCollectionStability,
  validateCollectionStabilityMatrix,
  type CollectionStabilitySample,
  type StabilityDecisionConfig,
  type StabilityLane,
} from "./llang-collection-stability-report";
import { sha256, stableJson } from "./stable-hash";

type ProgramSpec = Readonly<{
  id: string;
  entry: string;
  root?: string;
  entryName: string;
  inputShape: "values" | "threshold" | "delta" | "scalar" | "string" | "union";
}>;
type Corpus = Readonly<{ programs: ProgramSpec[] }>;
type WorkloadCase = Readonly<{
  id: string;
  programId: string;
  partition: "exploration" | "holdout";
  size: number;
  pattern: string;
}>;
type SourceWorkload = Readonly<{ cases: WorkloadCase[]; mix: string[] }>;
type Order = Readonly<{
  blockId: number;
  orderId: string;
  direction: "forward" | "reverse";
  caseIds: string[];
  caseOrderHash: string;
}>;
type StabilityWorkload = Readonly<{
  sourceWorkload: string;
  sourceWorkloadHash: string;
  orders: Order[];
}>;
type Benchmark = Readonly<{
  blocks: number;
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
  decision: StabilityDecisionConfig;
}>;
type BuiltProgram = Readonly<{
  spec: ProgramSpec;
  program: CheckedCollectionProgram;
  bytes: Uint8Array;
  contract: CollectionWasmContract;
  descriptor: Record<string, unknown>;
}>;
type Timing = Omit<
  CollectionStabilitySample,
  | "blockId"
  | "orderId"
  | "orderIndex"
  | "caseId"
  | "programId"
  | "partition"
  | "size"
  | "lane"
  | "clockOverheadNs"
>;
type ChildResult = Readonly<{
  clockOverheadNs: number;
  laneOrder: readonly [StabilityLane, StabilityLane];
  resources: {
    startRssBytes: number;
    afterWarmupRssBytes: number;
    endRssBytes: number;
    userCpuMicros: number;
    systemCpuMicros: number;
  };
  lanes: Record<StabilityLane, Timing[]>;
}>;
type RecordedObservation = Readonly<{
  canonical: boolean;
  environment: ReturnType<typeof environment>;
  sourceObservationHash: string;
  benchmarkHash: string;
  workloadHash: string;
  programs: Record<string, unknown>[];
  cases: BottleneckCaseDiagnostic[];
  blockEnvironments: Array<
    ReturnType<typeof environment> & Readonly<{ blockId: number }>
  >;
  resources: Array<Record<string, unknown>>;
  samples: CollectionStabilitySample[];
  summary: ReturnType<typeof summarizeCollectionStability>;
  lifecycleSafety: Record<string, unknown>;
}>;
type ExperimentResult = Readonly<{
  deterministic: Record<string, unknown>;
  lifecycleSafety?: Record<string, unknown>;
  observation?: Record<string, unknown>;
  decision?: Record<string, unknown>;
}>;

const repo = resolve(import.meta.dir, ".."),
  sourceRoot = join(repo, "benchmarks/collection-binaryen-v1"),
  date = "2026-09-21";
const paths = {
  benchmark: "benchmarks/collection-runtime-stability-v1/benchmark.json",
  workload: "benchmarks/collection-runtime-stability-v1/workload.json",
  observation:
    "benchmarks/collection-runtime-stability-v1/observations/darwin-arm64.json",
  decision: "benchmarks/collection-runtime-stability-v1/decision.json",
} as const;

function strictValue(text: string, file: string): unknown {
  parseStrictJsonObject(text, file);
  return JSON.parse(text);
}
async function loadSchema<T>(
  valuePath: string,
  schemaPath: string,
): Promise<T> {
  const [valueText, schemaText] = await Promise.all([
      readFile(join(repo, valuePath), "utf8"),
      readFile(join(repo, schemaPath), "utf8"),
    ]),
    value = strictValue(valueText, valuePath),
    schema = strictValue(schemaText, schemaPath),
    validate = new Ajv2020({ strict: true, allErrors: true }).compile(
      schema as Record<string, unknown>,
    );
  if (!validate(value))
    throw new Error(
      `INVALID_COLLECTION_STABILITY_INPUT: ${valuePath}: ${JSON.stringify(validate.errors)}`,
    );
  return value as T;
}
async function validateGenerated(value: unknown, schemaPath: string) {
  const schema = strictValue(
      await readFile(join(repo, schemaPath), "utf8"),
      schemaPath,
    ),
    validate = new Ajv2020({ strict: true, allErrors: true }).compile(
      schema as Record<string, unknown>,
    );
  if (!validate(value))
    throw new Error(
      `INVALID_COLLECTION_STABILITY_OUTPUT: ${JSON.stringify(validate.errors)}`,
    );
}
async function hashFile(path: string) {
  return createHash("sha256")
    .update(await readFile(join(repo, path)))
    .digest("hex");
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

function materialize(spec: ProgramSpec, item: WorkloadCase): unknown {
  if (spec.inputShape === "scalar") return { value: 1_234_567 };
  if (spec.inputShape === "string") return { value: "x".repeat(item.size) };
  if (spec.inputShape === "union") return { tag: "Value", text: "x" };
  const values = Array.from({ length: item.size }, (_, index) =>
    item.pattern === "ascending"
      ? index % 1000
      : item.pattern === "reverse"
        ? (item.size - index) % 1000
        : item.pattern === "alternating"
          ? index % 2 === 0
            ? index % 500
            : -(index % 500)
          : item.pattern === "duplicates"
            ? index % 7
            : (index % 21) - 10,
  );
  if (spec.inputShape === "threshold") return { values, threshold: 0 };
  if (spec.inputShape === "delta") return { values, delta: 3 };
  return { values };
}

async function buildPrograms(corpus: Corpus): Promise<BuiltProgram[]> {
  const built: BuiltProgram[] = [];
  for (const spec of corpus.programs) {
    const program = await loadCollectionModuleProgram(
        spec.entry,
        resolve(sourceRoot, spec.root ?? "."),
        spec.entryName,
      ),
      emitted = emitCollectionModuleWasm(program);
    built.push({
      spec,
      program,
      bytes: emitted.bytes,
      contract: emitted.contract,
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
      },
    });
  }
  return built.sort((a, b) => a.spec.id.localeCompare(b.spec.id));
}

function validateOrders(
  stability: StabilityWorkload,
  source: SourceWorkload,
  benchmark: Benchmark,
) {
  const ids = source.cases.map((item) => item.id),
    rotate = (count: number) => [...ids.slice(count), ...ids.slice(0, count)],
    expected = [
      ids,
      [...ids].reverse(),
      rotate(8),
      rotate(8).reverse(),
      rotate(16),
      rotate(16).reverse(),
    ];
  if (
    stability.orders.length !== benchmark.blocks ||
    new Set(stability.orders.map((order) => order.blockId)).size !==
      benchmark.blocks
  )
    throw new Error("INVALID_COLLECTION_STABILITY_WORKLOAD: blocks");
  stability.orders.forEach((order, index) => {
    if (
      order.blockId !== index ||
      order.orderId !== `order-${index}` ||
      order.direction !== (index % 2 === 0 ? "forward" : "reverse") ||
      stableJson(order.caseIds) !== stableJson(expected[index]) ||
      order.caseOrderHash !== sha256(stableJson(order.caseIds))
    )
      throw new Error("INVALID_COLLECTION_STABILITY_WORKLOAD: frozen order");
  });
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number) {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > limit) throw new Error("COLLECTION_STABILITY_OUTPUT_LIMIT");
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

function parseChild(
  candidate: unknown,
  samples: number,
  laneOrder: readonly [StabilityLane, StabilityLane],
): ChildResult {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    throw new Error("COLLECTION_STABILITY_PROTOCOL: expected object");
  const value = candidate as Record<string, unknown>,
    lanes = value.lanes as Record<string, unknown[]> | undefined,
    resources = value.resources as Record<string, unknown> | undefined;
  if (
    Object.keys(value).sort().join(",") !==
      "clockOverheadNs,laneOrder,lanes,resources" ||
    stableJson(value.laneOrder) !== stableJson(laneOrder) ||
    !Number.isSafeInteger(value.clockOverheadNs) ||
    !lanes ||
    Object.keys(lanes).sort().join(",") !== "cold,module-cached" ||
    !resources ||
    Object.keys(resources).sort().join(",") !==
      "afterWarmupRssBytes,endRssBytes,startRssBytes,systemCpuMicros,userCpuMicros" ||
    Object.values(resources).some(
      (item) => !Number.isSafeInteger(item) || (item as number) < 0,
    )
  )
    throw new Error("COLLECTION_STABILITY_PROTOCOL: invalid result");
  const parseLane = (lane: StabilityLane) => {
    const rows = lanes[lane];
    if (!Array.isArray(rows) || rows.length !== samples)
      throw new Error("COLLECTION_STABILITY_PROTOCOL: invalid lane");
    return rows.map((candidateRow, index) => {
      if (
        !candidateRow ||
        typeof candidateRow !== "object" ||
        Array.isArray(candidateRow)
      )
        throw new Error("COLLECTION_STABILITY_PROTOCOL: invalid timing");
      const row = candidateRow as Record<string, number>,
        timing = row as unknown as Timing,
        accounted =
          timing.compileNs +
          timing.instantiateNs +
          timing.encodeNs +
          timing.hostValidationNs +
          timing.evaluateNs +
          timing.decodeNs;
      if (
        Object.keys(row).sort().join(",") !==
          "accountedNs,compileNs,decodeNs,encodeNs,evaluateNs,hostValidationNs,inputBytes,instantiateNs,outputBytes,sample,totalNs,unattributedNs" ||
        timing.sample !== index ||
        Object.values(row).some(
          (item) => !Number.isSafeInteger(item) || item < 0,
        ) ||
        timing.totalNs <= 0 ||
        timing.accountedNs !== accounted ||
        timing.unattributedNs !== timing.totalNs - accounted ||
        (lane === "module-cached" && timing.compileNs !== 0)
      )
        throw new Error("COLLECTION_STABILITY_PROTOCOL: invalid timing");
      return timing;
    });
  };
  return {
    clockOverheadNs: value.clockOverheadNs as number,
    laneOrder,
    resources: resources as ChildResult["resources"],
    lanes: {
      cold: parseLane("cold"),
      "module-cached": parseLane("module-cached"),
    },
  };
}

async function measure(
  program: BuiltProgram,
  input: unknown,
  expected: unknown,
  benchmark: Benchmark,
  laneOrder: readonly [StabilityLane, StabilityLane],
  parent: string,
) {
  const root = await mkdtemp(join(parent, "case-"));
  try {
    const files = [
      "input.wasm",
      "contract.json",
      "input.json",
      "expected.json",
      "request.json",
      "output.json",
    ].map((name) => join(root, name));
    await Promise.all([
      writeFile(files[0] as string, program.bytes, { flag: "wx", mode: 0o600 }),
      writeFile(files[1] as string, stableJson(program.contract), {
        flag: "wx",
        mode: 0o600,
      }),
      writeFile(files[2] as string, stableJson(input), {
        flag: "wx",
        mode: 0o600,
      }),
      writeFile(files[3] as string, stableJson({ value: expected }), {
        flag: "wx",
        mode: 0o600,
      }),
      writeFile(
        files[4] as string,
        stableJson({
          warmup: benchmark.warmup,
          samples: benchmark.samples,
          laneOrder,
        }),
        { flag: "wx", mode: 0o600 },
      ),
    ]);
    const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "llang-collection-stability-child.ts"),
          ...(files as string[]),
        ],
        {
          cwd: root,
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
        readBounded(child.stdout, 65536),
        readBounded(child.stderr, 65536),
        child.exited,
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (timed.out) throw new Error("COLLECTION_STABILITY_TIMEOUT");
    if (exit !== 0)
      throw new Error(
        `COLLECTION_STABILITY_CHILD: ${new TextDecoder().decode(stderr).slice(0, 4096)}`,
      );
    if (stdout.length)
      throw new Error("COLLECTION_STABILITY_PROTOCOL: unexpected stdout");
    const info = await lstat(files[5] as string);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > benchmark.limits.jsonBytes
    )
      throw new Error("COLLECTION_STABILITY_PROTOCOL: invalid output");
    return parseChild(
      strictValue(
        await readFile(files[5] as string, "utf8"),
        files[5] as string,
      ),
      benchmark.samples,
      laneOrder,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function benchmarkBlocks(
  built: readonly BuiltProgram[],
  source: SourceWorkload,
  stability: StabilityWorkload,
  benchmark: Benchmark,
) {
  const root = await mkdtemp(join(tmpdir(), "llang-collection-stability-")),
    byProgram = new Map(built.map((item) => [item.spec.id, item])),
    byCase = new Map(source.cases.map((item) => [item.id, item])),
    samples: CollectionStabilitySample[] = [],
    resources: Record<string, unknown>[] = [],
    blockEnvironments: Record<string, unknown>[] = [];
  try {
    for (const order of stability.orders) {
      blockEnvironments.push({ blockId: order.blockId, ...environment() });
      const laneOrder: readonly [StabilityLane, StabilityLane] =
        order.blockId % 2 === 0
          ? ["cold", "module-cached"]
          : ["module-cached", "cold"];
      for (const [orderIndex, caseId] of order.caseIds.entries()) {
        const item = byCase.get(caseId),
          program = item ? byProgram.get(item.programId) : undefined;
        if (!item || !program)
          throw new Error("COLLECTION_STABILITY: missing case");
        const input = materialize(program.spec, item),
          expected = evaluateCollectionProgram(program.program, input),
          measured = await measure(
            program,
            input,
            expected,
            benchmark,
            laneOrder,
            root,
          );
        resources.push({
          blockId: order.blockId,
          orderId: order.orderId,
          orderIndex,
          caseId,
          laneOrder,
          ...measured.resources,
          clockOverheadNs: measured.clockOverheadNs,
        });
        for (const lane of laneOrder)
          for (const timing of measured.lanes[lane])
            samples.push({
              blockId: order.blockId,
              orderId: order.orderId,
              orderIndex,
              caseId,
              programId: item.programId,
              partition: item.partition,
              size: item.size,
              lane,
              clockOverheadNs: measured.clockOverheadNs,
              ...timing,
            });
      }
    }
    return { samples, resources, blockEnvironments };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function captureFault(operation: () => unknown) {
  try {
    operation();
    return "NO_FAULT";
  } catch (error) {
    return error instanceof Error ? error.message.split(":")[0] : String(error);
  }
}
function lifecycleSafety(built: readonly BuiltProgram[]) {
  const fold = built.find((item) => item.spec.id === "fold");
  if (!fold) throw new Error("COLLECTION_STABILITY: missing fold");
  const runtime = instantiateCollectionModule(fold.contract, fold.bytes),
    second = instantiateCollectionModule(fold.contract, fold.bytes),
    normal = { values: [1, 2, 3] },
    expected = evaluateCollectionProgram(fold.program, normal),
    hash = sha256(fold.bytes),
    first = runtime.evaluate(normal),
    secondResult = runtime.evaluate(normal),
    other = second.evaluate(normal),
    fault = captureFault(() =>
      runtime.evaluate({ values: [2_147_483_647, 1, -1] }),
    ),
    afterFault = runtime.evaluate(normal);
  if (
    [first, secondResult, other, afterFault].some(
      (value) => stableJson(value) !== stableJson(expected),
    ) ||
    fault !== "ARITHMETIC_OVERFLOW"
  )
    throw new Error("COLLECTION_STABILITY_LIFECYCLE: safety mismatch");
  return {
    normalReuse: true,
    faultIsolation: true,
    runtimeIsolation: true,
    memoryPages: fold.contract.memory.maximum,
    abi: fold.contract.abi,
    artifactStable: hash === sha256(fold.bytes),
  };
}

async function inputs(): Promise<
  [Benchmark, StabilityWorkload, SourceWorkload, Corpus]
> {
  const result = await Promise.all([
    loadSchema<Benchmark>(
      paths.benchmark,
      "schemas/collection-runtime-stability-benchmark-v1.schema.json",
    ),
    loadSchema<StabilityWorkload>(
      paths.workload,
      "schemas/collection-runtime-stability-workload-v1.schema.json",
    ),
    loadSchema<SourceWorkload>(
      "benchmarks/collection-bottleneck-v1/workload.json",
      "schemas/collection-bottleneck-workload-v1.schema.json",
    ),
    loadSchema<Corpus>(
      "benchmarks/collection-binaryen-v1/corpus.json",
      "schemas/collection-binaryen-corpus-v1.schema.json",
    ),
  ]);
  if (
    result[1].sourceWorkloadHash !== (await hashFile(result[1].sourceWorkload))
  )
    throw new Error("INVALID_COLLECTION_STABILITY_WORKLOAD: source hash");
  validateOrders(result[1], result[2], result[0]);
  return result;
}

async function deterministicEvidence(built: readonly BuiltProgram[]) {
  const prior = await runCollectionBottleneckExperiment(),
    deterministic = prior.deterministic as {
      programs: Record<string, unknown>[];
      cases: BottleneckCaseDiagnostic[];
    };
  if (
    stableJson(built.map((item) => item.descriptor)) !==
    stableJson(
      deterministic.programs.map(
        ({ metrics: _metrics, metricsHash: _metricsHash, ...descriptor }) =>
          descriptor,
      ),
    )
  )
    throw new Error(
      "COLLECTION_STABILITY_REPRODUCIBILITY: program evidence differs",
    );
  return {
    sourceObservationHash: await hashFile(
      "benchmarks/collection-bottleneck-v1/observations/darwin-arm64.json",
    ),
    benchmarkHash: await hashFile(paths.benchmark),
    workloadHash: await hashFile(paths.workload),
    programs: deterministic.programs,
    cases: deterministic.cases,
  };
}

function validateRecordedIdentities(
  observation: RecordedObservation,
  source: SourceWorkload,
  stability: StabilityWorkload,
): void {
  for (const item of source.cases) {
    const rows = observation.samples.filter((row) => row.caseId === item.id);
    if (
      rows.some(
        (row) =>
          row.programId !== item.programId ||
          row.partition !== item.partition ||
          row.size !== item.size,
      )
    )
      throw new Error("COLLECTION_STABILITY_REPORT: case metadata differs");
  }
  if (
    observation.samples.some((row) => {
      const order = stability.orders[row.blockId];
      return (
        !order ||
        row.orderId !== order.orderId ||
        order.caseIds[row.orderIndex] !== row.caseId
      );
    })
  )
    throw new Error("COLLECTION_STABILITY_REPORT: sample order differs");
  if (
    observation.blockEnvironments.length !== stability.orders.length ||
    observation.blockEnvironments.some((item, index) => {
      const { blockId, ...blockEnvironment } = item;
      return (
        blockId !== index ||
        stableJson(blockEnvironment) !== stableJson(observation.environment)
      );
    })
  )
    throw new Error("COLLECTION_STABILITY_REPORT: block environment differs");
  const resourceIds = new Set<string>();
  for (const resource of observation.resources) {
    const blockId = resource.blockId as number,
      orderIndex = resource.orderIndex as number,
      caseId = resource.caseId as string,
      order = stability.orders[blockId],
      identity = `${blockId}/${orderIndex}/${caseId}`;
    if (
      resourceIds.has(identity) ||
      !order ||
      resource.orderId !== order.orderId ||
      order.caseIds[orderIndex] !== caseId
    )
      throw new Error("COLLECTION_STABILITY_REPORT: resource matrix differs");
    resourceIds.add(identity);
  }
  if (resourceIds.size !== stability.orders.length * source.cases.length)
    throw new Error("COLLECTION_STABILITY_REPORT: resource matrix incomplete");
}

export async function regenerateCollectionStabilityDecision() {
  const [benchmark, stability, source] = await inputs(),
    observation = await loadSchema<RecordedObservation>(
      paths.observation,
      "schemas/collection-runtime-stability-observation-v1.schema.json",
    );
  validateCollectionStabilityMatrix(
    observation.samples,
    source.cases.map((item) => item.id),
    benchmark.blocks,
    benchmark.samples,
  );
  validateRecordedIdentities(observation, source, stability);
  const summary = summarizeCollectionStability(observation.samples);
  if (stableJson(summary) !== stableJson(observation.summary))
    throw new Error("COLLECTION_STABILITY_REPORT: summary differs");
  return {
    ...decideCollectionStability(
      observation.samples,
      summary,
      observation.cases,
      source.mix,
      {
        ...benchmark.decision,
        blocks: benchmark.blocks,
        samples: benchmark.samples,
      },
    ),
    createdOn: date,
    canonical: observation.canonical,
    lifecycleSafety: observation.lifecycleSafety,
  };
}

export async function withCollectionStabilityRecordLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = join(
      repo,
      "benchmarks/collection-runtime-stability-v1/.record.lock",
    ),
    handle = await open(lockPath, "wx", 0o600).catch(() => {
      throw new Error("COLLECTION_STABILITY_RECORD: already running");
    });
  try {
    return await operation();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

export async function runCollectionStabilityExperiment(
  options: Readonly<{ benchmark?: boolean; record?: boolean }> = {},
): Promise<ExperimentResult> {
  if (options.record)
    return withCollectionStabilityRecordLock(async () => {
      const result = await runCollectionStabilityExperiment({
        benchmark: true,
      });
      if (!result.observation || !result.decision)
        throw new Error("COLLECTION_STABILITY_RECORD: missing artifacts");
      await publishCollectionBottleneckEntries(repo, [
        { path: paths.observation, value: result.observation },
        { path: paths.decision, value: result.decision },
      ]);
      return result;
    });
  const [benchmark, stability, source, corpus] = await inputs(),
    current = environment();
  if ((options.benchmark || options.record) && !canonical(current, benchmark))
    throw new Error(
      "COLLECTION_STABILITY_ENVIRONMENT: benchmark requires Bun 1.4.2 on Apple M4 darwin-arm64",
    );
  const built = await buildPrograms(corpus),
    deterministic = await deterministicEvidence(built),
    safety = lifecycleSafety(built);
  if (built.some((item) => item.bytes.length > benchmark.limits.artifactBytes))
    throw new Error("COLLECTION_STABILITY_ARTIFACT_LIMIT");
  if (!options.benchmark && !options.record)
    return { deterministic, lifecycleSafety: safety };
  const measured = await benchmarkBlocks(built, source, stability, benchmark);
  validateCollectionStabilityMatrix(
    measured.samples,
    source.cases.map((item) => item.id),
    benchmark.blocks,
    benchmark.samples,
  );
  const summary = summarizeCollectionStability(measured.samples),
    decision = {
      ...decideCollectionStability(
        measured.samples,
        summary,
        deterministic.cases,
        source.mix,
        {
          ...benchmark.decision,
          blocks: benchmark.blocks,
          samples: benchmark.samples,
        },
      ),
      createdOn: date,
      canonical: true,
      lifecycleSafety: safety,
    },
    observation = {
      format: "llang-collection-runtime-stability-observation",
      version: 1,
      createdOn: date,
      canonical: true,
      environment: current,
      ...deterministic,
      blockEnvironments: measured.blockEnvironments,
      resources: measured.resources,
      samples: measured.samples,
      summary,
      lifecycleSafety: safety,
    };
  await validateGenerated(
    observation,
    "schemas/collection-runtime-stability-observation-v1.schema.json",
  );
  await validateGenerated(
    decision,
    "schemas/collection-runtime-stability-decision-v1.schema.json",
  );
  return { deterministic, observation, decision };
}

if (import.meta.main) {
  const [command, ...extra] = process.argv.slice(2);
  if (
    !command ||
    extra.length ||
    !["verify", "benchmark", "record", "report"].includes(command)
  )
    throw new Error(
      "usage: llang-collection-stability-experiment <verify|benchmark|record|report>",
    );
  if (command === "report") {
    const regenerated = await regenerateCollectionStabilityDecision(),
      recorded = await loadSchema<Record<string, unknown>>(
        paths.decision,
        "schemas/collection-runtime-stability-decision-v1.schema.json",
      );
    if (stableJson(regenerated) !== stableJson(recorded))
      throw new Error("COLLECTION_STABILITY_REPORT: decision differs");
    console.log(stableJson(regenerated));
  } else {
    const result = await runCollectionStabilityExperiment({
      benchmark: command !== "verify",
      record: command === "record",
    });
    if (command === "verify") {
      const observation = await loadSchema<RecordedObservation>(
          paths.observation,
          "schemas/collection-runtime-stability-observation-v1.schema.json",
        ),
        regenerated = await regenerateCollectionStabilityDecision(),
        recorded = await loadSchema<Record<string, unknown>>(
          paths.decision,
          "schemas/collection-runtime-stability-decision-v1.schema.json",
        );
      if (
        stableJson(result.deterministic) !==
        stableJson({
          sourceObservationHash: observation.sourceObservationHash,
          benchmarkHash: observation.benchmarkHash,
          workloadHash: observation.workloadHash,
          programs: observation.programs,
          cases: observation.cases,
        })
      )
        throw new Error(
          "COLLECTION_STABILITY_VERIFY: deterministic evidence differs",
        );
      if (
        stableJson(result.lifecycleSafety) !==
        stableJson(observation.lifecycleSafety)
      )
        throw new Error("COLLECTION_STABILITY_VERIFY: lifecycle differs");
      if (stableJson(regenerated) !== stableJson(recorded))
        throw new Error("COLLECTION_STABILITY_VERIFY: decision differs");
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
