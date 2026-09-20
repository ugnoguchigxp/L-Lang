import { describe, expect, test } from "bun:test";
import { RegionMemory } from "./llang-region-memory";

describe("effects region memory", () => {
  test("consumed chunks are recycled under a constant memory bound", () => {
    const memory = new RegionMemory(1024);
    for (let index = 0; index < 10_000; index++) {
      const chunk = memory.allocate(64, "temporary");
      memory.write(chunk, Uint8Array.of(index & 0xff));
      expect(memory.read(chunk)[0]).toBe(index & 0xff);
      memory.release(chunk);
    }
    expect(memory.usedBytes).toBe(0);
    expect(memory.peakBytes).toBe(64);
    expect(memory.diagnostics).toEqual({
      activeAllocations: 0,
      freeBlocks: 1,
      usedBytes: 0,
      peakBytes: 64,
      temporaryBytes: 0,
      sessionBytes: 0,
    });
  });

  test("promotion preserves await-live values and stale handles fail", () => {
    const memory = new RegionMemory(128),
      temporary = memory.allocate(4, "temporary");
    memory.write(temporary, Uint8Array.of(1, 2, 3, 4));
    const promoted = memory.promote(temporary);
    memory.release(temporary);
    expect([...memory.read(promoted)]).toEqual([1, 2, 3, 4]);
    expect(() => memory.read(temporary)).toThrow("STALE_REGION_HANDLE");
    expect(() => memory.allocate(256, "temporary")).toThrow("RESOURCE_LIMIT");
  });

  test("released metadata remains bounded and forged handles fail closed", () => {
    const memory = new RegionMemory(64);
    let stale = memory.allocate(8, "temporary"),
      active = memory.allocate(8, "session");
    expect(() => memory.read({ ...active })).toThrow("STALE_REGION_HANDLE");
    memory.release(active);
    memory.release(stale);
    for (let index = 0; index < 1_000_000; index++) {
      const handle = memory.allocate(index % 2, "temporary");
      memory.release(handle);
    }
    expect(memory.diagnostics.activeAllocations).toBe(0);
    expect(memory.diagnostics.freeBlocks).toBe(1);
    expect(() => memory.read(stale)).toThrow("STALE_REGION_HANDLE");
    expect(() => memory.release(stale)).toThrow("STALE_REGION_HANDLE");
    stale = { ...stale, id: Number.MAX_SAFE_INTEGER };
    expect(() => memory.release(stale)).toThrow("STALE_REGION_HANDLE");
  });
});
