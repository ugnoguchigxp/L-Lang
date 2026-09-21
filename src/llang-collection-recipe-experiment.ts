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
import { CollectionDirectHarness } from "./llang-collection-direct-harness";
import { measureCollectionCost } from "./llang-collection-cost";
import { parseStrictJsonObject } from "./llang-jsonc";
import { evaluateCollectionProgram } from "./llang-module-collection-evaluator";
import type { CheckedCollectionProgram } from "./llang-module-collection-ir";
import { loadCollectionModuleProgram } from "./llang-module-collection-loader";
import { instantiateCollectionModule } from "./llang-module-collection-runtime";
import {
  type emitCollectionModuleWasm,
  emitUnoptimizedCollectionModuleWasm,
} from "./llang-module-collection-wasm";
import {
  COLLECTION_BINARYEN_RECIPES,
  COLLECTION_BINARYEN_VERSION,
  canonicalCollectionBinaryenRecipe,
  collectionBinaryenRecipeHash,
  parseCollectionBinaryenRecipe,
  type CollectionBinaryenRecipe,
} from "./llang-collection-binaryen-recipe";
import {
  optimizeCollectionWasm,
  type OptimizedCollectionWasm,
} from "./llang-collection-optimized-wasm";
import {
  decideCollectionBinaryenRecipe,
  summarizeCollectionRecipeSamples,
  type CollectionRecipeSample,
} from "./llang-collection-recipe-report";
import { sha256, stableJson } from "./stable-hash";

type ProgramSpec = Readonly<{
  id: string;
  entry: string;
  root?: string;
  entryName: string;
  inputShape: "values" | "threshold" | "delta" | "scalar" | "string" | "union";
}>;
type CaseSpec = Readonly<{
  id: string;
  programId: string;
  partition: "correctness" | "exploration" | "holdout";
  size: number;
  pattern:
    | "ascending"
    | "reverse"
    | "cycle"
    | "alternating"
    | "duplicates"
    | "scalar";
}>;
type Corpus = Readonly<{
  format: "llang-collection-binaryen-corpus";
  version: 1;
  programs: ProgramSpec[];
  cases: CaseSpec[];
}>;
type Benchmark = Readonly<{
  format: "llang-collection-binaryen-benchmark";
  version: 1;
  seed: number;
  warmup: number;
  iterations: number;
  samples: number;
  canonicalEnvironment: {
    bun: "1.4.2";
    binaryen: "132.0.0";
    platform: "darwin";
    arch: "arm64";
    cpuIncludes: string;
  };
  limits: { optimizerTimeoutMs: number; artifactBytes: number };
  decision: {
    baselineRecipeId: "baseline-v1";
    maximumRegressionPercent: number;
    requiredImprovementPercent: number;
    maximumArtifactRatio: number;
    maximumMemoryRegressionPercent: number;
  };
}>;
type RecordedObservation = Readonly<{
  samples: CollectionRecipeSample[];
  canonical: boolean;
}>;
type RecordedFreeze = Readonly<{
  verification: Array<
    Readonly<{
      recipeId: string;
      correctness: boolean;
      rawAbi: boolean;
      reproducible: boolean;
    }>
  >;
}>;
type BuiltProgram = Readonly<{
  spec: ProgramSpec;
  program: CheckedCollectionProgram;
  contract: ReturnType<typeof emitCollectionModuleWasm>["contract"];
  loadMs: number;
  emitMs: number;
  artifacts: ReadonlyMap<
    string,
    Readonly<{
      bytes: Uint8Array;
      wasmHash: string;
      recipeHash: string;
      optimizeMs: number;
      phases: Readonly<{
        readMs: number;
        preValidationMs: number;
        optimizeMs: number;
        postValidationMs: number;
        emitMs: number;
      }>;
    }>
  >;
}>;

const repo = resolve(import.meta.dir, ".."),
  benchmarkRoot = join(repo, "benchmarks/collection-binaryen-v1"),
  hashBytes = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex"),
  resultShape = (result: ReturnType<CollectionDirectHarness["invoke"]>) => ({
    kind: result.kind,
    faultCode: result.faultCode,
    ...(result.kind === "return" ? { outputLength: result.outputLength } : {}),
    inputPreserved: result.inputHashBefore === result.inputHashAfter,
    outputPreserved: result.outputHashBefore === result.outputHashAfter,
  });

