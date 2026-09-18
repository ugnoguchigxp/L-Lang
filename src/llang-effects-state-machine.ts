import binaryen from "binaryen";
import {
  checkTypedEffectsProgram,
  decodeEffectWire,
  type EffectValue,
  type EffectValueType,
  effectValueTypeJson,
  encodeEffectWire,
  MAX_EFFECT_WIRE_BYTES,
  typeTag,
  type TypedAwait,
  type TypedEffectsProgram,
} from "./llang-effects-ir";
import { EFFECTS_SESSION_ABI, SESSION_STATUS } from "./llang-effects-wasm";
import { fingerprintFor } from "./stable-hash";

export const TYPED_REQUEST_BYTES = 32;
export const TYPED_EVENT_BYTES = 24;
export const TYPED_OUTPUT_BYTES = 12;
const DATA_START = 4096;
const RESULT_START = 2 * 1024 * 1024;
const EVENT_PAYLOAD_START = RESULT_START + MAX_EFFECT_WIRE_BYTES;

export type LoweredEffectState = Readonly<{
  kind: "await" | "task" | "stream";
  operation: number;
  requestType: EffectValueType;
  responseType: EffectValueType;
  request: EffectValue;
  payload: Uint8Array;
}>;

export type TypedEffectsWasmContract = Readonly<{
  abi: typeof EFFECTS_SESSION_ABI;
  layout: "typed-wire-v1";
  memory: Readonly<{ initial: 512; maximum: 512 }>;
  requestBytes: typeof TYPED_REQUEST_BYTES;
  eventBytes: typeof TYPED_EVENT_BYTES;
  outputBytes: typeof TYPED_OUTPUT_BYTES;
  stateCount: number;
  programHash: string;
}>;

const flatten = (
  program: TypedEffectsProgram,
  operationIndex: ReadonlyMap<string, number>,
): readonly LoweredEffectState[] =>
  Object.freeze(
    program.nodes.map((node): LoweredEffectState => {
      if (node.kind === "task") {
        const taskOperations = node.tasks.map((task) => {
          const operation = operationIndex.get(
            `${task.operation}@${task.version}`,
          );
          if (operation === undefined)
            throw new Error(
              `UNKNOWN_OPERATION: ${task.operation}@${task.version}`,
            );
          return operation;
        });
        const request = Object.freeze(
          node.tasks.map((task, index) => ({
            operation: taskOperations[index],
            requestType: task.requestType,
            responseType: task.responseType,
            request: task.request,
          })),
        ) as unknown as EffectValue;
        const payload = new TextEncoder().encode(
          JSON.stringify(
            node.tasks.map((task, index) => ({
              operation: taskOperations[index],
              requestType: task.requestType,
              responseType: task.responseType,
              request: JSON.parse(
                new TextDecoder().decode(
                  encodeEffectWire(task.requestType, task.request),
                ),
              ),
            })),
          ),
        );
        if (payload.length > MAX_EFFECT_WIRE_BYTES)
          throw new Error("RESOURCE_LIMIT: wireBytes");
        return Object.freeze({
          kind: "task",
          operation: -1,
          requestType: { kind: "bytes" } as const,
          responseType: node.responseType,
          request,
          payload,
        });
      }
      const operation = operationIndex.get(`${node.operation}@${node.version}`);
      if (operation === undefined)
        throw new Error(`UNKNOWN_OPERATION: ${node.operation}@${node.version}`);
      return Object.freeze({
        kind: node.kind,
        operation,
        requestType: node.requestType,
        responseType: node.responseType,
        request: node.request,
        payload: encodeEffectWire(node.requestType, node.request),
      });
    }),
  );

const watBytes = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => `\\${byte.toString(16).padStart(2, "0")}`).join("");

export function lowerTypedEffectsProgram(
  input: TypedEffectsProgram,
  operations: readonly Readonly<{ id: string; version: number }>[],
): readonly LoweredEffectState[] {
  const program = checkTypedEffectsProgram(input),
    index = new Map(
      operations.map((operation, position) => [
        `${operation.id}@${operation.version}`,
        position,
      ]),
    );
  return flatten(program, index);
}

