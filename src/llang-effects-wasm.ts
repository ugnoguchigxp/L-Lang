import binaryen from "binaryen";
import { fingerprintFor } from "./stable-hash";

export const EFFECTS_SESSION_ABI = "llang-effects-session-v1" as const;
export const SESSION_STATUS = Object.freeze({
  YIELDED: 1,
  RUNNABLE: 2,
  DONE: 3,
  FAILED: 4,
  CANCELLED: 5,
});

export type LinearEffectStep = Readonly<{
  operation: number;
  payload: number;
  combine: "replace" | "add";
}>;
export type LinearEffectsProgram = Readonly<{
  steps: readonly LinearEffectStep[];
  initial: number;
}>;
export type EffectsWasmContract = Readonly<{
  abi: typeof EFFECTS_SESSION_ABI;
  memory: { initial: 512; maximum: 512 };
  requestBytes: 16;
  eventBytes: 16;
  outputBytes: 4;
  programHash: string;
}>;

const checkedI32 = (value: number, label: string) => {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)
    throw new Error(`INVALID_EFFECTS_PROGRAM: ${label}`);
  return value;
};

export function emitLinearEffectsWasm(program: LinearEffectsProgram): {
  bytes: Uint8Array;
  wat: string;
  contract: EffectsWasmContract;
} {
  if (!program.steps.length || program.steps.length > 1024)
    throw new Error("INVALID_EFFECTS_PROGRAM: steps");
  checkedI32(program.initial, "initial");
  program.steps.forEach((step) => {
    if (!Number.isInteger(step.operation) || step.operation < 0)
      throw new Error("INVALID_EFFECTS_PROGRAM: operation");
    checkedI32(step.payload, "payload");
  });
  const cases = program.steps
      .map(
        (step, index) => `local.get $step i32.const ${index} i32.eq
          if
            local.get $out global.get $generation i32.store
            local.get $out global.get $sequence i32.store offset=4
            local.get $out i32.const ${step.operation} i32.store offset=8
            local.get $out i32.const ${step.payload} i32.store offset=12
            i32.const 1 return
          end`,
      )
      .join("\n"),
    combines = program.steps
      .map(
        (step, index) => `local.get $step i32.const ${index} i32.eq
          if
            ${
              step.combine === "replace"
                ? "local.get $value global.set $accumulator"
                : `global.get $accumulator local.get $value i32.add
            global.get $accumulator local.get $value i32.add global.get $accumulator i32.xor i32.const 0 i32.lt_s
            global.get $accumulator local.get $value i32.xor i32.const 0 i32.ge_s i32.and
            if i32.const 3 global.set $fault i32.const 4 return end
            global.set $accumulator`
            }
          end`,
      )
      .join("\n");
  const wat = `(module
    (memory (export "memory") 512 512)
    (global $step (mut i32) (i32.const 0))
    (global $sequence (mut i32) (i32.const 0))
    (global $generation (mut i32) (i32.const 0))
    (global $accumulator (mut i32) (i32.const 0))
    (global $terminal (mut i32) (i32.const 0))
    (global $busy (mut i32) (i32.const 0))
    (global $fault (mut i32) (i32.const 0))
    (func $yield (param $out i32) (param $capacity i32) (result i32)
      (local $step i32)
      global.get $step local.set $step
      local.get $step i32.const ${program.steps.length} i32.ge_u
      if
        local.get $capacity i32.const 4 i32.lt_u
        if i32.const 5 global.set $fault i32.const 4 return end
        local.get $out global.get $accumulator i32.store
        i32.const 3 global.set $terminal
        i32.const 3 return
      end
      local.get $capacity i32.const 16 i32.lt_u
      if i32.const 5 global.set $fault i32.const 4 return end
      global.get $sequence i32.const 1 i32.add global.set $sequence
      ${cases}
      i32.const 5 global.set $fault i32.const 4)
    (func (export "start") (param $out i32) (param $capacity i32) (result i32)
      global.get $terminal i32.eqz i32.eqz
      if i32.const 5 global.set $fault i32.const 4 return end
      global.get $busy
      if i32.const 5 global.set $fault i32.const 4 return end
      i32.const 1 global.set $busy
      i32.const 0 global.set $step
      i32.const 0 global.set $sequence
      i32.const ${program.initial} global.set $accumulator
      local.get $out local.get $capacity call $yield
      i32.const 0 global.set $busy)
    (func (export "resume")
      (param $event i32) (param $length i32) (param $out i32) (param $capacity i32)
      (result i32) (local $value i32) (local $step i32)
      global.get $terminal i32.eqz i32.eqz
      if i32.const 5 global.set $fault i32.const 4 return end
      global.get $busy
      if i32.const 5 global.set $fault i32.const 4 return end
      i32.const 1 global.set $busy
      local.get $length i32.const 16 i32.ne
      local.get $event i32.load global.get $generation i32.ne i32.or
      local.get $event i32.load offset=4 global.get $sequence i32.ne i32.or
      if
        i32.const 5 global.set $fault i32.const 0 global.set $busy i32.const 4 return
      end
      local.get $event i32.load offset=8 i32.eqz
      if
        i32.const 6 global.set $fault i32.const 4 global.set $terminal
        i32.const 0 global.set $busy i32.const 4 return
      end
      local.get $event i32.load offset=12 local.set $value
      global.get $step local.set $step
      ${combines}
      global.get $step i32.const 1 i32.add global.set $step
      local.get $out local.get $capacity call $yield
      i32.const 0 global.set $busy)
    (func (export "cancel") (result i32)
      global.get $terminal i32.eqz
      if
        global.get $generation i32.const 1 i32.add global.set $generation
        i32.const 5 global.set $terminal
      end
      i32.const 5)
    (func (export "dispose") (result i32)
      i32.const 5 global.set $terminal
      i32.const 0 global.set $accumulator
      i32.const 0)
    (func (export "fault_code") (result i32) global.get $fault))`;
  const module = binaryen.parseText(wat);
  try {
    if (!module.validate()) throw new Error("INVALID_IR: effects Wasm");
    const bytes = new Uint8Array(module.emitBinary());
    if (!WebAssembly.validate(bytes))
      throw new Error("INVALID_IR: effects Wasm");
    return {
      bytes,
      wat,
      contract: Object.freeze({
        abi: EFFECTS_SESSION_ABI,
        memory: { initial: 512 as const, maximum: 512 as const },
        requestBytes: 16,
        eventBytes: 16,
        outputBytes: 4,
        programHash: fingerprintFor({ program }),
      }),
    };
  } finally {
    module.dispose();
  }
}