function strictJsonValue(text: string, file: string): unknown {
  parseStrictJsonObject(text, file);
  return JSON.parse(text);
}

export async function runCollectionRecipeExperiment(
  options: Readonly<{ benchmark?: boolean; record?: boolean }> = {},
): Promise<Record<string, unknown>> {
  const [corpus, benchmark, recipes] = await loadInputs();
  validateCorpusSemantics(corpus);
  const environment = currentEnvironment();
  if (
    (options.benchmark || options.record) &&
    !isCanonicalEnvironment(environment, benchmark)
  )
    throw new Error(
      "COLLECTION_BINARYEN_ENVIRONMENT: benchmark and record require Bun 1.4.2 on Apple M4 darwin-arm64",
    );
  const temporary = await mkdtemp(join(tmpdir(), "llang-collection-recipes-"));
  try {
    const first = await buildPrograms(
        corpus,
        recipes,
        benchmark,
        join(temporary, "first"),
        false,
      ),
      correctness = verifyCorrectness(first, corpus, recipes),
      rawAbi = verifyRawAbi(first, recipes),
      second = await buildPrograms(
        corpus,
        [...recipes].reverse(),
        benchmark,
        join(temporary, "second"),
        true,
      ),
      reproducibility = verifyReproducibility(first, second, recipes),
      verification = recipes.map((recipe) => ({
        recipeId: recipe.recipeId,
        correctness,
        rawAbi,
        reproducible: reproducibility,
      })),
      artifacts = describeArtifacts(first, recipes),
      freeze = {
        format: "llang-collection-binaryen-freeze",
        version: 1,
        createdOn: "2026-09-21",
        baselineRevision: "0da5caeff8a5d36b56620dd127912c2c4acf7ce0",
        inputs: {
          recipesHash: await fileHash(
            "benchmarks/collection-binaryen-v1/recipes.json",
          ),
          corpusHash: await fileHash(
            "benchmarks/collection-binaryen-v1/corpus.json",
          ),
          benchmarkHash: await fileHash(
            "benchmarks/collection-binaryen-v1/benchmark.json",
          ),
        },
        recipes: recipes.map((recipe) => ({
          recipeId: recipe.recipeId,
          recipeHash: collectionBinaryenRecipeHash(recipe),
        })),
        programs: first.map(({ spec, program }) => ({
          id: spec.id,
          programHash: program.programHash,
          loweredHash: program.loweredHash,
          interfaceHash: program.interfaceHash,
          layoutHash: program.layoutHash,
        })),
        artifacts,
        verification,
      };

    let observation: Record<string, unknown> | undefined,
      decision: Record<string, unknown> | undefined;
    if (options.benchmark || options.record) {
      const samples = await benchmarkPrograms(
          first,
          corpus,
          recipes,
          benchmark,
          join(temporary, "benchmark"),
        ),
        summary = summarizeCollectionRecipeSamples(samples);
      observation = {
        format: "llang-collection-binaryen-observation",
        version: 1,
        createdOn: "2026-09-21",
        canonical: isCanonicalEnvironment(environment, benchmark),
        environment,
        benchmark,
        samples,
        summary,
      };
      decision = {
        ...decideCollectionBinaryenRecipe(
          summary,
          verification,
          recipes.map((recipe) => recipe.recipeId),
          benchmark.decision,
        ),
        createdOn: "2026-09-21",
        canonical: isCanonicalEnvironment(environment, benchmark),
      };
    }

    await validateGenerated(freeze, observation, decision);
    if (options.record) {
      if (!observation || !decision)
        throw new Error(
          "COLLECTION_BINARYEN_RECORD: missing generated evidence",
        );
      await publishEvidence([
        {
          path: "benchmarks/collection-binaryen-v1/freeze.json",
          value: freeze,
        },
        {
          path: `benchmarks/collection-binaryen-v1/observations/${platform()}-${arch()}.json`,
          value: observation,
        },
        {
          path: "benchmarks/collection-binaryen-v1/decision.json",
          value: decision,
        },
      ]);
    }
    return { freeze, ...(observation ? { observation, decision } : {}) };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function loadInputs(): Promise<
  [Corpus, Benchmark, CollectionBinaryenRecipe[]]
> {
  const [corpus, benchmark, recipeFile] = await Promise.all([
    loadWithSchema<Corpus>(
      "benchmarks/collection-binaryen-v1/corpus.json",
      "schemas/collection-binaryen-corpus-v1.schema.json",
    ),
    loadWithSchema<Benchmark>(
      "benchmarks/collection-binaryen-v1/benchmark.json",
      "schemas/collection-binaryen-benchmark-v1.schema.json",
    ),
    loadWithSchema<{ recipes: unknown[] }>(
      "benchmarks/collection-binaryen-v1/recipes.json",
      "schemas/collection-binaryen-recipes-v1.schema.json",
      ["schemas/collection-binaryen-recipe-v1.schema.json"],
    ),
  ]);
  const recipes = recipeFile.recipes.map(parseCollectionBinaryenRecipe);
  if (
    recipes.length !== COLLECTION_BINARYEN_RECIPES.length ||
    recipes.some(
      (recipe, index) =>
        canonicalCollectionBinaryenRecipe(recipe) !==
        canonicalCollectionBinaryenRecipe(
          COLLECTION_BINARYEN_RECIPES[index] as CollectionBinaryenRecipe,
        ),
    )
  )
    throw new Error("INVALID_COLLECTION_BINARYEN_RECIPES: frozen set differs");
  return [corpus, benchmark, recipes];
}

function validateCorpusSemantics(corpus: Corpus): void {
  const programs = new Set(corpus.programs.map((program) => program.id)),
    cases = new Set(corpus.cases.map((testCase) => testCase.id));
  if (
    programs.size !== corpus.programs.length ||
    cases.size !== corpus.cases.length ||
    ![
      "fold",
      "map",
      "filter",
      "sort",
      "closure",
      "generic",
      "composite",
      "string",
      "union",
    ].every((id) => programs.has(id)) ||
    corpus.programs.some(
      (program) =>
        !corpus.cases.some((testCase) => testCase.programId === program.id),
    ) ||
    corpus.cases.some((testCase) => !programs.has(testCase.programId)) ||
    !corpus.cases.some((testCase) => testCase.partition === "exploration") ||
    !corpus.cases.some((testCase) => testCase.partition === "holdout") ||
    !corpus.cases.some((testCase) => testCase.partition === "correctness") ||
    !corpus.cases.some((testCase) => testCase.size === 4096)
  )
    throw new Error("INVALID_COLLECTION_BINARYEN_CORPUS: incomplete matrix");
}

async function buildPrograms(
  corpus: Corpus,
  recipes: readonly CollectionBinaryenRecipe[],
  benchmark: Benchmark,
  temporaryParent: string,
  concurrent: boolean,
): Promise<BuiltProgram[]> {
  await mkdir(temporaryParent, { recursive: true });
  const output: BuiltProgram[] = [];
  for (const spec of corpus.programs) {
    const root = resolve(benchmarkRoot, spec.root ?? ".");
    containedRelativePath(repo, root, "corpus root", "repository");
    const loadStart = performance.now(),
      program = await loadCollectionModuleProgram(
        spec.entry,
        root,
        spec.entryName,
      ),
      loadMs = performance.now() - loadStart,
      emitStart = performance.now(),
      baseline = emitUnoptimizedCollectionModuleWasm(program),
      emitMs = performance.now() - emitStart,
      build = (recipe: CollectionBinaryenRecipe) =>
        optimizeCollectionWasm(baseline.bytes, recipe, {
          timeoutMs: benchmark.limits.optimizerTimeoutMs,
          temporaryParent,
        });
    const built: OptimizedCollectionWasm[] = [];
    if (concurrent) built.push(...(await Promise.all(recipes.map(build))));
    else for (const recipe of recipes) built.push(await build(recipe));
    const artifacts = new Map(
      built.map((item) => [
        item.recipe.recipeId,
        {
          bytes: item.bytes,
          wasmHash: item.wasmHash,
          recipeHash: item.recipeHash,
          optimizeMs: item.optimizeMs,
          phases: item.phases,
        },
      ]),
    );
    if (
      [...artifacts.values()].some(
        (artifact) => artifact.bytes.length > benchmark.limits.artifactBytes,
      )
    )
      throw new Error("COLLECTION_BINARYEN_ARTIFACT_LIMIT");
    output.push({
      spec,
      program,
      contract: baseline.contract,
      loadMs,
      emitMs,
      artifacts,
    });
  }
  return output;
}

function verifyCorrectness(
  programs: readonly BuiltProgram[],
  corpus: Corpus,
  recipes: readonly CollectionBinaryenRecipe[],
): boolean {
  const byId = new Map(programs.map((program) => [program.spec.id, program]));
  for (const testCase of corpus.cases) {
    const built = byId.get(testCase.programId);
    if (!built) throw new Error(`missing program ${testCase.programId}`);
    const input = materializeInput(built.spec, testCase),
      reference = evaluateCollectionProgram(built.program, input);
    for (const recipe of recipes) {
      const artifact = built.artifacts.get(recipe.recipeId);
      if (!artifact) throw new Error(`missing artifact ${recipe.recipeId}`);
      const actual = instantiateCollectionModule(
        built.contract,
        artifact.bytes,
      ).evaluate(input);
      if (stableJson(actual) !== stableJson(reference))
        throw new Error(
          `COLLECTION_BINARYEN_DIFFERENTIAL: ${testCase.id}/${recipe.recipeId}`,
        );
    }
  }
  const fold = byId.get("fold");
  if (!fold) throw new Error("missing fold program");
  const faultInput = { values: [2_147_483_647, 1, -1] },
    expectedFault = captureFault(() =>
      evaluateCollectionProgram(fold.program, faultInput),
    );
  for (const recipe of recipes) {
    const artifact = fold.artifacts.get(recipe.recipeId);
    if (!artifact) throw new Error("missing fold artifact");
    const actualFault = captureFault(() =>
      instantiateCollectionModule(fold.contract, artifact.bytes).evaluate(
        faultInput,
      ),
    );
    if (actualFault !== expectedFault)
      throw new Error(`COLLECTION_BINARYEN_FAULT: ${recipe.recipeId}`);
  }
  return true;
}

function verifyRawAbi(
  programs: readonly BuiltProgram[],
  recipes: readonly CollectionBinaryenRecipe[],
): boolean {
  const probes = [
    [-16, 32, 524_288, 262_144],
    [64, 4, 524_288, 262_144],
    [64, 32, 64, 64],
    [64, 32, 80, 64],
    [8_388_604, 8, 524_288, 262_144],
    [64, 32, 8_388_604, 8],
  ] as const;
  for (const built of programs) {
    const baselineArtifact = built.artifacts.get("baseline-v1");
    if (!baselineArtifact) throw new Error("missing baseline");
    for (const probe of probes) {
      const [input, inputLength, output, outputCapacity] = probe;
      const baseline = resultShape(
        new CollectionDirectHarness(
          built.contract,
          baselineArtifact.bytes,
        ).invoke(input, inputLength, output, outputCapacity),
      );
      if (!(inputLength === 4 && built.spec.inputShape === "scalar"))
        assertExpectedAbiFailure(
          baseline,
          `${built.spec.id}/${probe.join(",")}`,
        );
      for (const recipe of recipes) {
        const artifact = built.artifacts.get(recipe.recipeId);
        if (!artifact) throw new Error("missing candidate");
        const actual = resultShape(
          new CollectionDirectHarness(built.contract, artifact.bytes).invoke(
            input,
            inputLength,
            output,
            outputCapacity,
          ),
        );
        if (stableJson(actual) !== stableJson(baseline))
          throw new Error(
            `COLLECTION_BINARYEN_RAW_ABI: ${built.spec.id}/${recipe.recipeId}`,
          );
      }
    }
    if (built.spec.id === "string" || built.spec.id === "union") {
      const mutate = (harness: CollectionDirectHarness) => {
          const length = harness.encodeInput(
              built.spec.id === "string"
                ? { value: "x" }
                : { tag: "Value", text: "x" },
            ),
            view = new DataView(harness.memory.buffer);
          if (built.spec.id === "string") {
            const pointer = view.getUint32(64, true);
            harness.memory[pointer] = 0x80;
          } else view.setUint32(64, 2, true);
          return resultShape(harness.invoke(64, length));
        },
        expected = mutate(
          new CollectionDirectHarness(built.contract, baselineArtifact.bytes),
        );
      assertExpectedAbiFailure(expected, built.spec.id);
      for (const recipe of recipes) {
        const artifact = built.artifacts.get(recipe.recipeId);
        if (!artifact) throw new Error("missing nested ABI candidate");
        const actual = mutate(
          new CollectionDirectHarness(built.contract, artifact.bytes),
        );
        if (stableJson(actual) !== stableJson(expected))
          throw new Error(
            `COLLECTION_BINARYEN_NESTED_ABI: ${built.spec.id}/${recipe.recipeId}`,
          );
      }
    }
  }
  return true;
}

function assertExpectedAbiFailure(
  result: ReturnType<typeof resultShape>,
  programId: string,
): void {
  if (
    result.kind !== "trap" ||
    result.faultCode !== 5 ||
    !result.inputPreserved ||
    !result.outputPreserved
  )
    throw new Error(`COLLECTION_BINARYEN_RAW_ABI_BASELINE: ${programId}`);
}

function verifyReproducibility(
  first: readonly BuiltProgram[],
  second: readonly BuiltProgram[],
  recipes: readonly CollectionBinaryenRecipe[],
): boolean {
  const secondById = new Map(
    second.map((program) => [program.spec.id, program]),
  );
  for (const program of first) {
    const repeated = secondById.get(program.spec.id);
    if (!repeated) throw new Error("missing repeated program");
    for (const recipe of recipes)
      if (
        program.artifacts.get(recipe.recipeId)?.wasmHash !==
        repeated.artifacts.get(recipe.recipeId)?.wasmHash
      )
        throw new Error(
          `COLLECTION_BINARYEN_REPRODUCIBILITY: ${program.spec.id}/${recipe.recipeId}`,
        );
  }
  return true;
}

async function benchmarkPrograms(
  programs: readonly BuiltProgram[],
  corpus: Corpus,
  recipes: readonly CollectionBinaryenRecipe[],
  benchmark: Benchmark,
  temporaryParent: string,
): Promise<CollectionRecipeSample[]> {
  await mkdir(temporaryParent, { recursive: true });
  const byId = new Map(programs.map((program) => [program.spec.id, program])),
    samples: CollectionRecipeSample[] = [];
  let benchmarkCaseIndex = 0;
  for (const testCase of corpus.cases) {
    if (testCase.partition === "correctness") continue;
    const built = byId.get(testCase.programId);
    if (!built) throw new Error("missing benchmark program");
    const input = materializeInput(built.spec, testCase),
      diagnostics = measureCollectionCost(built.program, input).metrics,
      offset = (benchmark.seed + benchmarkCaseIndex++) % recipes.length,
      ordered = [...recipes.slice(offset), ...recipes.slice(0, offset)];
    for (const recipe of ordered) {
      const artifact = built.artifacts.get(recipe.recipeId);
      if (!artifact) throw new Error("missing benchmark artifact");
      const measured = await benchmarkArtifactInChild(
        artifact.bytes,
        built.contract,
        input,
        benchmark,
        temporaryParent,
      );
      for (const timing of measured.timings)
        samples.push({
          caseId: testCase.id,
          partition: testCase.partition,
          recipeId: recipe.recipeId,
          sample: timing.sample,
          buildMs: built.loadMs + built.emitMs + artifact.optimizeMs,
          loadMs: built.loadMs,
          emitMs: built.emitMs,
          optimizerReadMs: artifact.phases.readMs,
          optimizerPreValidationMs: artifact.phases.preValidationMs,
          optimizerCoreMs: artifact.phases.optimizeMs,
          optimizerPostValidationMs: artifact.phases.postValidationMs,
          optimizerEmitMs: artifact.phases.emitMs,
          compileMs: timing.compileMs,
          instantiateMs: timing.instantiateMs,
          encodeMs: timing.encodeMs,
          hostValidationMs: timing.hostValidationMs,
          evaluateMs: timing.evaluateMs,
          decodeMs: timing.decodeMs,
          endToEndMs: timing.endToEndMs,
          artifactBytes: artifact.bytes.length,
          linearMemoryBytes: 128 * 65_536,
          arenaPeakBytes: diagnostics.arenaPeakBytes,
          allocationCalls: diagnostics.allocationCalls,
          allocationBytes: diagnostics.alignedBytes,
          copyCalls: diagnostics.copyCalls,
          copyBytes: diagnostics.copyBytes,
          peakRssBytes: measured.peakRssBytes,
        });
    }
  }
  return samples;
}

type ChildBenchmarkResult = Readonly<{
  timings: ReadonlyArray<
    Readonly<{
      sample: number;
      compileMs: number;
      instantiateMs: number;
      encodeMs: number;
      hostValidationMs: number;
      evaluateMs: number;
      decodeMs: number;
      endToEndMs: number;
    }>
  >;
  peakRssBytes: number;
}>;

async function benchmarkArtifactInChild(
  wasm: Uint8Array,
  contract: BuiltProgram["contract"],
  input: unknown,
  benchmark: Benchmark,
  temporaryParent: string,
): Promise<ChildBenchmarkResult> {
  const root = await mkdtemp(join(temporaryParent, "measurement-"));
  try {
    const wasmPath = join(root, "input.wasm"),
      contractPath = join(root, "contract.json"),
      inputPath = join(root, "input.json"),
      requestPath = join(root, "request.json"),
      outputPath = join(root, "output.json");
    await Promise.all([
      writeFile(wasmPath, wasm, { flag: "wx", mode: 0o600 }),
      writeFile(contractPath, stableJson(contract), {
        flag: "wx",
        mode: 0o600,
      }),
      writeFile(inputPath, stableJson(input), { flag: "wx", mode: 0o600 }),
      writeFile(
        requestPath,
        stableJson({
          warmup: benchmark.warmup,
          iterations: benchmark.iterations,
          samples: benchmark.samples,
        }),
        { flag: "wx", mode: 0o600 },
      ),
    ]);
    const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "llang-collection-benchmark-child.ts"),
          wasmPath,
          contractPath,
          inputPath,
          requestPath,
          outputPath,
        ],
        {
          cwd: root,
          env: process.env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      ),
      timeoutMs = Math.max(30_000, benchmark.limits.optimizerTimeoutMs);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    let stdout: Uint8Array, stderr: Uint8Array, exitCode: number;
    try {
      [stdout, stderr, exitCode] = await Promise.all([
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
    if (timedOut) throw new Error("COLLECTION_BENCHMARK_TIMEOUT");
    if (exitCode !== 0)
      throw new Error(
        `COLLECTION_BENCHMARK_FAILED: ${new TextDecoder().decode(stderr).slice(0, 4096)}`,
      );
    if (stdout.length)
      throw new Error("COLLECTION_BENCHMARK_PROTOCOL: unexpected stdout");
    const outputInfo = await lstat(outputPath).catch(() => undefined);
    if (
      !outputInfo?.isFile() ||
      outputInfo.isSymbolicLink() ||
      outputInfo.size > 1024 * 1024
    )
      throw new Error("COLLECTION_BENCHMARK_PROTOCOL: invalid output");
    return parseChildBenchmarkResult(
      strictJsonValue(await readFile(outputPath, "utf8"), outputPath),
      benchmark.samples,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function parseChildBenchmarkResult(
  candidate: unknown,
  expectedSamples: number,
): ChildBenchmarkResult {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    throw new Error("COLLECTION_BENCHMARK_PROTOCOL: expected object");
  const value = candidate as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(",") !== "peakRssBytes,timings" ||
    !Number.isSafeInteger(value.peakRssBytes) ||
    (value.peakRssBytes as number) <= 0 ||
    !Array.isArray(value.timings) ||
    value.timings.length !== expectedSamples
  )
    throw new Error("COLLECTION_BENCHMARK_PROTOCOL: invalid result");
  const timings = value.timings.map((candidateRow, index) => {
    if (
      !candidateRow ||
      typeof candidateRow !== "object" ||
      Array.isArray(candidateRow)
    )
      throw new Error("COLLECTION_BENCHMARK_PROTOCOL: invalid timing");
    const row = candidateRow as Record<string, unknown>;
    if (
      Object.keys(row).sort().join(",") !==
        "compileMs,decodeMs,encodeMs,endToEndMs,evaluateMs,hostValidationMs,instantiateMs,sample" ||
      row.sample !== index ||
      [
        "compileMs",
        "instantiateMs",
        "encodeMs",
        "hostValidationMs",
        "evaluateMs",
        "decodeMs",
        "endToEndMs",
      ].some(
        (key) =>
          typeof row[key] !== "number" ||
          !Number.isFinite(row[key]) ||
          (row[key] as number) < 0,
      )
    )
      throw new Error("COLLECTION_BENCHMARK_PROTOCOL: invalid timing");
    return row as ChildBenchmarkResult["timings"][number];
  });
  return Object.freeze({
    timings: Object.freeze(timings),
    peakRssBytes: value.peakRssBytes as number,
  });
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > limit) throw new Error("COLLECTION_BENCHMARK_OUTPUT_LIMIT");
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

function materializeInput(spec: ProgramSpec, testCase: CaseSpec): unknown {
  if (spec.inputShape === "scalar") return { value: 1_234_567 };
  if (spec.inputShape === "string") return { value: "A😀境界" };
  if (spec.inputShape === "union") return { tag: "Value", text: "x" };
  const values = Array.from({ length: testCase.size }, (_, index) => {
    switch (testCase.pattern) {
      case "ascending":
        return index % 1_000;
      case "reverse":
        return (testCase.size - index) % 1_000;
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

function describeArtifacts(
  programs: readonly BuiltProgram[],
  recipes: readonly CollectionBinaryenRecipe[],
) {
  return programs.flatMap((program) =>
    recipes.map((recipe) => {
      const artifact = program.artifacts.get(recipe.recipeId);
      if (!artifact) throw new Error("missing described artifact");
      return {
        programId: program.spec.id,
        recipeId: recipe.recipeId,
        recipeHash: artifact.recipeHash,
        wasmHash: artifact.wasmHash,
        bytes: artifact.bytes.length,
      };
    }),
  );
}

function currentEnvironment() {
  return {
    bun: Bun.version,
    binaryen: COLLECTION_BINARYEN_VERSION,
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    cpu: cpus()[0]?.model ?? "unknown",
  };
}

function isCanonicalEnvironment(
  environment: ReturnType<typeof currentEnvironment>,
  benchmark: Benchmark,
): boolean {
  const expected = benchmark.canonicalEnvironment;
  return (
    environment.bun === expected.bun &&
    environment.binaryen === expected.binaryen &&
    environment.platform === expected.platform &&
    environment.arch === expected.arch &&
    environment.cpu.includes(expected.cpuIncludes)
  );
}

async function loadWithSchema<T>(
  valuePath: string,
  schemaPath: string,
  references: readonly string[] = [],
): Promise<T> {
  const [valueText, schemaText, ...referenceTexts] = await Promise.all([
      readFile(join(repo, valuePath), "utf8"),
      readFile(join(repo, schemaPath), "utf8"),
      ...references.map((path) => readFile(join(repo, path), "utf8")),
    ]),
    value = strictJsonValue(valueText, valuePath),
    schema = JSON.parse(schemaText),
    ajv = new Ajv2020({ strict: true, allErrors: true });
  for (const text of referenceTexts) ajv.addSchema(JSON.parse(text));
  const validate = ajv.compile(schema);
  if (!validate(value))
    throw new Error(
      `INVALID_COLLECTION_BINARYEN_INPUT: ${valuePath}: ${ajv.errorsText(validate.errors)}`,
    );
  return value as T;
}

async function validateGenerated(
  freeze: Record<string, unknown>,
  observation?: Record<string, unknown>,
  decision?: Record<string, unknown>,
): Promise<void> {
  const items: Array<readonly [Record<string, unknown>, string]> = [
    [freeze, "schemas/collection-binaryen-freeze-v1.schema.json"],
  ];
  if (observation)
    items.push([
      observation,
      "schemas/collection-binaryen-observation-v1.schema.json",
    ]);
  if (decision)
    items.push([
      decision,
      "schemas/collection-binaryen-decision-v1.schema.json",
    ]);
  for (const [value, schemaPath] of items) {
    const schema = JSON.parse(await readFile(join(repo, schemaPath), "utf8")),
      ajv = new Ajv2020({ strict: true, allErrors: true }),
      validate = ajv.compile(schema);
    if (!validate(value))
      throw new Error(
        `INVALID_COLLECTION_BINARYEN_OUTPUT: ${schemaPath}: ${ajv.errorsText(validate.errors)}`,
      );
  }
}

async function fileHash(path: string): Promise<string> {
  return hashBytes(new Uint8Array(await readFile(join(repo, path))));
}

async function publishEvidence(
  entries: ReadonlyArray<Readonly<{ path: string; value: unknown }>>,
): Promise<void> {
  const snapshots = new Map<string, Uint8Array | undefined>();
  for (const entry of entries) {
    const absolute = join(repo, entry.path);
    await mkdir(dirname(absolute), { recursive: true });
    snapshots.set(
      absolute,
      await readFile(absolute).catch((error: unknown) => {
        if (hasErrorCode(error, "ENOENT")) return undefined;
        throw error;
      }),
    );
  }
  const written: string[] = [];
  try {
    for (const entry of entries) {
      const absolute = join(repo, entry.path);
      written.push(absolute);
      await atomicWriteJson(absolute, entry.value);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const absolute of written.reverse()) {
      try {
        const snapshot = snapshots.get(absolute);
        if (snapshot) await atomicWriteFile(absolute, snapshot);
        else
          await unlink(absolute).catch((unlinkError: unknown) => {
            if (!hasErrorCode(unlinkError, "ENOENT")) throw unlinkError;
          });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length)
      throw new AggregateError(
        [error, ...rollbackErrors],
        "COLLECTION_BINARYEN_RECORD: publication and rollback failed",
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

export async function regenerateCollectionRecipeDecision(): Promise<
  Record<string, unknown>
> {
  const [observation, freeze, benchmark, recipes] = await Promise.all([
    loadWithSchema<RecordedObservation>(
      "benchmarks/collection-binaryen-v1/observations/darwin-arm64.json",
      "schemas/collection-binaryen-observation-v1.schema.json",
    ),
    loadWithSchema<RecordedFreeze>(
      "benchmarks/collection-binaryen-v1/freeze.json",
      "schemas/collection-binaryen-freeze-v1.schema.json",
    ),
    loadWithSchema<Benchmark>(
      "benchmarks/collection-binaryen-v1/benchmark.json",
      "schemas/collection-binaryen-benchmark-v1.schema.json",
    ),
    loadInputs().then((loaded) => loaded[2]),
  ]);
  const decision = {
    ...decideCollectionBinaryenRecipe(
      summarizeCollectionRecipeSamples(observation.samples),
      freeze.verification,
      recipes.map((recipe) => recipe.recipeId),
      benchmark.decision,
    ),
    createdOn: "2026-09-21",
    canonical: observation.canonical,
  };
  return decision;
}

if (import.meta.main) {
  const [command, ...extra] = process.argv.slice(2);
  if (
    !command ||
    extra.length ||
    !["verify", "benchmark", "record", "report"].includes(command)
  )
    throw new Error(
      "usage: llang-collection-recipe-experiment <verify|benchmark|record|report>",
    );
  if (command === "report") {
    const regenerated = await regenerateCollectionRecipeDecision(),
      recorded = await loadWithSchema<Record<string, unknown>>(
        "benchmarks/collection-binaryen-v1/decision.json",
        "schemas/collection-binaryen-decision-v1.schema.json",
      );
    if (stableJson(regenerated) !== stableJson(recorded))
      throw new Error("COLLECTION_BINARYEN_REPORT: recorded decision differs");
    console.log(stableJson(regenerated));
  } else {
    const result = await runCollectionRecipeExperiment({
      benchmark: command !== "verify",
      record: command === "record",
    });
    if (command === "verify") {
      const recorded = await loadWithSchema<Record<string, unknown>>(
        "benchmarks/collection-binaryen-v1/freeze.json",
        "schemas/collection-binaryen-freeze-v1.schema.json",
      );
      if (stableJson(result.freeze) !== stableJson(recorded))
        throw new Error(
          "COLLECTION_BINARYEN_VERIFY: recorded freeze differs from regenerated evidence",
        );
    }
    console.log(
      JSON.stringify(
        {
          command,
          freezeHash: sha256(stableJson(result.freeze)),
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
