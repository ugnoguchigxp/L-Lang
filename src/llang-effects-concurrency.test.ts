import { describe, expect, test } from "bun:test";
import { ResourceLedger } from "./llang-effects-contract";
import {
  BoundedPullStream,
  RuntimeTaskFault,
  StructuredTaskScope,
} from "./llang-effects-concurrency";
import { LBytes } from "./llang-effects-values";

const limits = {
  hostRequests: 10,
  tasks: 10,
  concurrentIo: 2,
  concurrentTasks: 2,
  openResources: 2,
  streams: 2,
  sentBytes: 1024,
  receivedBytes: 1024,
  memoryBytes: 1024,
  fuel: 100,
};

describe("structured tasks and pull streams", () => {
  test("join preserves spawn order while execution is concurrency-limited", async () => {
    const scope = new StructuredTaskScope(new ResourceLedger(limits), 2),
      completion: number[] = [];
    scope.spawn(async () => {
      await Bun.sleep(5);
      completion.push(0);
      return "first";
    });
    scope.spawn(async () => {
      completion.push(1);
      return "second";
    });
    scope.spawn(async () => {
      completion.push(2);
      return "third";
    });
    expect(await scope.joinAll<string>()).toEqual(["first", "second", "third"]);
    expect(completion[0]).toBe(1);
  });

  test("runtime fault cancels siblings and queued tasks", async () => {
    const scope = new StructuredTaskScope(new ResourceLedger(limits), 2),
      observed: string[] = [];
    scope.spawn(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            observed.push("cancelled");
            reject(new Error("CANCELLED"));
          });
        }),
    );
    scope.spawn(async () => {
      throw new RuntimeTaskFault("FAULT");
    });
    scope.spawn(async () => "never");
    expect(scope.joinAll()).rejects.toThrow("FAULT");
    expect(observed).toEqual(["cancelled"]);
  });

  test("pull stream permits one outstanding read and propagates early cancel", async () => {
    let resolve!: (value: { eof: false; bytes: LBytes }) => void,
      closed = 0;
    const stream = new BoundedPullStream(
        () =>
          new Promise((ok) => {
            resolve = ok;
          }),
        () => {
          closed += 1;
        },
      ),
      pending = stream.read();
    expect(stream.read()).rejects.toThrow("STREAM_READ_PENDING");
    resolve({ eof: false, bytes: LBytes.from([1, 2]) });
    expect(await pending).toEqual({ eof: false, bytes: LBytes.from([1, 2]) });
    await stream.cancel();
    expect(closed).toBe(1);
    expect(await stream.read()).toEqual({ eof: true });
  });
});
