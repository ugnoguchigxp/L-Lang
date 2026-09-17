import binaryen from "binaryen";
import { canonicalCollectionType } from "./llang-module-collection-ir";
import { fingerprintFor } from "./stable-hash";
import {
  COLLECTION_ABI,
  type CollectionWasmContract,
} from "./llang-module-collection-wasm";
import {
  decodeCollectionFromMemory,
  encodeCollectionToMemory,
} from "./llang-collection-abi";

const HASH = /^[0-9a-f]{64}$/;
export function assertCollectionWasmContract(candidate: unknown): void {
  try {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      throw new Error();
    const value = candidate as CollectionWasmContract,
      keys = Object.keys(value);
    if (
      keys.length !== 7 ||
      ![
        "abi",
        "memory",
        "inputType",
        "outputType",
        "layoutHash",
        "programHash",
        "loweredHash",
      ].every((key) => Object.hasOwn(value, key)) ||
      value.abi !== COLLECTION_ABI ||
      !value.memory ||
      typeof value.memory !== "object" ||
      Array.isArray(value.memory) ||
      Object.keys(value.memory).length !== 2 ||
      value.memory.initial !== 128 ||
      value.memory.maximum !== 128 ||
      !HASH.test(value.layoutHash) ||
      !HASH.test(value.programHash) ||
      !HASH.test(value.loweredHash)
    )
      throw new Error();
    const layoutHash = fingerprintFor({
      abi: COLLECTION_ABI,
      input: canonicalCollectionType(value.inputType),
      output: canonicalCollectionType(value.outputType),
    });
    if (layoutHash !== value.layoutHash) throw new Error();
  } catch {
    throw new Error("INVALID_ARTIFACT: invalid collection ABI contract");
  }
}
export function assertCollectionWasmBinary(
  bytes: Uint8Array,
): WebAssembly.Module {
  if (
    bytes.length > 4 * 1024 * 1024 ||
    !WebAssembly.validate(bytes as BufferSource)
  )
    throw new Error("INVALID_ARTIFACT: invalid collection Wasm");
  const compiled = new WebAssembly.Module(bytes as BufferSource),
    imports = WebAssembly.Module.imports(compiled),
    exports = WebAssembly.Module.exports(compiled);
  if (
    imports.length ||
    exports.length !== 3 ||
    !exports.some((x) => x.name === "memory" && x.kind === "memory") ||
    !exports.some((x) => x.name === "evaluate" && x.kind === "function") ||
    !exports.some((x) => x.name === "fault_code" && x.kind === "function")
  )
    throw new Error("INVALID_ARTIFACT: unexpected collection Wasm interface");
  const inspected = binaryen.readBinary(bytes);
  try {
    const memory = inspected.getMemoryInfo(),
      ex = binaryen.getExportInfo(inspected.getExport("evaluate")),
      fn = binaryen.getFunctionInfo(inspected.getFunction(ex.value)),
      params = binaryen.expandType(fn.params),
      results = binaryen.expandType(fn.results);
    if (
      inspected.getStart() !== 0 ||
      memory.initial !== 128 ||
      memory.max !== 128 ||
      memory.shared ||
      memory.is64 ||
      params.length !== 4 ||
      params.some((x) => x !== binaryen.i32) ||
      results.length !== 1 ||
      results[0] !== binaryen.i32
    )
      throw new Error("INVALID_ARTIFACT: invalid collection Wasm shape");
  } finally {
    inspected.dispose();
  }
  return compiled;
}
export function instantiateCollectionModule(
  contract: CollectionWasmContract,
  bytes: Uint8Array,
): { evaluate(input: unknown): unknown } {
  assertCollectionWasmContract(contract);
  const compiled = assertCollectionWasmBinary(bytes);
  return {
    evaluate(input: unknown): unknown {
      const instance = new WebAssembly.Instance(compiled, {}),
        memory = instance.exports.memory;
      if (
        !(memory instanceof WebAssembly.Memory) ||
        memory.buffer.byteLength !== 128 * 65536
      )
        throw new Error("INVALID_ARTIFACT: invalid memory export");
      const wasmEvaluate = instance.exports.evaluate;
      if (typeof wasmEvaluate !== "function")
        throw new Error("INVALID_ARTIFACT: invalid evaluate export");
      const bytes = new Uint8Array(memory.buffer),
        inputBase = 64,
        outputBase = 524288,
        capacity = 262144,
        inputLength = encodeCollectionToMemory(
          bytes,
          contract.inputType,
          input,
          inputBase,
          capacity,
        ),
        decodedInput = decodeCollectionFromMemory(
          bytes,
          contract.inputType,
          inputBase,
          inputLength,
        );
      // Decode once before entering Wasm so malformed descriptors never reach
      // the native program. The decoded value is intentionally unused: the
      // Wasm module consumes the canonical bytes directly.
      void decodedInput;
      let outputLength: number;
      try {
        outputLength = Number(
          wasmEvaluate(inputBase, inputLength, outputBase, capacity),
        );
      } catch (error) {
        const faultCode = instance.exports.fault_code;
        const code = typeof faultCode === "function" ? Number(faultCode()) : 0;
        const names: Record<number, string> = {
          1: "INDEX_OUT_OF_BOUNDS",
          2: "DIVISION_BY_ZERO",
          3: "ARITHMETIC_OVERFLOW",
          4: "RESOURCE_LIMIT",
          5: "INVALID_ARTIFACT",
        };
        throw new Error(names[code] ?? `WASM_TRAP: ${String(error)}`);
      }
      if (
        !Number.isInteger(outputLength) ||
        outputLength <= 0 ||
        outputLength > capacity
      )
        throw new Error("INVALID_ARTIFACT: invalid native output length");
      return decodeCollectionFromMemory(
        bytes,
        contract.outputType,
        outputBase,
        outputLength,
      );
    },
  };
}
