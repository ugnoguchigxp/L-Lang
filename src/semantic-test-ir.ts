import {
  normativeClauseIds,
  type SemanticContract,
} from "./semantic-contract";
import { sha256, stableJson } from "./semantic-fingerprint";
import type { TypeSchema } from "./semantic-source";

export const SEMANTIC_TEST_PLAN_VERSION = 1;
export const SEMANTIC_TEST_COMPILER_VERSION = "semantic-test-v1";

const MAX_OBLIGATIONS = 128;
const MAX_VALUE_DEPTH = 8;
const MAX_ARRAY_ITEMS = 128;
const MAX_OBJECT_PROPERTIES = 128;
const MAX_STRING_LENGTH = 4_096;
const MAX_PROPERTY_PATH = 8;

export type SemanticTestValue =
  | null
  | boolean
  | number
  | string
  | SemanticTestValue[]
  | { [key: string]: SemanticTestValue };

export type SemanticTestChange = {
  property: string[];
  value: SemanticTestValue;
};

export type SemanticTestObligationBase = {
  id: string;
  sourceClauses: string[];
  strength: "hard" | "exploratory";
  rationale: string;
};

export type ExampleObligation = SemanticTestObligationBase & {
  kind: "example";
  input: SemanticTestValue;
  expected: boolean;
};

export type CounterfactualObligation = SemanticTestObligationBase & {
  kind: "counterfactual";
  base: SemanticTestValue;
  changes: SemanticTestChange[];
  expectedBefore: boolean;
  expectedAfter: boolean;
};

export type InvarianceObligation = SemanticTestObligationBase & {
  kind: "invariance";
  base: SemanticTestValue;
  changes: SemanticTestChange[];
};

export type SemanticTestObligation =
  | ExampleObligation
  | CounterfactualObligation
  | InvarianceObligation;

export type SemanticTestPlan = {
  version: 1;
  contractHash: string;
  obligations: SemanticTestObligation[];
};

export type ValidatedSemanticTestPlan = {
  plan: SemanticTestPlan;
  testPlanHash: string;
  hardClauseCoverage: number;
};

export function parseSemanticTestPlan(input: unknown): SemanticTestPlan {
  const value = recordValue(input, "testPlan");
  exactKeys(value, ["version", "contractHash", "obligations"], "testPlan");
  if (value.version !== SEMANTIC_TEST_PLAN_VERSION) {
    throw new Error("testPlan.version must be 1");
  }
  const obligations = arrayValue(value.obligations, "testPlan.obligations");
  if (obligations.length === 0 || obligations.length > MAX_OBLIGATIONS) {
    throw new Error(
      `testPlan.obligations must contain 1-${MAX_OBLIGATIONS} items`,
    );
  }
  const parsed = obligations.map((obligation, index) =>
    parseObligation(obligation, `testPlan.obligations[${index}]`),
  );
  const ids = new Set<string>();
  for (const obligation of parsed) {
    if (ids.has(obligation.id)) {
      throw new Error(`duplicate test obligation id: ${obligation.id}`);
    }
    ids.add(obligation.id);
  }
  return {
    version: 1,
    contractHash: hashValue(value.contractHash, "testPlan.contractHash"),
    obligations: parsed,
  };
}

