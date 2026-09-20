import {
  decodeCollectionFromMemory,
  encodeCollectionToMemory,
} from "./llang-collection-abi";
import { createHash } from "node:crypto";
import { COLLECTION_LIMITS } from "./llang-module-collection-ir";
import {
  assertCollectionWasmBinary,
  assertCollectionWasmContract,
} from "./llang-module-collection-runtime";
import type { CollectionWasmContract } from "./llang-module-collection-wasm";

type CollectionNativeExports = {
  memory: WebAssembly.Memory;
  evaluate: (
    input: number,
    inputLength: number,
    output: number,
    outputCapacity: number,
  ) => number;
  fault_code: () => number;
};

type CollectionDirectEvidence = {
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

export type CollectionDirectResult = CollectionDirectEvidence &
  (
    | { kind: "return"; outputLength: number; faultCode: number }
    | { kind: "trap"; error: unknown; faultCode: number }
  );

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export class CollectionDirectHarness {
  readonly memory: Uint8Array;
  readonly #exports: CollectionNativeExports;

  constructor(
    readonly contract: CollectionWasmContract,
    wasm: Uint8Array,
  ) {
    assertCollectionWasmContract(contract);
    const compiled = assertCollectionWasmBinary(wasm),
      instance = new WebAssembly.Instance(compiled, {}),
      exports = instance.exports as unknown as CollectionNativeExports;
    if (!(exports.memory instanceof WebAssembly.Memory))
      throw new Error("INVALID_ARTIFACT: invalid memory export");
    this.#exports = exports;
    this.memory = new Uint8Array(exports.memory.buffer);
  }

  encodeInput(
    value: unknown,
    base = 64,
    capacity = COLLECTION_LIMITS.wireBytes,
  ): number {
    return encodeCollectionToMemory(
      this.memory,
      this.contract.inputType,
      value,
      base,
      capacity,
    );
  }

  invoke(
    input: number,
    inputLength: number,
    output = 524_288,
    outputCapacity = COLLECTION_LIMITS.wireBytes,
  ): CollectionDirectResult {
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
      evidence = (): CollectionDirectEvidence => ({
        arguments: arguments_,
        inputHashBefore,
        inputHashAfter: rangeHash(input, inputLength),
        outputHashBefore,
        outputHashAfter: rangeHash(output, outputCapacity),
      });
    try {
      return {
        ...evidence(),
        kind: "return",
        outputLength: Number(
          this.#exports.evaluate(input, inputLength, output, outputCapacity),
        ),
        faultCode: Number(this.#exports.fault_code()),
      };
    } catch (error) {
      return {
        ...evidence(),
        kind: "trap",
        error,
        faultCode: Number(this.#exports.fault_code()),
      };
    }
  }

  decodeOutput(base: number, length: number): unknown {
    return decodeCollectionFromMemory(
      this.memory,
      this.contract.outputType,
      base,
      length,
    );
  }
}
