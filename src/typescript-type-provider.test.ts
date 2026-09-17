import { describe, expect, test } from "bun:test";

import type { TypeSchema } from "./semantic-source-type-schema";
import {
  mapTypeScriptSchema,
  type TypeMappingDiagnosticCode,
} from "./typescript-type-provider";

describe("TypeScript Canonical Type Provider", () => {
  test("maps the supported subset losslessly and in canonical order", () => {
    const schema: TypeSchema = {
      kind: "object",
      properties: [
        {
          name: "status",
          optional: false,
          type: {
            kind: "union",
            types: [
              { kind: "literal", value: "pending" },
              { kind: "literal", value: "paid" },
            ],
          },
        },
        {
          name: "active",
          optional: false,
          type: {
            kind: "union",
            types: [
              { kind: "literal", value: false },
              { kind: "literal", value: true },
            ],
          },
        },
        {
          name: "note",
          optional: true,
          type: {
            kind: "union",
            types: [
              { kind: "undefined" },
              { kind: "null" },
              { kind: "string" },
            ],
          },
        },
      ],
    };
    expect(mapTypeScriptSchema(schema)).toEqual({
      status: "lossless",
      provider: "typescript",
      diagnostics: [],
      type: {
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
              values: ["paid", "pending"],
            },
          },
        ],
      },
    });
  });

  test("keeps optional and explicit undefined independent", () => {
    const requiredUndefined = mapTypeScriptSchema({
      kind: "object",
      properties: [
        {
          name: "value",
          optional: false,
          type: {
            kind: "union",
            types: [{ kind: "boolean" }, { kind: "undefined" }],
          },
        },
      ],
    });
    expect(requiredUndefined).toHaveProperty(
      "type.fields.0.presence",
      "required",
    );
    expect(requiredUndefined).toHaveProperty(
      "type.fields.0.undefinedValue",
      "allowed",
    );

    const optionalDefined = mapTypeScriptSchema({
      kind: "object",
      properties: [
        {
          name: "value",
          optional: true,
          type: { kind: "boolean" },
        },
      ],
    });
    expect(optionalDefined).toHaveProperty(
      "type.fields.0.presence",
      "optional",
    );
    expect(optionalDefined).toHaveProperty(
      "type.fields.0.undefinedValue",
      "forbidden",
    );
  });

  test("classifies unsupported types without returning a partial type", () => {
    const cases: Array<[TypeSchema, TypeMappingDiagnosticCode]> = [
      [{ kind: "number" }, "TOP_LEVEL_NOT_RECORD"],
      [
        {
          kind: "object",
          properties: [
            { name: "count", optional: false, type: { kind: "number" } },
          ],
        },
        "NUMBER_REQUIRES_PROFILE",
      ],
      [
        {
          kind: "object",
          properties: [
            {
              name: "items",
              optional: false,
              type: { kind: "array", elementType: { kind: "string" } },
            },
          ],
        },
        "ARRAY_REQUIRES_PROFILE",
      ],
      [
        {
          kind: "object",
          properties: [
            {
              name: "child",
              optional: false,
              type: { kind: "object", properties: [] },
            },
          ],
        },
        "NESTED_RECORD",
      ],
      [
        {
          kind: "object",
          properties: [
            {
              name: "mixed",
              optional: false,
              type: {
                kind: "union",
                types: [{ kind: "string" }, { kind: "boolean" }],
              },
            },
          ],
        },
        "MIXED_UNION",
      ],
      [
        {
          kind: "object",
          properties: [
            {
              name: "empty",
              optional: false,
              type: {
                kind: "union",
                types: [{ kind: "null" }, { kind: "undefined" }],
              },
            },
          ],
        },
        "EMPTY_VALUE_SET",
      ],
    ];
    for (const [schema, code] of cases) {
      const result = mapTypeScriptSchema(schema);
      expect(result.status).toBe("unsupported");
      expect(result.type).toBeNull();
      expect(result.diagnostics[0]?.code).toBe(code);
    }
  });
});