export function assertEffectsWasm(bytes: Uint8Array): WebAssembly.Module {
  if (!WebAssembly.validate(bytes as BufferSource))
    throw new Error("INVALID_ARTIFACT");
  const module = new WebAssembly.Module(bytes as BufferSource),
    imports = WebAssembly.Module.imports(module),
    exports = WebAssembly.Module.exports(module),
    expected = ["cancel", "dispose", "fault_code", "memory", "resume", "start"];
  if (
    imports.length ||
    exports
      .map((item) => item.name)
      .sort()
      .join() !== expected.join()
  )
    throw new Error("INVALID_ARTIFACT: effects Wasm interface");
  return module;
}

export type LinearHostRequest = Readonly<{
  generation: number;
  sequence: number;
  operation: number;
  payload: number;
}>;

type SessionExports = {
  memory: WebAssembly.Memory;
  start(out: number, capacity: number): number;
  resume(event: number, length: number, out: number, capacity: number): number;
  cancel(): number;
  dispose(): number;
  fault_code(): number;
};

export class LinearEffectsRuntime {
  readonly #exports: SessionExports;
  readonly #requestAddress = 64;
  readonly #eventAddress = 128;
  #started = false;
  #disposed = false;

  constructor(bytes: Uint8Array) {
    this.#exports = new WebAssembly.Instance(assertEffectsWasm(bytes), {})
      .exports as unknown as SessionExports;
  }

  start(): { status: number; request?: LinearHostRequest; result?: number } {
    if (this.#started || this.#disposed)
      throw new Error("SESSION_NOT_STARTABLE");
    this.#started = true;
    return this.#outcome(this.#exports.start(this.#requestAddress, 16));
  }

  resume(
    request: LinearHostRequest,
    event: Readonly<{ ok: boolean; value: number }>,
  ): { status: number; request?: LinearHostRequest; result?: number } {
    if (!this.#started || this.#disposed) throw new Error("SESSION_NOT_ACTIVE");
    checkedI32(event.value, "event value");
    const view = new DataView(this.#exports.memory.buffer);
    view.setUint32(this.#eventAddress, request.generation, true);
    view.setUint32(this.#eventAddress + 4, request.sequence, true);
    view.setUint32(this.#eventAddress + 8, event.ok ? 1 : 0, true);
    view.setInt32(this.#eventAddress + 12, event.value, true);
    return this.#outcome(
      this.#exports.resume(this.#eventAddress, 16, this.#requestAddress, 16),
    );
  }

  cancel(): void {
    if (!this.#disposed) this.#exports.cancel();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#exports.dispose();
    this.#disposed = true;
  }

  #outcome(status: number): {
    status: number;
    request?: LinearHostRequest;
    result?: number;
  } {
    const view = new DataView(this.#exports.memory.buffer);
    if (status === SESSION_STATUS.YIELDED)
      return {
        status,
        request: Object.freeze({
          generation: view.getUint32(this.#requestAddress, true),
          sequence: view.getUint32(this.#requestAddress + 4, true),
          operation: view.getUint32(this.#requestAddress + 8, true),
          payload: view.getInt32(this.#requestAddress + 12, true),
        }),
      };
    if (status === SESSION_STATUS.DONE)
      return {
        status,
        result: view.getInt32(this.#requestAddress, true),
      };
    if (status === SESSION_STATUS.FAILED)
      throw new Error(`EFFECTS_WASM_FAULT: ${this.#exports.fault_code()}`);
    if (status === SESSION_STATUS.CANCELLED) throw new Error("CANCELLED");
    return { status };
  }
}

export function replayLinearEffects(
  bytes: Uint8Array,
  fixture: readonly Readonly<{
    request: LinearHostRequest;
    response: { ok: boolean; value: number };
  }>[],
): { result: number; requests: readonly LinearHostRequest[] } {
  const runtime = new LinearEffectsRuntime(bytes),
    requests: LinearHostRequest[] = [];
  try {
    let outcome = runtime.start(),
      index = 0;
    while (outcome.status === SESSION_STATUS.YIELDED) {
      const request = outcome.request,
        item = fixture[index++];
      if (
        !request ||
        !item ||
        JSON.stringify(request) !== JSON.stringify(item.request)
      )
        throw new Error("REPLAY_MISMATCH");
      requests.push(request);
      outcome = runtime.resume(request, item.response);
    }
    if (outcome.status !== SESSION_STATUS.DONE || outcome.result === undefined)
      throw new Error("REPLAY_INCOMPLETE");
    if (index !== fixture.length) throw new Error("REPLAY_UNUSED_EVENTS");
    return { result: outcome.result, requests: Object.freeze(requests) };
  } finally {
    runtime.dispose();
  }
}
