import { createHash } from "node:crypto";
import {
  assertValueWasmBinary,
  assertValueWasmContract,
} from "./llang-module-value-runtime";
import type { ValueType } from "./llang-module-value-ir";
import type { ValueWasmContract } from "./llang-module-value-wasm";
import { decodeValueFromMemory, encodeValueToMemory } from "./llang-value-abi";

type ValueNativeExports = {
  memory: WebAssembly.Memory;
  evaluate: (
    input: number,
    inputLength: number,
    output: number,
    outputCapacity: number,
  ) => number;
};

type ValueDirectEvidence = {
  arguments: Readonly<{
    input: number;
    inputLength: number;
    output: number;
    outputCapacity: number;
  }>;
  inputHashBefore: string | null;
  inputHashAfter: string | null;
  outputHashBefore: string | null;
  outputHashAfter: string | null;
};

export type ValueDirectResult = ValueDirectEvidence &
  ({ kind: "return"; status: number } | { kind: "trap"; error: unknown });

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export class ValueDirectHarness {
  readonly memory: Uint8Array;
  readonly #exports: ValueNativeExports;

  constructor(
    readonly contract: ValueWasmContract,
    wasm: Uint8Array,
  ) {
    const { inputType, outputType } = assertValueWasmContract(contract),
      compiled = assertValueWasmBinary(wasm),
      instance = new WebAssembly.Instance(compiled, {}),
      exports = instance.exports as unknown as ValueNativeExports;
    if (!(exports.memory instanceof WebAssembly.Memory))
      throw new Error("INVALID_ARTIFACT: invalid memory export");
    this.#exports = exports;
    this.memory = new Uint8Array(exports.memory.buffer);
    this.inputType = inputType;
    this.outputType = outputType;
  }

  readonly inputType: ValueType;
  readonly outputType: ValueType;

  encodeInput(value: unknown, base = 64, capacity = 65_536): number {
    return encodeValueToMemory(
      this.memory,
      this.inputType,
      value,
      base,
      capacity,
    );
  }

  invoke(
    input: number,
    inputLength: number,
    output = 131_072,
    outputCapacity = 65_536,
  ): ValueDirectResult {
    const rangeHash = (base: number, length: number) =>
        Number.isInteger(base) &&
        Number.isInteger(length) &&
        base >= 0 &&
        length >= 0 &&
        base <= this.memory.length &&
        length <= this.memory.length - base
          ? hash(this.memory.subarray(base, base + length))
          : null,
      arguments_ = Object.freeze({
        input,
        inputLength,
        output,
        outputCapacity,
      }),
      inputHashBefore = rangeHash(input, inputLength),
      outputHashBefore = rangeHash(output, outputCapacity),
      evidence = (): ValueDirectEvidence => ({
        arguments: arguments_,
        inputHashBefore,
        inputHashAfter: rangeHash(input, inputLength),
        outputHashBefore,
        outputHashAfter: rangeHash(output, outputCapacity),
      });
    try {
      const status = Number(
        this.#exports.evaluate(input, inputLength, output, outputCapacity),
      );
      return {
        ...evidence(),
        kind: "return",
        status,
      };
    } catch (error) {
      return { ...evidence(), kind: "trap", error };
    }
  }

  decodeOutput(base = 131_072, capacity = 65_536): unknown {
    return decodeValueFromMemory(this.memory, this.outputType, base, capacity);
  }
}
