import { lstat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { TypedEffectsRuntimeRecorder } from "./llang-effects-typed-runtime";
import { classifyIoError } from "./llang-effects-session";
import { fingerprintFor, sha256, stableJson } from "./stable-hash";
import { readStableRegularFile } from "./llang-effects-stable-file";

export const EFFECTS_TRANSCRIPT_GENESIS = sha256("llang-effects-transcript-v1");

export type EffectsTranscriptEvent = Readonly<{
  sequence: number;
  kind:
    | "request"
    | "response"
    | "stream-chunk"
    | "cancel"
    | "cleanup"
    | "terminal";
  requestId?: string;
  state?: number;
  operation?: string;
  target?: string;
  payloadHash?: string;
  bytes?: number;
  chunk?: number;
  eof?: boolean;
  cleanupAction?: "close" | "commit" | "abort" | "cancel";
  outcome?: Readonly<{ code: string; certainty: "known" | "unknown" }>;
  previousHash: string;
  eventHash: string;
}>;

const targetFor = (
  target:
    | {
        path?: string;
        url?: string;
      }
    | undefined,
): string | undefined => {
  if (target?.path) return "file:<redacted>";
  if (target?.url)
    try {
      return new URL(target.url).origin;
    } catch {
      return "url:<invalid>";
    }
  return undefined;
};

export function classifyExecutionError(error: unknown): Readonly<{
  code: string;
  certainty: "known" | "unknown";
}> {
  const classified = classifyIoError(error);
  return Object.freeze({
    code: classified.code,
    certainty: classified.outcome,
  });
}

export class EffectsTranscriptWriter implements TypedEffectsRuntimeRecorder {
  #handle: FileHandle | undefined;
  #previousHash = EFFECTS_TRANSCRIPT_GENESIS;
  #sequence = 0;
  #bytes = 0;
  #cleanupFailures = 0;
  #queue = Promise.resolve();

  private constructor(
    readonly path: string,
    handle: FileHandle,
    readonly device: number,
    readonly inode: number,
  ) {
    this.#handle = handle;
  }

  static async create(path: string): Promise<EffectsTranscriptWriter> {
    const handle = await open(path, "wx", 0o600),
      identity = await handle.stat();
    return new EffectsTranscriptWriter(
      path,
      handle,
      identity.dev,
      identity.ino,
    );
  }

  get events(): number {
    return this.#sequence;
  }

  get bytes(): number {
    return this.#bytes;
  }

  get finalHash(): string {
    return this.#previousHash;
  }

  get cleanupFailures(): number {
    return this.#cleanupFailures;
  }

  async append(
    body: Omit<
      EffectsTranscriptEvent,
      "sequence" | "previousHash" | "eventHash"
    >,
  ): Promise<void> {
    const task = this.#queue.then(async () => {
      const handle = this.#handle;
      if (!handle) throw new Error("TRANSCRIPT_CLOSED");
      const base = {
          sequence: ++this.#sequence,
          ...body,
          previousHash: this.#previousHash,
        },
        eventHash = fingerprintFor(base),
        event = { ...base, eventHash },
        line = `${stableJson(event)}\n`;
      await handle.writeFile(line);
      await handle.sync();
      this.#previousHash = eventHash;
      this.#bytes += Buffer.byteLength(line);
    });
    this.#queue = task.catch(() => undefined);
    await task;
  }

  async request(event: Parameters<TypedEffectsRuntimeRecorder["request"]>[0]) {
    const target = targetFor(event.target);
    await this.append({
      kind: "request",
      requestId: event.requestId,
      state: event.state,
      operation: `${event.operation.id}@${event.operation.version}`,
      ...(target ? { target } : {}),
      payloadHash: sha256(event.payload),
      bytes: event.payload.length,
    });
  }

  async response(
    event: Parameters<TypedEffectsRuntimeRecorder["response"]>[0],
  ) {
    await this.append({
      kind: "response",
      requestId: event.requestId,
      state: event.state,
      operation: `${event.operation.id}@${event.operation.version}`,
      ...(event.payload
        ? { payloadHash: sha256(event.payload), bytes: event.payload.length }
        : {}),
      outcome: event.ok
        ? { code: "ok", certainty: "known" }
        : classifyExecutionError(event.error),
    });
  }

  async streamChunk(
    event: Parameters<
      NonNullable<TypedEffectsRuntimeRecorder["streamChunk"]>
    >[0],
  ) {
    await this.append({
      kind: "stream-chunk",
      requestId: event.requestId,
      state: event.state,
      chunk: event.chunk,
      payloadHash: sha256(event.bytes),
      bytes: event.bytes.length,
      eof: event.eof,
    });
  }

  async cleanup(
    event: Parameters<NonNullable<TypedEffectsRuntimeRecorder["cleanup"]>>[0],
  ) {
    if (!event.ok) this.#cleanupFailures += 1;
    await this.append({
      kind: "cleanup",
      requestId: event.requestId,
      state: event.state,
      operation: `${event.operation.id}@${event.operation.version}`,
      cleanupAction: event.action,
      outcome: event.ok
        ? { code: "ok", certainty: "known" }
        : classifyExecutionError(event.error),
    });
  }

  async close(): Promise<void> {
    await this.#queue;
    const handle = this.#handle;
    if (!handle) return;
    this.#handle = undefined;
    await handle.sync();
    await handle.close();
    const current = await lstat(this.path);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      current.dev !== this.device ||
      current.ino !== this.inode
    )
      throw new Error("EFFECTS_TRANSCRIPT_CHANGED");
  }
}

