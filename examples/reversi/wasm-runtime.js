// Generic collection-native ABI transport. No Reversi rules or turn decisions.
const WIRE_BYTES = 262144;
const align = (value) => Math.ceil(value / 4) * 4;
function size(type) {
  if (type.kind === "i32" || type.kind === "boolean") return 4;
  if (type.kind === "list" || type.kind === "string") return 8;
  if (type.kind === "record")
    return type.fields.reduce((n, field) => n + size(field.type), 0);
  throw new Error("Unsupported wire type");
}
function encode(memory, type, value) {
  const base = 64,
    end = base + WIRE_BYTES,
    view = new DataView(memory.buffer);
  let cursor = base + size(type),
    elements = 0;
  memory.fill(0, base, end);
  function allocate(bytes) {
    const pointer = align(cursor);
    if (bytes > end - pointer) throw new Error("RESOURCE_LIMIT: input bytes");
    cursor = pointer + bytes;
    return pointer;
  }
  function write(t, v, address, depth) {
    if (depth > 8) throw new Error("RESOURCE_LIMIT: input depth");
    if (t.kind === "i32") {
      if (!Number.isInteger(v) || v < -2147483648 || v > 2147483647)
        throw new Error("Invalid i32");
      view.setInt32(address, v, true);
    } else if (t.kind === "boolean") {
      if (typeof v !== "boolean") throw new Error("Invalid boolean");
      view.setInt32(address, v ? 1 : 0, true);
    } else if (t.kind === "record") {
      if (
        !v ||
        typeof v !== "object" ||
        Array.isArray(v) ||
        Object.keys(v).length !== t.fields.length
      )
        throw new Error("Invalid record");
      for (const field of t.fields) {
        if (!Object.hasOwn(v, field.name))
          throw new Error("Missing record field");
        write(field.type, v[field.name], address, depth + 1);
        address += size(field.type);
      }
    } else if (t.kind === "list") {
      if (
        !Array.isArray(v) ||
        v.length > 4096 ||
        (elements += v.length) > 16384
      )
        throw new Error("RESOURCE_LIMIT: input list");
      const stride = size(t.element),
        pointer = v.length ? allocate(stride * v.length) : 0;
      view.setUint32(address, pointer, true);
      view.setUint32(address + 4, v.length, true);
      v.forEach((item, i) =>
        write(t.element, item, pointer + i * stride, depth + 1),
      );
    } else if (t.kind === "string") {
      if (typeof v !== "string" || !v.isWellFormed())
        throw new Error("Invalid Unicode string");
      const bytes = new TextEncoder().encode(v);
      if (bytes.length > 16384) throw new Error("RESOURCE_LIMIT: input string");
      const pointer = bytes.length ? allocate(bytes.length) : 0;
      memory.set(bytes, pointer);
      view.setUint32(address, pointer, true);
      view.setUint32(address + 4, bytes.length, true);
    } else throw new Error("Unsupported wire type");
  }
  write(type, value, base, 0);
  return cursor - base;
}
function decode(memory, type, length) {
  const base = 524288,
    end = base + length,
    view = new DataView(memory.buffer);
  if (!Number.isInteger(length) || length < size(type) || length > WIRE_BYTES)
    throw new Error("Invalid output size");
  const claims = [[base, base + size(type)]];
  let elements = 0;
  function region(pointer, bytes, payload = false) {
    if (pointer < base || pointer > end || bytes < 0 || bytes > end - pointer)
      throw new Error("Invalid output region");
    if (payload) {
      if (
        claims.some(
          ([start, stop]) => pointer < stop && start < pointer + bytes,
        )
      )
        throw new Error("Overlapping output payload");
      claims.push([pointer, pointer + bytes]);
    }
  }
  function read(t, address, depth) {
    if (depth > 8) throw new Error("RESOURCE_LIMIT: output depth");
    region(address, size(t));
    if (t.kind === "i32") return view.getInt32(address, true);
    if (t.kind === "boolean") {
      const value = view.getInt32(address, true);
      if (value !== 0 && value !== 1) throw new Error("Invalid output boolean");
      return value === 1;
    }
    if (t.kind === "record") {
      const out = {};
      for (const field of t.fields) {
        out[field.name] = read(field.type, address, depth + 1);
        address += size(field.type);
      }
      return out;
    }
    const pointer = view.getUint32(address, true),
      count = view.getUint32(address + 4, true);
    if (!count) {
      if (pointer !== 0) throw new Error("Noncanonical empty value");
      return t.kind === "list" ? [] : "";
    }
    if (t.kind === "string") {
      if (count > 16384) throw new Error("RESOURCE_LIMIT: output string");
      region(pointer, count, true);
      return new TextDecoder("utf-8", { fatal: true }).decode(
        memory.subarray(pointer, pointer + count),
      );
    }
    if (t.kind === "list") {
      if (pointer % 4 || count > 4096 || (elements += count) > 16384)
        throw new Error("Invalid output list");
      const stride = size(t.element);
      region(pointer, count * stride, true);
      return Array.from({ length: count }, (_, i) =>
        read(t.element, pointer + i * stride, depth + 1),
      );
    }
    throw new Error("Unsupported wire type");
  }
  return read(type, base, 0);
}
export function createNativeRuntime(contract, bytes) {
  if (contract.abi !== "llang-collection-native-v1")
    throw new Error("Unsupported Wasm ABI");
  const module = new WebAssembly.Module(bytes);
  if (WebAssembly.Module.imports(module).length)
    throw new Error("Unexpected Wasm imports");
  return {
    evaluate(input) {
      const instance = new WebAssembly.Instance(module, {}),
        exports = instance.exports;
      if (
        !(exports.memory instanceof WebAssembly.Memory) ||
        exports.memory.buffer.byteLength !== 128 * 65536 ||
        typeof exports.evaluate !== "function" ||
        typeof exports.fault_code !== "function"
      )
        throw new Error("Invalid Wasm exports");
      const memory = new Uint8Array(exports.memory.buffer),
        inputLength = encode(memory, contract.inputType, input);
      let outputLength;
      try {
        outputLength = exports.evaluate(64, inputLength, 524288, WIRE_BYTES);
      } catch (cause) {
        throw new Error(
          [
            "WASM_TRAP",
            "INDEX_OUT_OF_BOUNDS",
            "DIVISION_BY_ZERO",
            "ARITHMETIC_OVERFLOW",
            "RESOURCE_LIMIT",
            "INVALID_ARTIFACT",
          ][exports.fault_code()] ?? "WASM_TRAP",
          { cause },
        );
      }
      return decode(memory, contract.outputType, outputLength);
    },
  };
}
