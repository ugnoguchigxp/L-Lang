import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { decodeCollectionFromMemory } from "./llang-collection-abi";
import { CollectionDirectHarness } from "./llang-collection-direct-harness";
import { parseStrictJsonObject } from "./llang-jsonc";
import {
  assertCollectionWasmBinary,
  assertCollectionWasmContract,
  instantiateCollectionModule,
} from "./llang-module-collection-runtime";
import type { CollectionWasmContract } from "./llang-module-collection-wasm";

const MAX_WASM_BYTES = 4 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;

type BenchmarkRequest = Readonly<{
  warmup: number;
  iterations: number;
  samples: number;
}>;

export async function runCollectionBenchmarkChild(
  wasmArgument: string,
  contractArgument: string,
  inputArgument: string,
  requestArgument: string,
  outputArgument: string,
): Promise<void> {
  const paths = [
      wasmArgument,
      contractArgument,
      inputArgument,
      requestArgument,
      outputArgument,
    ].map((path) => resolve(path)),
    parents = await Promise.all(paths.map((path) => realpath(dirname(path))));
  if (new Set(parents).size !== 1)
    throw new Error("COLLECTION_BENCHMARK_PATH: files must share one root");
  const [wasm, contractPath, inputPath, requestPath, output] = paths,
    [wasmInfo, contractInfo, inputInfo, requestInfo, outputInfo] =
      await Promise.all([
        lstat(wasm as string),
        lstat(contractPath as string),
        lstat(inputPath as string),
        lstat(requestPath as string),
        lstat(output as string).catch(() => undefined),
      ]);
  if (
    [wasmInfo, contractInfo, inputInfo, requestInfo].some(
      (info) => !info.isFile() || info.isSymbolicLink(),
    ) ||
    outputInfo ||
    wasmInfo.size > MAX_WASM_BYTES ||
    [contractInfo, inputInfo, requestInfo].some(
      (info) => info.size > MAX_JSON_BYTES,
    )
  )
    throw new Error("COLLECTION_BENCHMARK_PATH: invalid input or output");
  const [wasmBytes, contractText, inputText, requestText] = await Promise.all([
      readFile(wasm as string),
      readFile(contractPath as string, "utf8"),
      readFile(inputPath as string, "utf8"),
      readFile(requestPath as string, "utf8"),
    ]),
    contract = parseStrictJsonObject(
      contractText,
      contractPath as string,
    ) as CollectionWasmContract,
    input = parseStrictJsonObject(inputText, inputPath as string),
    request = parseRequest(
      parseStrictJsonObject(requestText, requestPath as string),
    );
  assertCollectionWasmContract(contract);
  assertCollectionWasmBinary(wasmBytes);

  const timings: Array<{
    sample: number;
    compileMs: number;
    instantiateMs: number;
    encodeMs: number;
    hostValidationMs: number;
    evaluateMs: number;
    decodeMs: number;
    endToEndMs: number;
  }> = [];
  for (let sample = 0; sample < request.samples; sample++) {
    for (let warmup = 0; warmup < request.warmup; warmup++)
      instantiateCollectionModule(contract, wasmBytes).evaluate(input);
    const compileStart = performance.now(),
      module = new WebAssembly.Module(wasmBytes as BufferSource),
      compileMs = performance.now() - compileStart,
      instantiateStart = performance.now(),
      instance = new WebAssembly.Instance(module, {}),
      instantiateMs = performance.now() - instantiateStart;
    void instance;
    const harness = new CollectionDirectHarness(contract, wasmBytes),
      encodeStart = performance.now(),
      inputLength = harness.encodeInput(input),
      encodeMs = performance.now() - encodeStart,
      hostValidationStart = performance.now();
    decodeCollectionFromMemory(
      harness.memory,
      contract.inputType,
      64,
      inputLength,
    );
    const hostValidationMs = performance.now() - hostValidationStart,
      evaluateStart = performance.now();
    let outputLength = 0;
    for (let iteration = 0; iteration < request.iterations; iteration++) {
      const result = harness.invoke(64, inputLength);
      if (result.kind !== "return")
        throw new Error("COLLECTION_BINARYEN_BENCHMARK: candidate trapped");
      outputLength = result.outputLength;
    }
    const evaluateMs = (performance.now() - evaluateStart) / request.iterations,
      decodeStart = performance.now(),
      decoded = harness.decodeOutput(524_288, outputLength),
      decodeMs = performance.now() - decodeStart,
      endToEndStart = performance.now();
    void decoded;
    for (let iteration = 0; iteration < request.iterations; iteration++)
      instantiateCollectionModule(contract, wasmBytes).evaluate(input);
    timings.push({
      sample,
      compileMs,
      instantiateMs,
      encodeMs,
      hostValidationMs,
      evaluateMs,
      decodeMs,
      endToEndMs: (performance.now() - endToEndStart) / request.iterations,
    });
  }
  const reportedMaxRss = process.resourceUsage().maxRSS,
    currentRss = process.memoryUsage.rss(),
    peakRssBytes = Math.round(
      reportedMaxRss < currentRss / 128
        ? reportedMaxRss * 1024
        : reportedMaxRss,
    );
  if (!Number.isSafeInteger(peakRssBytes) || peakRssBytes <= 0)
    throw new Error("COLLECTION_BINARYEN_BENCHMARK: invalid peak RSS");
  await writeFile(
    output as string,
    `${JSON.stringify({ timings, peakRssBytes })}\n`,
    { flag: "wx", mode: 0o600 },
  );
}

function parseRequest(candidate: unknown): BenchmarkRequest {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    throw new Error("COLLECTION_BENCHMARK_REQUEST: expected object");
  const value = candidate as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(",") !== "iterations,samples,warmup" ||
    !Number.isSafeInteger(value.warmup) ||
    (value.warmup as number) < 0 ||
    (value.warmup as number) > 100 ||
    !Number.isSafeInteger(value.iterations) ||
    (value.iterations as number) < 1 ||
    (value.iterations as number) > 10_000 ||
    !Number.isSafeInteger(value.samples) ||
    (value.samples as number) < 1 ||
    (value.samples as number) > 100
  )
    throw new Error("COLLECTION_BENCHMARK_REQUEST: invalid request");
  return value as BenchmarkRequest;
}

if (import.meta.main) {
  const [wasm, contract, input, request, output, ...extra] =
    process.argv.slice(2);
  if (!wasm || !contract || !input || !request || !output || extra.length)
    throw new Error(
      "usage: llang-collection-benchmark-child <input.wasm> <contract.json> <input.json> <request.json> <output.json>",
    );
  await runCollectionBenchmarkChild(wasm, contract, input, request, output);
}
