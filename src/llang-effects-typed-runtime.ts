import {
  assertGranted,
  ResourceLedger,
  type EffectsGrant,
  type OperationDefinition,
} from "./llang-effects-contract";
import {
  type BoundedPullStream,
  StructuredTaskScope,
} from "./llang-effects-concurrency";
import type {
  EffectValue,
  EffectValueRecord,
  EffectValueType,
  TypedTask,
} from "./llang-effects-ir";
import {
  decodeEffectWire,
  encodeEffectWire,
  MAX_EFFECT_WIRE_BYTES,
} from "./llang-effects-ir";
import { LBytes } from "./llang-effects-values";
import {
  emitTypedEffectsWasm,
  TypedEffectsRuntime,
  type LoweredEffectState,
} from "./llang-effects-state-machine";
import type { CheckedEffectsGraph } from "./llang-module-effects-graph";
import type { LocalFileAdapter } from "./llang-io-file-adapter";
import type { HttpAdapter } from "./llang-io-http-adapter";
import { SESSION_STATUS } from "./llang-effects-wasm";
import { effectsRequestId } from "./llang-effects-session";

export type TypedOperationExecutor = (
  operation: OperationDefinition,
  request: EffectValue,
  context: Readonly<{
    signal: AbortSignal;
    cleanup?: (
      outcome: Readonly<{
        action: "close" | "commit" | "abort" | "cancel";
        ok: boolean;
        error?: unknown;
      }>,
    ) => Promise<void>;
  }>,
) => Promise<EffectValue>;

export type TypedEffectsRuntimeRecorder = Readonly<{
  request(
    event: Readonly<{
      requestId: string;
      state: number;
      operation: OperationDefinition;
      target?: ReturnType<typeof operationTarget>;
      payload: Uint8Array;
    }>,
  ): void | Promise<void>;
  response(
    event: Readonly<{
      requestId: string;
      state: number;
      operation: OperationDefinition;
      ok: boolean;
      payload?: Uint8Array;
      error?: unknown;
    }>,
  ): void | Promise<void>;
  streamChunk?(
    event: Readonly<{
      requestId: string;
      state: number;
      chunk: number;
      bytes: Uint8Array;
      eof: boolean;
    }>,
  ): void | Promise<void>;
  cleanup?(
    event: Readonly<{
      requestId: string;
      state: number;
      operation: OperationDefinition;
      action: "close" | "commit" | "abort" | "cancel";
      ok: boolean;
      error?: unknown;
    }>,
  ): void | Promise<void>;
}>;

const abortError = () => new Error("CANCELLED");

