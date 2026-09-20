import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import binaryen from "binaryen";
import { MAX_EFFECT_WIRE_BYTES, typeTag } from "./llang-effects-ir";
import { LBytes } from "./llang-effects-values";
import { EffectsMemoryDirectHarness } from "./llang-effects-memory-direct-harness";
import {
  renderEffectsMemorySafetyMatrix,
  type EffectsMemorySafetyMatrix,
} from "./llang-effects-memory-matrix";
import {
  emitTypedEffectsWasm,
  TYPED_DATA_START,
  TYPED_EVENT_BYTES,
  TYPED_EVENT_PAYLOAD_START,
  TYPED_REQUEST_BYTES,
  TYPED_RESULT_START,
} from "./llang-effects-state-machine";
import {
  emitLinearEffectsWasm,
  LinearEffectsRuntime,
  replayLinearEffects,
  SESSION_STATUS,
} from "./llang-effects-wasm";

const LINEAR_REQUEST_BYTES = 16;
const LINEAR_RESULT_BYTES = 4;
const REQUEST = 64;
const EVENT = 128;
const OUTPUT = 192;
const PAYLOAD = TYPED_EVENT_PAYLOAD_START;

const linearProgram = {
  initial: 10,
  steps: [
    { operation: 2, payload: 100, combine: "add" as const },
    { operation: 3, payload: 200, combine: "replace" as const },
  ],
};

const typedProgram = {
  nodes: [
    {
      kind: "await" as const,
      operation: "host.bytes",
      version: 1,
      requestType: { kind: "bytes" as const },
      responseType: { kind: "bytes" as const },
      request: LBytes.from([]),
    },
    {
      kind: "await" as const,
      operation: "host.bytes",
      version: 1,
      requestType: { kind: "bytes" as const },
      responseType: { kind: "bytes" as const },
      request: LBytes.from([1]),
    },
  ],
  resultType: { kind: "bytes" as const },
};

const typedOperations = [{ id: "host.bytes", version: 1 }];
const returned = (result: ReturnType<EffectsMemoryDirectHarness["start"]>) => {
  expect(result.kind).toBe("return");
  return result;
};

const compileWat = (wat: string): Uint8Array => {
  const module = binaryen.parseText(wat);
  try {
    expect(Boolean(module.validate())).toBe(true);
    return new Uint8Array(module.emitBinary());
  } finally {
    module.dispose();
  }
};

