import {
  parseCanonicalPredicateType,
  type CanonicalPredicateField,
  type CanonicalPredicateType,
} from "./canonical-type-ir";
import { fingerprintFor } from "./stable-hash";

export const JSON_SCHEMA_DIALECT =
  "https://json-schema.org/draft/2020-12/schema" as const;

export type JsonSchemaProjectionDiagnostic = {
  code: "EXPLICIT_UNDEFINED_NOT_JSON";
  path: string[];
  message: string;
};

export type JsonSchemaProjection = {
  version: 1;
  dialect: typeof JSON_SCHEMA_DIALECT;
  status: "lossless" | "requires-host-adapter";
  schema: Record<string, unknown>;
  diagnostics: JsonSchemaProjectionDiagnostic[];
  hash: string;
};

export function projectCanonicalTypeToJsonSchema(
  input: CanonicalPredicateType,
): JsonSchemaProjection {
  const type = parseCanonicalPredicateType(input);
  const diagnostics = type.fields
    .filter((field) => field.undefinedValue === "allowed")
    .map(
      (field): JsonSchemaProjectionDiagnostic => ({
        code: "EXPLICIT_UNDEFINED_NOT_JSON",
        path: [field.name],
        message: `JSON cannot represent explicit undefined for ${field.name}`,
      }),
    );
  const undefinedFields = diagnostics.map((diagnostic) => diagnostic.path[0]);
  const properties = Object.fromEntries(
    type.fields.map((field) => [field.name, fieldSchema(field)]),
  );
  const schema: Record<string, unknown> = {
    $schema: JSON_SCHEMA_DIALECT,
    type: "object",
    properties,
    required: type.fields
      .filter((field) => field.presence === "required")
      .map((field) => field.name),
    additionalProperties: false,
    "x-l-lang-canonical-type": {
      version: 1,
      undefinedFields,
    },
  };
  const prototypeField = type.fields.find(
    (field) => field.name === "__proto__",
  );
  if (prototypeField !== undefined) {
    schema.patternProperties = {
      "^__proto__$": fieldSchema(prototypeField),
    };
    if (prototypeField.presence === "required") {
      schema.allOf = [
        {
          not: {
            propertyNames: { not: { const: "__proto__" } },
          },
        },
      ];
    }
  }
  const status: JsonSchemaProjection["status"] =
    diagnostics.length === 0 ? "lossless" : "requires-host-adapter";
  const base = {
    version: 1 as const,
    dialect: JSON_SCHEMA_DIALECT,
    status,
    schema,
    diagnostics,
  };
  return { ...base, hash: fingerprintFor(base) };
}

function fieldSchema(field: CanonicalPredicateField): Record<string, unknown> {
  let value: Record<string, unknown>;
  switch (field.value.kind) {
    case "boolean":
      value = { type: "boolean" };
      break;
    case "open-string":
      value = { type: "string" };
      break;
    case "closed-string-enum":
      value = { type: "string", enum: [...field.value.values] };
      break;
  }
  if (field.nullability === "non-null") return value;
  return { anyOf: [value, { type: "null" }] };
}