const waitForHost = async <T>(
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  if (!signal) return run();
  if (signal.aborted)
    throw signal.reason instanceof Error ? signal.reason : abortError();
  let rejectAbort: ((error: Error) => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    }),
    abort = () =>
      rejectAbort?.(
        signal.reason instanceof Error ? signal.reason : abortError(),
      );
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([run(), cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
};

export async function runTypedEffectsGraph(options: {
  graph: CheckedEffectsGraph;
  grant: EffectsGrant;
  execute: TypedOperationExecutor;
  openStream?: (
    operation: OperationDefinition,
    request: EffectValue,
    context: Readonly<{ signal: AbortSignal }>,
  ) => Promise<BoundedPullStream>;
  ledger?: ResourceLedger;
  concurrency?: number;
  signal?: AbortSignal;
  recorder?: TypedEffectsRuntimeRecorder;
  sessionId?: string;
}): Promise<Readonly<{ result: EffectValue; ledger: ResourceLedger }>> {
  const operations = options.graph.manifest.operations,
    emitted = emitTypedEffectsWasm(options.graph.program, operations);
  return runTypedEffectsSnapshot({
    ...options,
    wasmBytes: emitted.bytes,
    states: emitted.states,
  });
}

export async function runTypedEffectsSnapshot(options: {
  graph: CheckedEffectsGraph;
  wasmBytes: Uint8Array;
  states: readonly LoweredEffectState[];
  grant: EffectsGrant;
  execute: TypedOperationExecutor;
  openStream?: (
    operation: OperationDefinition,
    request: EffectValue,
    context: Readonly<{ signal: AbortSignal }>,
  ) => Promise<BoundedPullStream>;
  ledger?: ResourceLedger;
  concurrency?: number;
  signal?: AbortSignal;
  recorder?: TypedEffectsRuntimeRecorder;
  sessionId?: string;
}): Promise<Readonly<{ result: EffectValue; ledger: ResourceLedger }>> {
  const operations = options.graph.manifest.operations,
    ledger = options.ledger ?? new ResourceLedger();
  ledger.consume("memoryBytes", 512 * 64 * 1024);
  const runtime = new TypedEffectsRuntime(options.wasmBytes, options.states),
    abort = () => runtime.cancel();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    options.graph.registry.verify(options.graph.manifest);
    if (options.signal?.aborted) throw abortError();
    let outcome = runtime.start();
    while (outcome.status === SESSION_STATUS.YIELDED) {
      ledger.consume("fuel");
      const request = outcome.request,
        state = request && options.states[request.state];
      if (!request || !state)
        throw new Error("INVALID_ARTIFACT: typed request");
      if (options.signal?.aborted) throw abortError();
      let response: EffectValue;
      if (state.kind === "task") {
        const node = options.graph.program.nodes[request.state];
        if (node?.kind !== "task")
          throw new Error("INVALID_ARTIFACT: task state");
        response = await executeTask(
          node,
          options.graph,
          options.grant,
          options.execute,
          ledger,
          options.concurrency ?? 8,
          options.signal,
          options.recorder,
          request.state,
          options.sessionId ?? "typed",
          request.generation,
          request.sequence,
        );
      } else {
        const requirement = operations[state.operation],
          definition =
            requirement &&
            options.graph.registry.get(requirement.id, requirement.version);
        if (!definition) throw new Error("INVALID_ARTIFACT: operation index");
        const value = decodeEffectWire(state.requestType, request.payload);
        const requestId = effectsRequestId(
          options.sessionId ?? "typed",
          0,
          request.generation,
          request.sequence,
        );
        assertGranted(
          definition,
          options.grant,
          operationTarget(definition, value),
        );
        ledger.consume("hostRequests");
        ledger.consume("sentBytes", request.payload.length);
        ledger.consume("concurrentIo");
        try {
          await options.recorder?.request({
            requestId,
            state: request.state,
            operation: definition,
            target: operationTarget(definition, value),
            payload: request.payload,
          });
          const openStream = options.openStream;
          if (state.kind === "stream" && openStream) {
            const node = options.graph.program.nodes[request.state];
            if (node?.kind !== "stream" || state.responseType.kind !== "bytes")
              throw new Error("INVALID_ARTIFACT: stream state");
            ledger.consume("streams");
            const signal = options.signal ?? new AbortController().signal;
            let stream: BoundedPullStream;
            try {
              stream = await waitForHost(
                () => openStream(definition, value, { signal }),
                signal,
              );
            } catch (error) {
              ledger.release("streams");
              await options.recorder?.cleanup?.({
                requestId,
                state: request.state,
                operation: definition,
                action: "cancel",
                ok: false,
                error,
              });
              throw error;
            }
            let output = LBytes.from([]),
              chunks = 0,
              streamError: unknown,
              streamFailed = false;
            try {
              while (true) {
                const chunk = await waitForHost(
                  () => stream.read(signal),
                  signal,
                );
                await options.recorder?.streamChunk?.({
                  requestId,
                  state: request.state,
                  chunk: chunks,
                  bytes: chunk.eof
                    ? new Uint8Array()
                    : chunk.bytes.toUint8Array(),
                  eof: chunk.eof,
                });
                if (chunk.eof) break;
                chunks += 1;
                ledger.consume("receivedBytes", chunk.bytes.length);
                if (chunks > node.maximumChunks)
                  throw new Error("RESOURCE_LIMIT: stream chunks");
                output = output.concat(chunk.bytes, MAX_EFFECT_WIRE_BYTES);
              }
            } catch (error) {
              streamFailed = true;
              streamError = error;
            }
            let cleanupError: unknown,
              cleanupFailed = false;
            try {
              await stream.cancel();
            } catch (error) {
              cleanupFailed = true;
              cleanupError = error;
            }
            ledger.release("streams");
            await options.recorder?.cleanup?.({
              requestId,
              state: request.state,
              operation: definition,
              action: "cancel",
              ok: !cleanupFailed,
              ...(cleanupFailed ? { error: cleanupError } : {}),
            });
            if (streamFailed) throw streamError;
            if (cleanupFailed) throw cleanupError;
            response = output;
          } else
            response = await waitForHost(
              () =>
                options.execute(definition, value, {
                  signal: options.signal ?? new AbortController().signal,
                  ...(options.recorder?.cleanup
                    ? {
                        cleanup: async (cleanup) =>
                          options.recorder?.cleanup?.({
                            requestId,
                            state: request.state,
                            operation: definition,
                            ...cleanup,
                          }),
                      }
                    : {}),
                }),
              options.signal,
            );
          const responsePayload = encodeEffectWire(
            state.responseType,
            response,
          );
          if (state.kind !== "stream")
            ledger.consume("receivedBytes", responsePayload.length);
          await options.recorder?.response({
            requestId,
            state: request.state,
            operation: definition,
            ok: true,
            payload: responsePayload,
          });
        } catch (error) {
          await options.recorder?.response({
            requestId,
            state: request.state,
            operation: definition,
            ok: false,
            error,
          });
          throw error;
        } finally {
          ledger.release("concurrentIo");
        }
      }
      outcome = runtime.resume(request, true, response);
    }
    if (outcome.status !== SESSION_STATUS.DONE || outcome.result === undefined)
      throw new Error("EFFECTS_RUNTIME_INCOMPLETE");
    return Object.freeze({ result: outcome.result, ledger });
  } finally {
    options.signal?.removeEventListener("abort", abort);
    runtime.dispose();
  }
}