export function validateSemanticTestPlan(
  plan: SemanticTestPlan,
  contract: SemanticContract,
  contractHash: string,
): ValidatedSemanticTestPlan {
  if (plan.contractHash !== contractHash) {
    throw new Error(
      `testPlan.contractHash does not match the current Semantic Contract`,
    );
  }
  const clauses = new Map(
    contract.clauses.map((clause) => [clause.id, clause]),
  );
  const coveredHardClauses = new Set<string>();
  let hasAcceptedHardCase = false;
  let hasRejectedHardCase = false;

  for (const obligation of plan.obligations) {
    for (const clauseId of obligation.sourceClauses) {
      const clause = clauses.get(clauseId);
      if (clause === undefined) {
        throw new Error(
          `test obligation ${obligation.id} references unknown clause ${clauseId}`,
        );
      }
      if (obligation.strength === "hard" && clause.normative) {
        coveredHardClauses.add(clauseId);
      }
    }
    validateObligationValues(obligation, contract.typeSchema);
    if (obligation.strength === "hard") {
      const expected = expectedResults(obligation);
      hasAcceptedHardCase ||= expected.includes(true);
      hasRejectedHardCase ||= expected.includes(false);
    }
  }

  const normative = normativeClauseIds(contract);
  const uncovered = normative.filter(
    (clauseId) => !coveredHardClauses.has(clauseId),
  );
  if (uncovered.length > 0) {
    throw new Error(
      `test plan does not cover hard contract clauses: ${uncovered.join(", ")}`,
    );
  }
  if (!hasAcceptedHardCase || !hasRejectedHardCase) {
    throw new Error(
      "test plan hard obligations must include accepted and rejected expectations",
    );
  }
  const hardClauseCoverage =
    normative.length === 0 ? 1 : coveredHardClauses.size / normative.length;
  return {
    plan,
    testPlanHash: sha256(
      stableJson({
        compilerVersion: SEMANTIC_TEST_COMPILER_VERSION,
        plan,
      }),
    ),
    hardClauseCoverage,
  };
}

export function applySemanticTestChanges(
  base: SemanticTestValue,
  changes: readonly SemanticTestChange[],
): SemanticTestValue {
  const cloned = cloneValue(base);
  for (const change of changes) {
    setProperty(cloned, change.property, cloneValue(change.value));
  }
  return cloned;
}

function parseObligation(
  input: unknown,
  path: string,
): SemanticTestObligation {
  const value = recordValue(input, path);
  const common = parseCommon(value, path);
  switch (value.kind) {
    case "example":
      exactKeys(
        value,
        [
          "id",
          "kind",
          "sourceClauses",
          "strength",
          "rationale",
          "input",
          "expected",
        ],
        path,
      );
      return {
        ...common,
        kind: "example",
        input: testValue(value.input, `${path}.input`, 0),
        expected: booleanValue(value.expected, `${path}.expected`),
      };
    case "counterfactual":
      exactKeys(
        value,
        [
          "id",
          "kind",
          "sourceClauses",
          "strength",
          "rationale",
          "base",
          "changes",
          "expectedBefore",
          "expectedAfter",
        ],
        path,
      );
      return {
        ...common,
        kind: "counterfactual",
        base: testValue(value.base, `${path}.base`, 0),
        changes: changesValue(value.changes, `${path}.changes`),
        expectedBefore: booleanValue(
          value.expectedBefore,
          `${path}.expectedBefore`,
        ),
        expectedAfter: booleanValue(
          value.expectedAfter,
          `${path}.expectedAfter`,
        ),
      };
    case "invariance":
      exactKeys(
        value,
        [
          "id",
          "kind",
          "sourceClauses",
          "strength",
          "rationale",
          "base",
          "changes",
        ],
        path,
      );
      return {
        ...common,
        kind: "invariance",
        base: testValue(value.base, `${path}.base`, 0),
        changes: changesValue(value.changes, `${path}.changes`),
      };
    default:
      throw new Error(
        `${path}.kind must be example, counterfactual, or invariance`,
      );
  }
}

function parseCommon(
  value: Record<string, unknown>,
  path: string,
): SemanticTestObligationBase {
  const strength = value.strength;
  if (strength !== "hard" && strength !== "exploratory") {
    throw new Error(`${path}.strength must be hard or exploratory`);
  }
  const sourceClauses = stringArray(
    value.sourceClauses,
    `${path}.sourceClauses`,
  );
  if (sourceClauses.length === 0) {
    throw new Error(`${path}.sourceClauses must not be empty`);
  }
  return {
    id: identifierValue(value.id, `${path}.id`),
    sourceClauses,
    strength,
    rationale: stringValue(value.rationale, `${path}.rationale`),
  };
}

