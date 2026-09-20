import {
  decodeCollectionFromMemory,
  encodeCollectionToMemory,
} from "./llang-collection-abi";
import type { CheckedCollectionProgram } from "./llang-module-collection-ir";
import {
  emitCollectionModuleWasm,
  emitInstrumentedCollectionModuleWasm,
} from "./llang-module-collection-wasm";
import { fingerprintFor } from "./stable-hash";

export type CollectionCostMetrics = {
  allocationSites: number;
  allocationCalls: number;
  requestedBytes: number;
  alignedBytes: number;
  copySites: number;
  copyCalls: number;
  copyBytes: number;
  promotionAllocationBytes: number;
  promotionCopyBytes: number;
  validationDescriptors: number;
  validationListElements: number;
  validationStringBytes: number;
  arenaPeakBytes: number;
};

export const COLLECTION_COST_CANDIDATE_SHARE = 0.3;

export type CollectionCostObservation = {
  format: "llang-collection-cost-observation";
  version: 1;
  programHash: string;
  loweredHash: string;
  inputHash: string;
  productWasmHash: string;
  instrumentedWasmHash: string;
  productWasmBytes: number;
  instrumentedWasmBytes: number;
  output: unknown;
  outputHash: string;
  metrics: CollectionCostMetrics;
  decision: {
    candidate: "output-promotion" | null;
    status: "rejected" | "skipped";
    measuredShare: number;
    reason: string;
  };
  timingMs: {
    build: number;
    instantiate: number;
    encode: number;
    hostValidation: number;
    wasmValidation: number;
    kernel: number;
    decode: number;
    endToEnd: number;
  };
  memory: {
    linearBytes: number;
    arenaPeakBytes: number;
    rssBefore: number;
    rssAfter: number;
    peakRssBytes: number;
    steadyRssBytes: number;
  };
};

type InstrumentedExports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  evaluate: (a: number, b: number, c: number, d: number) => number;
  fault_code: () => number;
  __metric_alloc_calls: () => number;
  __metric_alloc_requested_bytes: () => number;
  __metric_alloc_aligned_bytes: () => number;
  __metric_copy_calls: () => number;
  __metric_copy_bytes: () => number;
  __metric_validation_descriptors: () => number;
  __metric_validation_list_elements: () => number;
  __metric_validation_string_bytes: () => number;
  __metric_arena_peak: () => number;
  __metric_promotion_alloc_bytes: () => number;
  __metric_promotion_copy_bytes: () => number;
  __validate: (a: number, b: number, c: number, d: number) => number;
  __kernel: (a: number, b: number, c: number, d: number) => number;
};

const elapsed = (start: number) => performance.now() - start;
const countCalls = (wat: string, name: string) =>
  wat.match(new RegExp(`call \\$${name}(?:\\s|\\))`, "g"))?.length ?? 0;
const countGeneratedCopyCalls = (wat: string) =>
  wat.match(/call \$copy[0-9]+(?:\s|\))/g)?.length ?? 0;

export function deterministicCollectionCost(
  observation: CollectionCostObservation,
): Omit<CollectionCostObservation, "timingMs" | "memory"> & {
  memory: Pick<
    CollectionCostObservation["memory"],
    "linearBytes" | "arenaPeakBytes"
  >;
} {
  const { timingMs: _timing, memory, ...stable } = observation;
  return {
    ...stable,
    memory: {
      linearBytes: memory.linearBytes,
      arenaPeakBytes: memory.arenaPeakBytes,
    },
  };
}

