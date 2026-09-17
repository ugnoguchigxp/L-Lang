import {
  assertGranted,
  type EffectsGrant,
  type EffectsManifest,
  type HostOperationRegistry,
  type OperationDefinition,
  type ResourceLedger,
} from "./llang-effects-contract";
import { fingerprintFor } from "./stable-hash";

export type RequestId = `${string}:${number}:${number}:${number}`;
export type IoErrorCode =
  | "not-found"
  | "permission"
  | "connection"
  | "timeout"
  | "cancelled"
  | "invalid-response"
  | "resource-limit"
  | "internal";
export type OperationOutcome =
  | Readonly<{ ok: true; value: unknown; receivedBytes?: number }>
  | Readonly<{
      ok: false;
      error: {
        code: IoErrorCode;
        message?: string;
        outcome?: "known" | "unknown";
      };
    }>;
export type HostRequest = Readonly<{
  taskId: number;
  operation: string;
  version: number;
  payload: unknown;
  sentBytes?: number;
  target?: Readonly<{
    path?: string;
    fileMode?: "read" | "write" | "replace";
    url?: string;
    method?: string;
    headers?: readonly string[];
  }>;
  cleanup?: boolean;
}>;
export type RequestEnvelope = Readonly<{
  id: RequestId;
  request: HostRequest;
}>;
export type ResponseEvent = Readonly<{
  id: RequestId;
  sequence: number;
  monotonicMs: number;
  outcome: OperationOutcome;
}>;
export type TranscriptEntry = Readonly<{
  sequence: number;
  kind: "request" | "response" | "cancel" | "cleanup";
  requestId?: RequestId;
  operation?: string;
  target?: string;
  payloadHash?: string;
  outcome?: "ok" | IoErrorCode;
}>;

type Pending = {
  operation: OperationDefinition;
  request: HostRequest;
  generation: number;
};

const redactTarget = (request: HostRequest): string | undefined => {
  if (request.target?.path) return "file:<redacted>";
  if (request.target?.url) {
    try {
      return `${new URL(request.target.url).origin}/<redacted>`;
    } catch {
      return "url:<invalid>";
    }
  }
  return undefined;
};

export class EffectsSession {
  readonly #pending = new Map<RequestId, Pending>();
  readonly #settled = new Set<RequestId>();
  readonly #transcript: TranscriptEntry[] = [];
  readonly #declared = new Map<string, string>();
  #requestSequence = 0;
  #eventSequence = 0;
  #generation = 0;
  #terminal: "active" | "cancelled" | "done" | "failed" = "active";
  #cancelReason: string | undefined;

