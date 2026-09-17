import binaryen from "binaryen";
import { evaluateCollectionProgram } from "./llang-module-collection-evaluator";
import {
  canonicalCollectionType,
  type CheckedCollectionProgram,
  type CollectionType,
} from "./llang-module-collection-ir";
import { fingerprintFor } from "./stable-hash";
import {
  decodeCollectionFromMemory,
  encodeCollectionToMemory,
} from "./llang-collection-abi";

export type LegacyCollectionWasmContract = {
  abi: "llang-collection-memory-v1";
  memory: { initial: 128; maximum: 128 };
  inputType: CollectionType;
  outputType: CollectionType;
  layoutHash: string;
  programHash: string;
  loweredHash: string;
  executableHash: string;
  executable: Pick<
    CheckedCollectionProgram,
    | "profile"
    | "entry"
    | "entryModuleId"
    | "functions"
    | "entryInput"
    | "entryOutput"
    | "programHash"
    | "loweredHash"
    | "interfaceHash"
    | "sourceSetHash"
    | "layoutHash"
    | "instances"
  >;
};

const HASH = /^[0-9a-f]{64}$/;

export function assertLegacyCollectionWasmContract(
  candidate: unknown,
): asserts candidate is LegacyCollectionWasmContract {
  try {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      throw new Error();
    const value = candidate as LegacyCollectionWasmContract,
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
      value.abi !== "llang-collection-memory-v1" ||
      value.memory?.initial !== 128 ||
      value.memory?.maximum !== 128 ||
      !HASH.test(value.layoutHash) ||
      !HASH.test(value.programHash) ||
      !HASH.test(value.loweredHash) ||
      !HASH.test(value.executableHash) ||
      value.executable?.profile !== "module-collection-v1" ||
      value.executable.programHash !== value.programHash ||
      value.executable.loweredHash !== value.loweredHash ||
      fingerprintFor(value.executable) !== value.executableHash ||
      fingerprintFor({
        abi: "llang-collection-memory-v1",
        input: canonicalCollectionType(value.inputType),
        output: canonicalCollectionType(value.outputType),
      }) !== value.layoutHash
    )
      throw new Error();
  } catch {
    throw new Error("INVALID_ARTIFACT: invalid legacy collection contract");
  }
}

export function assertLegacyCollectionWasmBinary(
  bytes: Uint8Array,
): WebAssembly.Module {
  if (!WebAssembly.validate(bytes as BufferSource))
    throw new Error("INVALID_ARTIFACT: invalid legacy collection Wasm");
  const compiled = new WebAssembly.Module(bytes as BufferSource),
    imports = WebAssembly.Module.imports(compiled),
    exports = WebAssembly.Module.exports(compiled);
  if (
    imports.length ||
    exports.length !== 2 ||
    !exports.some((item) => item.name === "memory" && item.kind === "memory") ||
    !exports.some(
      (item) => item.name === "evaluate" && item.kind === "function",
    )
  )
    throw new Error("INVALID_ARTIFACT: invalid legacy collection interface");
  const inspected = binaryen.readBinary(bytes);
  try {
    const memory = inspected.getMemoryInfo();
    if (
      memory.initial !== 128 ||
      memory.max !== 128 ||
      memory.shared ||
      memory.is64
    )
      throw new Error("INVALID_ARTIFACT: invalid legacy collection memory");
  } finally {
    inspected.dispose();
  }
  return compiled;
}

export function instantiateLegacyCollectionModule(
  contract: LegacyCollectionWasmContract,
  bytes: Uint8Array,
): { evaluate(input: unknown): unknown } {
  assertLegacyCollectionWasmContract(contract);
  const compiled = assertLegacyCollectionWasmBinary(bytes);
  return {
    evaluate(input: unknown): unknown {
      const instance = new WebAssembly.Instance(compiled, {}),
        memory = instance.exports.memory,
        evaluate = instance.exports.evaluate;
      if (
        !(memory instanceof WebAssembly.Memory) ||
        typeof evaluate !== "function"
      )
        throw new Error("INVALID_ARTIFACT: invalid legacy collection instance");
      const data = new Uint8Array(memory.buffer),
        inputBase = 64,
        outputBase = 524288,
        capacity = 262144,
        inputLength = encodeCollectionToMemory(
          data,
          contract.inputType,
          input,
          inputBase,
          capacity,
        ),
        decoded = decodeCollectionFromMemory(
          data,
          contract.inputType,
          inputBase,
          inputLength,
        );
      if (evaluate(inputBase, inputLength, outputBase, capacity) !== 5)
        throw new Error("INVALID_ARTIFACT: invalid legacy execution marker");
      return evaluateCollectionProgram(
        { ...contract.executable, modules: [] } as CheckedCollectionProgram,
        decoded,
      );
    },
  };
}