export function emitTypedEffectsWasm(
  program: TypedEffectsProgram,
  operations: readonly Readonly<{ id: string; version: number }>[],
): {
  bytes: Uint8Array;
  wat: string;
  contract: TypedEffectsWasmContract;
  states: readonly LoweredEffectState[];
} {
  const states = lowerTypedEffectsProgram(program, operations);
  let cursor = DATA_START;
  const data = states.map((state) => {
    const address = cursor;
    cursor += state.payload.length;
    return { address, bytes: state.payload };
  });
  if (cursor > RESULT_START)
    throw new Error("RESOURCE_LIMIT: embedded effect requests");
  const cases = states
    .map((state, index) => {
      const payload = data[index] as { address: number; bytes: Uint8Array };
      const kind = state.kind === "await" ? 1 : state.kind === "task" ? 2 : 3;
      return `local.get $state i32.const ${index} i32.eq
      if
        local.get $out global.get $generation i32.store
        local.get $out global.get $sequence i32.store offset=4
        local.get $out local.get $state i32.store offset=8
        local.get $out i32.const ${kind} i32.store offset=12
        local.get $out i32.const ${state.operation} i32.store offset=16
        local.get $out i32.const ${typeTag(state.requestType)} i32.store offset=20
        local.get $out i32.const ${payload.address} i32.store offset=24
        local.get $out i32.const ${payload.bytes.length} i32.store offset=28
        i32.const ${SESSION_STATUS.YIELDED} return
      end`;
    })
    .join("\n");
  const expectedTypes = states
    .map(
      (state, index) => `local.get $state i32.const ${index} i32.eq
    if i32.const ${typeTag(state.responseType)} local.set $expected end`,
    )
    .join("\n");
  const segments = data
    .map(
      (item) => `(data (i32.const ${item.address}) "${watBytes(item.bytes)}")`,
    )
    .join("\n");
  const wat = `(module
    (memory (export "memory") 512 512)
    ${segments}
    (global $state (mut i32) (i32.const 0))
    (global $sequence (mut i32) (i32.const 0))
    (global $generation (mut i32) (i32.const 0))
    (global $terminal (mut i32) (i32.const 0))
    (global $busy (mut i32) (i32.const 0))
    (global $fault (mut i32) (i32.const 0))
    (global $result-length (mut i32) (i32.const 0))
    (global $result-type (mut i32) (i32.const 0))
    (func $copy (param $source i32) (param $target i32) (param $length i32)
      (local $index i32)
      block $done loop $copy-loop
        local.get $index local.get $length i32.ge_u br_if $done
        local.get $target local.get $index i32.add
        local.get $source local.get $index i32.add i32.load8_u i32.store8
        local.get $index i32.const 1 i32.add local.set $index
        br $copy-loop
      end end)
    (func $yield (param $out i32) (param $capacity i32) (result i32)
      (local $state i32)
      global.get $state local.set $state
      local.get $state i32.const ${states.length} i32.ge_u
      if
        local.get $capacity i32.const ${TYPED_OUTPUT_BYTES} i32.lt_u
        if i32.const 5 global.set $fault i32.const ${SESSION_STATUS.FAILED} return end
        local.get $out global.get $result-type i32.store
        local.get $out i32.const ${RESULT_START} i32.store offset=4
        local.get $out global.get $result-length i32.store offset=8
        i32.const ${SESSION_STATUS.DONE} global.set $terminal
        i32.const ${SESSION_STATUS.DONE} return
      end
      local.get $capacity i32.const ${TYPED_REQUEST_BYTES} i32.lt_u
      if i32.const 5 global.set $fault i32.const ${SESSION_STATUS.FAILED} return end
      global.get $sequence i32.const 1 i32.add global.set $sequence
      ${cases}
      i32.const 5 global.set $fault i32.const ${SESSION_STATUS.FAILED})
    (func (export "start") (param $out i32) (param $capacity i32) (result i32)
      global.get $terminal i32.eqz i32.eqz global.get $busy i32.or
      if i32.const 5 global.set $fault i32.const ${SESSION_STATUS.FAILED} return end
      i32.const 1 global.set $busy
      i32.const 0 global.set $state
      i32.const 0 global.set $sequence
      local.get $out local.get $capacity call $yield
      i32.const 0 global.set $busy)
    (func (export "resume")
      (param $event i32) (param $length i32) (param $out i32) (param $capacity i32)
      (result i32) (local $payload i32) (local $payload-length i32) (local $expected i32) (local $state i32)
      global.get $terminal i32.eqz i32.eqz global.get $busy i32.or
      if i32.const 5 global.set $fault i32.const ${SESSION_STATUS.FAILED} return end
      i32.const 1 global.set $busy
      local.get $length i32.const ${TYPED_EVENT_BYTES} i32.ne
      local.get $event i32.load global.get $generation i32.ne i32.or
      local.get $event i32.load offset=4 global.get $sequence i32.ne i32.or
      if i32.const 5 global.set $fault i32.const 0 global.set $busy i32.const ${SESSION_STATUS.FAILED} return end
      local.get $event i32.load offset=8 i32.eqz
      if i32.const 6 global.set $fault i32.const ${SESSION_STATUS.FAILED} global.set $terminal i32.const 0 global.set $busy i32.const ${SESSION_STATUS.FAILED} return end
      global.get $state local.set $state
      ${expectedTypes}
      local.get $event i32.load offset=12 local.get $expected i32.ne
      if i32.const 7 global.set $fault i32.const 0 global.set $busy i32.const ${SESSION_STATUS.FAILED} return end
      local.get $event i32.load offset=16 local.set $payload
      local.get $event i32.load offset=20 local.set $payload-length
      local.get $payload-length i32.const ${MAX_EFFECT_WIRE_BYTES} i32.gt_u
      local.get $payload i32.const ${512 * 65536} i32.gt_u i32.or
      local.get $payload-length i32.const ${512 * 65536} local.get $payload i32.sub i32.gt_u i32.or
      if i32.const 8 global.set $fault i32.const 0 global.set $busy i32.const ${SESSION_STATUS.FAILED} return end
      local.get $payload i32.const ${RESULT_START} local.get $payload-length call $copy
      local.get $payload-length global.set $result-length
      local.get $expected global.set $result-type
      global.get $state i32.const 1 i32.add global.set $state
      local.get $out local.get $capacity call $yield
      i32.const 0 global.set $busy)
    (func (export "cancel") (result i32)
      global.get $terminal i32.eqz if
        global.get $generation i32.const 1 i32.add global.set $generation
        i32.const ${SESSION_STATUS.CANCELLED} global.set $terminal
      end
      i32.const ${SESSION_STATUS.CANCELLED})
    (func (export "dispose") (result i32)
      i32.const ${SESSION_STATUS.CANCELLED} global.set $terminal
      i32.const 0 global.set $result-length i32.const 0)
    (func (export "fault_code") (result i32) global.get $fault))`;
  const module = binaryen.parseText(wat);
  try {
    if (!module.validate()) throw new Error("INVALID_IR: typed effects Wasm");
    const bytes = new Uint8Array(module.emitBinary());
    if (!WebAssembly.validate(bytes))
      throw new Error("INVALID_IR: typed effects Wasm");
    return {
      bytes,
      wat,
      states,
      contract: Object.freeze({
        abi: EFFECTS_SESSION_ABI,
        layout: "typed-wire-v1",
        memory: { initial: 512 as const, maximum: 512 as const },
        requestBytes: TYPED_REQUEST_BYTES,
        eventBytes: TYPED_EVENT_BYTES,
        outputBytes: TYPED_OUTPUT_BYTES,
        stateCount: states.length,
        programHash: fingerprintFor({
          resultType: effectValueTypeJson(program.resultType),
          states: states.map((state) => ({
            kind: state.kind,
            operation: state.operation,
            requestType: effectValueTypeJson(state.requestType),
            responseType: effectValueTypeJson(state.responseType),
            payload: Buffer.from(state.payload).toString("base64"),
          })),
        }),
      }),
    };
  } finally {
    module.dispose();
  }
}