function changesValue(input: unknown, path: string): SemanticTestChange[] {
  const values = arrayValue(input, path);
  if (values.length === 0 || values.length > 8) {
    throw new Error(`${path} must contain 1-8 changes`);
  }
  return values.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const value = recordValue(item, itemPath);
    exactKeys(value, ["property", "value"], itemPath);
    const property = stringArray(value.property, `${itemPath}.property`);
    if (property.length === 0 || property.length > MAX_PROPERTY_PATH) {
      throw new Error(
        `${itemPath}.property must contain 1-${MAX_PROPERTY_PATH} parts`,
      );
    }
    return {
      property,
      value: testValue(value.value, `${itemPath}.value`, 0),
    };
  });
}

function validateObligationValues(
  obligation: SemanticTestObligation,
  schema: TypeSchema,
): void {
  if (obligation.kind === "example") {
    assertValueMatchesSchema(obligation.input, schema, `${obligation.id}.input`);
    return;
  }
  assertValueMatchesSchema(obligation.base, schema, `${obligation.id}.base`);
  for (const change of obligation.changes) {
    const target = resolveSchemaProperty(schema, change.property);
    if (target === null) {
      throw new Error(
        `${obligation.id}: property ${change.property.join(".")} does not exist`,
      );
    }
    assertValueMatchesSchema(
      change.value,
      target,
      `${obligation.id}.${change.property.join(".")}`,
    );
  }
  const changed = applySemanticTestChanges(obligation.base, obligation.changes);
  assertValueMatchesSchema(changed, schema, `${obligation.id}.changed`);
}

function assertValueMatchesSchema(
  value: SemanticTestValue,
  schema: TypeSchema,
  path: string,
): void {
  if (schema.kind === "union") {
    const matches = schema.types.some((part) => {
      try {
        assertValueMatchesSchema(value, part, path);
        return true;
      } catch {
        return false;
      }
    });
    if (!matches) throw new Error(`${path} does not match its declared union`);
    return;
  }
  switch (schema.kind) {
    case "null":
      if (value !== null) throw new Error(`${path} must be null`);
      return;
    case "undefined":
      throw new Error(`${path} cannot encode undefined in Test IR v1`);
    case "string":
    case "number":
    case "boolean":
      if (typeof value !== schema.kind) {
        throw new Error(`${path} must be ${schema.kind}`);
      }
      return;
    case "literal":
      if (value !== schema.value) {
        throw new Error(`${path} must equal ${JSON.stringify(schema.value)}`);
      }
      return;
    case "array":
      if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
      value.forEach((item, index) => {
        assertValueMatchesSchema(item, schema.elementType, `${path}[${index}]`);
      });
      return;
    case "object": {
      if (!isRecord(value)) throw new Error(`${path} must be an object`);
      const allowed = new Set(
        schema.properties.map((property) => property.name),
      );
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          throw new Error(`${path} contains unknown property ${key}`);
        }
      }
      for (const property of schema.properties) {
        if (!(property.name in value)) {
          if (property.optional || acceptsMissing(property.type)) continue;
          throw new Error(`${path}.${property.name} is required`);
        }
        const propertyValue = value[property.name];
        if (propertyValue === undefined) {
          throw new Error(`${path}.${property.name} must not be undefined`);
        }
        assertValueMatchesSchema(
          propertyValue,
          property.type,
          `${path}.${property.name}`,
        );
      }
      return;
    }
  }
}

function resolveSchemaProperty(
  schema: TypeSchema,
  property: string[],
): TypeSchema | null {
  let current = schema;
  for (const part of property) {
    const object = nonNullishSchema(current);
    if (object === null || object.kind !== "object") return null;
    const next = object.properties.find((candidate) => candidate.name === part);
    if (next === undefined) return null;
    current = next.type;
  }
  return current;
}

function nonNullishSchema(schema: TypeSchema): TypeSchema | null {
  if (schema.kind !== "union") return schema;
  const nonNullish = schema.types.filter(
    (part) => part.kind !== "null" && part.kind !== "undefined",
  );
  return nonNullish.length === 1 ? (nonNullish.at(0) ?? null) : null;
}

function acceptsMissing(schema: TypeSchema): boolean {
  return (
    schema.kind === "undefined" ||
    (schema.kind === "union" && schema.types.some(acceptsMissing))
  );
}

