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
      boundarySource:
        '[{ name: "edge", input: { state: "ready" }, expected: "accepted" }]',
      counterfactualSource:
        '[{ name: "transition", base: { input: { state: "ready" }, expected: "accepted" }, variants: [{ name: "stop", input: { state: "stopped" }, expected: "rejected" }] }]',
      invarianceSource:
        '[{ name: "stable", expected: "accepted", inputs: [{ state: "ready" }] }]',
    });

    expect(module).toContain("function prettyCase");
    expect(module).toContain("input: input.value");
    expect(module).toContain("expected: input.expected");
    expect(module).toContain("actual: input.actual");
    expect(module).toContain("console.log(");
    expect(module).toContain("const actual = isExample(value)");
    expect(module).toContain('item === undefined ? "<undefined>" : item');
    expect(module).toContain("    2,");
    expect(module).toContain('"boundary:" + item.name');
    expect(module).toContain('"counterfactual:" + group.name + ":base"');
    expect(module).toContain('"invariance:" + group.name + "[" + index + "]"');
  });
});
