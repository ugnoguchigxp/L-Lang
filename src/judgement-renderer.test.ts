import { describe, expect, test } from "bun:test";

import {
  renderInterpretedJudgement,
  renderSemanticTestModule,
} from "./judgement-renderer";

describe("judgement renderer", () => {
  test("renders the interpreted predicate as a readable tree", () => {
    expect(
      renderInterpretedJudgement({
        predicateName: "isActiveCustomer",
        parameterName: "customer",
        expression: {
          kind: "all",
          conditions: [
            { kind: "equals", property: ["status"], value: "active" },
            { kind: "equals", property: ["deletedAt"], value: null },
            { kind: "present", property: ["email"] },
          ],
        },
      }),
    ).toBe(
      [
        "isActiveCustomer(customer)",
        "  ALL",
        '    customer.status EQUALS "active"',
        "    customer.deletedAt EQUALS null",
        "    customer.email IS PRESENT (not null/undefined)",
      ].join("\n"),
    );
  });

  test("renders case names with input, expected, and actual judgement", () => {
    const module = renderSemanticTestModule({
      candidateModuleName: ".candidate",
      predicateName: "isExample",
      acceptSource: '[{ state: "ready" }]',
      rejectSource: '[{ state: "stopped" }]',
    });

    expect(module).toContain("function prettyCase");
    expect(module).toContain("input: input.value");
    expect(module).toContain("expected: input.expected");
    expect(module).toContain("actual: input.actual");
    expect(module).toContain("console.log(");
    expect(module).toContain("const actual = isExample(value)");
    expect(module).toContain('item === undefined ? "<undefined>" : item');
    expect(module).toContain("    2,");
  });
});
