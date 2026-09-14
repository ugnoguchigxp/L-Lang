import { describe, expect, test } from "bun:test";
import { evaluateExpression } from "./cross-schema-benchmark";
import type { TypeSchema } from "./semantic-source";
import { contractSlots, encodeInput, parseContract } from "./wasm-contract";
import { contractFromType, lowerPredicate } from "./wasm-core";
import { emitWasm } from "./wasm-emitter";
import { customerBody, customerSchema } from "./wasm-test-fixture";

const contract = contractFromType(customerSchema);
function run(body: unknown, schema = customerSchema) {
  const c = contractFromType(schema);
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(emitWasm(body, c)),
  );
  const fn = instance.exports.evaluate;
  if (typeof fn !== "function") throw new Error("missing export");
  return (input: unknown) => fn(...encodeInput(c, input));
}

describe("Wasm predicate semantics", () => {
  test("strict equality agrees on signed zero", () => {
    expect(
      evaluateExpression(
        { kind: "equals", property: ["n"], value: 0 },
        { n: -0 },
      ),
    ).toBe(true);
    expect(
      evaluateExpression(
        { kind: "equals", property: ["n"], value: -0 },
        { n: 0 },
      ),
    ).toBe(true);
  });
  test("all twelve customer states match an independent truth table", () => {
    const evaluate = run(customerBody);
    // status: active/suspended; deleted: null/date; email: undefined/null/string.
    const expected = [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    let index = 0;
    for (const status of ["active", "suspended"])
      for (const deletedAt of [null, "2026-01-01"])
        for (const email of [undefined, null, ""]) {
          const input = { status, deletedAt, email };
          expect(evaluate(input)).toBe(expected[index] ?? -1);
          expect(Number(evaluateExpression(customerBody, input))).toBe(
            expected[index++] ?? -1,
          );
        }
    expect(evaluate({ status: "active", deletedAt: null, email: "x" })).toBe(1);
  });
  test("generic boolean, optional enum, any and not compose", () => {
    const schema: TypeSchema = {
      kind: "object",
      properties: [
        { name: "enabled", optional: false, type: { kind: "boolean" } },
        {
          name: "mode",
          optional: true,
          type: {
            kind: "union",
            types: [
              { kind: "literal", value: "go" },
              { kind: "literal", value: "stop" },
              { kind: "null" },
              { kind: "undefined" },
            ],
          },
        },
      ],
    };
    const f = run(
      {
        kind: "any",
        conditions: [
          {
            kind: "not",
            condition: { kind: "equals", property: ["enabled"], value: true },
          },
          { kind: "equals", property: ["mode"], value: "go" },
        ],
      },
      schema,
    );
    expect(f({ enabled: false })).toBe(1);
    expect(f({ enabled: true })).toBe(0);
    expect(f({ enabled: true, mode: "go" })).toBe(1);
    expect(f({ enabled: true, mode: null })).toBe(0);
    expect(f({ enabled: true, mode: "stop" })).toBe(0);
  });
  test("rejects unsupported IR and types instead of weakening them", () => {
    for (const body of [
      { kind: "call" },
      { kind: "all", conditions: [] },
      { kind: "equals", property: ["email"], value: "x" },
      { kind: "equals", property: ["status"], value: "unknown" },
      { kind: "equals", property: ["status"], value: null },
      { kind: "present", property: ["status"] },
      { kind: "present", property: ["missing"] },
      { kind: "present", property: ["email", "length"] },
    ])
      expect(() => lowerPredicate(body, contract)).toThrow();
    expect(() => contractFromType({ kind: "number" })).toThrow();
    expect(() =>
      contractFromType({
        kind: "object",
        properties: [{ name: "n", optional: false, type: { kind: "number" } }],
      }),
    ).toThrow();
  });
  test("checks canonical field and enum contracts", () => {
    expect(contractSlots(contract).length).toBe(3);
    for (const bad of [
      null,
      {},
      { ...contract, version: 2 },
      { ...contract, extra: 1 },
      { ...contract, fields: [] },
      { ...contract, fields: [...contract.fields].reverse() },
      { ...contract, fields: [contract.fields[0], contract.fields[0]] },
      { version: 1, fields: [{ ...contract.fields[0], kind: "unknown" }] },
      { version: 1, fields: [{ ...contract.fields[2], values: ["z", "a"] }] },
    ])
      expect(() => parseContract(bad)).toThrow();
    expect(() =>
      lowerPredicate(customerBody, {
        ...contract,
        version: 2,
      } as unknown as typeof contract),
    ).toThrow();
  });
  test("adapter rejects invalid input without invoking getters", () => {
    const valid = { status: "active", deletedAt: null, email: "" };
    for (const bad of [
      null,
      [],
      1,
      new Date(),
      {},
      { ...valid, email: 1 },
      { ...valid, status: "no" },
      { ...valid, deletedAt: undefined },
      { ...valid, extra: 1 },
      { ...valid, [Symbol()]: 1 },
    ])
      expect(() => encodeInput(contract, bad)).toThrow();
    let called = false;
    const getter = {
      ...valid,
      get email() {
        called = true;
        return "";
      },
    };
    expect(() => encodeInput(contract, getter)).toThrow();
    expect(called).toBe(false);
  });
  test("enum ordering remains strict when literals contain NUL", () => {
    expect(() =>
      parseContract({
        version: 1,
        fields: [
          {
            name: "state",
            kind: "enum",
            values: ["a\0a", "a"],
            nullable: false,
            undefinable: false,
            optional: false,
          },
        ],
      }),
    ).toThrow("enum values");
  });
  test("canonical encoding ignores field declaration order", () => {
    if (customerSchema.kind !== "object") throw new Error("fixture");
    const reversed = {
      ...customerSchema,
      properties: [...customerSchema.properties].reverse(),
    };
    expect(emitWasm(customerBody, contractFromType(reversed))).toEqual(
      emitWasm(customerBody, contract),
    );
  });
});
