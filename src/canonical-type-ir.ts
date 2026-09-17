import { fingerprintFor } from "./stable-hash";
import { WASM_LIMITS } from "./wasm-contract";

const FIELD_NAME_CHARACTERS = 256;
const ENUM_VALUE_CHARACTERS = 4_096;

export type CanonicalPredicateValue =
  | { kind: "boolean" }
  | { kind: "open-string"; encoding: "utf-8" }
  | { kind: "closed-string-enum"; values: string[] };

export type CanonicalPredicateField = {
  name: string;
  presence: "required" | "optional";
  nullability: "non-null" | "nullable";
  undefinedValue: "forbidden" | "allowed";
  value: CanonicalPredicateValue;
};

export type CanonicalPredicateType = {
  version: 1;
  kind: "record";
  fields: CanonicalPredicateField[];
};

export type CanonicalTypeErrorCode =
  | "INVALID_CANONICAL_TYPE"
  | "NON_CANONICAL_ORDER"
  | "DUPLICATE_FIELD";

export class CanonicalTypeError extends Error {
  override name = "CanonicalTypeError";

  constructor(
    public readonly code: CanonicalTypeErrorCode,
    public readonly path: string,
    message: string,
  ) {
    super(`${code}: ${path}: ${message}`);
  }
}

export function parseCanonicalPredicateType(
  input: unknown,
): CanonicalPredicateType {
  const root = objectValue(input, "type", ["version", "kind", "fields"]);
  if (root.version !== 1 || root.kind !== "record") {
    invalid("type", "expected Canonical Predicate Type version 1 record");
  }
  const rawFields = arrayValues(root.fields, "type.fields");
  if (rawFields.length === 0 || rawFields.length > WASM_LIMITS.fields) {
    invalid("type.fields", `expected 1-${WASM_LIMITS.fields} record fields`);
  }
  const fields = rawFields.map((field, index) =>
    parseField(field, `type.fields[${index}]`),
  );
  const names = fields.map((field) => field.name);
  if (new Set(names).size !== names.length) {
    throw new CanonicalTypeError(
      "DUPLICATE_FIELD",
      "type.fields",
      "field names must be unique",
    );
  }
  assertSorted(names, "type.fields", "field names");
  return { version: 1, kind: "record", fields };
}

export function canonicalTypeHash(input: CanonicalPredicateType): string {
  return fingerprintFor(parseCanonicalPredicateType(input));
}

function parseField(input: unknown, path: string): CanonicalPredicateField {
  const field = objectValue(input, path, [
    "name",
    "presence",
    "nullability",
    "undefinedValue",
    "value",
  ]);
  if (
    typeof field.name !== "string" ||
    !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(field.name) ||
    field.name.length > FIELD_NAME_CHARACTERS
  ) {
    invalid(`${path}.name`, "expected a bounded TypeScript identifier");
  }
  if (field.presence !== "required" && field.presence !== "optional") {
    invalid(`${path}.presence`, "expected required or optional");
  }
  if (field.nullability !== "non-null" && field.nullability !== "nullable") {
    invalid(`${path}.nullability`, "expected non-null or nullable");
  }
  if (
    field.undefinedValue !== "forbidden" &&
    field.undefinedValue !== "allowed"
  ) {
    invalid(`${path}.undefinedValue`, "expected forbidden or allowed");
  }
  return {
    name: field.name,
    presence: field.presence,
    nullability: field.nullability,
    undefinedValue: field.undefinedValue,
    value: parseValue(field.value, `${path}.value`),
  };
}

function parseValue(input: unknown, path: string): CanonicalPredicateValue {
  const base = objectValue(input, path, ["kind", "encoding", "values"]);
  if (base.kind === "boolean") {
    exactKeys(base, path, ["kind"]);
    return { kind: "boolean" };
  }
  if (base.kind === "open-string") {
    exactKeys(base, path, ["kind", "encoding"]);
    if (base.encoding !== "utf-8") {
      invalid(`${path}.encoding`, "expected utf-8");
    }
    return { kind: "open-string", encoding: "utf-8" };
  }
  if (base.kind === "closed-string-enum") {
    exactKeys(base, path, ["kind", "values"]);
    const rawValues = arrayValues(base.values, `${path}.values`);
    if (
      rawValues.length === 0 ||
      rawValues.length > WASM_LIMITS.values ||
      rawValues.some(
        (value) =>
          typeof value !== "string" || value.length > ENUM_VALUE_CHARACTERS,
      )
    ) {
      invalid(
        `${path}.values`,
        `expected 1-${WASM_LIMITS.values} bounded strings`,
      );
    }
    const values = rawValues as string[];
    if (new Set(values).size !== values.length) {
      invalid(`${path}.values`, "enum values must be unique");
    }
    assertSorted(values, `${path}.values`, "enum values");
    return { kind: "closed-string-enum", values: [...values] };
  }
  invalid(`${path}.kind`, "unsupported canonical value kind");
}

function objectValue(
  input: unknown,
  path: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    invalid(path, "expected an object");
  }
  if (Object.getOwnPropertySymbols(input).length > 0) {
    invalid(path, "symbol fields are not supported");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const unknown = Object.keys(descriptors).find(
    (key) => !allowed.includes(key),
  );
  if (unknown !== undefined) invalid(path, `unknown field ${unknown}`);
  const entries = Object.entries(descriptors).map(([key, descriptor]) => {
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      invalid(`${path}.${key}`, "expected an enumerable data field");
    }
    return [key, descriptor.value] as const;
  });
  return Object.fromEntries(entries);
}

function arrayValues(input: unknown, path: string): unknown[] {
  if (!Array.isArray(input)) invalid(path, "expected an array");
  if (Object.getOwnPropertySymbols(input).length > 0) {
    invalid(path, "symbol fields are not supported");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const length = input.length;
  const keys = Object.keys(descriptors).filter((key) => key !== "length");
  if (
    keys.length !== length ||
    keys.some((key, index) => key !== String(index))
  ) {
    invalid(path, "expected a dense array without extra fields");
  }
  return keys.map((key) => {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      invalid(`${path}[${key}]`, "expected an enumerable data item");
    }
    return descriptor.value;
  });
}

function exactKeys(
  value: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) invalid(path, `unknown field ${unknown}`);
}

function assertSorted(
  values: readonly string[],
  path: string,
  label: string,
): void {
  if (
    values.some(
      (value, index) => index > 0 && (values[index - 1] ?? "") >= value,
    )
  ) {
    throw new CanonicalTypeError(
      "NON_CANONICAL_ORDER",
      path,
      `${label} must be strictly sorted`,
    );
  }
}

function invalid(path: string, message: string): never {
  throw new CanonicalTypeError("INVALID_CANONICAL_TYPE", path, message);
}
