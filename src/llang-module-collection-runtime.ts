import binaryen from "binaryen";
import { evaluateCollectionProgram } from "./llang-module-collection-evaluator";
import {
  canonicalCollectionType,
  type CheckedCollectionProgram,
} from "./llang-module-collection-ir";
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
      keys.length !== 9 ||
      ![
        "abi",
        "memory",
        "inputType",
        "outputType",
        "layoutHash",
        "programHash",
        "loweredHash",
        "executableHash",
        "executable",
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
      !HASH.test(value.loweredHash) ||
      !HASH.test(value.executableHash) ||
      !value.executable ||
      typeof value.executable !== "object" ||
      Array.isArray(value.executable) ||
      value.executable.profile !== "module-collection-v1" ||
      value.executable.programHash !== value.programHash ||
      value.executable.loweredHash !== value.loweredHash ||
      fingerprintFor(value.executable) !== value.executableHash
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
    exports.length !== 2 ||
    !exports.some((x) => x.name === "memory" && x.kind === "memory") ||
    !exports.some((x) => x.name === "evaluate" && x.kind === "function")
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
      // Status 5 is the ABI's explicit sealed-host-execution marker. Calling
      // the export prevents a shape-compatible but behaviorally unrelated
      // binary from being silently ignored by the portable runtime.
      if (wasmEvaluate(inputBase, inputLength, outputBase, capacity) !== 5)
        throw new Error("INVALID_ARTIFACT: unexpected Wasm execution status");
      const result = evaluateCollectionProgram(
          { ...contract.executable, modules: [] } as CheckedCollectionProgram,
          decodedInput,
        ),
        outputLength = encodeCollectionToMemory(
          bytes,
          contract.outputType,
          result,
          outputBase,
          capacity,
        );
      return decodeCollectionFromMemory(
        bytes,
        contract.outputType,
        outputBase,
        outputLength,
      );
    },
  };
}
