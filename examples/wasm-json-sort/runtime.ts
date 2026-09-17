import { MAX_RECORDS } from "./data";

export async function createWasm(bytes: Uint8Array, capacity: number) {
  if (!Number.isInteger(capacity) || capacity < 0 || capacity > MAX_RECORDS)
    throw new Error("Invalid capacity");
  const start = performance.now();
  const module = await WebAssembly.compile(bytes);
  const compileMs = performance.now() - start;
  const instanceStart = performance.now();
  const instance = await WebAssembly.instantiate(module);
  const instantiateMs = performance.now() - instanceStart;
  const memory = instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory))
    throw new Error("Missing memory");
  const needed = Math.ceil((capacity * 4) / 65536);
  const current = memory.buffer.byteLength / 65536;
  if (needed > current) memory.grow(needed - current);
  const data = new Int32Array(memory.buffer, 0, capacity);
  return {
    compileMs,
    instantiateMs,
    load(input: Int32Array) {
      if (input.length > capacity)
        throw new Error("Input exceeds allocated capacity");
      data.set(input);
    },
    sort(exportName: string, length: number) {
      if (!Number.isInteger(length) || length < 0 || length > capacity)
        throw new Error("Invalid length");
      const fn = instance.exports[exportName];
      if (typeof fn !== "function") throw new Error("Missing sort export");
      fn(length);
    },
    view(length: number) {
      return data.subarray(0, length);
    },
  };
}
