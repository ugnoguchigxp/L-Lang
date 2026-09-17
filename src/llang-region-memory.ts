export type RegionHandle = Readonly<{
  id: number;
  generation: number;
  offset: number;
  length: number;
  lifetime: "temporary" | "session";
}>;
type Block = { offset: number; length: number };
type Allocation = { handle: RegionHandle; released: boolean };

const align = (value: number, alignment: number) =>
  Math.ceil(value / alignment) * alignment;

export class RegionMemory {
  readonly #memory: Uint8Array;
  readonly #free: Block[];
  readonly #allocations = new Map<number, Allocation>();
  #nextId = 1;
  #used = 0;
  #peak = 0;

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new Error("INVALID_MEMORY_CAPACITY");
    this.#memory = new Uint8Array(capacity);
    this.#free = [{ offset: 0, length: capacity }];
  }

  allocate(
    length: number,
    lifetime: "temporary" | "session",
    alignment = 8,
  ): RegionHandle {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      !Number.isSafeInteger(alignment) ||
      alignment < 1 ||
      (alignment & (alignment - 1)) !== 0
    )
      throw new Error("INVALID_ALLOCATION");
    const reserved = Math.max(1, length);
    for (let index = 0; index < this.#free.length; index++) {
      const block = this.#free[index],
        start = block && align(block.offset, alignment),
        padding = start === undefined || !block ? 0 : start - block.offset;
      if (!block || start === undefined || padding + reserved > block.length)
        continue;
      const before = padding,
        after = block.length - padding - reserved,
        replacements: Block[] = [];
      if (before) replacements.push({ offset: block.offset, length: before });
      if (after) replacements.push({ offset: start + reserved, length: after });
      this.#free.splice(index, 1, ...replacements);
      const handle = Object.freeze({
        id: this.#nextId++,
        generation: 1,
        offset: start,
        length,
        lifetime,
      });
      this.#allocations.set(handle.id, { handle, released: false });
      this.#used += reserved;
      this.#peak = Math.max(this.#peak, this.#used);
      return handle;
    }
    throw new Error("RESOURCE_LIMIT: memory");
  }

  write(handle: RegionHandle, value: Uint8Array): void {
    const allocation = this.#get(handle);
    if (value.length > allocation.handle.length)
      throw new Error("REGION_OUT_OF_BOUNDS");
    this.#memory.fill(
      0,
      allocation.handle.offset,
      allocation.handle.offset + allocation.handle.length,
    );
    this.#memory.set(value, allocation.handle.offset);
  }

  read(handle: RegionHandle): Uint8Array {
    const allocation = this.#get(handle);
    return this.#memory.slice(
      allocation.handle.offset,
      allocation.handle.offset + allocation.handle.length,
    );
  }

  promote(handle: RegionHandle): RegionHandle {
    const allocation = this.#get(handle);
    if (allocation.handle.lifetime === "session") return allocation.handle;
    const promoted = this.allocate(handle.length, "session");
    this.write(promoted, this.read(handle));
    return promoted;
  }

  release(handle: RegionHandle): void {
    const allocation = this.#get(handle);
    allocation.released = true;
    const reserved = Math.max(1, handle.length);
    this.#memory.fill(0, handle.offset, handle.offset + reserved);
    this.#used -= reserved;
    this.#free.push({ offset: handle.offset, length: reserved });
    this.#free.sort((a, b) => a.offset - b.offset);
    for (let index = this.#free.length - 1; index > 0; index--) {
      const previous = this.#free[index - 1],
        current = this.#free[index];
      if (
        previous &&
        current &&
        previous.offset + previous.length === current.offset
      ) {
        previous.length += current.length;
        this.#free.splice(index, 1);
      }
    }
  }

  get usedBytes(): number {
    return this.#used;
  }

  get peakBytes(): number {
    return this.#peak;
  }

  #get(handle: RegionHandle): Allocation {
    const allocation = this.#allocations.get(handle.id);
    if (
      !allocation ||
      allocation.released ||
      allocation.handle.generation !== handle.generation ||
      allocation.handle.offset !== handle.offset ||
      allocation.handle.length !== handle.length ||
      allocation.handle.lifetime !== handle.lifetime
    )
      throw new Error("STALE_REGION_HANDLE");
    return allocation;
  }
}