export function measureCollectionCost(
  program: CheckedCollectionProgram,
  input: unknown,
): CollectionCostObservation {
  const buildStart = performance.now(),
    product = emitCollectionModuleWasm(program),
    instrumented = emitInstrumentedCollectionModuleWasm(program),
    build = elapsed(buildStart),
    instantiateStart = performance.now(),
    instance = new WebAssembly.Instance(
      new WebAssembly.Module(instrumented.bytes as BufferSource),
      {},
    ),
    instantiate = elapsed(instantiateStart),
    exports = instance.exports as InstrumentedExports,
    memory = new Uint8Array(exports.memory.buffer),
    inputBase = 64,
    outputBase = 524_288,
    capacity = 262_144,
    rssBefore = process.memoryUsage.rss(),
    endToEndStart = performance.now(),
    encodeStart = performance.now(),
    inputLength = encodeCollectionToMemory(
      memory,
      program.entryInput,
      input,
      inputBase,
      capacity,
    ),
    encode = elapsed(encodeStart),
    hostValidationStart = performance.now();
  decodeCollectionFromMemory(
    memory,
    program.entryInput,
    inputBase,
    inputLength,
  );
  const hostValidation = elapsed(hostValidationStart);
  let outputLength: number;
  try {
    outputLength = exports.evaluate(
      inputBase,
      inputLength,
      outputBase,
      capacity,
    );
  } catch (error) {
    throw new Error(`instrumented collection trap: ${exports.fault_code()}`, {
      cause: error,
    });
  }
  const decodeStart = performance.now(),
    output = decodeCollectionFromMemory(
      memory,
      program.entryOutput,
      outputBase,
      outputLength,
    ),
    decode = elapsed(decodeStart),
    endToEnd = elapsed(endToEndStart),
    rssAfterExecution = process.memoryUsage.rss(),
    probe = () => {
      const next = new WebAssembly.Instance(
          new WebAssembly.Module(instrumented.bytes as BufferSource),
          {},
        ).exports as InstrumentedExports,
        nextMemory = new Uint8Array(next.memory.buffer),
        nextLength = encodeCollectionToMemory(
          nextMemory,
          program.entryInput,
          input,
          inputBase,
          capacity,
        );
      return { exports: next, inputLength: nextLength };
    },
    validationProbe = probe(),
    validationStart = performance.now();
  validationProbe.exports.__validate(
    inputBase,
    validationProbe.inputLength,
    outputBase,
    capacity,
  );
  const wasmValidation = elapsed(validationStart),
    kernelProbe = probe(),
    kernelOnlyStart = performance.now();
  kernelProbe.exports.__kernel(
    inputBase,
    kernelProbe.inputLength,
    outputBase,
    capacity,
  );
  const kernel = elapsed(kernelOnlyStart),
    metrics: CollectionCostMetrics = {
      allocationSites:
        countCalls(instrumented.wat, "alloc") +
        countCalls(instrumented.wat, "allocArray") -
        1,
      allocationCalls: exports.__metric_alloc_calls(),
      requestedBytes: exports.__metric_alloc_requested_bytes(),
      alignedBytes: exports.__metric_alloc_aligned_bytes(),
      copySites:
        countCalls(instrumented.wat, "copyBytes") +
        countGeneratedCopyCalls(instrumented.wat),
      copyCalls: exports.__metric_copy_calls(),
      copyBytes: exports.__metric_copy_bytes(),
      promotionAllocationBytes: exports.__metric_promotion_alloc_bytes(),
      promotionCopyBytes: exports.__metric_promotion_copy_bytes(),
      validationDescriptors: exports.__metric_validation_descriptors(),
      validationListElements: exports.__metric_validation_list_elements(),
      validationStringBytes: exports.__metric_validation_string_bytes(),
      arenaPeakBytes: exports.__metric_arena_peak(),
    },
    promotionShare = Math.max(
      metrics.copyBytes ? metrics.promotionCopyBytes / metrics.copyBytes : 0,
      metrics.alignedBytes
        ? metrics.promotionAllocationBytes / metrics.alignedBytes
        : 0,
    ),
    decision =
      promotionShare >= COLLECTION_COST_CANDIDATE_SHARE
        ? {
            candidate: "output-promotion" as const,
            status: "rejected" as const,
            measuredShare: promotionShare,
            reason:
              "The copy establishes output ownership; removing it would expose input or arena lifetimes through ABI v1.",
          }
        : {
            candidate: null,
            status: "skipped" as const,
            measuredShare: promotionShare,
            reason:
              "No eligible candidate accounts for at least 30% of measured allocation or copy bytes.",
          };
  return {
    format: "llang-collection-cost-observation",
    version: 1,
    programHash: program.programHash,
    loweredHash: program.loweredHash,
    inputHash: fingerprintFor(input as object),
    productWasmHash: fingerprintFor([...product.bytes]),
    instrumentedWasmHash: fingerprintFor([...instrumented.bytes]),
    productWasmBytes: product.bytes.length,
    instrumentedWasmBytes: instrumented.bytes.length,
    output,
    outputHash: fingerprintFor(output as object),
    metrics,
    decision,
    timingMs: {
      build,
      instantiate,
      encode,
      hostValidation,
      wasmValidation,
      kernel,
      decode,
      endToEnd,
    },
    memory: {
      linearBytes: memory.byteLength,
      arenaPeakBytes: metrics.arenaPeakBytes,
      rssBefore,
      rssAfter: rssAfterExecution,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      steadyRssBytes: process.memoryUsage.rss(),
    },
  };
}
