import {
  COLLECTION_LIMITS,
  containsFunctionType,
  type CollectionType,
} from "./llang-module-collection-ir";

export type CollectionLayout = {
  size: number;
  align: number;
  fields?: { name: string; offset: number; type: CollectionType }[];
  variants?: {
    tag: string;
    index: number;
    fields: { name: string; offset: number; type: CollectionType }[];
  }[];
};
const align = (value: number, alignment: number) =>
  (value + alignment - 1) & -alignment;
const hasLoneSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
};
const isEnumerableData = (
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { value: unknown } =>
  !!descriptor && descriptor.enumerable === true && "value" in descriptor;
function dataObject(
  value: unknown,
  expected: string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    throw new Error("INVALID_INPUT: expected plain object");
  const descriptors = Object.getOwnPropertyDescriptors(value),
    keys = Object.keys(descriptors);
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key)) ||
    expected.some((key) => !isEnumerableData(descriptors[key]))
  )
    throw new Error("INVALID_INPUT: invalid object fields");
  return Object.fromEntries(
    expected.map((key) => [key, descriptors[key]?.value]),
  );
}
export function layoutCollectionType(type: CollectionType): CollectionLayout {
  if (
    containsFunctionType(type) ||
    type.kind === "function" ||
    type.kind === "parameter"
  )
    throw new Error("function and unresolved types have no wire layout");
  if (type.kind === "boolean" || type.kind === "i32")
    return { size: 4, align: 4 };
  if (type.kind === "string" || type.kind === "list")
    return { size: 8, align: 4 };
  if (type.kind === "record") {
    let cursor = 0;
    const fields = type.fields.map((f) => {
      const layout = layoutCollectionType(f.type);
      cursor = align(cursor, layout.align);
      const result = { name: f.name, offset: cursor, type: f.type };
      cursor += layout.size;
      return result;
    });
    return { size: align(cursor, 4), align: 4, fields };
  }
  const variants = type.variants.map((variant, index) => {
    let cursor = 4;
    const fields = variant.fields.map((f) => {
      const layout = layoutCollectionType(f.type);
      cursor = align(cursor, layout.align);
      const result = { name: f.name, offset: cursor, type: f.type };
      cursor += layout.size;
      return result;
    });
    return { tag: variant.tag, index, fields, size: align(cursor, 4) };
  });
  return {
    size: Math.max(4, ...variants.map((x) => x.size)),
    align: 4,
    variants: variants.map(({ size: _size, ...x }) => x),
  };
}
function assertRegion(
  memory: Uint8Array,
  start: number,
  length: number,
  base: number,
  capacity: number,
): void {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(length) ||
    start < base ||
    length < 0 ||
    start > base + capacity ||
    length > base + capacity - start ||
    start > memory.length ||
    length > memory.length - start
  )
    throw new Error("INVALID_INPUT: wire region out of bounds");
}
function claim(
  claimed: { start: number; end: number }[],
  start: number,
  length: number,
): void {
  const end = start + length;
  if (length && claimed.some((x) => start < x.end && x.start < end))
    throw new Error("INVALID_INPUT: overlapping wire payload");
  if (length) claimed.push({ start, end });
}
export function encodeCollectionToMemory(
  memory: Uint8Array,
  type: CollectionType,
  value: unknown,
  base: number,
  capacity: number,
): number {
  const root = layoutCollectionType(type);
  if (
    !Number.isSafeInteger(base) ||
    !Number.isSafeInteger(capacity) ||
    base < 0 ||
    capacity < 0 ||
    base % root.align !== 0 ||
    base > memory.length ||
    capacity > memory.length - base
  )
    throw new Error("INVALID_INPUT: invalid wire destination");
  assertRegion(memory, base, root.size, base, capacity);
  memory.fill(0, base, base + capacity);
  let cursor = align(base + root.size, 4),
    totalElements = 0;
  const allocate = (bytes: number, alignment = 4) => {
    const start = align(cursor, alignment);
    assertRegion(memory, start, bytes, base, capacity);
    cursor = start + bytes;
    return start;
  };
  const view = new DataView(
    memory.buffer,
    memory.byteOffset,
    memory.byteLength,
  );
  const write = (
    t: CollectionType,
    v: unknown,
    address: number,
    depth: number,
  ): void => {
    if (depth > COLLECTION_LIMITS.typeDepth)
      throw new Error("RESOURCE_LIMIT: wire depth");
    const layout = layoutCollectionType(t);
    if (t.kind === "boolean") {
      if (typeof v !== "boolean")
        throw new Error("INVALID_INPUT: expected boolean");
      view.setInt32(address, v ? 1 : 0, true);
      return;
    }
    if (t.kind === "i32") {
      if (
        !Number.isInteger(v) ||
        Number(v) < -2147483648 ||
        Number(v) > 2147483647
      )
        throw new Error("INVALID_INPUT: expected i32");
      view.setInt32(address, Number(v), true);
      return;
    }
    if (t.kind === "string") {
      if (typeof v !== "string")
        throw new Error("INVALID_INPUT: expected string");
      if (hasLoneSurrogate(v))
        throw new Error("INVALID_INPUT: invalid Unicode string");
      const encoded = new TextEncoder().encode(v);
      if (encoded.length > COLLECTION_LIMITS.stringBytes)
        throw new Error("RESOURCE_LIMIT: string");
      const pointer = encoded.length ? allocate(encoded.length, 1) : 0;
      if (encoded.length) memory.set(encoded, pointer);
      view.setUint32(address, pointer, true);
      view.setUint32(address + 4, encoded.length, true);
      return;
    }
    if (t.kind === "list") {
      if (!Array.isArray(v)) throw new Error("INVALID_INPUT: expected List");
      totalElements += v.length;
      if (
        v.length > COLLECTION_LIMITS.listElements ||
        totalElements > COLLECTION_LIMITS.totalListElements
      )
        throw new Error("RESOURCE_LIMIT: List elements");
      const item = layoutCollectionType(t.element),
        stride = align(item.size, item.align),
        bytes = v.length * stride;
      if (!Number.isSafeInteger(bytes))
        throw new Error("INVALID_INPUT: List size overflow");
      const pointer = bytes ? allocate(bytes, item.align) : 0;
      view.setUint32(address, pointer, true);
      view.setUint32(address + 4, v.length, true);
      v.forEach((x, i) => {
        write(t.element, x, pointer + i * stride, depth + 1);
      });
      return;
    }
    if (t.kind === "function" || t.kind === "parameter")
      throw new Error("INVALID_INPUT: function on wire");
    if (t.kind === "record") {
      const fields = layout.fields;
      if (!fields) throw new Error("INVALID_INPUT: invalid record layout");
      const object = dataObject(
        v,
        fields.map((field) => field.name),
      );
      for (const field of fields)
        write(
          field.type,
          object[field.name],
          address + field.offset,
          depth + 1,
        );
      return;
    }
    if (
      !v ||
      typeof v !== "object" ||
      Array.isArray(v) ||
      (Object.getPrototypeOf(v) !== Object.prototype &&
        Object.getPrototypeOf(v) !== null)
    )
      throw new Error("INVALID_INPUT: expected plain object");
    const tagDescriptor = Object.getOwnPropertyDescriptor(v, "tag");
    if (
      !tagDescriptor?.enumerable ||
      !("value" in tagDescriptor) ||
      typeof tagDescriptor.value !== "string"
    )
      throw new Error("INVALID_INPUT: invalid union tag");
    const variant = layout.variants?.find((x) => x.tag === tagDescriptor.value);
    if (!variant) throw new Error("INVALID_INPUT: invalid union tag");
    const object = dataObject(v, [
      "tag",
      ...variant.fields.map((field) => field.name),
    ]);
    view.setUint32(address, variant.index, true);
    for (const field of variant.fields)
      write(field.type, object[field.name], address + field.offset, depth + 1);
  };
  write(type, value, base, 0);
  return cursor - base;
}
export function decodeCollectionFromMemory(
  memory: Uint8Array,
  type: CollectionType,
  base: number,
  length: number,
): unknown {
  const root = layoutCollectionType(type);
  if (length < root.size || length > COLLECTION_LIMITS.wireBytes)
    throw new Error("INVALID_INPUT: invalid wire length");
  assertRegion(memory, base, length, base, length);
  const view = new DataView(
      memory.buffer,
      memory.byteOffset,
      memory.byteLength,
    ),
    claimed = [{ start: base, end: base + root.size }];
  let totalElements = 0;
  const read = (t: CollectionType, address: number, depth: number): unknown => {
    if (depth > COLLECTION_LIMITS.typeDepth)
      throw new Error("RESOURCE_LIMIT: wire depth");
    const layout = layoutCollectionType(t);
    assertRegion(memory, address, layout.size, base, length);
    if (t.kind === "boolean") {
      const value = view.getInt32(address, true);
      if (value !== 0 && value !== 1)
        throw new Error("INVALID_INPUT: invalid boolean");
      return value === 1;
    }
    if (t.kind === "i32") return view.getInt32(address, true);
    if (t.kind === "string") {
      const pointer = view.getUint32(address, true),
        bytes = view.getUint32(address + 4, true);
      if (!bytes) {
        if (pointer !== 0)
          throw new Error("INVALID_INPUT: noncanonical empty string");
        return "";
      }
      if (bytes > COLLECTION_LIMITS.stringBytes)
        throw new Error("RESOURCE_LIMIT: string");
      assertRegion(memory, pointer, bytes, base, length);
      claim(claimed, pointer, bytes);
      return new TextDecoder("utf-8", { fatal: true }).decode(
        memory.subarray(pointer, pointer + bytes),
      );
    }
    if (t.kind === "list") {
      const pointer = view.getUint32(address, true),
        count = view.getUint32(address + 4, true);
      if (!count) {
        if (pointer !== 0)
          throw new Error("INVALID_INPUT: noncanonical empty List");
        return [];
      }
      totalElements += count;
      if (
        count > COLLECTION_LIMITS.listElements ||
        totalElements > COLLECTION_LIMITS.totalListElements
      )
        throw new Error("RESOURCE_LIMIT: List elements");
      const item = layoutCollectionType(t.element),
        stride = align(item.size, item.align),
        bytes = count * stride;
      if (!Number.isSafeInteger(bytes) || pointer % item.align)
        throw new Error("INVALID_INPUT: invalid List descriptor");
      assertRegion(memory, pointer, bytes, base, length);
      claim(claimed, pointer, bytes);
      return Array.from({ length: count }, (_, i) =>
        read(t.element, pointer + i * stride, depth + 1),
      );
    }
    if (t.kind === "function" || t.kind === "parameter")
      throw new Error("INVALID_INPUT: function on wire");
    if (t.kind === "record") {
      const fields = layout.fields;
      if (!fields) throw new Error("INVALID_INPUT: invalid record layout");
      return Object.fromEntries(
        fields.map((f) => [
          f.name,
          read(f.type, address + f.offset, depth + 1),
        ]),
      );
    }
    const tag = view.getUint32(address, true),
      variant = layout.variants?.[tag];
    if (!variant) throw new Error("INVALID_INPUT: invalid union tag");
    return {
      tag: variant.tag,
      ...Object.fromEntries(
        variant.fields.map((f) => [
          f.name,
          read(f.type, address + f.offset, depth + 1),
        ]),
      ),
    };
  };
  return read(type, base, 0);
}
