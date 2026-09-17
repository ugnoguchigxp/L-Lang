export type RoundingMode = "toward-zero" | "half-even";

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const I128_MIN = -(1n << 127n);
const I128_MAX = (1n << 127n) - 1n;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const checked = (value: bigint, min: bigint, max: bigint, label: string) => {
  if (value < min || value > max) throw new Error(`NUMERIC_OVERFLOW: ${label}`);
  return value;
};
const power10 = (scale: number) => 10n ** BigInt(scale);
const scaleValue = (scale: number) => {
  if (!Number.isInteger(scale) || scale < 0 || scale > 18)
    throw new Error("INVALID_DECIMAL_SCALE");
  return scale;
};
const quotient = (
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode,
): bigint => {
  if (denominator === 0n) throw new Error("DIVISION_BY_ZERO");
  const negative = numerator < 0n !== denominator < 0n,
    a = numerator < 0n ? -numerator : numerator,
    b = denominator < 0n ? -denominator : denominator,
    floor = a / b,
    remainder = a % b;
  let magnitude = floor;
  if (mode === "half-even") {
    const twice = remainder * 2n;
    if (twice > b || (twice === b && floor % 2n !== 0n)) magnitude += 1n;
  }
  return negative ? -magnitude : magnitude;
};

export class LBytes {
  readonly #value: Uint8Array;

  private constructor(value: Uint8Array) {
    this.#value = value;
    Object.freeze(this);
  }

  static from(value: Uint8Array | readonly number[]): LBytes {
    const bytes = Uint8Array.from(value);
    return new LBytes(bytes);
  }

  static fromBase64(value: string): LBytes {
    if (!BASE64.test(value)) throw new Error("INVALID_BASE64");
    const decoded = Uint8Array.from(Buffer.from(value, "base64"));
    if (Buffer.from(decoded).toString("base64") !== value)
      throw new Error("INVALID_BASE64");
    return new LBytes(decoded);
  }

