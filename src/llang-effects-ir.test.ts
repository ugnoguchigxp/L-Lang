import { describe, expect, test } from "bun:test";
import {
  decodeEffectWire,
  decodeEffectValue,
  encodeEffectValue,
  encodeEffectWire,
  parseEffectValueType,
} from "./llang-effects-ir";
import { Decimal, LBytes } from "./llang-effects-values";

describe("generic typed effect values", () => {
  test("round-trips bytes, i64, finite f64 and decimal without coercion", () => {
    const vectors = [
      [{ kind: "bytes" } as const, LBytes.from([0, 255, 1])],
      [{ kind: "i64" } as const, 9_007_199_254_740_993n],
      [{ kind: "f64" } as const, 0.125],
      [{ kind: "decimal", scale: 2 } as const, new Decimal(12345n, 2)],
    ] as const;
    for (const [type, value] of vectors)
      expect(decodeEffectWire(type, encodeEffectWire(type, value))).toEqual(
        value,
      );
    expect(encodeEffectValue({ kind: "bytes" }, vectors[0][1])).toEqual({
      bytes: "AP8B",
    });
  });

  test("validates nested records and rejects implicit conversions", () => {
    const type = parseEffectValueType({
      kind: "record",
      fields: { count: "i64", payload: "bytes" },
    });
    expect(
      decodeEffectValue(type, {
        count: { i64: "42" },
        payload: { bytes: "AQI=" },
      }),
    ).toEqual({ count: 42n, payload: LBytes.from([1, 2]) });
    expect(() => decodeEffectValue({ kind: "i64" }, 42)).toThrow("INVALID_I64");
    expect(() => decodeEffectValue({ kind: "f64" }, Infinity)).toThrow(
      "NUMERIC_NON_FINITE",
    );
    expect(() =>
      encodeEffectValue(type, {
        count: 42n,
        payload: LBytes.from([1]),
        extra: true,
      }),
    ).toThrow("INVALID_RECORD");
  });

  test("keeps special record field names as own data properties", () => {
    const type = parseEffectValueType(
      JSON.parse('{"kind":"record","fields":{"__proto__":"string"}}'),
    );
    if (type.kind !== "record") throw new Error("missing record type");
    expect(Object.hasOwn(type.fields, "__proto__")).toBe(true);
    const value = Object.fromEntries([["__proto__", "safe"]]);
    expect(decodeEffectWire(type, encodeEffectWire(type, value))).toEqual(
      value,
    );
  });
});