type TypedSessionExports = {
  memory: WebAssembly.Memory;
  start(out: number, capacity: number): number;
  resume(event: number, length: number, out: number, capacity: number): number;
  cancel(): number;
  dispose(): number;
  fault_code(): number;
};

export type TypedHostRequest = Readonly<{
  generation: number;
  sequence: number;
  state: number;
  kind: "await" | "task" | "stream";
  operation: number;
  requestTypeTag: number;
  payload: Uint8Array;
}>;

export class TypedEffectsRuntime {
  readonly #exports: TypedSessionExports;
  readonly #states: readonly LoweredEffectState[];
  readonly #requestAddress = 64;
  readonly #eventAddress = 128;
  readonly #eventPayloadAddress = EVENT_PAYLOAD_START;
  #started = false;
  #disposed = false;
  #pending: TypedHostRequest | undefined;

  constructor(bytes: Uint8Array, states: readonly LoweredEffectState[]) {
    const module = new WebAssembly.Module(bytes as BufferSource);
    if (WebAssembly.Module.imports(module).length)
      throw new Error("INVALID_ARTIFACT");
    this.#exports = new WebAssembly.Instance(module, {})
      .exports as unknown as TypedSessionExports;
    this.#states = states;
  }

  start(): {
    status: number;
    request?: TypedHostRequest;
    result?: EffectValue;
  } {
    if (this.#started || this.#disposed)
      throw new Error("SESSION_NOT_STARTABLE");
    this.#started = true;
    return this.#outcome(
      this.#exports.start(this.#requestAddress, TYPED_REQUEST_BYTES),
    );
  }

