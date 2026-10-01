import { describe, expect, test } from "bun:test";
import type { PredicateExpression } from "./ir";
import {
  parsePropertySchema,
  parsePropertyTestConfig,
  replayPropertyTest,
  runPropertyTest,
  type PropertyTestConfig,
} from "./semantic-property-test";
import type { TypeSchema } from "./semantic-source";
import type { SemanticTestPlan } from "./semantic-test-ir";
const schema: TypeSchema = {
  kind: "object",
  properties: [
    { name: "enabled", optional: false, type: { kind: "boolean" } },
    { name: "suspended", optional: false, type: { kind: "boolean" } },
    { name: "noise", optional: true, type: { kind: "string" } },
  ],
};
const expected: PredicateExpression = {
  kind: "all",
  conditions: [
    { kind: "equals", property: ["enabled"], value: true },
    { kind: "equals", property: ["suspended"], value: false },
  ],
};
const defective: PredicateExpression = {
  kind: "equals",
  property: ["enabled"],
  value: true,
};
const config: PropertyTestConfig = {
  version: 1,
  seed: 42,
  cases: 64,
  maxGeneratedNodes: 1024,
  maxShrinkSteps: 100,
  domains: [{ path: ["noise"], values: ["long synthetic value", ""] }],
  expected,
};
const plan: SemanticTestPlan = {
  version: 1,
  contractHash: "a".repeat(64),
  obligations: [
    {
      id: "accept",
      kind: "example",
      sourceClauses: ["requirements[0]"],
      strength: "hard",
      rationale: "enabled and not suspended",
      input: { enabled: true, suspended: false, noise: "x" },
      expected: true,
    },
    {
      id: "reject",
      kind: "example",
      sourceClauses: ["requirements[0]"],
      strength: "hard",
      rationale: "disabled",
      input: { enabled: false, suspended: false },
      expected: false,
    },
  ],
};
const run = (
  expression: PredicateExpression = defective,
  overrides: Partial<Extract<PropertyTestConfig, { version: 1 }>> = {},
) =>
  runPropertyTest({
    schema,
    config: { ...config, ...overrides },
    expression,
    plan,
  });