  static encodeUtf8(value: string): LBytes {
    for (let index = 0; index < value.length; index++) {
      const unit = value.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(++index);
        if (!(next >= 0xdc00 && next <= 0xdfff))
          throw new Error("INVALID_UNICODE");
      } else if (unit >= 0xdc00 && unit <= 0xdfff)
        throw new Error("INVALID_UNICODE");
    }
    return new LBytes(new TextEncoder().encode(value));
  }

  get length(): number {
    return this.#value.length;
  }

  at(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= this.#value.length)
      throw new Error("INDEX_OUT_OF_BOUNDS");
    return this.#value[index] as number;
  }

  slice(start: number, end: number): LBytes {
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < start ||
      end > this.#value.length
    )
      throw new Error("INDEX_OUT_OF_BOUNDS");
    return new LBytes(this.#value.slice(start, end));
  }

  concat(other: LBytes, maximum = 1024 * 1024): LBytes {
    if (this.length > maximum - other.length) throw new Error("RESOURCE_LIMIT");
    const output = new Uint8Array(this.length + other.length);
    output.set(this.#value);
    output.set(other.#value, this.length);
    return new LBytes(output);
  }

  decodeUtf8(): string {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(this.#value);
    } catch {
      throw new Error("INVALID_UTF8");
    }
  }

  toBase64(): string {
    return Buffer.from(this.#value).toString("base64");
  }

  toUint8Array(): Uint8Array {
    return this.#value.slice();
  }
}

export class Utf8StreamDecoder {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  #ended = false;

  push(chunk: LBytes): string {
    if (this.#ended) throw new Error("STREAM_CLOSED");
    try {
      return this.#decoder.decode(chunk.toUint8Array(), { stream: true });
    } catch {
      this.#ended = true;
      throw new Error("INVALID_UTF8");
    }
  }

  finish(): string {
    if (this.#ended) throw new Error("STREAM_CLOSED");
    this.#ended = true;
    try {
      return this.#decoder.decode();
    } catch {
      throw new Error("INVALID_UTF8");
    }
  }
}

export const i64 = {
  parse(value: string): bigint {
    if (!/^-?(?:0|[1-9][0-9]*)$/.test(value) || value === "-0")
      throw new Error("INVALID_I64");
    return checked(BigInt(value), I64_MIN, I64_MAX, "i64");
  },
  add(a: bigint, b: bigint): bigint {
    return checked(a + b, I64_MIN, I64_MAX, "i64");
  },
  subtract(a: bigint, b: bigint): bigint {
    return checked(a - b, I64_MIN, I64_MAX, "i64");
  },
  multiply(a: bigint, b: bigint): bigint {
    return checked(a * b, I64_MIN, I64_MAX, "i64");
  },
  divide(a: bigint, b: bigint): bigint {
    if (b === 0n) throw new Error("DIVISION_BY_ZERO");
    return checked(a / b, I64_MIN, I64_MAX, "i64");
  },
  encode(value: bigint): Uint8Array {
    checked(value, I64_MIN, I64_MAX, "i64");
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigInt64(0, value, true);
    return bytes;
  },
  decode(bytes: Uint8Array): bigint {
    if (bytes.length !== 8) throw new Error("INVALID_I64_WIRE");
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, true);
  },
};

export function finiteF64(value: number): number {
  if (!Number.isFinite(value)) throw new Error("NUMERIC_NON_FINITE");
  return Object.is(value, -0) ? 0 : value;
}

export const f64 = {
  add: (a: number, b: number) => finiteF64(finiteF64(a) + finiteF64(b)),
  subtract: (a: number, b: number) => finiteF64(finiteF64(a) - finiteF64(b)),
  multiply: (a: number, b: number) => finiteF64(finiteF64(a) * finiteF64(b)),
  divide(a: number, b: number): number {
    finiteF64(a);
    finiteF64(b);
    if (b === 0) throw new Error("DIVISION_BY_ZERO");
    return finiteF64(a / b);
  },
  encode(value: number): Uint8Array {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, finiteF64(value), true);
    return bytes;
  },
  decode(bytes: Uint8Array): number {
    if (bytes.length !== 8) throw new Error("INVALID_F64_WIRE");
    return finiteF64(
      new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true),
    );
  },
};

export class Decimal {
  readonly coefficient: bigint;
  readonly scale: number;

  constructor(coefficient: bigint, scale: number) {
    this.coefficient = checked(coefficient, I64_MIN, I64_MAX, "decimal");
    this.scale = scaleValue(scale);
    Object.freeze(this);
  }

  add(other: Decimal): Decimal {
    this.assertSameScale(other);
    return new Decimal(
      i64.add(this.coefficient, other.coefficient),
      this.scale,
    );
  }

  subtract(other: Decimal): Decimal {
    this.assertSameScale(other);
    return new Decimal(
      i64.subtract(this.coefficient, other.coefficient),
      this.scale,
    );
  }

  compare(other: Decimal): number {
    this.assertSameScale(other);
    return this.coefficient < other.coefficient
      ? -1
      : this.coefficient > other.coefficient
        ? 1
        : 0;
  }

  multiply(other: Decimal, outputScale: number, mode: RoundingMode): Decimal {
    scaleValue(outputScale);
    const product = checked(
        this.coefficient * other.coefficient,
        I128_MIN,
        I128_MAX,
        "decimal intermediate",
      ),
      shift = this.scale + other.scale - outputScale,
      coefficient =
        shift >= 0
          ? quotient(product, power10(shift), mode)
          : checked(
              product * power10(-shift),
              I128_MIN,
              I128_MAX,
              "decimal intermediate",
            );
    return new Decimal(coefficient, outputScale);
  }

  divide(other: Decimal, outputScale: number, mode: RoundingMode): Decimal {
    scaleValue(outputScale);
    const shift = outputScale + other.scale - this.scale,
      numerator =
        shift >= 0
          ? checked(
              this.coefficient * power10(shift),
              I128_MIN,
              I128_MAX,
              "decimal intermediate",
            )
          : this.coefficient,
      denominator =
        shift >= 0
          ? other.coefficient
          : checked(
              other.coefficient * power10(-shift),
              I128_MIN,
              I128_MAX,
              "decimal intermediate",
            );
    return new Decimal(quotient(numerator, denominator, mode), outputScale);
  }

  rescale(outputScale: number, mode: RoundingMode): Decimal {
    scaleValue(outputScale);
    const shift = outputScale - this.scale;
    return new Decimal(
      shift >= 0
        ? checked(
            this.coefficient * power10(shift),
            I64_MIN,
            I64_MAX,
            "decimal",
          )
        : quotient(this.coefficient, power10(-shift), mode),
      outputScale,
    );
  }

  toJSON(): { coefficient: string; scale: number } {
    return { coefficient: this.coefficient.toString(), scale: this.scale };
  }

  private assertSameScale(other: Decimal): void {
    if (this.scale !== other.scale) throw new Error("DECIMAL_SCALE_MISMATCH");
  }
}
