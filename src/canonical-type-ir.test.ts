import { describe, expect, test } from "bun:test";

import {
  canonicalTypeHash,
  CanonicalTypeError,
  parseCanonicalPredicateType,
  type CanonicalPredicateType,
} from "./canonical-type-ir";

const canonical: CanonicalPredicateType = {
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

describe("Canonical Predicate Type IR", () => {
  test("strictly parses and hashes the supported canonical record", () => {
    expect(parseCanonicalPredicateType(canonical)).toEqual(canonical);
    expect(canonicalTypeHash(canonical)).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalTypeHash(structuredClone(canonical))).toBe(
      canonicalTypeHash(canonical),
    );
  });

  test("changes hash for every nullish and value-semantic mutation", () => {
    const mutations: CanonicalPredicateType[] = [
      {
        ...canonical,
        fields: canonical.fields.map((field) =>
          field.name === "active"
            ? { ...field, presence: "optional" as const }
            : field,
        ),
      },
      {
        ...canonical,
        fields: canonical.fields.map((field) =>
          field.name === "active" ? { ...field, name: "activated" } : field,
        ),
      },
      {
        ...canonical,
        fields: canonical.fields.map((field) =>
          field.name === "note"
            ? {
                ...field,
                value: {
                  kind: "closed-string-enum" as const,
                  values: ["internal"],
                },
              }
            : field,
        ),
      },
      {
        ...canonical,
        fields: canonical.fields.map((field) =>
          field.name === "active"
            ? { ...field, nullability: "nullable" as const }
            : field,
        ),
      },
      {
        ...canonical,
        fields: canonical.fields.map((field) =>
          field.name === "active"
            ? { ...field, undefinedValue: "allowed" as const }
            : field,
        ),
      },
      {
        ...canonical,
        fields: canonical.fields.map((field) =>
          field.name === "status"
            ? {
                ...field,
                value: {
                  kind: "closed-string-enum" as const,
                  values: ["active", "pending", "suspended"],
                },
              }
            : field,
        ),
      },
    ];
    for (const mutation of mutations) {
      expect(canonicalTypeHash(mutation)).not.toBe(
        canonicalTypeHash(canonical),
      );
    }
  });

  test("rejects unknown keys, duplicates, invalid values, and non-canonical order", () => {
    const inherited = Object.create(canonical) as unknown;
    const accessor = { ...canonical } as Record<string, unknown>;
    Object.defineProperty(accessor, "version", {
      enumerable: true,
      get: () => {
        throw new Error("canonical parser invoked an accessor");
      },
    });
    const symbolKeyed = { ...canonical, [Symbol("extra")]: true };
    const accessorFields = [...canonical.fields];
    Object.defineProperty(accessorFields, "0", {
      enumerable: true,
      get: () => {
        throw new Error("canonical parser invoked an array accessor");
      },
    });
    const bad: unknown[] = [
      null,
      {},
      inherited,
      accessor,
      symbolKeyed,
      { ...canonical, fields: accessorFields },
      { ...canonical, extra: true },
      { ...canonical, fields: [] },
      {
        ...canonical,
        fields: Array.from({ length: 65 }, (_, index) => ({
          name: `field${index.toString().padStart(3, "0")}`,
          presence: "required",
          nullability: "non-null",
          undefinedValue: "forbidden",
          value: { kind: "boolean" },
        })),
      },
      { ...canonical, fields: [...canonical.fields].reverse() },
      { ...canonical, fields: [canonical.fields[0], canonical.fields[0]] },
      {
        ...canonical,
        fields: canonical.fields.map((field) =>
          field.name === "active" ? { ...field, name: "not-valid!" } : field,
        ),
      },
      {
        ...canonical,
        fields: canonical.fields.map((field) =>
          field.name === "note"
            ? { ...field, value: { kind: "open-string", encoding: "utf-16" } }
            : field,
        ),
      },
      {
        ...canonical,
        fields: canonical.fields.map((field) =>
          field.name === "status"
            ? {
                ...field,
                value: {
                  kind: "closed-string-enum",
                  values: Array.from(
                    { length: 257 },
                    (_, index) => `value${index.toString().padStart(3, "0")}`,
                  ),
                },
              }
            : field,
        ),
      },
      {
        ...canonical,
        fields: canonical.fields.map((field) =>
          field.name === "status"
            ? {
                ...field,
                value: {
                  kind: "closed-string-enum",
                  values: ["suspended", "active"],
                },
              }
            : field,
        ),
      },
      {
        ...canonical,
        fields: canonical.fields.map((field) =>
          field.name === "active"
            ? { ...field, value: { kind: "boolean", values: [] } }
            : field,
        ),
      },
    ];
    for (const value of bad) {
      expect(() => parseCanonicalPredicateType(value)).toThrow(
        CanonicalTypeError,
      );
    }
  });
});
