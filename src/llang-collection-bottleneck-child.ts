import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  decodeCollectionFromMemory,
  encodeCollectionToMemory,
} from "./llang-collection-abi";
import { parseStrictJsonObject } from "./llang-jsonc";
import { COLLECTION_LIMITS } from "./llang-module-collection-ir";
import {
  assertCollectionWasmBinary,
  assertCollectionWasmContract,
} from "./llang-module-collection-runtime";
import type { CollectionWasmContract } from "./llang-module-collection-wasm";
import { stableJson } from "./stable-hash";

const MAX_WASM_BYTES = 4 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const INPUT_BASE = 64;
const OUTPUT_BASE = 524_288;

type Request = Readonly<{ warmup: number; samples: number }>;
type NativeExports = Readonly<{
  memory: WebAssembly.Memory;
  evaluate: (
    input: number,
    inputLength: number,
    output: number,
    capacity: number,
  ) => number;
  fault_code: () => number;
}>;

export type CollectionBottleneckTiming = Readonly<{
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

const now = () => process.hrtime.bigint();
const elapsed = (start: bigint) => {
  const value = Number(now() - start);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("COLLECTION_BOTTLENECK_CLOCK: invalid duration");
  return value;
};

function trace(
  bytes: Uint8Array,
  contract: CollectionWasmContract,
  input: unknown,
  expected: unknown,
  sample: number,
  cached?: WebAssembly.Module,
): CollectionBottleneckTiming {
  const totalStart = now();
  let compileNs = 0;
  let module = cached;
  if (!module) {
    const start = now();
    module = assertCollectionWasmBinary(bytes);
    compileNs = elapsed(start);
  }
  const instantiateStart = now(),
    instance = new WebAssembly.Instance(module, {}),
    exports = instance.exports as unknown as NativeExports;
  if (
    !(exports.memory instanceof WebAssembly.Memory) ||
    typeof exports.evaluate !== "function" ||
    typeof exports.fault_code !== "function"
  )
    throw new Error("COLLECTION_BOTTLENECK_ARTIFACT: invalid exports");
  const memory = new Uint8Array(exports.memory.buffer),
    instantiateNs = elapsed(instantiateStart),
    encodeStart = now(),
    inputBytes = encodeCollectionToMemory(
      memory,
      contract.inputType,
      input,
      INPUT_BASE,
      COLLECTION_LIMITS.wireBytes,
    ),
    encodeNs = elapsed(encodeStart),
    validationStart = now();
  const validatedInput = decodeCollectionFromMemory(
    memory,
    contract.inputType,
    INPUT_BASE,
    inputBytes,
  );
  void validatedInput;
  const hostValidationNs = elapsed(validationStart),
    evaluateStart = now();
  let outputBytes: number;
  try {
    outputBytes = Number(
      exports.evaluate(
        INPUT_BASE,
        inputBytes,
        OUTPUT_BASE,
        COLLECTION_LIMITS.wireBytes,
      ),
    );
  } catch (error) {
    throw new Error(
      `COLLECTION_BOTTLENECK_EVALUATE: fault ${exports.fault_code()}: ${String(error)}`,
    );
  }
  if (
    !Number.isSafeInteger(outputBytes) ||
    outputBytes <= 0 ||
    outputBytes > COLLECTION_LIMITS.wireBytes
  )
    throw new Error("COLLECTION_BOTTLENECK_EVALUATE: invalid output length");
  const evaluateNs = elapsed(evaluateStart),
    decodeStart = now();
  const output = decodeCollectionFromMemory(
    memory,
    contract.outputType,
    OUTPUT_BASE,
    outputBytes,
  );
  const decodeNs = elapsed(decodeStart),
    totalNs = elapsed(totalStart),
    accountedNs =
      compileNs +
      instantiateNs +
      encodeNs +
      hostValidationNs +
      evaluateNs +
      decodeNs,
    unattributedNs = totalNs - accountedNs;
  if (unattributedNs < 0)
    throw new Error("COLLECTION_BOTTLENECK_CLOCK: phase total exceeds trace");
  if (stableJson(output) !== stableJson(expected))
    throw new Error("COLLECTION_BOTTLENECK_CORRECTNESS: output mismatch");
  return Object.freeze({
    sample,
    compileNs,
    instantiateNs,
    encodeNs,
    hostValidationNs,
    evaluateNs,
    decodeNs,
    totalNs,
    accountedNs,
    unattributedNs,
    inputBytes,
    outputBytes,
  });
}

function clockOverheadNs(): number {
  const values = Array.from({ length: 1001 }, () => {
    const start = now();
    return elapsed(start);
  }).sort((left, right) => left - right);
  return values[Math.floor(values.length / 2)] as number;
}

export async function runCollectionBottleneckChild(
  wasmArgument: string,
  contractArgument: string,
  inputArgument: string,
  expectedArgument: string,
  requestArgument: string,
  outputArgument: string,
): Promise<void> {
  const paths = [
      wasmArgument,
      contractArgument,
      inputArgument,
      expectedArgument,
      requestArgument,
      outputArgument,
    ].map((path) => resolve(path)),
    parents = await Promise.all(paths.map((path) => realpath(dirname(path))));
  if (new Set(parents).size !== 1)
    throw new Error("COLLECTION_BOTTLENECK_PATH: files must share one root");
  const [
      wasmPath,
      contractPath,
      inputPath,
      expectedPath,
      requestPath,
      outputPath,
    ] = paths,
    [wasmInfo, contractInfo, inputInfo, expectedInfo, requestInfo, outputInfo] =
      await Promise.all([
        lstat(wasmPath as string),
        lstat(contractPath as string),
        lstat(inputPath as string),
        lstat(expectedPath as string),
        lstat(requestPath as string),
        lstat(outputPath as string).catch(() => undefined),
      ]);
  if (
    [wasmInfo, contractInfo, inputInfo, expectedInfo, requestInfo].some(
      (info) => !info.isFile() || info.isSymbolicLink(),
    ) ||
    outputInfo ||
    wasmInfo.size > MAX_WASM_BYTES ||
    [contractInfo, inputInfo, expectedInfo, requestInfo].some(
      (info) => info.size > MAX_JSON_BYTES,
    )
  )
    throw new Error("COLLECTION_BOTTLENECK_PATH: invalid input or output");
  const [bytes, contractText, inputText, expectedText, requestText] =
      await Promise.all([
        readFile(wasmPath as string),
        readFile(contractPath as string, "utf8"),
        readFile(inputPath as string, "utf8"),
        readFile(expectedPath as string, "utf8"),
        readFile(requestPath as string, "utf8"),
      ]),
    contract = parseStrictJsonObject(
      contractText,
      contractPath as string,
    ) as CollectionWasmContract,
    input = parseStrictJsonObject(inputText, inputPath as string),
    expectedEnvelope = parseStrictJsonObject(
      expectedText,
      expectedPath as string,
    ),
    request = parseRequest(
      parseStrictJsonObject(requestText, requestPath as string),
    );
  if (
    !expectedEnvelope ||
    typeof expectedEnvelope !== "object" ||
    Array.isArray(expectedEnvelope) ||
    Object.keys(expectedEnvelope).join(",") !== "value"
  )
    throw new Error("COLLECTION_BOTTLENECK_EXPECTED: invalid envelope");
  const expected = (expectedEnvelope as { value: unknown }).value;
  assertCollectionWasmContract(contract);
  assertCollectionWasmBinary(bytes);
  for (let index = 0; index < request.warmup; index++)
    trace(bytes, contract, input, expected, index);
  const cachedModule = new WebAssembly.Module(bytes as BufferSource);
  for (let index = 0; index < request.warmup; index++)
    trace(bytes, contract, input, expected, index, cachedModule);
  const cold: CollectionBottleneckTiming[] = [],
    cached: CollectionBottleneckTiming[] = [];
  for (let sample = 0; sample < request.samples; sample++) {
    cold.push(trace(bytes, contract, input, expected, sample));
    cached.push(trace(bytes, contract, input, expected, sample, cachedModule));
  }
  await writeFile(
    outputPath as string,
    `${JSON.stringify({ clockOverheadNs: clockOverheadNs(), cold, cached })}\n`,
    { flag: "wx", mode: 0o600 },
  );
}

function parseRequest(candidate: unknown): Request {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    throw new Error("COLLECTION_BOTTLENECK_REQUEST: expected object");
  const value = candidate as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(",") !== "samples,warmup" ||
    !Number.isSafeInteger(value.warmup) ||
    (value.warmup as number) < 0 ||
    (value.warmup as number) > 20 ||
    !Number.isSafeInteger(value.samples) ||
    (value.samples as number) < 1 ||
    (value.samples as number) > 100
  )
    throw new Error("COLLECTION_BOTTLENECK_REQUEST: invalid request");
  return value as Request;
}

if (import.meta.main) {
  const [wasm, contract, input, expected, request, output, ...extra] =
    process.argv.slice(2);
  if (
    !wasm ||
    !contract ||
    !input ||
    !expected ||
    !request ||
    !output ||
    extra.length
  )
    throw new Error(
      "usage: llang-collection-bottleneck-child <input.wasm> <contract.json> <input.json> <expected.json> <request.json> <output.json>",
    );
  await runCollectionBottleneckChild(
    wasm,
    contract,
    input,
    expected,
    request,
    output,
  );
}
