import binaryen from "binaryen";
import type {
  CheckedCollectionProgram,
  CollectionType,
} from "./llang-module-collection-ir";
import { emitNativeCollectionWat } from "./llang-module-collection-native";

export const COLLECTION_ABI = "llang-collection-native-v1" as const;
export type CollectionWasmContract = {
  abi: typeof COLLECTION_ABI;
  memory: { initial: 128; maximum: 128 };
  inputType: CollectionType;
  outputType: CollectionType;
  layoutHash: string;
  programHash: string;
  loweredHash: string;
};

export function emitCollectionModuleWasm(program: CheckedCollectionProgram): {
  bytes: Uint8Array;
  contract: CollectionWasmContract;
  wat: string;
} {
  return emitUnoptimizedCollectionModuleWasm(program);
}

export function emitUnoptimizedCollectionModuleWasm(
  program: CheckedCollectionProgram,
): {
  bytes: Uint8Array;
  contract: CollectionWasmContract;
  wat: string;
} {
  return emitCollectionWasm(program, false);
}

export function emitInstrumentedCollectionModuleWasm(
  program: CheckedCollectionProgram,
): {
  bytes: Uint8Array;
  contract: CollectionWasmContract;
  wat: string;
} {
  return emitCollectionWasm(program, true);
}

function emitCollectionWasm(
  program: CheckedCollectionProgram,
  instrumented: boolean,
): {
  bytes: Uint8Array;
  contract: CollectionWasmContract;
  wat: string;
} {
  const wat = emitNativeCollectionWat(program, { instrumented });
  const module = binaryen.parseText(wat);
  try {
    if (!module.validate())
      throw new Error("INVALID_IR: Binaryen validation failed");
    const bytes = new Uint8Array(module.emitBinary());
    if (!WebAssembly.validate(bytes))
      throw new Error("INVALID_IR: invalid Wasm");
    return {
      bytes,
      wat,
      contract: {
        abi: COLLECTION_ABI,
        memory: { initial: 128, maximum: 128 },
        inputType: program.entryInput,
        outputType: program.entryOutput,
        layoutHash: program.layoutHash,
        programHash: program.programHash,
        loweredHash: program.loweredHash,
      },
    };
  } finally {
    module.dispose();
  }
}