describe("bounded property testing", () => {
  test("reproduces seeded input sequence and detects/shrinks a known defect", () => {
    const report = run();
    expect(report.status).toBe("failed");
    expect(report.counterexample?.input).toEqual({
      enabled: true,
      suspended: true,
    });
    expect(report.counterexample?.shrinkComplete).toBe(true);
    expect(run()).toEqual(report);
    expect(replayPropertyTest(report)).toEqual(report);
    expect(run(expected).status).toBe("passed");
    expect(run(expected).sequenceHash).toBe(report.sequenceHash);
    expect(run(expected, { seed: 43 }).sequenceHash).not.toBe(
      report.sequenceHash,
    );
    expect(run(expected, { seed: 0 }).status).toBe("passed");
    expect(run(defective, { seed: 0x9e3779b9 }).status).toBe("failed");
  });
  test("preserves a bounded unshrunk counterexample and detects report tampering", () => {
    const report = run(defective, { maxShrinkSteps: 0 });
    expect(report.counterexample?.shrinkComplete).toBe(false);
    expect(report.counterexample?.input).toEqual(
      report.counterexample?.original,
    );
    expect(() =>
      replayPropertyTest({ ...report, sequenceHash: "0".repeat(64) }),
    ).toThrow("replay mismatch");
    expect(() => replayPropertyTest({ ...report, extra: 1 })).toThrow(
      "unknown field",
    );
    const altered = structuredClone(report);
    if (altered.counterexample === null)
      throw new Error("missing counterexample");
    altered.counterexample.actual = !altered.counterexample.actual;
    expect(() => replayPropertyTest(altered)).toThrow("replay mismatch");
  });
  test("rejects contradictory expected expressions, unknown fields, and resource overruns", () => {
    expect(() =>
      run(defective, {
        expected: { kind: "equals", property: ["enabled"], value: false },
      }),
    ).toThrow("contradicts frozen");
    expect(() => run(expected, { maxGeneratedNodes: 1 })).toThrow(
      "generation budget",
    );
    expect(() =>
      parsePropertyTestConfig({ ...config, callback: "eval" }),
    ).toThrow("unknown field");
    expect(() => run(expected, { domains: [] })).toThrow("domain required");
    expect(() =>
      run(expected, {
        domains: [...config.domains, { path: ["missing"], values: [""] }],
      }),
    ).toThrow("does not refer");
    expect(() =>
      run({ kind: "equals", property: ["unknown"], value: true }),
    ).toThrow("unknown field");
  });
  test("rejects cyclic/deep schemas, huge unions, required undefined and malformed domains", () => {
    const cycle: Record<string, unknown> = { kind: "object", properties: [] };
    cycle.properties = [{ name: "self", optional: true, type: cycle }];
    expect(() => parsePropertySchema(cycle)).toThrow("cyclic");
    expect(() =>
      parsePropertySchema({
        kind: "union",
        types: Array.from({ length: 17 }, () => ({ kind: "boolean" })),
      }),
    ).toThrow("union");
    expect(() =>
      runPropertyTest({
        schema: { kind: "undefined" },
        config,
        expression: expected,
        plan,
      }),
    ).toThrow("required undefined");
    expect(() =>
      parsePropertyTestConfig({
        ...config,
        domains: [{ path: ["noise"], values: ["", ""] }],
      }),
    ).toThrow("duplicate");
    expect(() =>
      parsePropertyTestConfig({
        ...config,
        domains: [{ path: ["__proto__"], values: [""] }],
      }),
    ).toThrow("invalid domain path");
  });
  test("supports nested bounded objects and mixed finite scalar domains", () => {
    const nested: TypeSchema = {
      kind: "object",
      properties: [
        ...(schema.kind === "object" ? schema.properties : []),
        {
          name: "nested",
          optional: true,
          type: {
            kind: "object",
            properties: [
              {
                name: "score",
                optional: false,
                type: {
                  kind: "union",
                  types: [{ kind: "string" }, { kind: "number" }],
                },
              },
            ],
          },
        },
      ],
    };
    const report = runPropertyTest({
      schema: nested,
      config: {
        ...config,
        domains: [
          ...config.domains,
          { path: ["nested", "score"], values: ["", 0, -3, 10] },
        ],
      },
      expression: defective,
      plan,
    });
    expect(report.counterexample?.input).toEqual({
      enabled: true,
      suspended: true,
    });
    expect(replayPropertyTest(report)).toEqual(report);
    let deep: TypeSchema = { kind: "boolean" };
    for (let i = 0; i < 5; i++)
      deep = {
        kind: "object",
        properties: [{ name: "nested", optional: false, type: deep }],
      };
    expect(() => parsePropertySchema(deep)).toThrow("budget exceeded");
  });

  test("generates and shrinks nullable/undefined/optional fields within their schema", () => {
    const nullable: TypeSchema = {
      kind: "object",
      properties: [
        { name: "enabled", optional: false, type: { kind: "boolean" } },
        { name: "suspended", optional: false, type: { kind: "boolean" } },
        {
          name: "noise",
          optional: false,
          type: {
            kind: "union",
            types: [
              { kind: "string" },
              { kind: "null" },
              { kind: "undefined" },
            ],
          },
        },
      ],
    };
    const report = runPropertyTest({
      schema: nullable,
      config,
      expression: defective,
      plan,
    });
    expect(report.counterexample?.input).toEqual({
      enabled: true,
      suspended: true,
    });
    expect(replayPropertyTest(report)).toEqual(report);
  });
});

