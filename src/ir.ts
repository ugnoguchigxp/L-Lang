import { assertKnownKeys, SEMANTIC_LIMITS } from "./semantic-limits";

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

export class PredicateProfileError extends Error {}
export class PredicateStructureError extends Error {
  constructor(
    message: string,
    public readonly diagnosticPath: (string | number)[],
  ) {
    super(message);
  }
}

const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function parsePredicateDefinition(input: unknown): PredicateDefinition {
  const value = expectRecord(input, "definition");
  assertKnownKeys(
    value,
    ["version", "name", "description", "input", "returns", "body"],
    "definition",
  );

  if (value.version !== 1) {
    throw new Error("definition.version must be 1");
  }

  const definitionInput = expectRecord(value.input, "definition.input");
  assertKnownKeys(
    definitionInput,
    ["parameter", "type", "module"],
    "definition.input",
  );
  const moduleName = expectString(
    definitionInput.module,
    "definition.input.module",
  );

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
  return parseExpression(input, path, { nodes: 0 }, 1, [path]);
}

function parseExpression(
  input: unknown,
  path: string,
  state: { nodes: number },
  depth: number,
  diagnosticPath: (string | number)[],
): PredicateExpression {
  state.nodes += 1;
  if (state.nodes > SEMANTIC_LIMITS.predicateExpressionNodes) {
    throw new PredicateProfileError(
      `${path} exceeds the ${SEMANTIC_LIMITS.predicateExpressionNodes} node limit`,
    );
  }
  if (depth > SEMANTIC_LIMITS.predicateExpressionDepth) {
    throw new PredicateProfileError(
      `${path} exceeds the ${SEMANTIC_LIMITS.predicateExpressionDepth} level depth limit`,
    );
  }

  const value = expectRecord(input, path);
  const kind = expectString(value.kind, `${path}.kind`);

  switch (kind) {
    case "all":
    case "any": {
      assertExpressionKeys(value, ["kind", "conditions"], path, diagnosticPath);
      if (!Array.isArray(value.conditions) || value.conditions.length === 0) {
        throw new Error(`${path}.conditions must be a non-empty array`);
      }
      if (value.conditions.length > SEMANTIC_LIMITS.predicateConditions) {
        throw new PredicateProfileError(
          `${path}.conditions must contain at most ${SEMANTIC_LIMITS.predicateConditions} items`,
        );
      }

      return {
        kind,
        conditions: value.conditions.map((condition, index) =>
          parseExpression(
            condition,
            `${path}.conditions[${index}]`,
            state,
            depth + 1,
            [...diagnosticPath, "conditions", index],
          ),
        ),
      };
    }
    case "not":
      assertExpressionKeys(value, ["kind", "condition"], path, diagnosticPath);
      return {
        kind,
        condition: parseExpression(
          value.condition,
          `${path}.condition`,
          state,
          depth + 1,
          [...diagnosticPath, "condition"],
        ),
      };
    case "equals":
      assertExpressionKeys(
        value,
        ["kind", "property", "value"],
        path,
        diagnosticPath,
      );
      return {
        kind,
        property: expectPropertyPath(value.property, `${path}.property`),
        value: expectLiteral(value.value, `${path}.value`),
      };
    case "present":
      assertExpressionKeys(value, ["kind", "property"], path, diagnosticPath);
      return {
        kind,
        property: expectPropertyPath(value.property, `${path}.property`),
      };
    default:
      throw new Error(`${path}.kind is not supported: ${kind}`);
  }
}

function assertExpressionKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  diagnosticPath: (string | number)[],
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined)
    throw new PredicateStructureError(
      `${path} contains unknown field ${unknown}`,
      [...diagnosticPath, unknown],
    );
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
  if (value.length > SEMANTIC_LIMITS.propertyPathSegments) {
    throw new Error(
      `${path} must contain at most ${SEMANTIC_LIMITS.propertyPathSegments} segments`,
    );
  }

  return value.map((part, index) => {
    const identifier = expectIdentifier(part, `${path}[${index}]`);
    if (identifier.length > SEMANTIC_LIMITS.propertySegmentCharacters) {
      throw new Error(
        `${path}[${index}] must contain at most ${SEMANTIC_LIMITS.propertySegmentCharacters} characters`,
      );
    }
    return identifier;
  });
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
