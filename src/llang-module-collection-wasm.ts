import binaryen from "binaryen";
import type {
  CheckedCollectionProgram,
  CollectionType,
} from "./llang-module-collection-ir";
import { fingerprintFor } from "./stable-hash";

export const COLLECTION_ABI = "llang-collection-memory-v1" as const;
export type CollectionWasmContract = {
  abi: typeof COLLECTION_ABI;
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

export function emitCollectionModuleWasm(program: CheckedCollectionProgram): {
  bytes: Uint8Array;
  contract: CollectionWasmContract;
  wat: string;
} {
  // The stable ABI shell is deliberately independent from host pointers. The
  // collection runtime validates this module and executes the sealed lowered
  // program carried by the authenticated contract until native lowering lands.
  const wat = `(module
    (memory (export "memory") 128 128)
    (func (export "evaluate") (param i32 i32 i32 i32) (result i32)
      (i32.const 5)))`;
  const module = binaryen.parseText(wat);
  try {
    if (!module.validate())
      throw new Error("INVALID_IR: Binaryen validation failed");
    const bytes = new Uint8Array(module.emitBinary());
    if (!WebAssembly.validate(bytes))
      throw new Error("INVALID_IR: invalid Wasm");
    const { modules: _modules, ...executable } = program;
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
        executableHash: fingerprintFor(executable),
        executable,
      },
    };
  } finally {
    module.dispose();
  }
}
