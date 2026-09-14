import binaryen from "binaryen";
import {
  contractSlots,
  digest,
  parseContract,
  type WasmContract,
  WasmError,
} from "./wasm-contract";
import { lowerPredicate, type WasmCore } from "./wasm-core";

export const WASM_COMPILER_VERSION = "0.1.0-dev.1";
export const WASM_BACKEND_VERSION = "132.0.0";
export const WASM_EXPORT = "evaluate";

export function emitWasm(expression: unknown, contractInput: WasmContract) {
  const contract = parseContract(contractInput);
  const body = lowerPredicate(expression, contract);
  const module = new binaryen.Module();
  function emit(node: WasmCore): number {
    switch (node.kind) {
      case "constant":
        return module.i32.const(Number(node.value));
      case "compare":
        return module.i32.eq(
          module.local.get(node.slot, binaryen.i32),
          module.i32.const(node.value),
        );
      case "not":
        return module.i32.eqz(emit(node.body));
      case "all":
        return node.bodies.reduceRight(
          (rest, b) => module.if(emit(b), rest, module.i32.const(0)),
          module.i32.const(1),
        );
      case "any":
        return node.bodies.reduceRight(
          (rest, b) => module.if(emit(b), module.i32.const(1), rest),
          module.i32.const(0),
        );
    }
  }
  try {
    module.setFeatures(binaryen.Features.MVP);
    module.addFunction(
      WASM_EXPORT,
      binaryen.createType(contractSlots(contract).map(() => binaryen.i32)),
      binaryen.i32,
      [],
      emit(body),
    );
    module.addFunctionExport(WASM_EXPORT, WASM_EXPORT);
    module.addCustomSection(
      "llang.contract",
      new TextEncoder().encode(digest(JSON.stringify(contract))),
    );
    if (
      module.hasMemory() ||
      module.getNumTables() ||
      module.getNumGlobals() ||
      module.getStart()
    )
      throw new WasmError("INVALID_IR", "unexpected stateful module");
    if (!module.validate())
      throw new WasmError("INVALID_IR", "Binaryen validation failed");
    const bytes = new Uint8Array(module.emitBinary());
    if (!WebAssembly.validate(bytes))
      throw new WasmError("INVALID_IR", "Wasm validation failed");
    return bytes;
  } finally {
    module.dispose();
  }
}
