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
import { decodeEffectWire, MAX_EFFECT_WIRE_BYTES } from "./llang-effects-ir";
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

export type TypedOperationExecutor = (
  operation: OperationDefinition,
  request: EffectValue,
  context: Readonly<{ signal: AbortSignal }>,
) => Promise<EffectValue>;

const abortError = () => new Error("CANCELLED");

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
}): Promise<Readonly<{ result: EffectValue; ledger: ResourceLedger }>> {
  const operations = options.graph.manifest.operations,
    emitted = emitTypedEffectsWasm(options.graph.program, operations),
    runtime = new TypedEffectsRuntime(emitted.bytes, emitted.states),
    ledger = options.ledger ?? new ResourceLedger(),
    abort = () => runtime.cancel();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    options.graph.registry.verify(options.graph.manifest);
    if (options.signal?.aborted) throw abortError();
    let outcome = runtime.start();
    while (outcome.status === SESSION_STATUS.YIELDED) {
      const request = outcome.request,
        state = request && emitted.states[request.state];
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
        );
      } else {
        const requirement = operations[state.operation],
          definition =
            requirement &&
            options.graph.registry.get(requirement.id, requirement.version);
        if (!definition) throw new Error("INVALID_ARTIFACT: operation index");
        const value = decodeEffectWire(state.requestType, request.payload);
        assertGranted(
          definition,
          options.grant,
          operationTarget(definition, value),
        );
        ledger.consume("hostRequests");
        ledger.consume("concurrentIo");
        try {
          if (state.kind === "stream" && options.openStream) {
            const node = options.graph.program.nodes[request.state];
            if (node?.kind !== "stream" || state.responseType.kind !== "bytes")
              throw new Error("INVALID_ARTIFACT: stream state");
            const signal = options.signal ?? new AbortController().signal,
              stream = await options.openStream(definition, value, { signal });
            let output = LBytes.from([]),
              chunks = 0;
            try {
              while (true) {
                const chunk = await stream.read(signal);
                if (chunk.eof) break;
                chunks += 1;
                if (chunks > node.maximumChunks)
                  throw new Error("RESOURCE_LIMIT: stream chunks");
                output = output.concat(chunk.bytes, MAX_EFFECT_WIRE_BYTES);
              }
              response = output;
            } finally {
              await stream.cancel();
            }
          } else
            response = await options.execute(definition, value, {
              signal: options.signal ?? new AbortController().signal,
            });
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
): Promise<EffectValue> => {
  const scope = new StructuredTaskScope(ledger, concurrency),
    abort = () => scope.cancel("parent cancelled");
  parentSignal?.addEventListener("abort", abort, { once: true });
  try {
    for (const child of task.tasks) {
      scope.spawn(async (signal) => {
        const definition = graph.registry.get(child.operation, child.version);
        if (!definition) throw new Error("INVALID_ARTIFACT: task operation");
        assertGranted(
          definition,
          grant,
          operationTarget(definition, child.request),
        );
        ledger.consume("hostRequests");
        ledger.consume("concurrentIo");
        try {
          return await execute(definition, child.request, { signal });
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
    file: LocalFileAdapter;
    http: HttpAdapter;
    maximumBodyBytes?: number;
  }>,
): TypedOperationExecutor {
  const maximum = adapters.maximumBodyBytes ?? 1024 * 1024;
  return async (operation, request, context) => {
    if (context.signal.aborted) throw abortError();
    const input = record(request);
    if (operation.id === "file.read") {
      const handle = await adapters.file.openRead(String(input.path));
      let output = LBytes.from([]);
      try {
        while (true) {
          if (context.signal.aborted) throw abortError();
          const chunk = await adapters.file.readChunk(handle);
          if (chunk.eof) break;
          output = output.concat(chunk.bytes, maximum);
        }
        return output;
      } finally {
        await adapters.file.close(handle);
      }
    }
    if (operation.id === "file.write") {
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
        return BigInt(offset);
      } catch (error) {
        await adapters.file.abort(handle);
        throw error;
      }
    }
    if (operation.id === "http.request") {
      if (!(input.body instanceof LBytes) || !Array.isArray(input.headers))
        throw new Error("INVALID_IO_REQUEST");
      const method = String(input.method);
      if (
        !(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const).some(
          (allowed) => allowed === method,
        )
      )
        throw new Error("INVALID_IO_REQUEST");
      const headers: Record<string, string> = Object.create(null) as Record<
        string,
        string
      >;
      for (const raw of input.headers) {
        const header = record(raw);
        const name = String(header.name).toLowerCase();
        if (Object.hasOwn(headers, name))
          throw new Error("INVALID_IO_REQUEST: duplicate header");
        headers[name] = String(header.value);
      }
      const response = await adapters.http.request({
        url: String(input.url),
        method: method as "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE",
        headers,
        body: input.body,
        signal: context.signal,
      });
      let output = LBytes.from([]);
      try {
        while (true) {
          if (context.signal.aborted) throw abortError();
          const chunk = await adapters.http.readChunk(response.body);
          if (chunk.eof) break;
          output = output.concat(chunk.bytes, maximum);
        }
        return output;
      } finally {
        await adapters.http.close(response.body);
      }
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