describe("module-effects-v1 direct memory boundary", () => {
  test("linear and typed invalid output bases fail without trapping and retry", () => {
    const linear = new EffectsMemoryDirectHarness(
      emitLinearEffectsWasm(linearProgram).bytes,
    );
    expect(returned(linear.start(0xffff_ffff, 16))).toMatchObject({
      status: SESSION_STATUS.FAILED,
      fault: 5,
    });
    expect(returned(linear.start(REQUEST, LINEAR_REQUEST_BYTES))).toMatchObject(
      { status: SESSION_STATUS.YIELDED, fault: 0 },
    );
    expect(linear.readWords(REQUEST, 2)).toEqual([0, 1]);

    const typed = new EffectsMemoryDirectHarness(
      emitTypedEffectsWasm(typedProgram, typedOperations).bytes,
    );
    expect(returned(typed.start(0xffff_ffff, 32))).toMatchObject({
      status: SESSION_STATUS.FAILED,
      fault: 5,
    });
    expect(returned(typed.start(REQUEST, TYPED_REQUEST_BYTES))).toMatchObject({
      status: SESSION_STATUS.YIELDED,
      fault: 0,
    });
    expect(typed.readWords(REQUEST, 2)).toEqual([0, 1]);
  });

  test("invalid event descriptors do not load memory or consume pending state", () => {
    const linear = new EffectsMemoryDirectHarness(
      emitLinearEffectsWasm(linearProgram).bytes,
    );
    expect(linear.start(REQUEST, 16).status).toBe(SESSION_STATUS.YIELDED);
    expect(returned(linear.resume(0xffff_ffff, 16, OUTPUT, 16))).toMatchObject({
      status: SESSION_STATUS.FAILED,
      fault: 5,
    });
    linear.writeLinearEvent(EVENT, {
      generation: 0,
      sequence: 1,
      ok: 1,
      value: 5,
    });
    expect(returned(linear.resume(EVENT, 16, OUTPUT, 16))).toMatchObject({
      status: SESSION_STATUS.YIELDED,
      fault: 0,
    });
    expect(linear.readWords(OUTPUT, 2)).toEqual([0, 2]);

    const typed = new EffectsMemoryDirectHarness(
      emitTypedEffectsWasm(typedProgram, typedOperations).bytes,
    );
    typed.start(REQUEST, 32);
    expect(returned(typed.resume(0xffff_ffff, 24, OUTPUT, 32))).toMatchObject({
      status: SESSION_STATUS.FAILED,
      fault: 5,
    });
    typed.writeTypedEvent(EVENT, {
      generation: 0,
      sequence: 1,
      ok: 1,
      type: typeTag({ kind: "bytes" }),
      payload: PAYLOAD,
      payloadLength: 0,
    });
    expect(returned(typed.resume(EVENT, 24, OUTPUT, 32))).toMatchObject({
      status: SESSION_STATUS.YIELDED,
      fault: 0,
    });
    expect(typed.readWords(OUTPUT, 3)).toEqual([0, 2, 1]);
  });

  test("successful events reject output aliasing and non-boolean success flags", () => {
    for (const output of [EVENT, EVENT + 8, EVENT + 15]) {
      const harness = new EffectsMemoryDirectHarness(
        emitLinearEffectsWasm(linearProgram).bytes,
      );
      harness.start(REQUEST, 16);
      harness.writeLinearEvent(EVENT, {
        generation: 0,
        sequence: 1,
        ok: 1,
        value: 5,
      });
      expect(returned(harness.resume(EVENT, 16, output, 16))).toMatchObject({
        status: SESSION_STATUS.FAILED,
        fault: 5,
      });
      expect(returned(harness.resume(EVENT, 16, OUTPUT, 16))).toMatchObject({
        status: SESSION_STATUS.YIELDED,
        fault: 0,
      });
    }
    const flag = new EffectsMemoryDirectHarness(
      emitLinearEffectsWasm(linearProgram).bytes,
    );
    flag.start(REQUEST, 16);
    flag.writeLinearEvent(EVENT, {
      generation: 0,
      sequence: 1,
      ok: 2,
      value: 5,
    });
    expect(returned(flag.resume(EVENT, 16, OUTPUT, 16))).toMatchObject({
      status: SESSION_STATUS.FAILED,
      fault: 5,
    });
  });

  test("typed payload faults precede output faults and preserve retry", () => {
    const emitted = emitTypedEffectsWasm(typedProgram, typedOperations),
      harness = new EffectsMemoryDirectHarness(emitted.bytes);
    harness.start(REQUEST, 32);
    harness.writeTypedEvent(EVENT, {
      generation: 0,
      sequence: 1,
      ok: 1,
      type: typeTag({ kind: "bytes" }),
      payload: 0xffff_ffff,
      payloadLength: 2,
    });
    const rejected = returned(
      harness.resume(EVENT, 24, 0xffff_ffff, 32, [
        { name: "event", base: EVENT, length: 24 },
        { name: "scratch", base: TYPED_RESULT_START, length: 64 },
      ]),
    );
    expect(rejected).toMatchObject({
      status: SESSION_STATUS.FAILED,
      fault: 8,
    });
    expect(rejected.after).toEqual(rejected.before);
    harness.writeTypedEvent(EVENT, {
      generation: 0,
      sequence: 1,
      ok: 1,
      type: typeTag({ kind: "bytes" }),
      payload: PAYLOAD,
      payloadLength: 0,
    });
    expect(returned(harness.resume(EVENT, 24, OUTPUT, 32))).toMatchObject({
      status: SESSION_STATUS.YIELDED,
      fault: 0,
    });
  });

  test("typed generation, sequence, and response type checks preserve the pending request", () => {
    const variants = [
      {
        generation: 1,
        sequence: 1,
        type: typeTag({ kind: "bytes" }),
        fault: 5,
      },
      {
        generation: 0,
        sequence: 2,
        type: typeTag({ kind: "bytes" }),
        fault: 5,
      },
      { generation: 0, sequence: 1, type: typeTag({ kind: "i32" }), fault: 7 },
    ];
    for (const variant of variants) {
      const harness = new EffectsMemoryDirectHarness(
        emitTypedEffectsWasm(typedProgram, typedOperations).bytes,
      );
      harness.start(REQUEST, 32);
      harness.writeTypedEvent(EVENT, {
        ...variant,
        ok: 1,
        payload: PAYLOAD,
        payloadLength: 0,
      });
      expect(returned(harness.resume(EVENT, 24, OUTPUT, 32))).toMatchObject({
        status: SESSION_STATUS.FAILED,
        fault: variant.fault,
      });
      harness.writeTypedEvent(EVENT, {
        generation: 0,
        sequence: 1,
        ok: 1,
        type: typeTag({ kind: "bytes" }),
        payload: PAYLOAD,
        payloadLength: 0,
      });
      expect(returned(harness.resume(EVENT, 24, OUTPUT, 32))).toMatchObject({
        status: SESSION_STATUS.YIELDED,
        fault: 0,
      });
    }
  });

  test("typed caller ranges cannot alias embedded data or result scratch", () => {
    const emitted = emitTypedEffectsWasm(typedProgram, typedOperations);
    for (const privateOutput of [TYPED_DATA_START, TYPED_RESULT_START]) {
      const harness = new EffectsMemoryDirectHarness(emitted.bytes);
      expect(
        returned(harness.start(privateOutput, TYPED_REQUEST_BYTES)),
      ).toMatchObject({ status: SESSION_STATUS.FAILED, fault: 5 });
      expect(
        returned(harness.start(REQUEST, TYPED_REQUEST_BYTES)),
      ).toMatchObject({ status: SESSION_STATUS.YIELDED, fault: 0 });
    }
    for (const privatePayload of [TYPED_DATA_START, TYPED_RESULT_START]) {
      const harness = new EffectsMemoryDirectHarness(emitted.bytes);
      harness.start(REQUEST, 32);
      harness.writeTypedEvent(EVENT, {
        generation: 0,
        sequence: 1,
        ok: 1,
        type: typeTag({ kind: "bytes" }),
        payload: privatePayload,
        payloadLength: 1,
      });
      expect(returned(harness.resume(EVENT, 24, OUTPUT, 32))).toMatchObject({
        status: SESSION_STATUS.FAILED,
        fault: 8,
      });
    }
  });

  test("typed output rejects event and payload overlap but accepts adjacency", () => {
    for (const output of [EVENT, EVENT + 16, PAYLOAD]) {
      const harness = new EffectsMemoryDirectHarness(
        emitTypedEffectsWasm(typedProgram, typedOperations).bytes,
      );
      harness.start(REQUEST, 32);
      harness.memory[PAYLOAD] = 0x5b;
      harness.writeTypedEvent(EVENT, {
        generation: 0,
        sequence: 1,
        ok: 1,
        type: typeTag({ kind: "bytes" }),
        payload: PAYLOAD,
        payloadLength: 1,
      });
      expect(returned(harness.resume(EVENT, 24, output, 32))).toMatchObject({
        status: SESSION_STATUS.FAILED,
        fault: 5,
      });
    }
    const adjacent = new EffectsMemoryDirectHarness(
      emitTypedEffectsWasm(typedProgram, typedOperations).bytes,
    );
    adjacent.start(REQUEST, 32);
    adjacent.writeTypedEvent(EVENT, {
      generation: 0,
      sequence: 1,
      ok: 1,
      type: typeTag({ kind: "bytes" }),
      payload: PAYLOAD,
      payloadLength: 0,
    });
    expect(returned(adjacent.resume(EVENT, 24, EVENT + 24, 32))).toMatchObject({
      status: SESSION_STATUS.YIELDED,
      fault: 0,
    });
  });

  test("exact-end, unaligned, zero and maximum payload boundaries are safe", () => {
    const linear = new EffectsMemoryDirectHarness(
      emitLinearEffectsWasm(linearProgram).bytes,
    );
    expect(
      returned(
        linear.start(
          linear.memory.length - LINEAR_REQUEST_BYTES,
          LINEAR_REQUEST_BYTES,
        ),
      ).status,
    ).toBe(SESSION_STATUS.YIELDED);

    const typed = new EffectsMemoryDirectHarness(
      emitTypedEffectsWasm(typedProgram, typedOperations).bytes,
    );
    expect(returned(typed.start(65, 32)).status).toBe(SESSION_STATUS.YIELDED);
    typed.writeTypedEvent(129, {
      generation: 0,
      sequence: 1,
      ok: 1,
      type: typeTag({ kind: "bytes" }),
      payload: PAYLOAD,
      payloadLength: MAX_EFFECT_WIRE_BYTES,
    });
    expect(returned(typed.resume(129, 24, OUTPUT, 32))).toMatchObject({
      status: SESSION_STATUS.YIELDED,
      fault: 0,
    });
  });

  test("final resumes require only result descriptor capacity", () => {
    const linear = new EffectsMemoryDirectHarness(
      emitLinearEffectsWasm({
        initial: 0,
        steps: [{ operation: 1, payload: 0, combine: "replace" }],
      }).bytes,
    );
    linear.start(REQUEST, 16);
    linear.writeLinearEvent(EVENT, {
      generation: 0,
      sequence: 1,
      ok: 1,
      value: 7,
    });
    expect(
      returned(linear.resume(EVENT, 16, OUTPUT, LINEAR_RESULT_BYTES)).status,
    ).toBe(SESSION_STATUS.DONE);

    const oneTyped = emitTypedEffectsWasm(
        { ...typedProgram, nodes: typedProgram.nodes.slice(0, 1) },
        typedOperations,
      ),
      typed = new EffectsMemoryDirectHarness(oneTyped.bytes);
    typed.start(REQUEST, 32);
    typed.writeTypedEvent(EVENT, {
      generation: 0,
      sequence: 1,
      ok: 1,
      type: typeTag({ kind: "bytes" }),
      payload: PAYLOAD,
      payloadLength: 0,
    });
    expect(returned(typed.resume(EVENT, 24, OUTPUT, 12)).status).toBe(
      SESSION_STATUS.DONE,
    );
  });

  test("ok=0 remains terminal without requiring type, payload, or output", () => {
    const typed = new EffectsMemoryDirectHarness(
      emitTypedEffectsWasm(typedProgram, typedOperations).bytes,
    );
    typed.start(REQUEST, 32);
    typed.writeTypedEvent(EVENT, {
      generation: 0,
      sequence: 1,
      ok: 0,
      type: 0xffff_ffff,
      payload: 0xffff_ffff,
      payloadLength: 0xffff_ffff,
    });
    expect(
      returned(typed.resume(EVENT, TYPED_EVENT_BYTES, 0xffff_ffff, 0)),
    ).toMatchObject({ status: SESSION_STATUS.FAILED, fault: 6 });
  });

  test("public runtime, replay and direct ABI preserve the linear result", () => {
    const emitted = emitLinearEffectsWasm(linearProgram),
      fixture = [
        {
          request: { generation: 0, sequence: 1, operation: 2, payload: 100 },
          response: { ok: true, value: 5 },
        },
        {
          request: { generation: 0, sequence: 2, operation: 3, payload: 200 },
          response: { ok: true, value: 7 },
        },
      ] as const,
      runtime = new LinearEffectsRuntime(emitted.bytes);
    const [firstFixture, secondFixture] = fixture;
    try {
      const first = runtime.start();
      if (!first.request) throw new Error("missing request");
      const second = runtime.resume(first.request, firstFixture.response);
      if (!second.request) throw new Error("missing request");
      expect(
        runtime.resume(second.request, secondFixture.response).result,
      ).toBe(7);
    } finally {
      runtime.dispose();
    }
    expect(replayLinearEffects(emitted.bytes, fixture).result).toBe(7);
    const direct = new EffectsMemoryDirectHarness(emitted.bytes);
    direct.start(REQUEST, 16);
    direct.writeLinearEvent(EVENT, {
      generation: 0,
      sequence: 1,
      ok: 1,
      value: 5,
    });
    direct.resume(EVENT, 16, OUTPUT, 16);
    direct.writeLinearEvent(EVENT, {
      generation: 0,
      sequence: 2,
      ok: 1,
      value: 7,
    });
    expect(direct.resume(EVENT, 16, OUTPUT, 4).status).toBe(
      SESSION_STATUS.DONE,
    );
    expect(direct.view.getInt32(OUTPUT, true)).toBe(7);
  });

  test("fixed corpus and matrix satisfy their strict schemas", async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    for (const [dataPath, schemaPath] of [
      [
        "benchmarks/effects-memory-v1/direct-corpus.json",
        "schemas/effects-memory-direct-corpus-v1.schema.json",
      ],
      [
        "benchmarks/effects-memory-v1/memory-safety-matrix.json",
        "schemas/effects-memory-safety-matrix-v1.schema.json",
      ],
    ] as const) {
      const data = JSON.parse(await readFile(dataPath, "utf8")),
        schema = JSON.parse(await readFile(schemaPath, "utf8")),
        validate = ajv.compile(schema);
      expect(validate(data), JSON.stringify(validate.errors)).toBe(true);
    }

    const matrix = JSON.parse(
      await readFile(
        "benchmarks/effects-memory-v1/memory-safety-matrix.json",
        "utf8",
      ),
    ) as EffectsMemorySafetyMatrix;
    expect(
      await readFile("docs/EFFECTS_WASM_MEMORY_SAFETY_MATRIX.md", "utf8"),
    ).toBe(renderEffectsMemorySafetyMatrix(matrix));
  });

  test("all nine boundary mutants are detected", () => {
    const linear = emitLinearEffectsWasm(linearProgram),
      typed = emitTypedEffectsWasm(typedProgram, typedOperations);
    const mutations = [
      linear.wat
        .replaceAll(
          "local.get $out local.get $capacity call $range-valid i32.eqz\n      if i32.const 5 global.set $fault i32.const 4 return end\n      i32.const 0 global.set $fault",
          "i32.const 0\n      if i32.const 5 global.set $fault i32.const 4 return end\n      i32.const 0 global.set $fault",
        )
        .replace(
          "local.get $out local.get $capacity call $range-valid i32.eqz\n      if i32.const 5 global.set $fault i32.const 4 return end\n      local.get $step",
          "i32.const 0\n      if i32.const 5 global.set $fault i32.const 4 return end\n      local.get $step",
        ),
      linear.wat.replace(
        "local.get $event local.get $length call $range-valid i32.eqz\n      if i32.const 5 global.set $fault i32.const 4 return end",
        "i32.const 0\n      if i32.const 5 global.set $fault i32.const 4 return end",
      ),
      linear.wat.replace(
        "i32.le_u\n      if (result i32)",
        "i32.le_s\n      if (result i32)",
      ),
      linear.wat.replace(
        "local.get $event local.get $length local.get $out local.get $capacity call $overlaps\n      if i32.const 5 global.set $fault i32.const 4 return end",
        "i32.const 0\n      if i32.const 5 global.set $fault i32.const 4 return end",
      ),
      typed.wat.replace(
        "local.get $payload local.get $payload-length call $range-valid i32.eqz\n      if i32.const 8 global.set $fault i32.const 4 return end",
        "i32.const 0\n      if i32.const 8 global.set $fault i32.const 4 return end",
      ),
      typed.wat
        .replace(
          "local.get $source local.get $length call $range-valid i32.eqz\n      local.get $target local.get $length call $range-valid i32.eqz i32.or",
          "i32.const 0",
        )
        .replace(
          '(func (export "fault_code") (result i32) global.get $fault)',
          '(export "copy_test" (func $copy))\n    (func (export "fault_code") (result i32) global.get $fault)',
        ),
      typed.wat.replace(
        "local.get $payload local.get $payload-length call $private-free i32.eqz\n      if i32.const 8 global.set $fault i32.const 4 return end",
        "i32.const 0\n      if i32.const 8 global.set $fault i32.const 4 return end",
      ),
      linear.wat.replace(
        "local.get $next-step i32.const 2 i32.ge_u\n      if i32.const 4 local.set $required\n      else i32.const 16 local.set $required end\n      local.get $capacity",
        "local.get $next-step i32.const 2 i32.ge_u\n      if i32.const 4 local.set $required\n      else i32.const 16 local.set $required end\n      local.get $next-step global.set $step\n      local.get $capacity",
      ),
      linear.wat.replace(
        "local.get $ok i32.const 1 i32.gt_u\n      if i32.const 5 global.set $fault i32.const 4 return end",
        "i32.const 0\n      if i32.const 5 global.set $fault i32.const 4 return end",
      ),
    ];
    expect(mutations).toHaveLength(9);
    expect(
      mutations.every(
        (wat, index) =>
          wat !== (index < 4 || index > 6 ? linear.wat : typed.wat),
      ),
    ).toBe(true);
    for (const wat of mutations)
      expect(WebAssembly.validate(compileWat(wat))).toBe(true);

    const [
      startMutation,
      eventMutation,
      signedMutation,
      aliasMutation,
      payloadMutation,
      copyMutation,
      privateMutation,
      earlyCommitMutation,
      successFlagMutation,
    ] = mutations;
    if (
      !startMutation ||
      !eventMutation ||
      !signedMutation ||
      !aliasMutation ||
      !payloadMutation ||
      !copyMutation ||
      !privateMutation ||
      !earlyCommitMutation ||
      !successFlagMutation
    )
      throw new Error("missing mutation");

    const startGuard = new EffectsMemoryDirectHarness(
      compileWat(startMutation),
    );
    expect(startGuard.start(0xffff_ffff, 16).kind).toBe("trap");
    const eventGuard = new EffectsMemoryDirectHarness(
      compileWat(eventMutation),
    );
    eventGuard.start(REQUEST, 16);
    expect(eventGuard.resume(0xffff_ffff, 16, OUTPUT, 16).kind).toBe("trap");
    const signed = new EffectsMemoryDirectHarness(compileWat(signedMutation));
    expect(signed.start(0xffff_ffff, 16).kind).toBe("trap");
    const alias = new EffectsMemoryDirectHarness(compileWat(aliasMutation));
    alias.start(REQUEST, 16);
    alias.writeLinearEvent(EVENT, {
      generation: 0,
      sequence: 1,
      ok: 1,
      value: 5,
    });
    expect(alias.resume(EVENT, 16, EVENT, 16).status).not.toBe(
      SESSION_STATUS.FAILED,
    );

    const payloadGuard = new EffectsMemoryDirectHarness(
      compileWat(payloadMutation),
    );
    payloadGuard.start(REQUEST, 32);
    payloadGuard.writeTypedEvent(EVENT, {
      generation: 0,
      sequence: 1,
      ok: 1,
      type: typeTag({ kind: "bytes" }),
      payload: 0xffff_ffff,
      payloadLength: 2,
    });
    expect(payloadGuard.resume(EVENT, 24, 0xffff_ffff, 32).fault).not.toBe(8);
    const copyInstance = new WebAssembly.Instance(
        new WebAssembly.Module(compileWat(copyMutation) as BufferSource),
        {},
      ),
      copyTest = copyInstance.exports.copy_test as (
        source: number,
        target: number,
        length: number,
      ) => number;
    expect(() => copyTest(0xffff_ffff, OUTPUT, 2)).toThrow();
    const privateGuard = new EffectsMemoryDirectHarness(
      compileWat(privateMutation),
    );
    privateGuard.start(REQUEST, 32);
    privateGuard.writeTypedEvent(EVENT, {
      generation: 0,
      sequence: 1,
      ok: 1,
      type: typeTag({ kind: "bytes" }),
      payload: TYPED_DATA_START,
      payloadLength: 1,
    });
    expect(privateGuard.resume(EVENT, 24, OUTPUT, 32).status).not.toBe(
      SESSION_STATUS.FAILED,
    );
    const earlyCommit = new EffectsMemoryDirectHarness(
      compileWat(earlyCommitMutation),
    );
    earlyCommit.start(REQUEST, 16);
    earlyCommit.writeLinearEvent(EVENT, {
      generation: 0,
      sequence: 1,
      ok: 1,
      value: 5,
    });
    expect(earlyCommit.resume(EVENT, 16, OUTPUT, 0).status).toBe(
      SESSION_STATUS.FAILED,
    );
    expect(earlyCommit.resume(EVENT, 16, OUTPUT, 16).status).not.toBe(
      SESSION_STATUS.YIELDED,
    );
    const successFlag = new EffectsMemoryDirectHarness(
      compileWat(successFlagMutation),
    );
    successFlag.start(REQUEST, 16);
    successFlag.writeLinearEvent(EVENT, {
      generation: 0,
      sequence: 1,
      ok: 2,
      value: 5,
    });
    expect(successFlag.resume(EVENT, 16, OUTPUT, 16).status).toBe(
      SESSION_STATUS.YIELDED,
    );
  });
});
