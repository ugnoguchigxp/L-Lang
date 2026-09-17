import { describe, expect, test } from "bun:test";

import type { CanonicalPredicateType } from "./canonical-type-ir";
import { projectCanonicalTypeToJsonSchema } from "./canonical-type-json-schema";
import { renderImplementationSpecification } from "./hybrid-specification";

const canonicalType: CanonicalPredicateType = {
  version: 1,
  kind: "record",
  fields: [
    {
      name: "enabled",
      presence: "required",
      nullability: "non-null",
      undefinedValue: "forbidden",
      value: { kind: "boolean" },
    },
    {
      name: "mode",
      presence: "optional",
      nullability: "nullable",
      undefinedValue: "allowed",
      value: { kind: "closed-string-enum", values: ["go", "stop"] },
    },
  ],
};

describe("Hybrid implementation specification", () => {
  test("renders a deterministic type table, decision tree, and limitation", () => {
    const input = {
      functionName: "isEnabled",
      parameterName: "feature",
      canonicalType,
      expression: {
        kind: "all" as const,
        conditions: [
          {
            kind: "equals" as const,
            property: ["enabled"],
            value: true,
          },
          { kind: "present" as const, property: ["mode"] },
        ],
      },
      jsonSchema: projectCanonicalTypeToJsonSchema(canonicalType),
    };
    const first = renderImplementationSpecification(input);
    const second = renderImplementationSpecification(structuredClone(input));
    expect(first).toEqual(second);
    expect(first.content).toContain(
      "# Implementation-derived specification: isEnabled",
    );
    expect(first.content).toContain(
      "| enabled | boolean | required | forbidden | forbidden |",
    );
    expect(first.content).toContain(
      '| mode | enum "go", "stop" | optional | allowed | allowed |',
    );
    expect(first.content).toContain("isEnabled(feature)\n  ALL");
    expect(first.content).toContain("feature.mode IS PRESENT");
    expect(first.content).toContain("does not prove");
    expect(first.content).not.toContain("business intent:");
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
