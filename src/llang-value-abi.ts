import { VALUE_LIMITS, type ValueType } from "./llang-module-value-ir";
import {
  ValueFault,
  assertUnicode,
  validateValue,
  type ValueRuntime,
} from "./llang-module-value-evaluator";

export const VALUE_ABI = "llang-value-memory-v1" as const;
export const VALUE_MEMORY_PAGES = 16;
export const VALUE_MIN_ADDRESS = 64;
export const VALUE_FAULT = {
  OK: 0,
  INVALID_INPUT: 1,
  ARITHMETIC_OVERFLOW: 2,
  DIVISION_BY_ZERO: 3,
  RESOURCE_LIMIT: 4,
  INVALID_ARTIFACT: 5,
} as const;
export type ValueLayout = {
  size: number;
  align: 4;
  fields?: {
    name: string;
    offset: number;
    type: ValueType;
    layout: ValueLayout;
  }[];
  variants?: {
    tag: string;
    index: number;
    fields: {
      name: string;
      offset: number;
      type: ValueType;
      layout: ValueLayout;
    }[];
  }[];
};
const align4 = (n: number) => (n + 3) & ~3;
export function layoutValueType(type: ValueType, depth = 0): ValueLayout {
  if (depth > 8) throw new Error("INVALID_ARTIFACT: layout depth");
  if (type.kind === "boolean" || type.kind === "i32")
    return { size: 4, align: 4 };
  if (type.kind === "string") return { size: 8, align: 4 };
  if (type.kind === "record") {
    let cursor = 0;
    const fields = type.fields.map((field) => {
      cursor = align4(cursor);
      const layout = layoutValueType(field.type, depth + 1),
        result = { name: field.name, offset: cursor, type: field.type, layout };
      cursor += layout.size;
      return result;
    });
    const size = align4(cursor);
    if (size > VALUE_LIMITS.payloadBytes)
      throw new Error("INVALID_ARTIFACT: layout exceeds 64 KiB");
    return { size, align: 4, fields };
  }
  const variants = type.variants.map((variant, index) => {
    let cursor = 4;
    const fields = variant.fields.map((field) => {
      cursor = align4(cursor);
      const layout = layoutValueType(field.type, depth + 1),
        result = { name: field.name, offset: cursor, type: field.type, layout };
      cursor += layout.size;
      return result;
    });
    return { tag: variant.tag, index, fields };
  });
  const size = align4(
    Math.max(
      4,
      ...variants.map((v) =>
        Math.max(4, ...v.fields.map((f) => f.offset + f.layout.size)),
      ),
    ),
  );
  if (size > VALUE_LIMITS.payloadBytes)
    throw new Error("INVALID_ARTIFACT: layout exceeds 64 KiB");
  return { size, align: 4, variants };
}
function range(
  pointer: number,
  length: number,
  base: number,
  capacity: number,
): void {
  if (
    !Number.isInteger(pointer) ||
    !Number.isInteger(length) ||
    pointer < base ||
    length < 0 ||
    pointer + length > base + capacity ||
    pointer + length > 0x7fffffff
  )
    throw new ValueFault("INVALID_INPUT", "wire pointer is out of range");
}
export function encodeValueToMemory(
  memory: Uint8Array,
  type: ValueType,
  input: unknown,
  base: number,
  capacity: number,
): number {
  if (
    base < VALUE_MIN_ADDRESS ||
    capacity < 0 ||
    base + capacity > memory.byteLength
  )
    throw new ValueFault(
      "INVALID_INPUT",
      "wire buffer is out of memory bounds",
    );
  range(base, capacity, base, capacity);
  if (capacity > VALUE_LIMITS.payloadBytes)
    capacity = VALUE_LIMITS.payloadBytes;
  const value = validateValue(type, input),
    view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength),
    layout = layoutValueType(type);
  let cursor = align4(layout.size);
  if (cursor > capacity)
    throw new ValueFault("RESOURCE_LIMIT", "wire payload is too small");
  memory.fill(0, base, base + capacity);
  const write = (t: ValueType, item: ValueRuntime, offset: number): void => {
    if (t.kind === "boolean") {
      view.setInt32(base + offset, item ? 1 : 0, true);
      return;
    }
    if (t.kind === "i32") {
      view.setInt32(base + offset, item as number, true);
      return;
    }
    if (t.kind === "string") {
      const bytes = new TextEncoder().encode(item as string);
      if (cursor + bytes.length > capacity)
        throw new ValueFault("RESOURCE_LIMIT", "wire payload is too small");
      view.setUint32(base + offset, base + cursor, true);
      view.setUint32(base + offset + 4, bytes.length, true);
      memory.set(bytes, base + cursor);
      cursor = align4(cursor + bytes.length);
      return;
    }
    const object = item as Record<string, ValueRuntime>,
      current = layoutValueType(t);
    if (t.kind === "record") {
      for (const field of current.fields ?? [])
        write(field.type, object[field.name]!, offset + field.offset);
      return;
    }
    const variant = current.variants?.find((x) => x.tag === object.tag);
    if (!variant) throw new ValueFault("INVALID_INPUT", "unknown union tag");
    view.setUint32(base + offset, variant.index, true);
    for (const field of variant.fields)
      write(field.type, object[field.name]!, offset + field.offset);
  };
  write(type, value, 0);
  return cursor;
}
export function decodeValueFromMemory(
  memory: Uint8Array,
  type: ValueType,
  base: number,
  capacity: number,
): ValueRuntime {
  if (
    base < VALUE_MIN_ADDRESS ||
    capacity < 0 ||
    base + capacity > memory.byteLength
  )
    throw new Error("INVALID_ARTIFACT: wire buffer is out of memory bounds");
  range(base, capacity, base, capacity);
  const view = new DataView(
      memory.buffer,
      memory.byteOffset,
      memory.byteLength,
    ),
    decoder = new TextDecoder("utf-8", { fatal: true });
  const read = (t: ValueType, offset: number): ValueRuntime => {
    const current = layoutValueType(t);
    range(base + offset, current.size, base, capacity);
    if (t.kind === "boolean") {
      const value = view.getInt32(base + offset, true);
      if (value !== 0 && value !== 1)
        throw new Error("INVALID_ARTIFACT: invalid boolean");
      return Boolean(value);
    }
    if (t.kind === "i32") return view.getInt32(base + offset, true);
    if (t.kind === "string") {
      const pointer = view.getUint32(base + offset, true),
        length = view.getUint32(base + offset + 4, true);
      range(pointer, length, base, capacity);
      let value: string;
      try {
        value = decoder.decode(memory.subarray(pointer, pointer + length));
      } catch {
        throw new Error("INVALID_ARTIFACT: invalid UTF-8");
      }
      assertUnicode(value);
      return value;
    }
    if (t.kind === "record")
      return Object.fromEntries(
        (current.fields ?? []).map((field) => [
          field.name,
          read(field.type, offset + field.offset),
        ]),
      );
    const index = view.getUint32(base + offset, true),
      variant = current.variants?.find((x) => x.index === index);
    if (!variant) throw new Error("INVALID_ARTIFACT: invalid union tag");
    return {
      tag: variant.tag,
      ...Object.fromEntries(
        variant.fields.map((field) => [
          field.name,
          read(field.type, offset + field.offset),
        ]),
      ),
    };
  };
  return read(type, 0);
}
export function rangesOverlap(
  a: number,
  al: number,
  b: number,
  bl: number,
): boolean {
  return a < b + bl && b < a + al;
}
