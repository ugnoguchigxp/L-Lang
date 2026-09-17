import {
  parseCanonicalPredicateType,
  type CanonicalPredicateField,
  type CanonicalPredicateType,
  type CanonicalPredicateValue,
} from "./canonical-type-ir";
import type { TypeSchema } from "./semantic-source-type-schema";

export type TypeMappingDiagnosticCode =
  | "TOP_LEVEL_NOT_RECORD"
  | "UNSUPPORTED_FIELD_TYPE"
  | "NESTED_RECORD"
  | "NUMBER_REQUIRES_PROFILE"
  | "ARRAY_REQUIRES_PROFILE"
  | "MIXED_UNION"
  | "EMPTY_VALUE_SET";

export type TypeMappingDiagnostic = {
  code: TypeMappingDiagnosticCode;
  path: string[];
  message: string;
};

export type CanonicalTypeMapping =
  | {
      status: "lossless";
      provider: "typescript";
      type: CanonicalPredicateType;
      diagnostics: [];
    }
  | {
      status: "unsupported";
      provider: "typescript";
      type: null;
      diagnostics: TypeMappingDiagnostic[];
    };

export function mapTypeScriptSchema(schema: TypeSchema): CanonicalTypeMapping {
  if (schema.kind !== "object") {
    return unsupported({
      code: "TOP_LEVEL_NOT_RECORD",
      path: [],
      message: "top-level TypeScript input must be a record",
    });
  }
  const diagnostics: TypeMappingDiagnostic[] = [];
  const fields: CanonicalPredicateField[] = [];
  for (const property of schema.properties) {
    const mapped = mapField(property.name, property.optional, property.type);
    if ("diagnostic" in mapped) diagnostics.push(mapped.diagnostic);
    else fields.push(mapped.field);
  }
  if (diagnostics.length > 0) {
    return {
      status: "unsupported",
      provider: "typescript",
      type: null,
      diagnostics,
    };
  }
  fields.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  try {
    return {
      status: "lossless",
      provider: "typescript",
      type: parseCanonicalPredicateType({ version: 1, kind: "record", fields }),
      diagnostics: [],
    };
  } catch (error) {
    return unsupported({
      code: "UNSUPPORTED_FIELD_TYPE",
      path: [],
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function mapField(
  name: string,
  optional: boolean,
  schema: TypeSchema,
): { field: CanonicalPredicateField } | { diagnostic: TypeMappingDiagnostic } {
  const parts = schema.kind === "union" ? schema.types : [schema];
  const nullable = parts.some((part) => part.kind === "null");
  const undefinable = parts.some((part) => part.kind === "undefined");
  const actual = parts.filter(
    (part) => part.kind !== "null" && part.kind !== "undefined",
  );
  const mapped = mapValue(actual, [name]);
  if ("diagnostic" in mapped) return mapped;
  return {
    field: {
      name,
      presence: optional ? "optional" : "required",
      nullability: nullable ? "nullable" : "non-null",
      undefinedValue: undefinable ? "allowed" : "forbidden",
      value: mapped.value,
    },
  };
}

function mapValue(
  actual: TypeSchema[],
  path: string[],
): { value: CanonicalPredicateValue } | { diagnostic: TypeMappingDiagnostic } {
  if (actual.length === 0) {
    return diagnostic(
      "EMPTY_VALUE_SET",
      path,
      "field has no non-nullish value type",
    );
  }
  if (actual.length === 1 && actual[0]?.kind === "boolean") {
    return { value: { kind: "boolean" } };
  }
  if (
    actual.length === 2 &&
    actual.every(
      (part) => part.kind === "literal" && typeof part.value === "boolean",
    ) &&
    new Set(actual.map((part) => (part.kind === "literal" ? part.value : null)))
      .size === 2
  ) {
    return { value: { kind: "boolean" } };
  }
  if (actual.length === 1 && actual[0]?.kind === "string") {
    return { value: { kind: "open-string", encoding: "utf-8" } };
  }
  if (
    actual.every(
      (part) => part.kind === "literal" && typeof part.value === "string",
    )
  ) {
    const values = actual
      .map((part) => (part.kind === "literal" ? String(part.value) : ""))
      .sort();
    if (new Set(values).size !== values.length) {
      return diagnostic(
        "UNSUPPORTED_FIELD_TYPE",
        path,
        "closed enum values must be unique",
      );
    }
    return { value: { kind: "closed-string-enum", values } };
  }
  const single = actual.length === 1 ? actual[0] : undefined;
  if (
    single?.kind === "number" ||
    (single?.kind === "literal" && typeof single.value === "number")
  ) {
    return diagnostic(
      "NUMBER_REQUIRES_PROFILE",
      path,
      "number requires a profile with explicit numeric semantics",
    );
  }
  if (single?.kind === "array") {
    return diagnostic(
      "ARRAY_REQUIRES_PROFILE",
      path,
      "array requires a profile with collection semantics",
    );
  }
  if (single?.kind === "object") {
    return diagnostic(
      "NESTED_RECORD",
      path,
      "nested records are not supported by predicate-i32-v1",
    );
  }
  return diagnostic(
    actual.length > 1 ? "MIXED_UNION" : "UNSUPPORTED_FIELD_TYPE",
    path,
    "field value type cannot be mapped losslessly",
  );
}

function diagnostic(
  code: TypeMappingDiagnosticCode,
  path: string[],
  message: string,
): { diagnostic: TypeMappingDiagnostic } {
  return { diagnostic: { code, path, message } };
}

function unsupported(
  item: TypeMappingDiagnostic,
): Extract<CanonicalTypeMapping, { status: "unsupported" }> {
  return {
    status: "unsupported",
    provider: "typescript",
    type: null,
    diagnostics: [item],
  };
}
