import { assertKnownKeys, SEMANTIC_LIMITS } from "./semantic-limits";

export type FieldDescriptor = {
  path: string[];
  type: string;
  optional?: boolean;
  omitWhenNegative?: boolean;
  positive: unknown;
  condition?:
    | { kind: "equals"; value: string | number | boolean | null }
    | { kind: "present" };
  negative?: unknown;
};

export type SchemaDescriptor = {
  typeName: string;
  expectedOutcome: "resolved" | "unresolved";
  fields: FieldDescriptor[];
};

export type SchemaEvolutionConcept = {
  id: string;
  exportName: string;
  displayName: string;
  specification: string;
  baseline: SchemaDescriptor;
  cases: Record<
    | "add-property"
    | "rename"
    | "representation"
    | "optionality"
    | "remove-role"
    | "ambiguity",
    SchemaDescriptor
  >;
};

export type SchemaEvolutionManifest = {
  version: 2;
  name: string;
  trials: 3;
  concepts: SchemaEvolutionConcept[];
  thresholds: {
    minimumConsensusCaseRate: number;
    minimumConsensusQuorumRate: number;
    maximumFalseResolutionRate: number;
    maximumWorkspaceMutationCount: number;
  };
};

const changeTypes = [
  "add-property",
  "rename",
  "representation",
  "optionality",
  "remove-role",
  "ambiguity",
] as const;

export function parseSchemaEvolutionAuthoritativeManifest(
  input: unknown,
): SchemaEvolutionManifest {
  const path = "authoritative schema evolution benchmark";
  const value = recordValue(input, path);
  assertExactKeys(
    value,
    ["version", "name", "trials", "concepts", "thresholds"],
    [],
    path,
  );
  if (value.version !== 2) throw new Error(`${path}.version must be 2`);
  if (value.trials !== 3) throw new Error(`${path}.trials must be 3`);
  if (!Array.isArray(value.concepts) || value.concepts.length > 16) {
    throw new Error(`${path}.concepts must be an array with at most 16 items`);
  }
  const concepts = value.concepts.map((concept, index) =>
    conceptValue(concept, `${path}.concepts[${index}]`),
  );
  unique(
    concepts.map((concept) => concept.id),
    `${path}.concept ids`,
  );
  unique(
    concepts.map((concept) => concept.exportName),
    `${path}.concept export names`,
  );
  return {
    version: 2,
    name: portableId(value.name, `${path}.name`),
    trials: 3,
    concepts,
    thresholds: thresholdsValue(value.thresholds),
  };
}

function conceptValue(input: unknown, path: string): SchemaEvolutionConcept {
  const value = recordValue(input, path);
  assertExactKeys(
    value,
    [
      "id",
      "exportName",
      "displayName",
      "specification",
      "baseline",
      "cases",
    ],
    [],
    path,
  );
  const casesValue = recordValue(value.cases, `${path}.cases`);
  assertExactKeys(casesValue, changeTypes, [], `${path}.cases`);
  return {
    id: portableId(value.id, `${path}.id`),
    exportName: identifier(value.exportName, `${path}.exportName`),
    displayName: boundedString(value.displayName, `${path}.displayName`),
    specification: boundedString(
      value.specification,
      `${path}.specification`,
      32 * 1024,
    ),
    baseline: schemaValue(value.baseline, `${path}.baseline`),
    cases: Object.fromEntries(
      changeTypes.map((change) => [
        change,
        schemaValue(casesValue[change], `${path}.cases.${change}`),
      ]),
    ) as SchemaEvolutionConcept["cases"],
  };
}

function schemaValue(input: unknown, path: string): SchemaDescriptor {
  const value = recordValue(input, path);
  assertExactKeys(value, ["typeName", "expectedOutcome", "fields"], [], path);
  if (
    value.expectedOutcome !== "resolved" &&
    value.expectedOutcome !== "unresolved"
  ) {
    throw new Error(`${path}.expectedOutcome is invalid`);
  }
  if (
    !Array.isArray(value.fields) ||
    value.fields.length < 2 ||
    value.fields.length > 64
  ) {
    throw new Error(`${path}.fields must contain between 2 and 64 items`);
  }
  const fields = value.fields.map((field, index) =>
    fieldValue(field, `${path}.fields[${index}]`),
  );
  unique(
    fields.map((field) => field.path.join(".")),
    `${path}.field paths`,
  );
  return {
    typeName: identifier(value.typeName, `${path}.typeName`),
    expectedOutcome: value.expectedOutcome,
    fields,
  };
}

function fieldValue(input: unknown, path: string): FieldDescriptor {
  const value = recordValue(input, path);
  assertExactKeys(
    value,
    ["path", "type", "positive"],
    ["optional", "omitWhenNegative", "condition", "negative"],
    path,
  );
  if (
    !Array.isArray(value.path) ||
    value.path.length === 0 ||
    value.path.length > SEMANTIC_LIMITS.propertyPathSegments
  ) {
    throw new Error(`${path}.path must be a non-empty bounded array`);
  }
  const propertyPath = value.path.map((part, index) =>
    identifier(part, `${path}.path[${index}]`),
  );
  const optional = optionalBoolean(value.optional, `${path}.optional`);
  const omitWhenNegative = optionalBoolean(
    value.omitWhenNegative,
    `${path}.omitWhenNegative`,
  );
  const condition = value.condition === undefined
    ? undefined
    : conditionValue(value.condition, `${path}.condition`);
  if (condition !== undefined && !("negative" in value)) {
    throw new Error(`${path} condition requires negative`);
  }
  if (omitWhenNegative === true && condition === undefined) {
    throw new Error(`${path}.omitWhenNegative requires condition`);
  }
  const state = { nodes: 0 };
  const positive = jsonValue(value.positive, `${path}.positive`, state, 1);
  const negative = "negative" in value
    ? jsonValue(value.negative, `${path}.negative`, state, 1)
    : undefined;
  return {
    path: propertyPath,
    type: boundedString(value.type, `${path}.type`),
    ...(optional === undefined ? {} : { optional }),
    ...(omitWhenNegative === undefined ? {} : { omitWhenNegative }),
    positive,
    ...(condition === undefined ? {} : { condition }),
    ...("negative" in value ? { negative } : {}),
  };
}

