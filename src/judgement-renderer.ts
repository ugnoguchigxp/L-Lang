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

export function renderSemanticTestModule(input: {
  candidateModuleName: string;
  predicateName: string;
  acceptSource: string;
  rejectSource: string;
}): string {
  return [
    'import { describe, expect, test } from "bun:test";',
    `import { ${input.predicateName} } from ${JSON.stringify(`./${input.candidateModuleName}`)};`,
    "",
    `type SemanticInput = Parameters<typeof ${input.predicateName}>[0];`,
    "",
    `const accepted: readonly SemanticInput[] = ${input.acceptSource};`,
    `const rejected: readonly SemanticInput[] = ${input.rejectSource};`,
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
    "function registerCases(",
    '  kind: "accept" | "reject",',
    "  values: readonly SemanticInput[],",
    "  expected: boolean,",
    "): void {",
    "  values.forEach((value, index) => {",
    `    const actual = ${input.predicateName}(value);`,
    "    console.log(",
    "      prettyCase({",
    "        case: `${kind}[${index}]`,",
    "        value,",
    "        expected,",
    "        actual,",
    "      }),",
    "    );",
    "    test(",
    "      `${kind}[${index}] expected=${expected} actual=${actual}`,",
    "      () => {",
    "        expect(actual).toBe(expected);",
    "      },",
    "    );",
    "  });",
    "}",
    "",
    `describe(${JSON.stringify(`${input.predicateName} semantic contract`)}, () => {`,
    '  registerCases("accept", accepted, true);',
    '  registerCases("reject", rejected, false);',
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
