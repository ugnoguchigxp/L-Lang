import { createHash } from "node:crypto";
import { unicodeScalarLength } from "./unicode-length";

export class WasmError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "WasmError";
  }
}

export const WASM_LIMITS = { bytes: 1024 * 1024, fields: 64, values: 256 };
export type WasmField = {
  name: string;
  kind: "boolean" | "enum" | "string";
  values: string[];
  nullable: boolean;
  undefinable: boolean;
  optional: boolean;
};
export type WasmSlot = { field: string; kind: "state" | "value" };
export type WasmContract = { version: 1; fields: WasmField[] };

export function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function record(
  value: unknown,
  keys: string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WasmError("INVALID_ARTIFACT", "expected an object");
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key))
      throw new WasmError("INVALID_ARTIFACT", `unknown key ${key}`);
  }
  return value as Record<string, unknown>;
}

export function parseContract(input: unknown): WasmContract {
  const value = record(input, ["version", "fields"]);
  if (
    value.version !== 1 ||
    !Array.isArray(value.fields) ||
    value.fields.length === 0 ||
    value.fields.length > WASM_LIMITS.fields
  ) {
    throw new WasmError(
      "UNSUPPORTED_TYPE",
      "invalid contract version or field count",
    );
  }
  const fields = value.fields.map((raw): WasmField => {
    const f = record(raw, [
      "name",
      "kind",
      "values",
      "nullable",
      "undefinable",
      "optional",
    ]);
    if (
      typeof f.name !== "string" ||
      !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(f.name) ||
      f.name.length > 256 ||
      (f.kind !== "boolean" && f.kind !== "enum" && f.kind !== "string") ||
      typeof f.nullable !== "boolean" ||
      typeof f.undefinable !== "boolean" ||
      typeof f.optional !== "boolean" ||
      !Array.isArray(f.values) ||
      f.values.length > WASM_LIMITS.values ||
      f.values.some(
        (v) => typeof v !== "string" || unicodeScalarLength(v) > 4096,
      )
    ) {
      throw new WasmError("UNSUPPORTED_TYPE", "invalid field contract");
    }
    const values = f.values as string[];
    if (
      (f.kind === "enum" ? values.length === 0 : values.length !== 0) ||
      new Set(values).size !== values.length ||
      values.some((v, i) => i > 0 && (values[i - 1] ?? "") >= v)
    ) {
      throw new WasmError("UNSUPPORTED_TYPE", "invalid enum values");
    }
    return {
      name: f.name,
      kind: f.kind,
      values,
      nullable: f.nullable,
      undefinable: f.undefinable,
      optional: f.optional,
    };
  });
  if (
    new Set(fields.map((f) => f.name)).size !== fields.length ||
    fields.some((f, i) => i > 0 && (fields[i - 1]?.name ?? "") >= f.name)
  ) {
    throw new WasmError("UNSUPPORTED_TYPE", "fields must be unique and sorted");
  }
  return { version: 1, fields };
}

export function contractSlots(contract: WasmContract): WasmSlot[] {
  return contract.fields.flatMap((f) => {
    const slots: WasmSlot[] = [];
    if (f.nullable || f.undefinable || f.optional || f.kind === "string")
      slots.push({ field: f.name, kind: "state" });
    if (f.kind !== "string") slots.push({ field: f.name, kind: "value" });
    return slots;
  });
}

export function encodeInput(contract: WasmContract, input: unknown): number[] {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  ) {
    throw new WasmError("INVALID_INPUT", "expected a data record");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Object.getOwnPropertySymbols(input).length ||
    Object.entries(descriptors).some(
      ([key, d]) =>
        !contract.fields.some((f) => f.name === key) || !("value" in d),
    )
  ) {
    throw new WasmError("INVALID_INPUT", "unknown field or accessor");
  }
  const result: number[] = [];
  for (const f of contract.fields) {
    const d = Object.getOwnPropertyDescriptor(input, f.name);
    const v: unknown = d?.value;
    if (
      (!d && !f.optional) ||
      (v === undefined && !(f.undefinable || (!d && f.optional))) ||
      (v === null && !f.nullable)
    ) {
      throw new WasmError(
        "INVALID_INPUT",
        `invalid missing/nullish field ${f.name}`,
      );
    }
    const state = v === undefined ? 0 : v === null ? 1 : 2;
    let encoded = 0;
    if (state === 2) {
      if (f.kind === "boolean") {
        if (typeof v !== "boolean")
          throw new WasmError("INVALID_INPUT", `${f.name} must be boolean`);
        encoded = v ? 1 : 0;
      } else {
        if (typeof v !== "string")
          throw new WasmError("INVALID_INPUT", `${f.name} must be string`);
        if (f.kind === "enum") {
          encoded = f.values.indexOf(v);
          if (encoded < 0)
            throw new WasmError("INVALID_INPUT", `unknown enum ${f.name}`);
        }
      }
    }
    if (f.nullable || f.undefinable || f.optional || f.kind === "string")
      result.push(state);
    if (f.kind !== "string") result.push(encoded);
  }
  return result;
}