function conditionValue(
  input: unknown,
  path: string,
): NonNullable<FieldDescriptor["condition"]> {
  const value = recordValue(input, path);
  if (value.kind === "present") {
    assertExactKeys(value, ["kind"], [], path);
    return { kind: "present" };
  }
  if (value.kind === "equals") {
    assertExactKeys(value, ["kind", "value"], [], path);
    if (
      value.value !== null &&
      typeof value.value !== "string" &&
      typeof value.value !== "boolean" &&
      !(typeof value.value === "number" && Number.isFinite(value.value))
    ) {
      throw new Error(`${path}.value must be a JSON primitive`);
    }
    return { kind: "equals", value: value.value };
  }
  throw new Error(`${path}.kind must be equals or present`);
}

function thresholdsValue(input: unknown): SchemaEvolutionManifest["thresholds"] {
  const path = "authoritative schema evolution benchmark.thresholds";
  const value = recordValue(input, path);
  assertExactKeys(
    value,
    [
      "minimumConsensusCaseRate",
      "minimumConsensusQuorumRate",
      "maximumFalseResolutionRate",
      "maximumWorkspaceMutationCount",
    ],
    [],
    path,
  );
  return {
    minimumConsensusCaseRate: unitInterval(
      value.minimumConsensusCaseRate,
      `${path}.minimumConsensusCaseRate`,
    ),
    minimumConsensusQuorumRate: unitInterval(
      value.minimumConsensusQuorumRate,
      `${path}.minimumConsensusQuorumRate`,
    ),
    maximumFalseResolutionRate: unitInterval(
      value.maximumFalseResolutionRate,
      `${path}.maximumFalseResolutionRate`,
    ),
    maximumWorkspaceMutationCount: nonNegativeInteger(
      value.maximumWorkspaceMutationCount,
      `${path}.maximumWorkspaceMutationCount`,
    ),
  };
}

function jsonValue(
  input: unknown,
  path: string,
  state: { nodes: number },
  depth: number,
): unknown {
  state.nodes += 1;
  if (state.nodes > 1_024 || depth > 32) {
    throw new Error(`${path} exceeds the JSON value complexity limit`);
  }
  if (
    input === null ||
    typeof input === "boolean" ||
    (typeof input === "number" && Number.isFinite(input))
  ) {
    return input;
  }
  if (typeof input === "string") {
    if (input.length > 32 * 1024) throw new Error(`${path} is too long`);
    return input;
  }
  if (Array.isArray(input)) {
    if (input.length > 256) throw new Error(`${path} contains too many items`);
    return input.map((item, index) =>
      jsonValue(item, `${path}[${index}]`, state, depth + 1),
    );
  }
  const value = recordValue(input, path);
  if (Object.keys(value).length > 256) {
    throw new Error(`${path} contains too many fields`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      jsonValue(item, `${path}.${key}`, state, depth + 1),
    ]),
  );
}

function optionalBoolean(input: unknown, path: string): boolean | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "boolean") throw new Error(`${path} must be a boolean`);
  return input;
}

function unitInterval(input: unknown, path: string): number {
  if (
    typeof input !== "number" ||
    !Number.isFinite(input) ||
    input < 0 ||
    input > 1
  ) {
    throw new Error(`${path} must be a finite number between 0 and 1`);
  }
  return input;
}

function nonNegativeInteger(input: unknown, path: string): number {
  if (!Number.isSafeInteger(input) || Number(input) < 0) {
    throw new Error(`${path} must be a non-negative safe integer`);
  }
  return Number(input);
}

function portableId(input: unknown, path: string): string {
  const value = trimmedString(input, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${path} must be a portable identifier`);
  }
  return value;
}

function identifier(input: unknown, path: string): string {
  const value = trimmedString(input, path);
  if (!/^[$A-Z_a-z][$\w]*$/.test(value)) {
    throw new Error(`${path} must be a TypeScript identifier`);
  }
  return value;
}

function boundedString(
  input: unknown,
  path: string,
  maximum: number = SEMANTIC_LIMITS.diagnosticCharacters,
): string {
  const value = trimmedString(input, path);
  if (value.length > maximum) throw new Error(`${path} is too long`);
  return value;
}

function trimmedString(input: unknown, path: string): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.trim() !== input
  ) {
    throw new Error(`${path} must be a non-empty trimmed string`);
  }
  return input;
}

function unique(values: string[], path: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${path} must be unique`);
  }
}

function recordValue(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${path} must be an object`);
  }
  return input as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  assertKnownKeys(value, [...required, ...optional], path);
  const missing = required.find((key) => !(key in value));
  if (missing !== undefined) throw new Error(`${path} is missing ${missing}`);
}
