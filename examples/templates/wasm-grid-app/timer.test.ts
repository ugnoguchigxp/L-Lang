import { expect, test } from "bun:test";
import { join } from "node:path";
const timerPath = join(import.meta.dir, "timer.js");
const { createTimer } = await import(timerPath);
function fixture() {
  let time = 0,
    ticks = 0,
    nextId = 1;
  const pending = new Map<number, { fn: () => void; due: number }>();
  const timer = createTimer(() => ticks++, {
    now: () => time,
    start: (fn: () => void, delay: number) => {
      const id = nextId++;
      pending.set(id, { fn, due: time + delay });
      return id;
    },
    stop: (id: number) => pending.delete(id),
  });
  return {
    timer,
    pending,
    ticks: () => ticks,
    time: (value: number) => {
      time = value;
    },
  };
}
test("repeated inputs preserve the current deadline instead of postponing gravity", () => {
  const f = fixture();
  f.timer.update(800);
  f.time(300);
  f.timer.update(800);
  expect([...f.pending.values()][0]?.due).toBe(800);
  f.time(700);
  f.timer.update(800);
  expect([...f.pending.values()][0]?.due).toBe(800);
  [...f.pending.values()][0]?.fn();
  expect(f.ticks()).toBe(1);
});
test("a new tick, reset, or changed interval starts a fresh deadline", () => {
  const f = fixture();
  f.timer.update(800);
  f.time(300);
  f.timer.update(800, true);
  expect([...f.pending.values()][0]?.due).toBe(1100);
  f.time(400);
  f.timer.update(740);
  expect([...f.pending.values()][0]?.due).toBe(1140);
});
test("cancelled callbacks cannot apply after pause or reset", () => {
  const f = fixture();
  f.timer.update(800);
  const stale = [...f.pending.values()][0]?.fn;
  f.timer.update(0);
  stale?.();
  expect(f.ticks()).toBe(0);
  expect(f.pending.size).toBe(0);
  f.timer.update(800);
  const second = [...f.pending.values()][0]?.fn;
  f.timer.update(800, true);
  second?.();
  expect(f.ticks()).toBe(0);
});
test("hidden or stopped timing does not accumulate overdue ticks", () => {
  const f = fixture();
  f.timer.update(800);
  f.time(300);
  f.timer.cancel(true);
  f.time(10000);
  f.timer.update(800);
  expect([...f.pending.values()][0]?.due).toBe(10800);
});
test("invalid intervals fail without retaining scheduled callbacks", () => {
  const f = fixture();
  for (const bad of [-1, 60001, NaN, 1.5]) {
    f.timer.update(800);
    expect(() => f.timer.update(bad)).toThrow("Invalid timer view");
    expect(f.pending.size).toBe(0);
  }
});
