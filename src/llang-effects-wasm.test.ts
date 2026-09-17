import { describe, expect, test } from "bun:test";
import {
  assertEffectsWasm,
  emitLinearEffectsWasm,
  LinearEffectsRuntime,
  replayLinearEffects,
  SESSION_STATUS,
} from "./llang-effects-wasm";

type Exports = {
  memory: WebAssembly.Memory;
  start: (out: number, capacity: number) => number;
  resume: (
    event: number,
    length: number,
    out: number,
    capacity: number,
  ) => number;
  cancel: () => number;
  dispose: () => number;
  fault_code: () => number;
};

describe("effects continuation Wasm ABI", () => {
  test("multiple waits resume exactly once and Wasm computes the result", () => {
    const emitted = emitLinearEffectsWasm({
        initial: 10,
        steps: [
          { operation: 2, payload: 100, combine: "add" },
          { operation: 3, payload: 200, combine: "replace" },
        ],
      }),
      instance = new WebAssembly.Instance(assertEffectsWasm(emitted.bytes), {}),
      ex = instance.exports as unknown as Exports,
      view = new DataView(ex.memory.buffer),
      request = 64,
      event = 128,
      output = 192;
    expect(ex.start(request, 16)).toBe(SESSION_STATUS.YIELDED);
    expect([
      view.getUint32(request, true),
      view.getUint32(request + 4, true),
    ]).toEqual([0, 1]);
    expect(view.getInt32(request + 8, true)).toBe(2);
    view.setUint32(event, 0, true);
    view.setUint32(event + 4, 1, true);
    view.setUint32(event + 8, 1, true);
    view.setInt32(event + 12, 5, true);
    expect(ex.resume(event, 16, request, 16)).toBe(SESSION_STATUS.YIELDED);
    expect(view.getUint32(request + 4, true)).toBe(2);
    view.setUint32(event + 4, 2, true);
    view.setInt32(event + 12, 7, true);
    expect(ex.resume(event, 16, output, 4)).toBe(SESSION_STATUS.DONE);
    expect(view.getInt32(output, true)).toBe(7);
  });

  test("duplicate events and post-cancel resumes fail in Wasm", () => {
    const emitted = emitLinearEffectsWasm({
        initial: 0,
        steps: [{ operation: 1, payload: 0, combine: "replace" }],
      }),
      ex = new WebAssembly.Instance(assertEffectsWasm(emitted.bytes), {})
        .exports as unknown as Exports,
      view = new DataView(ex.memory.buffer);
    expect(ex.start(64, 16)).toBe(SESSION_STATUS.YIELDED);
    view.setUint32(128, 0, true);
    view.setUint32(132, 1, true);
    view.setUint32(136, 1, true);
    view.setInt32(140, 1, true);
    expect(ex.resume(128, 16, 192, 4)).toBe(SESSION_STATUS.DONE);
    expect(ex.resume(128, 16, 192, 4)).toBe(SESSION_STATUS.FAILED);

    const cancelled = new WebAssembly.Instance(
      assertEffectsWasm(emitted.bytes),
      {},
    ).exports as unknown as Exports;
    expect(cancelled.start(64, 16)).toBe(SESSION_STATUS.YIELDED);
    expect(cancelled.cancel()).toBe(SESSION_STATUS.CANCELLED);
    expect(cancelled.resume(128, 16, 192, 4)).toBe(SESSION_STATUS.FAILED);
  });

  test("checked continuation arithmetic reports a numeric fault", () => {
    const emitted = emitLinearEffectsWasm({
        initial: 2147483647,
        steps: [{ operation: 1, payload: 0, combine: "add" }],
      }),
      ex = new WebAssembly.Instance(assertEffectsWasm(emitted.bytes), {})
        .exports as unknown as Exports,
      view = new DataView(ex.memory.buffer);
    expect(ex.start(64, 16)).toBe(SESSION_STATUS.YIELDED);
    view.setUint32(128, 0, true);
    view.setUint32(132, 1, true);
    view.setUint32(136, 1, true);
    view.setInt32(140, 1, true);
    expect(ex.resume(128, 16, 192, 4)).toBe(SESSION_STATUS.FAILED);
    expect(ex.fault_code()).toBe(3);
  });

  test("portable runtime replays fixed events without host IO", () => {
    const emitted = emitLinearEffectsWasm({
        initial: 1,
        steps: [
          { operation: 4, payload: 8, combine: "add" },
          { operation: 5, payload: 9, combine: "add" },
        ],
      }),
      fixture = [
        {
          request: { generation: 0, sequence: 1, operation: 4, payload: 8 },
          response: { ok: true, value: 2 },
        },
        {
          request: { generation: 0, sequence: 2, operation: 5, payload: 9 },
          response: { ok: true, value: 3 },
        },
      ];
    expect(replayLinearEffects(emitted.bytes, fixture).result).toBe(6);
    expect(() =>
      replayLinearEffects(emitted.bytes, [
        { ...fixture[0]!, request: { ...fixture[0]!.request, sequence: 9 } },
        fixture[1]!,
      ]),
    ).toThrow("REPLAY_MISMATCH");
    const runtime = new LinearEffectsRuntime(emitted.bytes);
    expect(runtime.start().request?.operation).toBe(4);
    runtime.cancel();
    expect(() =>
      runtime.resume(fixture[0]!.request, fixture[0]!.response),
    ).toThrow("EFFECTS_WASM_FAULT");
    runtime.dispose();
  });
});
