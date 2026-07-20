export type Literal = string | number | boolean | null;

export type PredicateExpression =
  | {
      kind: "all" | "any";
      conditions: PredicateExpression[];
    }
  | {
      kind: "not";
      condition: PredicateExpression;
    }
  | {
      kind: "equals";
      property: string[];
      value: Literal;
    }
  | {
      kind: "present";
      property: string[];
    };

export type PredicateDefinition = {
  version: 1;
  name: string;
  description: string;
  input: {
    parameter: string;
    type: string;
    module: string;
  };
  returns: "boolean";
  body: PredicateExpression;
};

const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function parsePredicateDefinition(input: unknown): PredicateDefinition {
  const value = expectRecord(input, "definition");

  if (value.version !== 1) {
    throw new Error("definition.version must be 1");
  }

  const definitionInput = expectRecord(value.input, "definition.input");
  const moduleName = expectString(definitionInput.module, "definition.input.module");

  if (!moduleName.startsWith("./") && !moduleName.startsWith("../")) {
    throw new Error("definition.input.module must be a relative module path");
  }

  if (value.returns !== "boolean") {
    throw new Error('definition.returns must be "boolean"');
  }

  return {
    version: 1,
    name: expectIdentifier(value.name, "definition.name"),
    description: expectString(value.description, "definition.description"),
    input: {
      parameter: expectIdentifier(
        definitionInput.parameter,
        "definition.input.parameter",
      ),
      type: expectIdentifier(definitionInput.type, "definition.input.type"),
      module: moduleName,
    },
    returns: "boolean",
    body: parsePredicateExpression(value.body, "definition.body"),
  };
}

export function parsePredicateExpression(
  input: unknown,
  path = "expression",
): PredicateExpression {
  const value = expectRecord(input, path);
  const kind = expectString(value.kind, `${path}.kind`);

  switch (kind) {
    case "all":
    case "any": {
      if (!Array.isArray(value.conditions) || value.conditions.length === 0) {
        throw new Error(`${path}.conditions must be a non-empty array`);
      }

      return {
        kind,
        conditions: value.conditions.map((condition, index) =>
          parsePredicateExpression(condition, `${path}.conditions[${index}]`),
        ),
      };
    }
    case "not":
      return {
        kind,
        condition: parsePredicateExpression(value.condition, `${path}.condition`),
      };
    case "equals":
      return {
        kind,
        property: expectPropertyPath(value.property, `${path}.property`),
        value: expectLiteral(value.value, `${path}.value`),
      };
    case "present":
      return {
        kind,
        property: expectPropertyPath(value.property, `${path}.property`),
      };
    default:
      throw new Error(`${path}.kind is not supported: ${kind}`);
  }
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }

  return value as Record<string, unknown>;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }

  return value;
}

function expectIdentifier(value: unknown, path: string): string {
  const identifier = expectString(value, path);

  if (!identifierPattern.test(identifier)) {
    throw new Error(`${path} must be a valid TypeScript identifier`);
  }

  return identifier;
}

function expectPropertyPath(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must be a non-empty array`);
  }

  return value.map((part, index) =>
    expectIdentifier(part, `${path}[${index}]`),
  );
}

function expectLiteral(value: unknown, path: string): Literal {
  if (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean"
  ) {
    return value;
  }

  throw new Error(`${path} must be a JSON primitive`);
}