function expectedResults(obligation: SemanticTestObligation): boolean[] {
  switch (obligation.kind) {
    case "example":
      return [obligation.expected];
    case "counterfactual":
      return [obligation.expectedBefore, obligation.expectedAfter];
    case "invariance":
      return [];
  }
}

function setProperty(
  value: SemanticTestValue,
  property: string[],
  replacement: SemanticTestValue,
): void {
  let current = value;
  for (let index = 0; index < property.length - 1; index += 1) {
    const part = property[index];
    if (part === undefined) {
      throw new Error("property path contains an invalid segment");
    }
    if (!isRecord(current) || !(part in current)) {
      throw new Error(`cannot change missing property ${property.join(".")}`);
    }
    const next = current[part];
    if (next === undefined) {
      throw new Error(`cannot change undefined property ${property.join(".")}`);
    }
    current = next;
  }
  const final = property.at(-1);
  if (final === undefined) {
    throw new Error("property path must not be empty");
  }
  if (!isRecord(current)) {
    throw new Error(`cannot change non-object property ${property.join(".")}`);
  }
  current[final] = replacement;
}

function cloneValue(value: SemanticTestValue): SemanticTestValue {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneValue(item)]),
    );
  }
  return value;
}

function testValue(
  input: unknown,
  path: string,
  depth: number,
): SemanticTestValue {
  if (depth > MAX_VALUE_DEPTH) {
    throw new Error(`${path} exceeds maximum value depth ${MAX_VALUE_DEPTH}`);
  }
  if (
    input === null ||
    typeof input === "boolean" ||
    (typeof input === "number" && Number.isFinite(input))
  ) {
    return input;
  }
  if (typeof input === "string") {
    if (input.length > MAX_STRING_LENGTH) {
      throw new Error(`${path} exceeds maximum string length`);
    }
    return input;
  }
  if (Array.isArray(input)) {
    if (input.length > MAX_ARRAY_ITEMS) {
      throw new Error(`${path} exceeds maximum array length`);
    }
    return input.map((item, index) =>
      testValue(item, `${path}[${index}]`, depth + 1),
    );
  }
  const value = recordValue(input, path);
  const entries = Object.entries(value);
  if (entries.length > MAX_OBJECT_PROPERTIES) {
    throw new Error(`${path} exceeds maximum object property count`);
  }
  return Object.fromEntries(
    entries.map(([key, item]) => [
      key,
      testValue(item, `${path}.${key}`, depth + 1),
    ]),
  );
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) {
    throw new Error(`${path} contains unknown field ${unknown}`);
  }
  const missing = allowed.find((key) => !(key in value));
  if (missing !== undefined) {
    throw new Error(`${path} is missing required field ${missing}`);
  }
}

function recordValue(
  input: unknown,
  path: string,
): Record<string, unknown> {
  if (!isRecord(input)) throw new Error(`${path} must be an object`);
  return input;
}

function isRecord(
  input: unknown,
): input is Record<string, SemanticTestValue> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function arrayValue(input: unknown, path: string): unknown[] {
  if (!Array.isArray(input)) throw new Error(`${path} must be an array`);
  return input;
}

function stringArray(input: unknown, path: string): string[] {
  const values = arrayValue(input, path);
  if (!values.every((item) => typeof item === "string")) {
    throw new Error(`${path} must be an array of strings`);
  }
  return values as string[];
}

function stringValue(input: unknown, path: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  if (input.length > MAX_STRING_LENGTH) {
    throw new Error(`${path} exceeds maximum string length`);
  }
  return input;
}

function identifierValue(input: unknown, path: string): string {
  const value = stringValue(input, path);
  if (!/^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/.test(value)) {
    throw new Error(`${path} must be a stable lowercase identifier`);
  }
  return value;
}

function booleanValue(input: unknown, path: string): boolean {
  if (typeof input !== "boolean") throw new Error(`${path} must be boolean`);
  return input;
}

function hashValue(input: unknown, path: string): string {
  const value = stringValue(input, path);
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${path} must be a SHA-256 hash`);
  }
  return value;
}
