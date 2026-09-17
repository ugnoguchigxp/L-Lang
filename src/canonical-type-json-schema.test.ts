import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";

import type { CanonicalPredicateType } from "./canonical-type-ir";
import { projectCanonicalTypeToJsonSchema } from "./canonical-type-json-schema";
import { encodeInput } from "./wasm-contract";
import { contractFromCanonicalType } from "./wasm-core";

const type: CanonicalPredicateType = {
  version: 1,
  kind: "record",
  fields: [
    {
      name: "active",
      presence: "required",
      nullability: "non-null",
      undefinedValue: "forbidden",
      value: { kind: "boolean" },
    },
    {
      name: "note",
      presence: "optional",
      nullability: "nullable",
      undefinedValue: "allowed",
      value: { kind: "open-string", encoding: "utf-8" },
    },
    {
      name: "status",
      presence: "required",
      nullability: "non-null",
      undefinedValue: "forbidden",
      value: {
        kind: "closed-string-enum",
        values: ["active", "suspended"],
      },
    },
  ],
};

describe("Canonical Type JSON Schema projection", () => {
  test("projects the JSON-compatible contract and validates it with Ajv", () => {
    const projection = projectCanonicalTypeToJsonSchema(type);
    expect(projection.status).toBe("requires-host-adapter");
    expect(projection.diagnostics).toEqual([
      {
        code: "EXPLICIT_UNDEFINED_NOT_JSON",
        path: ["note"],
        message: "JSON cannot represent explicit undefined for note",
      },
    ]);
    expect(projection.schema).toMatchObject({
      type: "object",
      required: ["active", "status"],
      additionalProperties: false,
      "x-l-lang-canonical-type": {
        version: 1,
        undefinedFields: ["note"],
      },
    });
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(projection.schema);
    const contract = contractFromCanonicalType(type);
    for (const value of [
      { active: true, status: "active" },
      { active: false, status: "suspended", note: null },
      { active: true, status: "active", note: "" },
    ]) {
      expect(validate(value)).toBe(true);
      expect(() => encodeInput(contract, value)).not.toThrow();
    }
    for (const value of [
      { status: "active" },
      { active: true, status: "other" },
      { active: true, status: "active", extra: true },
      { active: true, status: "active", note: 1 },
    ]) {
      expect(validate(value)).toBe(false);
      expect(() => encodeInput(contract, value)).toThrow();
    }

    const explicitUndefined = {
      active: true,
      status: "active",
      note: undefined,
    };
    expect(validate(explicitUndefined)).toBe(true);
    expect(() => encodeInput(contract, explicitUndefined)).not.toThrow();
  });

  test("exposes the required undefined gap across JSON serialization", () => {
    const requiredUndefined: CanonicalPredicateType = {
      ...type,
      fields: type.fields.map((field) =>
        field.name === "note"
          ? { ...field, presence: "required" as const }
          : field,
      ),
    };
    const projection = projectCanonicalTypeToJsonSchema(requiredUndefined);
    const validate = new Ajv2020({ strict: false }).compile(projection.schema);
    const contract = contractFromCanonicalType(requiredUndefined);
    const hostValue = { active: true, note: undefined, status: "active" };
    const jsonValue = JSON.parse(JSON.stringify(hostValue)) as unknown;

    expect(projection.status).toBe("requires-host-adapter");
    expect(validate(hostValue)).toBe(false);
    expect(() => encodeInput(contract, hostValue)).not.toThrow();
    expect(validate(jsonValue)).toBe(false);
    expect(() => encodeInput(contract, jsonValue)).toThrow();
  });

  test("reports lossless only when no explicit undefined value exists", () => {
    const lossless: CanonicalPredicateType = {
      ...type,
      fields: type.fields.map((field) =>
        field.name === "note"
          ? { ...field, undefinedValue: "forbidden" as const }
          : field,
      ),
    };
    const first = projectCanonicalTypeToJsonSchema(lossless);
    const second = projectCanonicalTypeToJsonSchema(structuredClone(lossless));
    expect(first.status).toBe("lossless");
    expect(first.diagnostics).toEqual([]);
    expect(first.hash).toBe(second.hash);
  });

  test("preserves a __proto__ field as schema data", () => {
    const prototypeField: CanonicalPredicateType = {
      version: 1,
      kind: "record",
      fields: [
        {
          name: "__proto__",
          presence: "required",
          nullability: "non-null",
          undefinedValue: "forbidden",
          value: { kind: "boolean" },
        },
      ],
    };
    const projection = projectCanonicalTypeToJsonSchema(prototypeField);
    const properties = projection.schema.properties as Record<string, unknown>;
    const roundTrip = JSON.parse(
      JSON.stringify(projection.schema),
    ) as typeof projection.schema;
    const validate = new Ajv2020({ strict: false }).compile(projection.schema);

    expect(Object.hasOwn(properties, "__proto__")).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(properties, "__proto__")?.value,
    ).toEqual({ type: "boolean" });
    expect(roundTrip).toHaveProperty("properties.__proto__.type", "boolean");
    expect(validate(JSON.parse('{"__proto__":true}'))).toBe(true);
    expect(validate(JSON.parse('{"__proto__":"true"}'))).toBe(false);
    expect(validate({})).toBe(false);
  });
});
