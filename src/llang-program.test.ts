import { describe, expect, test } from "bun:test";
import { SEMANTIC_LIMITS } from "./semantic-limits";
import { checkLlangProgram } from "./llang-program";

function baseProgram() {
  return {
    language: "l-lang",
    version: 1,
    id: "branch-coverage",
    profile: "predicate-i32-v1",
    description: "Exercises every predicate branch.",
    contract: {
      version: 1,
      fields: [
        {
          name: "enabled",
          kind: "boolean",
          values: [],
          nullable: false,
          undefinable: false,
          optional: false,
        },
        {
          name: "note",
          kind: "string",
          values: [],
          nullable: false,
          undefinable: false,
          optional: true,
        },
        {
          name: "state",
          kind: "enum",
          values: ["active", "paused"],
          nullable: true,
          undefinable: false,
          optional: false,
        },
      ],
    },
    body: {
      kind: "all",
      conditions: [{ kind: "equals", property: ["enabled"], value: true }],
    },
  };
}

function check(program: unknown) {
  return checkLlangProgram(JSON.stringify(program), "program.llang.jsonc");
}

describe("L-Lang Program specification branches", () => {
  test("accepts all, any, not, present and nullable equality", () => {
    const program = baseProgram();
    program.body = {
      kind: "all",
      conditions: [
        {
          kind: "any",
          conditions: [
            { kind: "equals", property: ["state"], value: "active" },
            { kind: "equals", property: ["state"], value: null },
          ],
        },
        {
          kind: "not",
          condition: {
            kind: "equals",
            property: ["enabled"],
            value: false,
          },
        },
        { kind: "present", property: ["note"] },
      ],
    } as typeof program.body;
    expect(check(program).report).toMatchObject({ ok: true, diagnostics: [] });
  });

  test("rejects every top-level structural contract violation", () => {
    const cases: Array<[string, (program: Record<string, unknown>) => void]> = [
      ["unknown", (program) => Object.assign(program, { extra: true })],
      ["missing", (program) => delete program.body],
      ["language", (program) => Object.assign(program, { language: "other" })],
      ["version", (program) => Object.assign(program, { version: 2 })],
      ["id", (program) => Object.assign(program, { id: "bad id" })],
      ["profile", (program) => Object.assign(program, { profile: "other" })],
      [
        "empty description",
        (program) => Object.assign(program, { description: "" }),
      ],
      [
        "long description",
        (program) => Object.assign(program, { description: "x".repeat(4097) }),
      ],
      [
        "contract",
        (program) =>
          Object.assign(program, { contract: { version: 1, fields: [] } }),
      ],
      [
        "body",
        (program) =>
          Object.assign(program, { body: { kind: "all", conditions: [] } }),
      ],
    ];
    for (const [label, mutate] of cases) {
      const program = baseProgram() as unknown as Record<string, unknown>;
      mutate(program);
      const result = check(program);
      expect(result.report.ok, label).toBe(false);
      expect(
        result.report.diagnostics.some((item) => item.code === "LLS001"),
        label,
      ).toBe(true);
    }
  });

  test("rejects profile-level property and literal violations with stable paths", () => {
    const expressions = [
      [
        { kind: "equals", property: ["state", "nested"], value: "active" },
        "LLP001",
        "/body/property",
      ],
      [
        { kind: "equals", property: ["missing"], value: true },
        "LLT001",
        "/body/property/0",
      ],
      [{ kind: "present", property: ["enabled"] }, "LLT001", "/body"],
      [
        { kind: "equals", property: ["state"], value: "missing" },
        "LLT001",
        "/body/value",
      ],
      [
        { kind: "equals", property: ["enabled"], value: null },
        "LLT001",
        "/body/value",
      ],
      [
        { kind: "equals", property: ["note"], value: "text" },
        "LLT001",
        "/body/value",
      ],
    ] as const;
    for (const [body, code, path] of expressions) {
      const program = baseProgram();
      program.body = body as unknown as typeof program.body;
      expect(check(program).report.diagnostics).toContainEqual(
        expect.objectContaining({ code, path }),
      );
    }
  });

  test("enforces predicate fanout and depth through the JSONC entry point", () => {
    const leaf = { kind: "equals", property: ["enabled"], value: true };
    const atFanout = baseProgram();
    atFanout.body = {
      kind: "all",
      conditions: Array.from(
        { length: SEMANTIC_LIMITS.predicateConditions },
        () => structuredClone(leaf),
      ),
    } as typeof atFanout.body;
    expect(check(atFanout).report.ok).toBe(true);

    const overFanout = structuredClone(atFanout);
    overFanout.body.conditions.push(structuredClone(leaf));
    expect(check(overFanout).report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "LLP001", path: "/body" }),
    );

    const nested = (wrappers: number): Record<string, unknown> => {
      let body: Record<string, unknown> = structuredClone(leaf);
      for (let index = 0; index < wrappers; index++)
        body = { kind: "not", condition: body };
      return body;
    };
    const atDepth = baseProgram();
    atDepth.body = nested(
      SEMANTIC_LIMITS.predicateExpressionDepth - 1,
    ) as typeof atDepth.body;
    expect(check(atDepth).report.ok).toBe(true);
    const overDepth = baseProgram();
    overDepth.body = nested(
      SEMANTIC_LIMITS.predicateExpressionDepth,
    ) as typeof overDepth.body;
    expect(check(overDepth).report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "LLP001", path: "/body" }),
    );
  });

  test("counts bounded prose and enum values in Unicode scalar values", () => {
    const program = baseProgram();
    program.description = "😀".repeat(2049);
    const state = program.contract.fields[2];
    if (!state) throw new Error("missing state fixture field");
    state.values = ["😀".repeat(4096)];
    program.body = {
      kind: "equals",
      property: ["state"],
      value: "😀".repeat(4096),
    } as unknown as typeof program.body;
    expect(check(program).report.ok).toBe(true);
    program.description = "😀".repeat(4097);
    expect(check(program).report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "LLS001", path: "/description" }),
    );
  });

  test("root arrays and malformed syntax stop before semantic validation", () => {
    const array = checkLlangProgram("[]", "array.llang.jsonc");
    expect(array.report.diagnostics).toMatchObject([{ code: "LLJ001" }]);
    expect(array.checked).toBeUndefined();
    const malformed = checkLlangProgram('{"language":', "bad.llang.jsonc");
    expect(malformed.report.diagnostics[0]?.code).toBe("LLJ001");
    expect(malformed.checked).toBeUndefined();
  });

  test("points an unknown nested expression key at that key", () => {
    const program = baseProgram();
    program.body = {
      kind: "not",
      condition: {
        kind: "equals",
        property: ["enabled"],
        value: true,
        extra: true,
      },
    } as unknown as typeof program.body;
    expect(check(program).report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "LLS001",
        path: "/body/condition/extra",
      }),
    );
  });
});
