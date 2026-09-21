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

const MAX_WASM_BYTES = 4 * 1024 * 1024,
  MAX_JSON_BYTES = 1024 * 1024,
  INPUT_BASE = 64,
  OUTPUT_BASE = 524_288;
type Lane = "cold" | "module-cached";
type Request = Readonly<{
  warmup: number;
  samples: number;
  laneOrder: readonly [Lane, Lane];
}>;
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

const now = () => process.hrtime.bigint();
const elapsed = (start: bigint) => {
  const value = Number(now() - start);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("COLLECTION_STABILITY_CLOCK: invalid duration");
  return value;
};

function trace(
  bytes: Uint8Array,
  contract: CollectionWasmContract,
  input: unknown,
  expected: unknown,
  sample: number,
  module?: WebAssembly.Module,
) {
  const totalStart = now();
  let compileNs = 0,
    compiled = module;
  if (!compiled) {
    const start = now();
    compiled = assertCollectionWasmBinary(bytes);
    compileNs = elapsed(start);
  }
  const instantiateStart = now(),
    instance = new WebAssembly.Instance(compiled, {}),
    exports = instance.exports as unknown as NativeExports;
  if (
    !(exports.memory instanceof WebAssembly.Memory) ||
    typeof exports.evaluate !== "function" ||
    typeof exports.fault_code !== "function"
  )
    throw new Error("COLLECTION_STABILITY_ARTIFACT: invalid exports");
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
  void decodeCollectionFromMemory(
    memory,
    contract.inputType,
    INPUT_BASE,
    inputBytes,
  );
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
      `COLLECTION_STABILITY_EVALUATE: fault ${exports.fault_code()}: ${String(error)}`,
    );
  }
  if (
    !Number.isSafeInteger(outputBytes) ||
    outputBytes <= 0 ||
    outputBytes > COLLECTION_LIMITS.wireBytes
  )
    throw new Error("COLLECTION_STABILITY_EVALUATE: invalid output length");
  const evaluateNs = elapsed(evaluateStart),
    decodeStart = now(),
    output = decodeCollectionFromMemory(
      memory,
      contract.outputType,
      OUTPUT_BASE,
      outputBytes,
    ),
    decodeNs = elapsed(decodeStart),
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
    throw new Error("COLLECTION_STABILITY_CLOCK: phase total exceeds trace");
  if (stableJson(output) !== stableJson(expected))
    throw new Error("COLLECTION_STABILITY_CORRECTNESS: output mismatch");
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

function parseRequest(candidate: unknown): Request {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    throw new Error("COLLECTION_STABILITY_REQUEST: expected object");
  const value = candidate as Record<string, unknown>,
    order = value.laneOrder;
  if (
    Object.keys(value).sort().join(",") !== "laneOrder,samples,warmup" ||
    !Number.isSafeInteger(value.warmup) ||
    (value.warmup as number) < 0 ||
    (value.warmup as number) > 20 ||
    !Number.isSafeInteger(value.samples) ||
    (value.samples as number) < 1 ||
    (value.samples as number) > 100 ||
    !Array.isArray(order) ||
    order.length !== 2 ||
    new Set(order).size !== 2 ||
    !order.includes("cold") ||
    !order.includes("module-cached")
  )
    throw new Error("COLLECTION_STABILITY_REQUEST: invalid request");
  return value as unknown as Request;
}

function clockOverheadNs() {
  const values = Array.from({ length: 1001 }, () => {
    const start = now();
    return elapsed(start);
  }).sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] as number;
}

export async function runCollectionStabilityChild(
  wasmArgument: string,
  contractArgument: string,
  inputArgument: string,
  expectedArgument: string,
  requestArgument: string,
  outputArgument: string,
): Promise<void> {
  const startRssBytes = process.memoryUsage.rss(),
    startCpu = process.cpuUsage(),
    paths = [
      wasmArgument,
      contractArgument,
      inputArgument,
      expectedArgument,
      requestArgument,
      outputArgument,
    ].map((path) => resolve(path)),
    parents = await Promise.all(paths.map((path) => realpath(dirname(path))));
  if (new Set(parents).size !== 1)
    throw new Error("COLLECTION_STABILITY_PATH: files must share one root");
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
    throw new Error("COLLECTION_STABILITY_PATH: invalid input or output");
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
    envelope = parseStrictJsonObject(expectedText, expectedPath as string),
    request = parseRequest(
      parseStrictJsonObject(requestText, requestPath as string),
    );
  if (
    !envelope ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    Object.keys(envelope).join(",") !== "value"
  )
    throw new Error("COLLECTION_STABILITY_EXPECTED: invalid envelope");
  assertCollectionWasmContract(contract);
  assertCollectionWasmBinary(bytes);
  const expected = (envelope as { value: unknown }).value,
    compiled = new WebAssembly.Module(bytes as BufferSource),
    lanes: Record<Lane, unknown[]> = { cold: [], "module-cached": [] };
  for (const lane of request.laneOrder)
    for (let index = 0; index < request.warmup; index++)
      trace(
        bytes,
        contract,
        input,
        expected,
        index,
        lane === "module-cached" ? compiled : undefined,
      );
  const afterWarmupRssBytes = process.memoryUsage.rss();
  for (const lane of request.laneOrder)
    for (let sample = 0; sample < request.samples; sample++)
      lanes[lane].push(
        trace(
          bytes,
          contract,
          input,
          expected,
          sample,
          lane === "module-cached" ? compiled : undefined,
        ),
      );
  const cpu = process.cpuUsage(startCpu),
    endRssBytes = process.memoryUsage.rss();
  await writeFile(
    outputPath as string,
    `${JSON.stringify({
      clockOverheadNs: clockOverheadNs(),
      laneOrder: request.laneOrder,
      resources: {
        startRssBytes,
        afterWarmupRssBytes,
        endRssBytes,
        userCpuMicros: cpu.user,
        systemCpuMicros: cpu.system,
      },
      lanes,
    })}\n`,
    { flag: "wx", mode: 0o600 },
  );
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
      "usage: llang-collection-stability-child <input.wasm> <contract.json> <input.json> <expected.json> <request.json> <output.json>",
    );
  await runCollectionStabilityChild(
    wasm,
    contract,
    input,
    expected,
    request,
    output,
  );
}
