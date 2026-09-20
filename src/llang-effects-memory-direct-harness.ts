import { createHash } from "node:crypto";
import { assertEffectsWasm } from "./llang-effects-wasm";

export type EffectsMemoryRange = Readonly<{
  name: string;
  base: number;
  length: number;
}>;

export type EffectsDirectResult = Readonly<{
  kind: "return" | "trap";
  status?: number;
  fault?: number;
  error?: unknown;
  before: Readonly<Record<string, string | null>>;
  after: Readonly<Record<string, string | null>>;
}>;

type EffectsSessionExports = {
  memory: WebAssembly.Memory;
  start(out: number, capacity: number): number;
  resume(event: number, length: number, out: number, capacity: number): number;
  cancel(): number;
  dispose(): number;
  fault_code(): number;
};

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export class EffectsMemoryDirectHarness {
  readonly memory: Uint8Array;
  readonly view: DataView;
  readonly #exports: EffectsSessionExports;

  constructor(wasm: Uint8Array) {
    const instance = new WebAssembly.Instance(assertEffectsWasm(wasm), {}),
      exports = instance.exports as unknown as EffectsSessionExports;
    if (!(exports.memory instanceof WebAssembly.Memory))
      throw new Error("INVALID_ARTIFACT: invalid memory export");
    this.#exports = exports;
    this.memory = new Uint8Array(exports.memory.buffer);
    this.view = new DataView(exports.memory.buffer);
  }

  start(
    out: number,
    capacity: number,
    watch: readonly EffectsMemoryRange[] = [],
  ): EffectsDirectResult {
    return this.#invoke(() => this.#exports.start(out, capacity), watch);
  }

  resume(
    event: number,
    length: number,
    out: number,
    capacity: number,
    watch: readonly EffectsMemoryRange[] = [],
  ): EffectsDirectResult {
    return this.#invoke(
      () => this.#exports.resume(event, length, out, capacity),
      watch,
    );
  }

  cancel(): number {
    return this.#exports.cancel();
  }

  dispose(): number {
    return this.#exports.dispose();
  }

  fault(): number {
    return this.#exports.fault_code();
  }

  writeLinearEvent(
    base: number,
    event: Readonly<{
      generation: number;
      sequence: number;
      ok: number;
      value: number;
    }>,
  ): void {
    this.view.setUint32(base, event.generation, true);
    this.view.setUint32(base + 4, event.sequence, true);
    this.view.setUint32(base + 8, event.ok, true);
    this.view.setInt32(base + 12, event.value, true);
  }

  writeTypedEvent(
    base: number,
    event: Readonly<{
      generation: number;
      sequence: number;
      ok: number;
      type: number;
      payload: number;
      payloadLength: number;
    }>,
  ): void {
    this.view.setUint32(base, event.generation, true);
    this.view.setUint32(base + 4, event.sequence, true);
    this.view.setUint32(base + 8, event.ok, true);
    this.view.setUint32(base + 12, event.type, true);
    this.view.setUint32(base + 16, event.payload, true);
    this.view.setUint32(base + 20, event.payloadLength, true);
  }

  readWords(base: number, count: number): readonly number[] {
    return Object.freeze(
      Array.from({ length: count }, (_, index) =>
        this.view.getUint32(base + index * 4, true),
      ),
    );
  }

  #invoke(
    call: () => number,
    watch: readonly EffectsMemoryRange[],
  ): EffectsDirectResult {
    const before = this.#hashRanges(watch);
    try {
      const status = Number(call());
      return Object.freeze({
        kind: "return",
        status,
        fault: this.#exports.fault_code(),
        before,
        after: this.#hashRanges(watch),
      });
    } catch (error) {
      return Object.freeze({
        kind: "trap",
        error,
        before,
        after: this.#hashRanges(watch),
      });
    }
  }

  #hashRanges(
    ranges: readonly EffectsMemoryRange[],
  ): Readonly<Record<string, string | null>> {
    return Object.freeze(
      Object.fromEntries(
        ranges.map(({ name, base, length }) => [
          name,
          Number.isInteger(base) &&
          Number.isInteger(length) &&
          base >= 0 &&
          length >= 0 &&
          base <= this.memory.length &&
          length <= this.memory.length - base
            ? hash(this.memory.subarray(base, base + length))
            : null,
        ]),
      ),
    );
  }
}