const executeTask = async (
  task: TypedTask,
  graph: CheckedEffectsGraph,
  grant: EffectsGrant,
  execute: TypedOperationExecutor,
  ledger: ResourceLedger,
  concurrency: number,
  parentSignal?: AbortSignal,
  recorder?: TypedEffectsRuntimeRecorder,
  state = -1,
  sessionId = "typed",
  generation = 0,
  requestSequence = 0,
): Promise<EffectValue> => {
  const scope = new StructuredTaskScope(ledger, concurrency),
    abort = () => scope.cancel("parent cancelled");
  parentSignal?.addEventListener("abort", abort, { once: true });
  try {
    for (const [childIndex, child] of task.tasks.entries()) {
      scope.spawn(async (signal) => {
        const definition = graph.registry.get(child.operation, child.version);
        if (!definition) throw new Error("INVALID_ARTIFACT: task operation");
        assertGranted(
          definition,
          grant,
          operationTarget(definition, child.request),
        );
        ledger.consume("hostRequests");
        const requestId = effectsRequestId(
            sessionId,
            childIndex + 1,
            generation,
            requestSequence,
          ),
          payload = encodeEffectWire(child.requestType, child.request);
        ledger.consume("sentBytes", payload.length);
        ledger.consume("concurrentIo");
        try {
          await recorder?.request({
            requestId,
            state,
            operation: definition,
            target: operationTarget(definition, child.request),
            payload,
          });
          const result = await waitForHost(
            () =>
              execute(definition, child.request, {
                signal,
                ...(recorder?.cleanup
                  ? {
                      cleanup: async (cleanup) =>
                        recorder.cleanup?.({
                          requestId,
                          state,
                          operation: definition,
                          ...cleanup,
                        }),
                    }
                  : {}),
              }),
            signal,
          );
          const responsePayload = encodeEffectWire(child.responseType, result);
          ledger.consume("receivedBytes", responsePayload.length);
          await recorder?.response({
            requestId,
            state,
            operation: definition,
            ok: true,
            payload: responsePayload,
          });
          return result;
        } catch (error) {
          await recorder?.response({
            requestId,
            state,
            operation: definition,
            ok: false,
            error,
          });
          throw error;
        } finally {
          ledger.release("concurrentIo");
        }
      });
    }
    return Object.freeze(await scope.joinAll<EffectValue>());
  } finally {
    parentSignal?.removeEventListener("abort", abort);
  }
};

const record = (value: EffectValue): EffectValueRecord => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof LBytes
  )
    throw new Error("INVALID_IO_REQUEST");
  return value as EffectValueRecord;
};

const operationTarget = (
  operation: OperationDefinition,
  value: EffectValue,
):
  | Readonly<{
      path?: string;
      fileMode?: "read" | "write" | "replace";
      url?: string;
      method?: string;
      headers?: readonly string[];
    }>
  | undefined => {
  if (operation.effect !== "file" && operation.effect !== "http")
    return undefined;
  const input = record(value);
  if (operation.effect === "file")
    return {
      path: String(input.path),
      fileMode:
        operation.id === "file.read"
          ? "read"
          : input.replace === true
            ? "replace"
            : "write",
    };
  const headers = Array.isArray(input.headers)
    ? input.headers.map((item) => String(record(item).name).toLowerCase())
    : [];
  return {
    url: String(input.url),
    method: String(input.method),
    headers,
  };
};

