import { describe, expect, test } from "bun:test";
import {
  assertGranted,
  checkTransitiveEffects,
  effectsManifest,
  HostOperationRegistry,
  operationSignature,
  ResourceLedger,
  type OperationDefinition,
} from "./llang-effects-contract";

const definitions: OperationDefinition[] = [
  {
    id: "file.readChunk",
    version: 1,
    requestType: { handle: "resource", maximum: "i32" },
    responseType: { bytes: "bytes", eof: "boolean" },
    errorType: { code: "string" },
    effect: "file",
    resource: "file",
    cancellable: true,
    idempotent: true,
  },
  {
    id: "http.request",
    version: 1,
    requestType: { url: "string", method: "string" },
    responseType: { status: "i32" },
    errorType: { code: "string", outcome: "string" },
    effect: "http",
    resource: "http-body",
    cancellable: true,
    idempotent: false,
  },
];

describe("effects operation contracts, grants and budgets", () => {
  test("registry pins version, signature and transitive effect set", () => {
    const registry = new HostOperationRegistry(definitions),
      manifest = effectsManifest(registry, [
        { id: "http.request", version: 1 },
        { id: "file.readChunk", version: 1 },
      ]);
    expect(manifest.effects).toEqual(["file", "http"]);
    expect(manifest.operations[0]?.signatureHash).toBe(
      operationSignature(definitions[0]!),
    );
    expect(() => registry.verify(manifest)).not.toThrow();
    expect(() =>
      registry.verify({
        ...manifest,
        operations: [
          { ...manifest.operations[0]!, signatureHash: "0".repeat(64) },
          manifest.operations[1]!,
        ],
      }),
    ).toThrow("OPERATION_CONTRACT_MISMATCH");
  });

  test("dispatch rechecks operation and target grants", () => {
    const registry = new HostOperationRegistry(definitions),
      grant = {
        operations: new Set(["file.readChunk@1", "http.request@1"]),
        file: {
          roots: ["/sandbox/data"],
          read: true,
          write: false,
          replace: false,
        },
        http: {
          origins: new Set(["https://api.example.test"]),
          methods: new Set(["GET"]),
          requestHeaders: new Set(["accept"]),
        },
        wallClock: false,
      };
    expect(() =>
      assertGranted(registry.get("file.readChunk", 1)!, grant, {
        path: "/sandbox/data/orders.bin",
        fileMode: "read",
      }),
    ).not.toThrow();
    expect(() =>
      assertGranted(registry.get("file.readChunk", 1)!, grant, {
        path: "/sandbox/database",
        fileMode: "read",
      }),
    ).toThrow("PERMISSION_DENIED");
    expect(() =>
      assertGranted(registry.get("http.request", 1)!, grant, {
        url: "https://api.example.test/orders",
        method: "POST",
      }),
    ).toThrow("PERMISSION_DENIED");
  });

  test("one shared ledger enforces cumulative and concurrent limits", () => {
    const ledger = new ResourceLedger({
      hostRequests: 2,
      tasks: 1,
      concurrentIo: 1,
      concurrentTasks: 1,
      openResources: 1,
      streams: 1,
      sentBytes: 4,
      receivedBytes: 4,
      memoryBytes: 16,
      fuel: 10,
    });
    ledger.consume("hostRequests", 2);
    expect(() => ledger.consume("hostRequests")).toThrow("RESOURCE_LIMIT");
    ledger.consume("concurrentIo");
    expect(() => ledger.consume("concurrentIo")).toThrow("RESOURCE_LIMIT");
    ledger.release("concurrentIo");
    expect(ledger.used("concurrentIo")).toBe(0);
  });

  test("effect checker aggregates callees and enforces callback limits", () => {
    const registry = new HostOperationRegistry(definitions);
    expect(
      checkTransitiveEffects(
        [
          {
            name: "read",
            declared: ["file"],
            operations: [{ id: "file.readChunk", version: 1 }],
            calls: [],
          },
          {
            name: "entry",
            declared: ["file"],
            operations: [],
            calls: ["read"],
          },
        ],
        registry,
      ).get("entry"),
    ).toEqual(["file"]);
    expect(() =>
      checkTransitiveEffects(
        [
          {
            name: "callback",
            declared: ["file"],
            operations: [{ id: "file.readChunk", version: 1 }],
            calls: [],
            callbackLimit: [],
          },
        ],
        registry,
      ),
    ).toThrow("CALLBACK_EFFECT_EXCEEDED");
  });
});
