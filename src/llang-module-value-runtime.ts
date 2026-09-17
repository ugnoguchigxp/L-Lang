import binaryen from "binaryen";
import { ValueFault, type ValueRuntime } from "./llang-module-value-evaluator";
import { canonicalValueType, type ValueType } from "./llang-module-value-ir";
import {
  decodeValueFromMemory,
  encodeValueToMemory,
  VALUE_ABI,
  VALUE_FAULT,
  VALUE_MEMORY_PAGES,
} from "./llang-value-abi";
import type { ValueWasmContract } from "./llang-module-value-wasm";
import { fingerprintFor } from "./stable-hash";

const HASH = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function hasExactKeys(value: object, expected: string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    actual.every((name) => expected.includes(name))
  );
}
function parseContractType(
  value: unknown,
  depth = 0,
  state = { nodes: 0 },
): ValueType {
  if (
    depth > 8 ||
    ++state.nodes > 4096 ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    throw new Error("INVALID_ARTIFACT: invalid value ABI type");
  const source = value as Record<string, unknown>;
  if (
    (source.kind === "boolean" ||
      source.kind === "i32" ||
      source.kind === "string") &&
    hasExactKeys(source, ["kind"])
  )
    return { kind: source.kind };
  if (
    (source.kind !== "record" && source.kind !== "union") ||
    typeof source.symbol !== "string" ||
    !source.symbol ||
    source.symbol.length > 1024
  )
    throw new Error("INVALID_ARTIFACT: invalid value ABI type");
  const parseField = (item: unknown): { name: string; type: ValueType } => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      !hasExactKeys(item, ["name", "type"])
    )
      throw new Error("INVALID_ARTIFACT: invalid value ABI field");
    const raw = item as Record<string, unknown>;
    if (
      typeof raw.name !== "string" ||
      raw.name.length > 128 ||
      !NAME.test(raw.name)
    )
      throw new Error("INVALID_ARTIFACT: invalid value ABI field");
    return {
      name: raw.name,
      type: parseContractType(raw.type, depth + 1, state),
    };
  };
  const canonicallyOrdered = (names: string[]) =>
    names.every((name, index) => {
      const previous = names[index - 1];
      return index === 0 || (previous !== undefined && previous < name);
    });
  if (source.kind === "record") {
    if (
      !hasExactKeys(source, ["kind", "symbol", "fields"]) ||
      !Array.isArray(source.fields) ||
      !source.fields.length ||
      source.fields.length > 64
    )
      throw new Error("INVALID_ARTIFACT: invalid value ABI record");
    const fields = source.fields.map(parseField);
    if (!canonicallyOrdered(fields.map((item) => item.name)))
      throw new Error("INVALID_ARTIFACT: non-canonical value ABI record");
    return { kind: "record", symbol: source.symbol, fields };
  }
  if (
    !hasExactKeys(source, ["kind", "symbol", "variants"]) ||
    !Array.isArray(source.variants) ||
    source.variants.length < 2 ||
    source.variants.length > 16
  )
    throw new Error("INVALID_ARTIFACT: invalid value ABI union");
  const variants = source.variants.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      !hasExactKeys(item, ["tag", "fields"])
    )
      throw new Error("INVALID_ARTIFACT: invalid value ABI variant");
    const raw = item as Record<string, unknown>;
    if (
      typeof raw.tag !== "string" ||
      raw.tag.length > 128 ||
      !NAME.test(raw.tag) ||
      !Array.isArray(raw.fields) ||
      !raw.fields.length ||
      raw.fields.length > 64
    )
      throw new Error("INVALID_ARTIFACT: invalid value ABI variant");
    const fields = raw.fields.map(parseField);
    if (!canonicallyOrdered(fields.map((entry) => entry.name)))
      throw new Error("INVALID_ARTIFACT: non-canonical value ABI variant");
    return { tag: raw.tag, fields };
  });
  if (!canonicallyOrdered(variants.map((item) => item.tag)))
    throw new Error("INVALID_ARTIFACT: non-canonical value ABI union");
  return { kind: "union", symbol: source.symbol, variants };
}
export function assertValueWasmContract(value: ValueWasmContract): {
  inputType: ValueType;
  outputType: ValueType;
} {
  if (
    !value ||
    typeof value !== "object" ||
    !hasExactKeys(value, [
      "abi",
      "memory",
      "inputType",
      "outputType",
      "layoutHash",
      "inputLimit",
      "outputLimit",
    ]) ||
    value.abi !== VALUE_ABI ||
    !value.memory ||
    typeof value.memory !== "object" ||
    !hasExactKeys(value.memory, ["initial", "maximum"]) ||
    value.memory?.initial !== VALUE_MEMORY_PAGES ||
    value.memory.maximum !== VALUE_MEMORY_PAGES ||
    !HASH.test(value.layoutHash) ||
    value.inputLimit !== 65536 ||
    value.outputLimit !== 65536 ||
    !value.inputType ||
    !value.outputType
  )
    throw new Error("INVALID_ARTIFACT: invalid value ABI contract");
  const inputType = parseContractType(value.inputType),
    outputType = parseContractType(value.outputType),
    layoutHash = fingerprintFor({
      abi: VALUE_ABI,
      input: canonicalValueType(inputType),
      output: canonicalValueType(outputType),
      memoryPages: VALUE_MEMORY_PAGES,
    });
  if (layoutHash !== value.layoutHash)
    throw new Error("INVALID_ARTIFACT: value ABI layout hash mismatch");
  return { inputType, outputType };
}
export function assertValueWasmBinary(bytes: Uint8Array): WebAssembly.Module {
  if (
    bytes.byteLength > 1024 * 1024 ||
    !WebAssembly.validate(bytes as BufferSource)
  )
    throw new Error("INVALID_ARTIFACT: invalid value Wasm");
  const module = new WebAssembly.Module(bytes as BufferSource);
  if (WebAssembly.Module.imports(module).length)
    throw new Error("INVALID_ARTIFACT: value Wasm imports are forbidden");
  const exports = WebAssembly.Module.exports(module);
  if (
    exports.length !== 2 ||
    !exports.some((x) => x.name === "memory" && x.kind === "memory") ||
    !exports.some((x) => x.name === "evaluate" && x.kind === "function")
  )
    throw new Error("INVALID_ARTIFACT: unexpected value Wasm exports");
  const inspected = binaryen.readBinary(bytes);
  try {
    const memory = inspected.getMemoryInfo();
    if (
      inspected.getStart() !== 0 ||
      memory.initial !== VALUE_MEMORY_PAGES ||
      memory.max !== VALUE_MEMORY_PAGES ||
      memory.shared ||
      memory.is64
    )
      throw new Error("INVALID_ARTIFACT: invalid value Wasm memory or start");
    const exported = binaryen.getExportInfo(inspected.getExport("evaluate"));
    const signature = binaryen.getFunctionInfo(
      inspected.getFunction(exported.value),
    );
    const parameters = binaryen.expandType(signature.params),
      results = binaryen.expandType(signature.results);
    if (
      parameters.length !== 4 ||
      parameters.some((type) => type !== binaryen.i32) ||
      results.length !== 1 ||
      results[0] !== binaryen.i32
    )
      throw new Error("INVALID_ARTIFACT: invalid evaluate signature");
  } finally {
    inspected.dispose();
  }
  return module;
}
export function instantiateValueModule(
  contract: ValueWasmContract,
  bytes: Uint8Array,
): { evaluate(input: unknown): ValueRuntime } {
  const { inputType, outputType } = assertValueWasmContract(contract);
  const compiled = assertValueWasmBinary(bytes);
  return {
    evaluate(input: unknown): ValueRuntime {
      const instance = new WebAssembly.Instance(compiled, {}),
        memory = instance.exports.memory;
      if (
        !(memory instanceof WebAssembly.Memory) ||
        memory.buffer.byteLength !== VALUE_MEMORY_PAGES * 65536
      )
        throw new Error("INVALID_ARTIFACT: invalid memory export");
      const fn = instance.exports.evaluate;
      if (typeof fn !== "function")
        throw new Error("INVALID_ARTIFACT: missing evaluate");
      const bytesView = new Uint8Array(memory.buffer),
        inputBase = 64,
        inputCapacity = 65536,
        outputBase = 131072,
        outputCapacity = 65536,
        inputLength = encodeValueToMemory(
          bytesView,
          inputType,
          input,
          inputBase,
          inputCapacity,
        ),
        status = Number(fn(inputBase, inputLength, outputBase, outputCapacity));
      if (memory.buffer.byteLength !== VALUE_MEMORY_PAGES * 65536)
        throw new Error("INVALID_ARTIFACT: value Wasm changed memory size");
      if (status !== VALUE_FAULT.OK) {
        if (status === VALUE_FAULT.INVALID_ARTIFACT)
          throw new Error(
            "INVALID_ARTIFACT: Wasm evaluate rejected the artifact",
          );
        if (
          status !== VALUE_FAULT.INVALID_INPUT &&
          status !== VALUE_FAULT.ARITHMETIC_OVERFLOW &&
          status !== VALUE_FAULT.DIVISION_BY_ZERO &&
          status !== VALUE_FAULT.RESOURCE_LIMIT
        )
          throw new Error(`INVALID_ARTIFACT: unknown Wasm status ${status}`);
        const code =
          status === VALUE_FAULT.ARITHMETIC_OVERFLOW
            ? "ARITHMETIC_OVERFLOW"
            : status === VALUE_FAULT.DIVISION_BY_ZERO
              ? "DIVISION_BY_ZERO"
              : status === VALUE_FAULT.RESOURCE_LIMIT
                ? "RESOURCE_LIMIT"
                : "INVALID_INPUT";
        throw new ValueFault(code, `Wasm evaluate returned status ${status}`);
      }
      return decodeValueFromMemory(
        bytesView,
        outputType,
        outputBase,
        outputCapacity,
      );
    },
  };
}
