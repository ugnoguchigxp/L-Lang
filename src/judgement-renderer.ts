import type { PredicateExpression } from "./ir";

export function renderInterpretedJudgement(input: {
  predicateName: string;
  parameterName: string;
  expression: PredicateExpression;
}): string {
  return [
    `${input.predicateName}(${input.parameterName})`,
    ...renderExpression(input.expression, input.parameterName, 1),
  ].join("\n");
}

export function renderInterpretedExpression(input: {
  parameterName: string;
  expression: PredicateExpression;
}): string {
  return renderExpression(input.expression, input.parameterName, 0).join("\n");
}

export function renderSemanticTestModule(input: {
  candidateModuleName: string;
  candidateModuleSpecifier?: string;
  predicateName: string;
  acceptSource: string;
  rejectSource: string;
  boundarySource?: string | null;
  counterfactualSource?: string | null;
  invarianceSource?: string | null;
}): string {
  return [
    'import { describe, expect, test } from "bun:test";',
    `import { ${input.predicateName} } from ${JSON.stringify(input.candidateModuleSpecifier ?? `./${input.candidateModuleName}`)};`,
    "",
    `type SemanticInput = Parameters<typeof ${input.predicateName}>[0];`,
    'type SemanticExpected = "accepted" | "rejected";',
    "type NamedCase = {",
    "  name: string;",
    "  input: SemanticInput;",
    "  expected: SemanticExpected;",
    "};",
    "type CounterfactualCase = {",
    "  name: string;",
    "  base: { input: SemanticInput; expected: SemanticExpected };",
    "  variants: readonly NamedCase[];",
    "};",
    "type InvarianceCase = {",
    "  name: string;",
    "  expected: SemanticExpected;",
    "  inputs: readonly SemanticInput[];",
    "};",
    "",
    `const accepted: readonly SemanticInput[] = ${input.acceptSource};`,
    `const rejected: readonly SemanticInput[] = ${input.rejectSource};`,
    `const boundary: readonly NamedCase[] = ${input.boundarySource ?? "[]"};`,
    `const counterfactual: readonly CounterfactualCase[] = ${input.counterfactualSource ?? "[]"};`,
    `const invariance: readonly InvarianceCase[] = ${input.invarianceSource ?? "[]"};`,
    "",
    "function prettyCase(input: {",
    '  case: string;',
    "  value: SemanticInput;",
    "  expected: boolean;",
    "  actual: boolean;",
    "}): string {",
    "  return JSON.stringify(",
    "    {",
    "      case: input.case,",
    "      input: input.value,",
    "      expected: input.expected,",
    "      actual: input.actual,",
    "    },",
    "    (_key, item: unknown) =>",
    '      item === undefined ? "<undefined>" : item,',
    "    2,",
    "  );",
    "}",
    "",
    "function expectedBoolean(expected: SemanticExpected): boolean {",
    '  return expected === "accepted";',
    "}",
    "",
    "function registerCase(",
    "  caseId: string,",
    "  value: SemanticInput,",
    "  expected: boolean,",
    "): void {",
    `    const actual = ${input.predicateName}(value);`,
    "    console.log(",
    "      prettyCase({",
    "        case: caseId,",
    "        value,",
    "        expected,",
    "        actual,",
    "      }),",
    "    );",
    "    test(",
    '      caseId + " expected=" + expected + " actual=" + actual,',
    "      () => {",
    "        expect(actual).toBe(expected);",
    "      },",
    "    );",
    "}",
    "",
    `describe(${JSON.stringify(`${input.predicateName} semantic contract`)}, () => {`,
    '  accepted.forEach((value, index) => registerCase("accept[" + index + "]", value, true));',
    '  rejected.forEach((value, index) => registerCase("reject[" + index + "]", value, false));',
    "  boundary.forEach((item) =>",
    '    registerCase("boundary:" + item.name, item.input, expectedBoolean(item.expected)),',
    "  );",
    "  counterfactual.forEach((group) => {",
    "    registerCase(",
    '      "counterfactual:" + group.name + ":base",',
    "      group.base.input,",
    "      expectedBoolean(group.base.expected),",
    "    );",
    "    group.variants.forEach((variant) =>",
    "      registerCase(",
    '        "counterfactual:" + group.name + ":" + variant.name,',
    "        variant.input,",
    "        expectedBoolean(variant.expected),",
    "      ),",
    "    );",
    "  });",
    "  invariance.forEach((group) => {",
    "    group.inputs.forEach((value, index) =>",
    "      registerCase(",
    '        "invariance:" + group.name + "[" + index + "]",',
    "        value,",
    "        expectedBoolean(group.expected),",
    "      ),",
    "    );",
    "  });",
    "});",
    "",
  ].join("\n");
}

function renderExpression(
  expression: PredicateExpression,
  parameterName: string,
  depth: number,
): string[] {
  const indentation = "  ".repeat(depth);
  switch (expression.kind) {
    case "all":
    case "any":
      return [
        `${indentation}${expression.kind.toUpperCase()}`,
        ...expression.conditions.flatMap((condition) =>
          renderExpression(condition, parameterName, depth + 1),
        ),
      ];
    case "not":
      return [
        `${indentation}NOT`,
        ...renderExpression(expression.condition, parameterName, depth + 1),
      ];
    case "equals":
      return [
        `${indentation}${renderProperty(parameterName, expression.property)} EQUALS ${JSON.stringify(expression.value)}`,
      ];
    case "present":
      return [
        `${indentation}${renderProperty(parameterName, expression.property)} IS PRESENT (not null/undefined)`,
      ];
  }
}

function renderProperty(parameterName: string, property: string[]): string {
  return [parameterName, ...property].join(".");
}