  constructor(
    readonly id: string,
    manifest: EffectsManifest,
    readonly registry: HostOperationRegistry,
    readonly grant: EffectsGrant,
    readonly ledger: ResourceLedger,
    readonly startedAtMs: number,
    readonly deadlineMs: number,
  ) {
    registry.verify(manifest);
    if (!id || id.includes(":")) throw new Error("INVALID_SESSION_ID");
    if (
      !Number.isFinite(startedAtMs) ||
      !Number.isFinite(deadlineMs) ||
      deadlineMs < startedAtMs
    )
      throw new Error("INVALID_DEADLINE");
    for (const operation of manifest.operations)
      this.#declared.set(
        `${operation.id}@${operation.version}`,
        operation.signatureHash,
      );
  }

  dispatch(request: HostRequest, nowMs: number): RequestEnvelope {
    if (this.#terminal !== "active" && !request.cleanup)
      throw new Error("SESSION_NOT_ACTIVE");
    if (nowMs >= this.deadlineMs && !request.cleanup) {
      this.cancel("deadline", nowMs);
      throw new Error("TIMEOUT");
    }
    const operation = this.registry.get(request.operation, request.version),
      key = `${request.operation}@${request.version}`;
    if (!operation || !this.#declared.has(key))
      throw new Error("INVALID_ARTIFACT: undeclared operation");
    assertGranted(operation, this.grant, request.target);
    this.ledger.consume("hostRequests");
    this.ledger.consume("concurrentIo");
    this.ledger.consume("sentBytes", request.sentBytes ?? 0);
    const id =
      `${this.id}:${request.taskId}:${this.#generation}:${++this.#requestSequence}` as RequestId;
    this.#pending.set(id, { operation, request, generation: this.#generation });
    const target = redactTarget(request);
    this.#transcript.push(
      Object.freeze({
        sequence: ++this.#eventSequence,
        kind: request.cleanup ? "cleanup" : "request",
        requestId: id,
        operation: key,
        ...(target ? { target } : {}),
        payloadHash: fingerprintFor({ payload: request.payload }),
      }),
    );
    return Object.freeze({ id, request });
  }

  settle(
    id: RequestId,
    outcome: OperationOutcome,
    nowMs: number,
  ): ResponseEvent | undefined {
    if (this.#settled.has(id)) throw new Error("DUPLICATE_RESPONSE");
    const pending = this.#pending.get(id);
    if (!pending) throw new Error("UNKNOWN_REQUEST_ID");
    this.#pending.delete(id);
    this.#settled.add(id);
    this.ledger.release("concurrentIo");
    let finalOutcome = outcome;
    if (nowMs >= this.deadlineMs)
      finalOutcome = {
        ok: false,
        error: { code: "timeout", outcome: "unknown" },
      };
    if (!finalOutcome.ok && finalOutcome.error.code === "cancelled") {
      // The adapter acknowledged cancellation. It is still recorded, but an
      // older generation can never resume program state.
    } else if (finalOutcome.ok)
      this.ledger.consume("receivedBytes", finalOutcome.receivedBytes ?? 0);
    const sequence = ++this.#eventSequence;
    this.#transcript.push(
      Object.freeze({
        sequence,
        kind: "response",
        requestId: id,
        operation: `${pending.operation.id}@${pending.operation.version}`,
        outcome: finalOutcome.ok ? "ok" : finalOutcome.error.code,
      }),
    );
    if (
      pending.generation !== this.#generation ||
      this.#terminal === "cancelled"
    )
      return undefined;
    return Object.freeze({
      id,
      sequence,
      monotonicMs: nowMs,
      outcome: finalOutcome,
    });
  }

  cancel(reason: string, nowMs: number): readonly RequestId[] {
    if (this.#terminal !== "active") return [];
    this.#terminal = "cancelled";
    this.#cancelReason = reason;
    this.#generation += 1;
    this.#transcript.push(
      Object.freeze({ sequence: ++this.#eventSequence, kind: "cancel" }),
    );
    void nowMs;
    return Object.freeze(
      [...this.#pending]
        .filter(([, pending]) => pending.operation.cancellable)
        .map(([id]) => id),
    );
  }

  finish(status: "done" | "failed"): void {
    if (this.#terminal !== "active") throw new Error("SESSION_NOT_ACTIVE");
    if (this.#pending.size) throw new Error("PENDING_REQUESTS");
    this.#terminal = status;
  }

  get status(): "active" | "cancelled" | "done" | "failed" {
    return this.#terminal;
  }

  get cancelReason(): string | undefined {
    return this.#cancelReason;
  }

  transcript(): readonly TranscriptEntry[] {
    return Object.freeze([...this.#transcript]);
  }
}

export type ResourceHandle = Readonly<{
  id: number;
  generation: number;
  kind: string;
  scope: number;
}>;

type ResourceRecord = {
  handle: ResourceHandle;
  closed: boolean;
  close: () => void | Promise<void>;
};

export class ResourceScope {
  readonly #resources: ResourceRecord[] = [];
  readonly #generations = new Map<number, number>();
  #nextId = 1;
  #closed = false;

  constructor(
    readonly id: number,
    readonly ledger: ResourceLedger,
  ) {}

  acquire(kind: string, close: () => void | Promise<void>): ResourceHandle {
    if (this.#closed) throw new Error("SCOPE_CLOSED");
    this.ledger.consume("openResources");
    const id = this.#nextId++,
      generation = (this.#generations.get(id) ?? 0) + 1,
      handle = Object.freeze({ id, generation, kind, scope: this.id });
    this.#generations.set(id, generation);
    this.#resources.push({ handle, closed: false, close });
    return handle;
  }

  assert(handle: ResourceHandle, kind: string): void {
    const record = this.#resources.find(
      (item) =>
        item.handle.id === handle.id &&
        item.handle.generation === handle.generation,
    );
    if (
      !record ||
      record.closed ||
      handle.scope !== this.id ||
      handle.kind !== kind
    )
      throw new Error("STALE_RESOURCE_HANDLE");
  }

  async close(handle: ResourceHandle): Promise<void> {
    const record = this.#resources.find(
      (item) =>
        item.handle.id === handle.id &&
        item.handle.generation === handle.generation,
    );
    if (!record || record.closed) return;
    record.closed = true;
    this.ledger.release("openResources");
    await record.close();
  }

  async dispose(): Promise<readonly Error[]> {
    if (this.#closed) return [];
    this.#closed = true;
    const errors: Error[] = [];
    for (const record of [...this.#resources].reverse()) {
      if (record.closed) continue;
      record.closed = true;
      this.ledger.release("openResources");
      try {
        await record.close();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return Object.freeze(errors);
  }
}
