import { describe, expect, test } from "bun:test";
import { Decimal, LBytes } from "./llang-effects-values";
import {
  emitTypedEffectsWasm,
  TypedEffectsRuntime,
} from "./llang-effects-state-machine";
import { SESSION_STATUS } from "./llang-effects-wasm";

describe("generic typed effects Wasm state machine", () => {
  test("preserves typed values across multiple await states", () => {
    const emitted = emitTypedEffectsWasm(
        {
          nodes: [
            {
              kind: "await",
              operation: "host.i64",
              version: 1,
              requestType: { kind: "i64" },
              responseType: { kind: "i64" },
              request: 1n,
            },
            {
              kind: "await",
              operation: "host.bytes",
              version: 1,
              requestType: { kind: "bytes" },
              responseType: { kind: "bytes" },
              request: LBytes.from([1, 2]),
            },
          ],
          resultType: { kind: "bytes" },
        },
        [
          { id: "host.i64", version: 1 },
          { id: "host.bytes", version: 1 },
        ],
      ),
      runtime = new TypedEffectsRuntime(emitted.bytes, emitted.states);
    try {
      const first = runtime.start();
      expect(first.status).toBe(SESSION_STATUS.YIELDED);
      expect(first.request?.kind).toBe("await");
      if (!first.request) throw new Error("missing first request");
      const second = runtime.resume(first.request, true, 44n);
      expect(second.request?.sequence).toBe(2);
      if (!second.request) throw new Error("missing second request");
      const done = runtime.resume(second.request, true, LBytes.from([9, 8, 7]));
      expect(done).toEqual({
        status: SESSION_STATUS.DONE,
        result: LBytes.from([9, 8, 7]),
      });
    } finally {
      runtime.dispose();
    }
  });

  test("lowering distinguishes task join and stream pull states", () => {
    const emitted = emitTypedEffectsWasm(
        {
          nodes: [
            {
              kind: "task",
              tasks: [
                {
                  kind: "await",
                  operation: "host.echo",
                  version: 1,
                  requestType: { kind: "i32" },
                  responseType: { kind: "i32" },
                  request: 1,
                },
              ],
              responseType: { kind: "list", element: { kind: "i32" } },
            },
            {
              kind: "stream",
              operation: "host.pull",
              version: 1,
              requestType: { kind: "i32" },
              responseType: { kind: "bytes" },
              request: 64,
              maximumChunks: 2,
            },
          ],
          resultType: { kind: "bytes" },
        },
        [
          { id: "host.echo", version: 1 },
          { id: "host.pull", version: 1 },
        ],
      ),
      runtime = new TypedEffectsRuntime(emitted.bytes, emitted.states);
    try {
      const task = runtime.start();
      expect(task.request?.kind).toBe("task");
      if (!task.request) throw new Error("missing task request");
      const stream = runtime.resume(task.request, true, [1]);
      expect(stream.request?.kind).toBe("stream");
      if (!stream.request) throw new Error("missing stream request");
      expect(runtime.resume(stream.request, true, LBytes.from([])).status).toBe(
        SESSION_STATUS.DONE,
      );
    } finally {
      runtime.dispose();
    }
  });

  test("f64 and scaled decimal cross the same continuation ABI", () => {
    const emitted = emitTypedEffectsWasm(
        {
          nodes: [
            {
              kind: "await",
              operation: "host.f64",
              version: 1,
              requestType: { kind: "f64" },
              responseType: { kind: "f64" },
              request: 0.5,
            },
            {
              kind: "await",
              operation: "host.decimal",
              version: 1,
              requestType: { kind: "decimal", scale: 2 },
              responseType: { kind: "decimal", scale: 2 },
              request: new Decimal(123n, 2),
            },
          ],
          resultType: { kind: "decimal", scale: 2 },
        },
        [
          { id: "host.f64", version: 1 },
          { id: "host.decimal", version: 1 },
        ],
      ),
      runtime = new TypedEffectsRuntime(emitted.bytes, emitted.states);
    try {
      const first = runtime.start();
      if (!first.request) throw new Error("missing f64 request");
      const second = runtime.resume(first.request, true, 0.25);
      if (!second.request) throw new Error("missing decimal request");
      const done = runtime.resume(second.request, true, new Decimal(999n, 2));
      expect(done.result).toEqual(new Decimal(999n, 2));
    } finally {
      runtime.dispose();
    }
  });
});
