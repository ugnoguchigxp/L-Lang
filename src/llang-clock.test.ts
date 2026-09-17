import { describe, expect, test } from "bun:test";
import { VirtualEffectsClock } from "./llang-clock";

describe("effects virtual clock", () => {
  test("monotonic deadlines and wall-clock values are separate", async () => {
    const clock = new VirtualEffectsClock(10, 1_000),
      order: number[] = [];
    const later = clock.waitUntil(20).then(() => order.push(20)),
      sooner = clock.waitUntil(15).then(() => order.push(15));
    clock.advance(5);
    await sooner;
    expect(order).toEqual([15]);
    expect(clock.monotonicMs()).toBe(15);
    expect(clock.wallClockMs()).toBe(1_005);
    clock.advance(5);
    await later;
    expect(order).toEqual([15, 20]);
  });

  test("wait observes cooperative cancellation", async () => {
    const clock = new VirtualEffectsClock(0, 0),
      controller = new AbortController(),
      waiting = clock.waitUntil(10, controller.signal);
    controller.abort();
    expect(waiting).rejects.toThrow("CANCELLED");
    clock.advance(10);
  });
});