export function parseEffectsTranscript(
  text: string,
): readonly EffectsTranscriptEvent[] {
  let previousHash = EFFECTS_TRANSCRIPT_GENESIS,
    sequence = 0;
  const events: EffectsTranscriptEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("INVALID_EFFECTS_TRANSCRIPT");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("INVALID_EFFECTS_TRANSCRIPT");
    const event = value as EffectsTranscriptEvent,
      { eventHash, ...base } = event;
    if (
      ![
        "request",
        "response",
        "stream-chunk",
        "cancel",
        "cleanup",
        "terminal",
      ].includes(event.kind) ||
      Object.keys(event).some(
        (key) =>
          ![
            "sequence",
            "kind",
            "requestId",
            "state",
            "operation",
            "target",
            "payloadHash",
            "bytes",
            "chunk",
            "eof",
            "cleanupAction",
            "outcome",
            "previousHash",
            "eventHash",
          ].includes(key),
      ) ||
      !Number.isSafeInteger(event.sequence) ||
      event.sequence < 1 ||
      !/^[0-9a-f]{64}$/.test(event.previousHash) ||
      !/^[0-9a-f]{64}$/.test(event.eventHash) ||
      (event.requestId !== undefined && typeof event.requestId !== "string") ||
      (event.state !== undefined &&
        (!Number.isSafeInteger(event.state) || event.state < 0)) ||
      (event.operation !== undefined && typeof event.operation !== "string") ||
      (event.target !== undefined && typeof event.target !== "string") ||
      (event.payloadHash !== undefined &&
        !/^[0-9a-f]{64}$/.test(event.payloadHash)) ||
      (event.bytes !== undefined &&
        (!Number.isSafeInteger(event.bytes) || event.bytes < 0)) ||
      (event.chunk !== undefined &&
        (!Number.isSafeInteger(event.chunk) || event.chunk < 0)) ||
      (event.eof !== undefined && typeof event.eof !== "boolean") ||
      (event.cleanupAction !== undefined &&
        !["close", "commit", "abort", "cancel"].includes(
          event.cleanupAction,
        )) ||
      (event.outcome !== undefined &&
        (!event.outcome ||
          typeof event.outcome !== "object" ||
          Object.keys(event.outcome).length !== 2 ||
          typeof event.outcome.code !== "string" ||
          !["known", "unknown"].includes(event.outcome.certainty))) ||
      (["request", "response", "stream-chunk", "cleanup"].includes(
        event.kind,
      ) &&
        !event.requestId) ||
      (["response", "cleanup", "terminal"].includes(event.kind) &&
        !event.outcome) ||
      (event.kind === "cleanup" && !event.cleanupAction) ||
      (event.kind !== "cleanup" && event.cleanupAction !== undefined) ||
      event.sequence !== ++sequence ||
      event.previousHash !== previousHash ||
      eventHash !== fingerprintFor(base)
    )
      throw new Error("INVALID_EFFECTS_TRANSCRIPT_CHAIN");
    previousHash = eventHash;
    events.push(Object.freeze(event));
  }
  return Object.freeze(events);
}

export async function readEffectsTranscript(path: string) {
  const bytes = await readStableRegularFile(
    path,
    16 * 1024 * 1024,
    "INVALID_EFFECTS_TRANSCRIPT_FILE",
  );
  const events = parseEffectsTranscript(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  return Object.freeze({
    events,
    bytes: bytes.length,
    hash: sha256(bytes),
    finalHash: events.at(-1)?.eventHash ?? EFFECTS_TRANSCRIPT_GENESIS,
  });
}