describe("property v2 array and time bounds", () => {
  const v2: PropertyTestConfig = {
    ...config,
    version: 2,
    maxArrayLength: 4,
    timeoutMs: 10000,
    domains: [{ path: ["noise", "*"], values: ["", "synthetic"] }],
  };
  const arrays: TypeSchema = {
    kind: "object",
    properties: [
      { name: "enabled", optional: false, type: { kind: "boolean" } },
      { name: "suspended", optional: false, type: { kind: "boolean" } },
      {
        name: "noise",
        optional: true,
        type: { kind: "array", elementType: { kind: "string" } },
      },
    ],
  };
  test("shrinks array noise to empty while preserving the defect and replays v2", () => {
    const report = runPropertyTest({
      schema: arrays,
      config: v2,
      expression: defective,
      plan,
    });
    expect(report.status).toBe("failed");
    expect(report.counterexample?.input).toEqual({
      enabled: true,
      suspended: true,
    });
    expect(report.generatorVersion).toBe("semantic-property-v2");
    expect(replayPropertyTest(report)).toEqual(report);
    expect(() =>
      runPropertyTest({ schema: arrays, config, expression: defective, plan }),
    ).toThrow("v2");
  });
  test("required arrays retain their type and shrink to empty", () => {
    const required = structuredClone(arrays);
    if (required.kind !== "object") throw new Error("object required");
    const noise = required.properties[2];
    if (noise === undefined) throw new Error("noise required");
    noise.optional = false;
    const report = runPropertyTest({
      schema: required,
      config: v2,
      expression: defective,
      plan,
    });
    expect(report.counterexample?.input).toEqual({
      enabled: true,
      suspended: true,
      noise: [],
    });
    expect(replayPropertyTest(report)).toEqual(report);
    const zero = runPropertyTest({
      schema: required,
      config: { ...v2, maxArrayLength: 0 },
      expression: defective,
      plan,
    });
    expect(zero.counterexample?.input).toEqual({
      enabled: true,
      suspended: true,
      noise: [],
    });
  });
  test("supports nullable arrays and nested objects and rejects ambiguous container unions", () => {
    const nullable = structuredClone(arrays);
    if (nullable.kind !== "object") throw new Error("object required");
    const noise = nullable.properties[2];
    if (noise === undefined) throw new Error("noise required");
    noise.type = {
      kind: "union",
      types: [noise.type, { kind: "null" }, { kind: "undefined" }],
    };
    const report = runPropertyTest({
      schema: nullable,
      config: v2,
      expression: defective,
      plan,
    });
    expect(replayPropertyTest(report)).toEqual(report);
    noise.type = {
      kind: "union",
      types: [
        { kind: "object", properties: [] },
        { kind: "array", elementType: { kind: "boolean" } },
      ],
    };
    expect(() =>
      runPropertyTest({
        schema: nullable,
        config: { ...v2, domains: [] },
        expression: defective,
        plan,
      }),
    ).toThrow("ambiguous");
  });
  test("fails closed on invalid length/time bounds and timeout, without an output report", () => {
    expect(() =>
      parsePropertyTestConfig({ ...v2, maxArrayLength: 17 }),
    ).toThrow("maxArrayLength");
    expect(() => parsePropertyTestConfig({ ...v2, timeoutMs: 0 })).toThrow(
      "timeoutMs",
    );
    // Simulated advancing monotonic clock avoids timing-dependent tests.
    const original = performance.now;
    let tick = 0;
    performance.now = () => tick++ * 10;
    try {
      expect(() =>
        runPropertyTest({
          schema: arrays,
          config: { ...v2, timeoutMs: 1 },
          expression: defective,
          plan,
        }),
      ).toThrow("timeout");
    } finally {
      performance.now = original;
    }
  });
});

test("nullable containers support explicit null equality and nested field presence", () => {
  const schema: TypeSchema = {
    kind: "object",
    properties: [
      {
        name: "noise",
        optional: false,
        type: {
          kind: "union",
          types: [
            { kind: "array", elementType: { kind: "boolean" } },
            { kind: "null" },
          ],
        },
      },
    ],
  };
  const expected: PredicateExpression = {
    kind: "equals",
    property: ["noise"],
    value: null,
  };
  const config: PropertyTestConfig = {
    version: 2,
    seed: 42,
    cases: 64,
    maxGeneratedNodes: 1024,
    maxShrinkSteps: 128,
    maxArrayLength: 4,
    timeoutMs: 10000,
    domains: [],
    expected,
  };
  const plan: SemanticTestPlan = {
    version: 1,
    contractHash: "c".repeat(64),
    obligations: [
      {
        id: "null",
        kind: "example",
        strength: "hard",
        sourceClauses: ["requirements[0]"],
        rationale: "Null is accepted",
        input: { noise: null },
        expected: true,
      },
      {
        id: "array",
        kind: "example",
        strength: "hard",
        sourceClauses: ["requirements[0]"],
        rationale: "Array is rejected",
        input: { noise: [] },
        expected: false,
      },
    ],
  };
  const report = runPropertyTest({
    schema,
    config,
    expression: { kind: "not", condition: expected },
    plan,
  });
  expect(report.status).toBe("failed");
  expect(report.counterexample?.input).toEqual({ noise: null });
  expect(replayPropertyTest(report)).toEqual(report);
});

test("null equality requires a nullable field rather than any object", () => {
  const nested: TypeSchema = {
    kind: "object",
    properties: [
      {
        name: "child",
        optional: false,
        type: { kind: "object", properties: [] },
      },
    ],
  };
  expect(() =>
    runPropertyTest({
      schema: nested,
      config: {
        ...config,
        domains: [],
        expected: { kind: "equals", property: ["child"], value: null },
      },
      expression: { kind: "equals", property: ["child"], value: null },
      plan,
    }),
  ).toThrow("equality literal does not match schema");
});
