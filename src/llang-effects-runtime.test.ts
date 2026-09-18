import { describe, expect, test } from "bun:test";
import {
  effectsManifest,
  HostOperationRegistry,
  type OperationDefinition,
} from "./llang-effects-contract";
import { runLinearEffects } from "./llang-effects-runtime";
import { emitLinearEffectsWasm } from "./llang-effects-wasm";

const operation: OperationDefinition = {
  id: "host.increment",
  version: 1,
  requestType: { value: "i32" },
  responseType: { value: "i32" },
  errorType: { code: "string" },
  effect: "host",
  resource: "none",
  cancellable: true,
  idempotent: true,
};

describe("linear effects host runtime", () => {
  test("executes Wasm through grants, budgets and the transcript boundary", async () => {
    const registry = new HostOperationRegistry([operation]),
      manifest = effectsManifest(registry, [{ id: operation.id, version: 1 }]),
      wasm = emitLinearEffectsWasm({
        initial: 1,
        steps: [
          { operation: 0, payload: 40, combine: "replace" },
          { operation: 0, payload: 2, combine: "add" },
        ],
      }).bytes,
      seen: number[] = [],
      execution = await runLinearEffects({
        wasm,
        manifest,
        registry,
        grant: {
          operations: new Set(["host.increment@1"]),
          wallClock: false,
        },
        sessionId: "runtime-test",
        startedAtMs: 0,
        deadlineMs: 100,
        now: () => 1,
        execute: async (request) => {
          seen.push(request.payload as number);
          return { ok: true, value: request.payload };
        },
      });
    expect(execution.result).toBe(42);
    expect(seen).toEqual([40, 2]);
    expect(execution.ledger.used("hostRequests")).toBe(2);
    expect(execution.ledger.used("concurrentIo")).toBe(0);
    expect(execution.transcript.map((entry) => entry.kind)).toEqual([
      "request",
      "response",
      "request",
      "response",
    ]);
  });

  test("fails closed before execution when an operation is not granted", async () => {
    const registry = new HostOperationRegistry([operation]),
      manifest = effectsManifest(registry, [{ id: operation.id, version: 1 }]),
      wasm = emitLinearEffectsWasm({
        initial: 0,
        steps: [{ operation: 0, payload: 1, combine: "replace" }],
      }).bytes;
    let called = false;
    await expect(
      runLinearEffects({
        wasm,
        manifest,
        registry,
        grant: { operations: new Set(), wallClock: false },
        execute: async () => {
          called = true;
          return { ok: true, value: 1 };
        },
      }),
    ).rejects.toThrow("PERMISSION_DENIED: operation");
    expect(called).toBe(false);
  });

  test("cancellation aborts the executor and rejects late completion", async () => {
    const registry = new HostOperationRegistry([operation]),
      manifest = effectsManifest(registry, [{ id: operation.id, version: 1 }]),
      wasm = emitLinearEffectsWasm({
        initial: 0,
        steps: [{ operation: 0, payload: 1, combine: "replace" }],
      }).bytes,
      controller = new AbortController(),
      running = runLinearEffects({
        wasm,
        manifest,
        registry,
        grant: {
          operations: new Set(["host.increment@1"]),
          wallClock: false,
        },
        signal: controller.signal,
        execute: async () => new Promise<never>(() => undefined),
      });
    controller.abort();
    await expect(running).rejects.toThrow("CANCELLED");
  });
});
