import type {
  CollectionBody,
  CollectionExpression,
  CollectionModuleSource,
  CollectionStatement,
} from "./llang-module-collection-ir";

function sourceExpression(expression: CollectionExpression): unknown {
  switch (expression.kind) {
    case "literal":
    case "param":
    case "local":
      return expression;
    case "list":
      return {
        ...expression,
        elements: expression.elements.map(sourceExpression),
      };
    case "field":
      return { ...expression, base: sourceExpression(expression.base) };
    case "unary":
      return { ...expression, operand: sourceExpression(expression.operand) };
    case "binary":
      return {
        ...expression,
        left: sourceExpression(expression.left),
        right: sourceExpression(expression.right),
      };
    case "call":
    case "invoke":
    case "intrinsic":
      return {
        ...expression,
        arguments: expression.arguments.map(sourceExpression),
      };
    case "lambda":
      return { ...expression, body: sourceBody(expression.body) };
    case "record":
    case "variant":
      return {
        ...expression,
        fields: expression.fields.map((field) => ({
          name: field.name,
          value: sourceExpression(field.value),
        })),
      };
    case "if":
      return Object.fromEntries([
        ["kind", "if"],
        ["condition", sourceExpression(expression.condition)],
        // biome-ignore lint/suspicious/noThenProperty: The JSONC source grammar names this branch "then".
        ["then", sourceExpression(expression.whenTrue)],
        ["else", sourceExpression(expression.whenFalse)],
      ]);
  }
}

function sourceStatement(statement: CollectionStatement): unknown {
  switch (statement.kind) {
    case "const":
    case "let":
    case "assign":
    case "return":
      return { ...statement, value: sourceExpression(statement.value) };
    case "break":
    case "continue":
      return statement;
    case "while":
      return {
        ...statement,
        condition: sourceExpression(statement.condition),
        body: statement.body.map(sourceStatement),
      };
    case "forEach":
      return {
        ...statement,
        value: sourceExpression(statement.value),
        body: statement.body.map(sourceStatement),
      };
    case "if":
      return Object.fromEntries([
        ["kind", "if"],
        ["condition", sourceExpression(statement.condition)],
        // biome-ignore lint/suspicious/noThenProperty: The JSONC source grammar names this branch "then".
        ["then", statement.whenTrue.map(sourceStatement)],
        ["else", statement.whenFalse.map(sourceStatement)],
      ]);
    case "match":
      return {
        ...statement,
        value: sourceExpression(statement.value),
        cases: statement.cases.map((item) => ({
          tag: item.tag,
          body: item.body.map(sourceStatement),
        })),
      };
  }
}

function sourceBody(body: CollectionBody): unknown {
  return {
    statements: body.statements.map(sourceStatement),
    ...(body.result === undefined
      ? {}
      : { result: sourceExpression(body.result) }),
  };
}

export function collectionModuleSourceJson(
  source: CollectionModuleSource,
  mapImportFrom: (from: string) => string = (from) => from,
): unknown {
  return {
    ...source,
    imports: source.imports.map((item) => ({
      ...item,
      from: mapImportFrom(item.from),
    })),
    functions: source.functions.map((fn) => ({
      ...fn,
      body: sourceBody(fn.body),
    })),
  };
}
