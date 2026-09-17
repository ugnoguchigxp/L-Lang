import binaryen from "binaryen";
import { digest, type WasmContract, WasmError } from "./wasm-contract";
import { assertStatelessWasmBinary } from "./wasm-runtime";
import { WASM_EXPORT } from "./wasm-emitter";
import { moduleEntryContract, scalarSlots } from "./llang-module-evaluator";
import type {
  CheckedFunction,
  CheckedModuleProgram,
  ModuleExpression,
} from "./llang-module-ir";

export function emitModuleWasm(program: CheckedModuleProgram): {
  bytes: Uint8Array;
  contract: WasmContract;
} {
  const contract = moduleEntryContract(program),
    module = new binaryen.Module(),
    functions = new Map(program.functions.map((fn) => [fn.symbol, fn]));
  const signature = (fn: CheckedFunction) =>
    fn.parameters.flatMap((p) => Array(scalarSlots(p.type)).fill(binaryen.i32));
  try {
    module.setFeatures(binaryen.Features.MVP);
    for (const fn of program.functions) {
      const locals = new Map<string, { start: number; fields?: string[] }>();
      let offset = 0;
      for (const parameter of fn.parameters) {
        locals.set(parameter.name, {
          start: offset,
          ...(parameter.type.kind === "record"
            ? { fields: parameter.type.fields }
            : {}),
        });
        offset += scalarSlots(parameter.type);
      }
      const flatten = (
        expression: ModuleExpression,
        expectedFields?: string[],
      ): number[] => {
        if (expression.kind === "param" && expectedFields) {
          const local = locals.get(expression.name);
          if (
            !local?.fields ||
            local.fields.join("\0") !== expectedFields.join("\0")
          )
            throw new WasmError("INVALID_IR", "record argument mismatch");
          return expectedFields.map((_, i) =>
            module.local.get(local.start + i, binaryen.i32),
          );
        }
        return [emit(expression)];
      };
      const emit = (expression: ModuleExpression): number => {
        switch (expression.kind) {
          case "literal":
            return module.i32.const(Number(expression.value));
          case "param": {
            const local = locals.get(expression.name);
            if (!local || local.fields)
              throw new WasmError(
                "INVALID_IR",
                "record value cannot be emitted as scalar",
              );
            return module.local.get(local.start, binaryen.i32);
          }
          case "field": {
            const local = locals.get(expression.base.name),
              index = local?.fields?.indexOf(expression.name) ?? -1;
            if (!local || index < 0)
              throw new WasmError("INVALID_IR", "invalid record field");
            return module.local.get(local.start + index, binaryen.i32);
          }
          case "not":
            return module.i32.eqz(emit(expression.condition));
          case "all":
            return expression.conditions.reduceRight(
              (rest, item) => module.if(emit(item), rest, module.i32.const(0)),
              module.i32.const(1),
            );
          case "any":
            return expression.conditions.reduceRight(
              (rest, item) => module.if(emit(item), module.i32.const(1), rest),
              module.i32.const(0),
            );
          case "equals":
            return module.i32.eq(emit(expression.left), emit(expression.right));
          case "call": {
            const symbol = fn.callees[expression.callee];
            if (!symbol)
              throw new WasmError("INVALID_IR", "unknown call target");
            const target = functions.get(symbol);
            if (!target)
              throw new WasmError("INVALID_IR", "unknown call target");
            const operands = expression.arguments.flatMap((arg, index) => {
              const type = target.parameters[index]?.type;
              return flatten(
                arg,
                type?.kind === "record" ? type.fields : undefined,
              );
            });
            return module.call(symbol, operands, binaryen.i32);
          }
        }
      };
      module.addFunction(
        fn.symbol,
        binaryen.createType(signature(fn)),
        binaryen.i32,
        [],
        emit(fn.body),
      );
    }
    module.addFunctionExport(program.entry, WASM_EXPORT);
    module.addCustomSection(
      "llang.contract",
      new TextEncoder().encode(digest(JSON.stringify(contract))),
    );
    if (!module.validate())
      throw new WasmError("INVALID_IR", "Binaryen validation failed");
    const bytes = new Uint8Array(module.emitBinary());
    if (bytes.byteLength > 1024 * 1024 || !WebAssembly.validate(bytes))
      throw new WasmError("INVALID_IR", "invalid or oversized Wasm");
    assertStatelessWasmBinary(bytes);
    return { bytes, contract };
  } finally {
    module.dispose();
  }
}