export function createTypedIoExecutor(
  adapters: Readonly<{
    file?: LocalFileAdapter;
    http?: HttpAdapter;
    maximumBodyBytes?: number;
  }>,
): TypedOperationExecutor {
  const maximum = adapters.maximumBodyBytes ?? 1024 * 1024;
  return async (operation, request, context) => {
    if (context.signal.aborted) throw abortError();
    const input = record(request);
    if (operation.id === "file.read") {
      if (!adapters.file) throw new Error("PERMISSION_DENIED: file");
      const handle = await adapters.file.openRead(String(input.path));
      let output = LBytes.from([]),
        readError: unknown,
        readFailed = false;
      try {
        while (true) {
          if (context.signal.aborted) throw abortError();
          const chunk = await adapters.file.readChunk(handle);
          if (chunk.eof) break;
          output = output.concat(chunk.bytes, maximum);
        }
      } catch (error) {
        readFailed = true;
        readError = error;
      }
      let cleanupError: unknown,
        cleanupFailed = false;
      try {
        await adapters.file.close(handle);
      } catch (error) {
        cleanupFailed = true;
        cleanupError = error;
      }
      await context.cleanup?.({
        action: "close",
        ok: !cleanupFailed,
        ...(cleanupFailed ? { error: cleanupError } : {}),
      });
      if (readFailed) throw readError;
      if (cleanupFailed) throw cleanupError;
      return output;
    }
    if (operation.id === "file.write") {
      if (!adapters.file) throw new Error("PERMISSION_DENIED: file");
      if (
        !(input.bytes instanceof LBytes) ||
        typeof input.replace !== "boolean"
      )
        throw new Error("INVALID_IO_REQUEST");
      const handle = await adapters.file.openWrite(String(input.path), {
        replace: input.replace,
      });
      let offset = 0;
      try {
        while (offset < input.bytes.length) {
          if (context.signal.aborted) throw abortError();
          const chunk = input.bytes.slice(
            offset,
            Math.min(offset + 64 * 1024, input.bytes.length),
          );
          offset += await adapters.file.writeChunk(handle, chunk);
        }
        await adapters.file.commit(handle);
      } catch (error) {
        try {
          await adapters.file.abort(handle);
        } catch (cleanupError) {
          await context.cleanup?.({
            action: "abort",
            ok: false,
            error: cleanupError,
          });
          throw cleanupError;
        }
        await context.cleanup?.({ action: "abort", ok: true });
        throw error;
      }
      await context.cleanup?.({ action: "commit", ok: true });
      return BigInt(offset);
    }
    if (operation.id === "http.request") {
      if (!adapters.http) throw new Error("PERMISSION_DENIED: http");
      if (!(input.body instanceof LBytes) || !Array.isArray(input.headers))
        throw new Error("INVALID_IO_REQUEST");
      const method = String(input.method);
      if (
        !(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const).some(
          (allowed) => allowed === method,
        )
      )
        throw new Error("INVALID_IO_REQUEST");
      const headers = new Map<string, string>();
      for (const raw of input.headers) {
        const header = record(raw);
        const name = String(header.name).toLowerCase();
        if (headers.has(name))
          throw new Error("INVALID_IO_REQUEST: duplicate header");
        headers.set(name, String(header.value));
      }
      const response = await adapters.http.request({
        url: String(input.url),
        method: method as "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE",
        headers: Object.fromEntries(headers),
        body: input.body,
        signal: context.signal,
      });
      let output = LBytes.from([]),
        readError: unknown,
        readFailed = false;
      try {
        while (true) {
          if (context.signal.aborted) throw abortError();
          const chunk = await adapters.http.readChunk(response.body);
          if (chunk.eof) break;
          output = output.concat(chunk.bytes, maximum);
        }
      } catch (error) {
        readFailed = true;
        readError = error;
      }
      let cleanupError: unknown,
        cleanupFailed = false;
      try {
        await adapters.http.close(response.body);
      } catch (error) {
        cleanupFailed = true;
        cleanupError = error;
      }
      await context.cleanup?.({
        action: "close",
        ok: !cleanupFailed,
        ...(cleanupFailed ? { error: cleanupError } : {}),
      });
      if (readFailed) throw readError;
      if (cleanupFailed) throw cleanupError;
      return output;
    }
    throw new Error(`UNSUPPORTED_OPERATION: ${operation.id}`);
  };
}

export function emittedTypedGraph(
  graph: CheckedEffectsGraph,
): ReturnType<typeof emitTypedEffectsWasm> {
  return emitTypedEffectsWasm(graph.program, graph.manifest.operations);
}

export function responseTypeForState(
  state: LoweredEffectState,
): EffectValueType {
  return state.responseType;
}
