import { describe, expect, test } from "bun:test";
import {
  effectsManifest,
  HostOperationRegistry,
  ResourceLedger,
  type OperationDefinition,
} from "./llang-effects-contract";
import { EffectsSession, ResourceScope } from "./llang-effects-session";

const operation: OperationDefinition = {
  id: "host.lookup",
  version: 1,
  requestType: { id: "i64" },
  responseType: { name: "string" },
  errorType: { code: "string" },
  effect: "host",
  resource: "none",
  cancellable: true,
  idempotent: true,
};
const limits = {
  hostRequests: 4,
  tasks: 4,
  concurrentIo: 2,
  concurrentTasks: 2,
  openResources: 4,
  streams: 2,
  sentBytes: 1024,
  receivedBytes: 1024,
  memoryBytes: 1024,
  fuel: 100,
};
const setup = (deadline = 100) => {
  const registry = new HostOperationRegistry([operation]);
  return new EffectsSession(
    "session",
    effectsManifest(registry, [{ id: operation.id, version: 1 }]),
    registry,
    { operations: new Set(["host.lookup@1"]), wallClock: false },
    new ResourceLedger(limits),
    0,
    deadline,
  );
};

describe("effects session boundary", () => {
  test("request ids are unique and duplicate or unknown responses fail closed", () => {
    const session = setup(),
      first = session.dispatch(
        {
          taskId: 2,
          operation: "host.lookup",
          version: 1,
          payload: { id: "1" },
        },
        1,
      ),
      second = session.dispatch(
        {
          taskId: 2,
          operation: "host.lookup",
          version: 1,
          payload: { id: "2" },
        },
        2,
      );
    expect(first.id).not.toBe(second.id);
    expect(
      session.settle(first.id, { ok: true, value: { name: "A" } }, 3)?.outcome,
    ).toEqual({
      ok: true,
      value: { name: "A" },
    });
    expect(() => session.settle(first.id, { ok: true, value: {} }, 4)).toThrow(
      "DUPLICATE_RESPONSE",
    );
    expect(() =>
      session.settle("session:9:0:99", { ok: true, value: {} }, 4),
    ).toThrow("UNKNOWN_REQUEST_ID");
  });

  test("deadline wins at the boundary and cancellation drops late responses", () => {
    const timed = setup(10),
      request = timed.dispatch(
        { taskId: 1, operation: "host.lookup", version: 1, payload: {} },
        1,
      ),
      event = timed.settle(request.id, { ok: true, value: "late" }, 10);
    expect(event?.outcome).toEqual({
      ok: false,
      error: { code: "timeout", outcome: "unknown" },
    });
    const cancelled = setup(),
      pending = cancelled.dispatch(
        { taskId: 1, operation: "host.lookup", version: 1, payload: {} },
        1,
      );
    expect(cancelled.cancel("parent", 2)).toEqual([pending.id]);
    expect(
      cancelled.settle(pending.id, { ok: true, value: "late" }, 3),
    ).toBeUndefined();
    expect(() =>
      cancelled.dispatch(
        { taskId: 1, operation: "host.lookup", version: 1, payload: {} },
        4,
      ),
    ).toThrow("SESSION_NOT_ACTIVE");
  });

  test("transcript redacts targets and stores only payload hashes", () => {
    const session = setup();
    session.dispatch(
      {
        taskId: 1,
        operation: "host.lookup",
        version: 1,
        payload: { credential: "secret" },
        target: {
          url: "https://example.test/private?id=secret",
          method: "GET",
        },
      },
      1,
    );
    const text = JSON.stringify(session.transcript());
    expect(text).not.toContain("secret");
    expect(text).toContain("https://example.test/<redacted>");
  });

  test("resource scope validates ownership and cleans up in reverse order", async () => {
    const ledger = new ResourceLedger(limits),
      scope = new ResourceScope(7, ledger),
      order: string[] = [],
      first = scope.acquire("file", () => {
        order.push("first");
      }),
      second = scope.acquire("stream", () => {
        order.push("second");
      });
    scope.assert(first, "file");
    expect(() => scope.assert({ ...second, scope: 8 }, "stream")).toThrow(
      "STALE_RESOURCE_HANDLE",
    );
    expect(await scope.dispose()).toEqual([]);
    expect(order).toEqual(["second", "first"]);
    await scope.close(first);
    expect(order).toEqual(["second", "first"]);
  });
});
