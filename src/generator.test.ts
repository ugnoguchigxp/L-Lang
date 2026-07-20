import { describe, expect, test } from "bun:test";

import { generatePredicate } from "./generator";
import { parsePredicateDefinition } from "./ir";

describe("predicate generator", () => {
  test("generates deterministic TypeScript from validated IR", () => {
    const definition = parsePredicateDefinition({
      version: 1,
      name: "isEnabled",
      description: "利用可能なアカウント",
      input: {
        parameter: "account",
        type: "Account",
        module: "./model",
      },
      returns: "boolean",
      body: {
        kind: "equals",
        property: ["enabled"],
        value: true,
      },
    });

    expect(generatePredicate(definition)).toContain(
      "account.enabled === true",
    );
  });

  test("rejects an unsupported expression before generation", () => {
    expect(() =>
      parsePredicateDefinition({
        version: 1,
        name: "unsafe",
        description: "unsupported",
        input: {
          parameter: "value",
          type: "Value",
          module: "./model",
        },
        returns: "boolean",
        body: {
          kind: "call",
          function: "doAnything",
        },
      }),
    ).toThrow("is not supported");
  });

  test("preserves grouping for nested boolean expressions", () => {
    const definition = parsePredicateDefinition({
      version: 1,
      name: "matches",
      description: "nested boolean expression",
      input: {
        parameter: "value",
        type: "Value",
        module: "./model",
      },
      returns: "boolean",
      body: {
        kind: "all",
        conditions: [
          {
            kind: "any",
            conditions: [
              { kind: "equals", property: ["a"], value: true },
              { kind: "equals", property: ["b"], value: true },
            ],
          },
          { kind: "equals", property: ["c"], value: true },
        ],
      },
    });

    const generated = generatePredicate(definition);

    expect(generated).toContain(
      "value.a === true ||\n      value.b === true\n    ) &&",
    );
  });
});
