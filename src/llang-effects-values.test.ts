import { describe, expect, test } from "bun:test";
import {
  Decimal,
  f64,
  finiteF64,
  i64,
  LBytes,
  Utf8StreamDecoder,
} from "./llang-effects-values";

describe("module-effects scalar and bytes values", () => {
  test("bytes are immutable, strict and preserve split UTF-8", () => {
    const source = Uint8Array.of(1, 2, 3),
      value = LBytes.from(source);
    source[0] = 9;
    expect(value.at(0)).toBe(1);
    expect(value.slice(1, 3).toBase64()).toBe("AgM=");
    expect(() => LBytes.fromBase64("A===")).toThrow("INVALID_BASE64");
    expect(() => value.at(3)).toThrow("INDEX_OUT_OF_BOUNDS");
    const encoded = LBytes.encodeUtf8("A商品🙂"),
      bytes = encoded.toUint8Array(),
      decoder = new Utf8StreamDecoder();
    expect(
      decoder.push(LBytes.from(bytes.slice(0, 3))) +
        decoder.push(LBytes.from(bytes.slice(3, 7))) +
        decoder.push(LBytes.from(bytes.slice(7))) +
        decoder.finish(),
    ).toBe("A商品🙂");
    const incomplete = new Utf8StreamDecoder();
    incomplete.push(LBytes.from([0xf0, 0x9f]));
    expect(() => incomplete.finish()).toThrow("INVALID_UTF8");
  });

  test("i64 uses exact checked BigInt and little-endian wire values", () => {
    const maximum = i64.parse("9223372036854775807"),
      minimum = i64.parse("-9223372036854775808");
    expect(i64.decode(i64.encode(minimum))).toBe(minimum);
    expect(i64.decode(i64.encode(maximum))).toBe(maximum);
    expect(() => i64.add(maximum, 1n)).toThrow("NUMERIC_OVERFLOW");
    expect(() => i64.divide(minimum, -1n)).toThrow("NUMERIC_OVERFLOW");
  });

  test("f64 rejects non-finite values and canonicalizes negative zero", () => {
    expect(Object.is(finiteF64(-0), 0)).toBe(true);
    expect(f64.decode(f64.encode(Number.MIN_VALUE))).toBe(Number.MIN_VALUE);
    expect(() => f64.multiply(Number.MAX_VALUE, 2)).toThrow(
      "NUMERIC_NON_FINITE",
    );
    expect(() => f64.divide(1, 0)).toThrow("DIVISION_BY_ZERO");
  });

  test("decimal fixes scale and applies explicit ties-to-even", () => {
    expect(new Decimal(125n, 2).rescale(1, "half-even").coefficient).toBe(12n);
    expect(new Decimal(135n, 2).rescale(1, "half-even").coefficient).toBe(14n);
    expect(
      new Decimal(250n, 2).multiply(new Decimal(333n, 2), 2, "half-even"),
    ).toEqual(new Decimal(832n, 2));
    expect(
      new Decimal(100n, 2).divide(new Decimal(600n, 2), 2, "half-even"),
    ).toEqual(new Decimal(17n, 2));
    expect(() => new Decimal(1n, 2).add(new Decimal(1n, 3))).toThrow(
      "DECIMAL_SCALE_MISMATCH",
    );
  });
});