  resume(
    request: TypedHostRequest,
    ok: boolean,
    value: EffectValue,
  ): { status: number; request?: TypedHostRequest; result?: EffectValue } {
    if (!this.#started || this.#disposed) throw new Error("SESSION_NOT_ACTIVE");
    const pending = this.#pending;
    if (
      !pending ||
      request.generation !== pending.generation ||
      request.sequence !== pending.sequence ||
      request.state !== pending.state ||
      request.kind !== pending.kind ||
      request.operation !== pending.operation ||
      request.requestTypeTag !== pending.requestTypeTag
    )
      throw new Error("INVALID_REQUEST");
    const state = this.#states[request.state];
    if (!state) throw new Error("INVALID_STATE");
    const payload = ok
      ? encodeEffectWire(state.responseType, value)
      : new Uint8Array();
    const view = new DataView(this.#exports.memory.buffer);
    new Uint8Array(
      this.#exports.memory.buffer,
      this.#eventPayloadAddress,
      payload.length,
    ).set(payload);
    view.setUint32(this.#eventAddress, request.generation, true);
    view.setUint32(this.#eventAddress + 4, request.sequence, true);
    view.setUint32(this.#eventAddress + 8, ok ? 1 : 0, true);
    view.setUint32(this.#eventAddress + 12, typeTag(state.responseType), true);
    view.setUint32(this.#eventAddress + 16, this.#eventPayloadAddress, true);
    view.setUint32(this.#eventAddress + 20, payload.length, true);
    this.#pending = undefined;
    return this.#outcome(
      this.#exports.resume(
        this.#eventAddress,
        TYPED_EVENT_BYTES,
        this.#requestAddress,
        TYPED_REQUEST_BYTES,
      ),
    );
  }

  cancel(): void {
    if (!this.#disposed) {
      this.#pending = undefined;
      this.#exports.cancel();
    }
  }
  dispose(): void {
    if (!this.#disposed) {
      this.#pending = undefined;
      this.#exports.dispose();
      this.#disposed = true;
    }
  }

  #outcome(status: number): {
    status: number;
    request?: TypedHostRequest;
    result?: EffectValue;
  } {
    const view = new DataView(this.#exports.memory.buffer);
    if (status === SESSION_STATUS.YIELDED) {
      const stateIndex = view.getUint32(this.#requestAddress + 8, true),
        state = this.#states[stateIndex],
        kindTag = view.getUint32(this.#requestAddress + 12, true),
        operation = view.getInt32(this.#requestAddress + 16, true),
        requestTypeTag = view.getUint32(this.#requestAddress + 20, true),
        pointer = view.getUint32(this.#requestAddress + 24, true),
        length = view.getUint32(this.#requestAddress + 28, true);
      const expectedKind =
        state?.kind === "await" ? 1 : state?.kind === "task" ? 2 : 3;
      if (
        !state ||
        kindTag !== expectedKind ||
        operation !== state.operation ||
        requestTypeTag !== typeTag(state.requestType) ||
        pointer > this.#exports.memory.buffer.byteLength ||
        length > this.#exports.memory.buffer.byteLength - pointer
      )
        throw new Error("INVALID_ARTIFACT");
      const request = Object.freeze({
        generation: view.getUint32(this.#requestAddress, true),
        sequence: view.getUint32(this.#requestAddress + 4, true),
        state: stateIndex,
        kind: state.kind,
        operation,
        requestTypeTag,
        payload: new Uint8Array(
          this.#exports.memory.buffer.slice(pointer, pointer + length),
        ),
      });
      this.#pending = request;
      return {
        status,
        request,
      };
    }
    if (status === SESSION_STATUS.DONE) {
      const pointer = view.getUint32(this.#requestAddress + 4, true),
        length = view.getUint32(this.#requestAddress + 8, true),
        resultTypeTag = view.getUint32(this.#requestAddress, true),
        state = this.#states.at(-1);
      if (
        !state ||
        resultTypeTag !== typeTag(state.responseType) ||
        pointer > this.#exports.memory.buffer.byteLength ||
        length > this.#exports.memory.buffer.byteLength - pointer
      )
        throw new Error("INVALID_ARTIFACT");
      return {
        status,
        result: decodeEffectWire(
          state.responseType,
          new Uint8Array(
            this.#exports.memory.buffer.slice(pointer, pointer + length),
          ),
        ),
      };
    }
    if (status === SESSION_STATUS.FAILED)
      throw new Error(`EFFECTS_WASM_FAULT: ${this.#exports.fault_code()}`);
    if (status === SESSION_STATUS.CANCELLED) throw new Error("CANCELLED");
    return { status };
  }
}

export function typedAwait(
  operation: string,
  version: number,
  requestType: EffectValueType,
  responseType: EffectValueType,
  request: EffectValue,
): TypedAwait {
  return Object.freeze({
    kind: "await",
    operation,
    version,
    requestType,
    responseType,
    request,
  });
}
