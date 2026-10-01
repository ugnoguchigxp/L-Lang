import { parsePredicateExpression, type PredicateExpression } from "./ir";
import { sha256, stableJson } from "./semantic-fingerprint";
import type { TypeSchema } from "./semantic-source";
import {
  evaluatePredicateExpression,
  evaluateSemanticTestPlan,
} from "./semantic-test-generator";
import type { SemanticTestPlan, SemanticTestValue } from "./semantic-test-ir";
import {
  extensionInteger,
  extensionKeys,
  extensionRecord,
} from "./semantic-tdd-extension-contract";

export const PROPERTY_GENERATOR_VERSION = "semantic-property-v1";
export const PROPERTY_GENERATOR_VERSION_V2 = "semantic-property-v2";
type Scalar = string | number | boolean | null;
type PropertyTestConfigBase = {
  seed: number;
  cases: number;
  maxGeneratedNodes: number;
  maxShrinkSteps: number;
  domains: { path: string[]; values: (string | number)[] }[];
  expected: PredicateExpression;
};
export type PropertyTestConfig = PropertyTestConfigBase &
  ({ version: 1 } | { version: 2; maxArrayLength: number; timeoutMs: number });
export type PropertyTestReport = {
  version: 1;
  generatorVersion:
    | typeof PROPERTY_GENERATOR_VERSION
    | typeof PROPERTY_GENERATOR_VERSION_V2;
  schema: TypeSchema;
  config: PropertyTestConfig;
  expression: PredicateExpression;
  plan: SemanticTestPlan;
  inputHash: string;
  sequenceHash: string;
  status: "passed" | "failed";
  checked: number;
  counterexample: null | {
    index: number;
    original: SemanticTestValue;
    input: SemanticTestValue;
    expected: boolean;
    actual: boolean;
    shrinkSteps: number;
    shrinkComplete: boolean;
  };
};

export function parsePropertyTestConfig(input: unknown): PropertyTestConfig {
  const v = extensionRecord(input, "propertyTest");
  extensionKeys(
    v,
    [
      "version",
      "seed",
      "cases",
      "maxGeneratedNodes",
      "maxShrinkSteps",
      "domains",
      "expected",
      ...(v.version === 2 ? ["maxArrayLength", "timeoutMs"] : []),
    ],
    "propertyTest",
  );
  if (v.version !== 1 && v.version !== 2)
    throw new Error("propertyTest.version must be 1 or 2");
  if (!Array.isArray(v.domains) || v.domains.length > 32)
    throw new Error("propertyTest.domains must contain at most 32 entries");
  const domains = v.domains.map((input, i) => {
    const d = extensionRecord(input, `domain ${i}`);
    extensionKeys(d, ["path", "values"], "domain");
    if (
      !Array.isArray(d.path) ||
      d.path.length > 3 ||
      !d.path.every(
        (k) =>
          typeof k === "string" &&
          k.length > 0 &&
          k.length <= 128 &&
          !["__proto__", "constructor", "prototype"].includes(k),
      )
    )
      throw new Error("invalid domain path");
    if (
      !Array.isArray(d.values) ||
      d.values.length < 1 ||
      d.values.length > 16 ||
      !d.values.every(
        (x) =>
          (typeof x === "string" && x.length <= 128) ||
          (typeof x === "number" && Number.isFinite(x)),
      )
    )
      throw new Error("invalid finite domain values");
    if (new Set(d.values.map(stableJson)).size !== d.values.length)
      throw new Error("duplicate domain value");
    return {
      path: d.path as string[],
      values: d.values as (string | number)[],
    };
  });
  if (new Set(domains.map((d) => stableJson(d.path))).size !== domains.length)
    throw new Error("duplicate domain path");
  return {
    ...(v.version === 2
      ? {
          version: 2 as const,
          maxArrayLength: extensionInteger(
            v.maxArrayLength,
            0,
            16,
            "maxArrayLength",
          ),
          timeoutMs: extensionInteger(v.timeoutMs, 1, 120000, "timeoutMs"),
        }
      : { version: 1 as const }),
    seed: extensionInteger(v.seed, 0, 0xffff_ffff, "seed"),
    cases: extensionInteger(v.cases, 1, 1024, "cases"),
    maxGeneratedNodes: extensionInteger(
      v.maxGeneratedNodes,
      1,
      131072,
      "maxGeneratedNodes",
    ),
    maxShrinkSteps: extensionInteger(
      v.maxShrinkSteps,
      0,
      4096,
      "maxShrinkSteps",
    ),
    domains,
    expected: parsePredicateExpression(v.expected, "propertyTest.expected"),
  };
}

export function parsePropertySchema(input: unknown): TypeSchema {
  let nodes = 0;
  const ancestors = new Set<object>();
  function parse(input: unknown, depth: number): TypeSchema {
    if (++nodes > 128 || depth > 3)
      throw new Error("property schema budget exceeded");
    const v = extensionRecord(input, "property schema");
    if (ancestors.has(v)) throw new Error("cyclic property schema");
    ancestors.add(v);
    try {
      switch (v.kind) {
        case "boolean":
        case "string":
        case "number":
        case "null":
        case "undefined":
          extensionKeys(v, ["kind"], "schema");
          return { kind: v.kind };
        case "literal":
          extensionKeys(v, ["kind", "value"], "schema");
          if (
            !(
              typeof v.value === "boolean" ||
              (typeof v.value === "number" && Number.isFinite(v.value)) ||
              (typeof v.value === "string" && v.value.length <= 128)
            )
          )
            throw new Error("invalid schema literal");
          return { kind: "literal", value: v.value };
        case "union":
          extensionKeys(v, ["kind", "types"], "schema");
          if (
            !Array.isArray(v.types) ||
            v.types.length < 1 ||
            v.types.length > 16
          )
            throw new Error("invalid property union");
          return { kind: "union", types: v.types.map((t) => parse(t, depth)) };
        case "array":
          extensionKeys(v, ["kind", "elementType"], "schema");
          return {
            kind: "array",
            elementType: parse(v.elementType, depth + 1),
          };
        case "object": {
          extensionKeys(v, ["kind", "properties"], "schema");
          if (!Array.isArray(v.properties) || v.properties.length > 32)
            throw new Error("invalid property object");
          const properties = v.properties.map((p) => {
            const item = extensionRecord(p, "schema property");
            extensionKeys(
              item,
              ["name", "optional", "type"],
              "schema property",
            );
            if (
              typeof item.name !== "string" ||
              item.name.length < 1 ||
              item.name.length > 128 ||
              ["__proto__", "constructor", "prototype"].includes(item.name) ||
              typeof item.optional !== "boolean"
            )
              throw new Error("invalid schema property");
            return {
              name: item.name,
              optional: item.optional,
              type: parse(item.type, depth + 1),
            };
          });
          if (new Set(properties.map((p) => p.name)).size !== properties.length)
            throw new Error("duplicate schema property");
          return { kind: "object", properties };
        }
        default:
          throw new Error(`unsupported property schema: ${String(v.kind)}`);
      }
    } finally {
      ancestors.delete(v);
    }
  }
  return parse(input, 0);
}

const missing = Symbol("missing");
type DomainValue = Scalar | typeof missing;
function leafDomain(
  schema: TypeSchema,
  path: string[],
  config: PropertyTestConfig,
  allowMissing: boolean,
): DomainValue[] {
  let values: DomainValue[];
  switch (schema.kind) {
    case "boolean":
      values = [false, true];
      break;
    case "null":
      values = [null];
      break;
    case "undefined":
      if (!allowMissing) throw new Error("required undefined is unsupported");
      values = [missing];
      break;
    case "literal":
      values = [schema.value];
      break;
    case "string":
    case "number": {
      const domain = config.domains.find(
        (d) => stableJson(d.path) === stableJson(path),
      );
      const typedValues = domain?.values.filter(
        (v) => typeof v === schema.kind,
      );
      if (typedValues === undefined || typedValues.length === 0)
        throw new Error(
          `explicit ${schema.kind} domain required for ${path.join(".")}`,
        );
      values = typedValues;
      break;
    }
    case "union":
      if (
        schema.types.some(
          (t) =>
            t.kind === "object" || t.kind === "array" || t.kind === "union",
        )
      )
        throw new Error("property union supports scalar members only");
      values = schema.types.flatMap((t) =>
        leafDomain(t, path, config, allowMissing),
      );
      break;
    default:
      throw new Error("unsupported property leaf");
  }
  if (allowMissing) values = [missing, ...values];
  const unique = new Map<string, DomainValue>(
    values.map((v) => [v === missing ? "missing" : stableJson(v), v]),
  );
  return [...unique.values()].sort(
    (a, b) =>
      scalarRank(a) - scalarRank(b) ||
      compare(
        a === missing ? "" : stableJson(a),
        b === missing ? "" : stableJson(b),
      ),
  );
}
function scalarRank(v: DomainValue): number {
  if (v === missing) return -1;
  if (v === null) return 0;
  if (typeof v === "boolean") return v ? 2 : 1;
  if (typeof v === "number") return 3 + Math.min(Math.abs(v), 1_000_000);
  return 1_000_004 + v.length;
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function validateDomains(schema: TypeSchema, config: PropertyTestConfig): void {
  const consumed = new Set<string>();
  function walk(s: TypeSchema, path: string[], optional: boolean): void {
    if (
      s.kind === "union" &&
      s.types.some((t) => t.kind === "object" || t.kind === "array")
    ) {
      if (config.version !== 2)
        throw new Error("container unions require property config v2");
      const containers = s.types.filter(
        (t) => t.kind === "object" || t.kind === "array",
      );
      if (
        containers.length !== 1 ||
        s.types.some(
          (t) => !["object", "array", "null", "undefined"].includes(t.kind),
        )
      )
        throw new Error("ambiguous container union");
      if (!optional && allowsUndefined(s))
        throw new Error("required undefined is unsupported");
      for (const member of s.types)
        if (member.kind !== "undefined") walk(member, path, false);
    } else if (s.kind === "object") {
      for (const p of s.properties)
        walk(p.type, [...path, p.name], p.optional || allowsUndefined(p.type));
    } else if (s.kind === "array") {
      if (config.version !== 2)
        throw new Error("arrays require property config v2");
      walk(s.elementType, [...path, "*"], false);
    } else {
      leafDomain(s, path, config, optional);
      if (
        s.kind === "string" ||
        s.kind === "number" ||
        (s.kind === "union" &&
          s.types.some((t) => t.kind === "string" || t.kind === "number"))
      )
        consumed.add(stableJson(path));
    }
  }
  walk(schema, [], false);
  for (const d of config.domains)
    if (!consumed.has(stableJson(d.path)))
      throw new Error("domain does not refer to a string/number field");
}

export function runPropertyTest(input: {
  schema: TypeSchema;
  config: PropertyTestConfig;
  expression: PredicateExpression;
  plan: SemanticTestPlan;
}): PropertyTestReport {
  const deadline =
    input.config.version === 2
      ? performance.now() + input.config.timeoutMs
      : Infinity;
  const checkTime = () => {
    if (performance.now() > deadline)
      throw new Error("property timeout exceeded");
  };
  const schema = parsePropertySchema(input.schema);
  const config = parsePropertyTestConfig(input.config);
  const expression = parsePredicateExpression(input.expression);
  const plan = parsePlan(input.plan);
  validateDomains(schema, config);
  validatePropertyExpression(schema, config.expected, config, true);
  validatePropertyExpression(schema, expression, config, false);
  // All frozen expectations, including exploratory cases, must agree before sampling.
  const expectedPlan = evaluateSemanticTestPlan(plan, (value) =>
    evaluatePredicateExpression(config.expected, value),
  );
  if (!expectedPlan.passed)
    throw new Error(
      "property expected expression contradicts frozen Test Plan",
    );
  checkTime();
  let state = (config.seed ^ 0x9e3779b9) >>> 0 || 0x9e3779b9;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  let nodes = 0;
  function generate(
    s: TypeSchema,
    path: string[],
    optional: boolean,
  ): SemanticTestValue | typeof missing {
    checkTime();
    if (++nodes > config.maxGeneratedNodes)
      throw new Error("property generation budget exceeded");
    if (
      s.kind === "union" &&
      s.types.some((t) => t.kind === "object" || t.kind === "array")
    ) {
      if (optional && random() % 2 === 0) return missing;
      const members = s.types.filter((t) => t.kind !== "undefined");
      const member = members[random() % members.length];
      if (member === undefined) throw new Error("empty container union");
      return generate(member, path, false);
    }
    if (s.kind === "array") {
      if (config.version !== 2)
        throw new Error("arrays require property config v2");
      if (optional && random() % 2 === 0) return missing;
      const length = random() % (config.maxArrayLength + 1);
      return Array.from({ length }, () => {
        const item = generate(s.elementType, [...path, "*"], false);
        if (item === missing)
          throw new Error("undefined array element is unsupported");
        return item;
      });
    }
    if (s.kind === "object") {
      if (optional && random() % 2 === 0) return missing;
      const value: Record<string, SemanticTestValue> = {};
      for (const p of s.properties) {
        const child = generate(
          p.type,
          [...path, p.name],
          p.optional || allowsUndefined(p.type),
        );
        if (child !== missing) value[p.name] = child;
      }
      return value;
    }
    const values = leafDomain(s, path, config, optional);
    const value = values[random() % values.length];
    if (value === undefined) throw new Error("empty generator domain");
    return value;
  }
  const sequence: SemanticTestValue[] = [];
  for (let i = 0; i < config.cases; i++) {
    const value = generate(schema, [], false);
    if (value === missing) throw new Error("missing root input");
    sequence.push(value);
  }
  const normalized = { schema, config, expression, plan };
  const generatorVersion: PropertyTestReport["generatorVersion"] =
    config.version === 2
      ? PROPERTY_GENERATOR_VERSION_V2
      : PROPERTY_GENERATOR_VERSION;
  const base = {
    version: 1 as const,
    generatorVersion,
    ...normalized,
    inputHash: sha256(stableJson(normalized)),
    sequenceHash: sha256(stableJson(sequence)),
  };
  const fails = (value: SemanticTestValue) =>
    evaluatePredicateExpression(config.expected, value) !==
    evaluatePredicateExpression(expression, value);
  for (const [index, original] of sequence.entries()) {
    checkTime();
    if (!fails(original)) continue;
    let value = original;
    let shrinkSteps = 0;
    let shrinkComplete = false;
    while (shrinkSteps < config.maxShrinkSteps) {
      let changed = false;
      const next = shrinkCandidates(schema, value, [], config);
      let sawCandidate = false;
      for (const candidate of next) {
        sawCandidate = true;
        checkTime();
        if (shrinkSteps >= config.maxShrinkSteps) break;
        shrinkSteps++;
        if (fails(candidate)) {
          value = candidate;
          changed = true;
          break;
        }
      }
      if (!changed) {
        shrinkComplete = shrinkSteps < config.maxShrinkSteps || !sawCandidate;
        break;
      }
    }
    return {
      ...base,
      status: "failed",
      checked: index + 1,
      counterexample: {
        index,
        original,
        input: value,
        expected: evaluatePredicateExpression(config.expected, value),
        actual: evaluatePredicateExpression(expression, value),
        shrinkSteps,
        shrinkComplete,
      },
    };
  }
  return {
    ...base,
    status: "passed",
    checked: config.cases,
    counterexample: null,
  };
}

function* shrinkCandidates(
  schema: TypeSchema,
  value: SemanticTestValue,
  path: string[],
  config: PropertyTestConfig,
): Generator<SemanticTestValue> {
  if (
    schema.kind === "union" &&
    schema.types.some((t) => t.kind === "object" || t.kind === "array")
  ) {
    if (value === null) return;
    if (schema.types.some((t) => t.kind === "null")) yield null;
    const container = schema.types.find(
      (t) => t.kind === "object" || t.kind === "array",
    );
    if (container === undefined) throw new Error("missing container schema");
    yield* shrinkCandidates(container, value, path, config);
    return;
  }
  if (schema.kind === "array") {
    if (!Array.isArray(value)) throw new Error("invalid generated array");
    if (value.length > 0) yield [];
    for (let i = 0; i < value.length; i++) {
      if (value.length > 1) yield [...value.slice(0, i), ...value.slice(i + 1)];
      const child = value[i];
      if (child === undefined)
        throw new Error("invalid generated array element");
      for (const smaller of shrinkCandidates(
        schema.elementType,
        child,
        [...path, "*"],
        config,
      )) {
        const next = [...value];
        next[i] = smaller;
        yield next;
      }
    }
    return;
  }
  if (schema.kind !== "object") {
    const domain = leafDomain(schema, path, config, true).filter(
      (v) => v !== missing,
    );
    const index = domain.findIndex((v) => stableJson(v) === stableJson(value));
    yield* domain.slice(0, Math.max(index, 0));
    return;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid generated object");

  for (const p of schema.properties) {
    if (!Object.hasOwn(value, p.name)) continue;
    if (p.optional || allowsUndefined(p.type)) {
      const removed = structuredClone(value);
      delete removed[p.name];
      yield removed;
    }
    const child = value[p.name];
    if (child === undefined) throw new Error("invalid generated child");
    for (const smaller of shrinkCandidates(
      p.type,
      child,
      [...path, p.name],
      config,
    ))
      yield { ...value, [p.name]: smaller };
  }
}

export function replayPropertyTest(input: unknown): PropertyTestReport {
  const v = extensionRecord(input, "property report");
  extensionKeys(
    v,
    [
      "version",
      "generatorVersion",
      "schema",
      "config",
      "expression",
      "plan",
      "inputHash",
      "sequenceHash",
      "status",
      "checked",
      "counterexample",
    ],
    "property report",
  );
  if (
    v.version !== 1 ||
    ![PROPERTY_GENERATOR_VERSION, PROPERTY_GENERATOR_VERSION_V2].includes(
      v.generatorVersion as string,
    )
  )
    throw new Error("unsupported property report version");
  const report = runPropertyTest({
    schema: parsePropertySchema(v.schema),
    config: parsePropertyTestConfig(v.config),
    expression: parsePredicateExpression(v.expression),
    plan: parsePlan(v.plan),
  });
  if (stableJson(report) !== stableJson(v))
    throw new Error("property replay mismatch");
  return report;
}

// Reuse strict Test IR parsing without permitting executable callbacks in snapshots.
import { parseSemanticTestPlan as parsePlan } from "./semantic-test-ir";

function allowsUndefined(schema: TypeSchema): boolean {
  return (
    schema.kind === "undefined" ||
    (schema.kind === "union" && schema.types.some(allowsUndefined))
  );
}

function validatePropertyExpression(
  schema: TypeSchema,
  expression: PredicateExpression,
  config: PropertyTestConfig,
  expected: boolean,
): void {
  if (expression.kind === "all" || expression.kind === "any") {
    for (const child of expression.conditions)
      validatePropertyExpression(schema, child, config, expected);
    return;
  }
  if (expression.kind === "not") {
    validatePropertyExpression(schema, expression.condition, config, expected);
    return;
  }
  if (expression.kind !== "equals" && expression.kind !== "present")
    throw new Error("unsupported property expression");
  let current = schema;
  let optional = false;
  for (const key of expression.property) {
    if (current.kind === "union" && config.version === 2) {
      const container = current.types.find((t) => t.kind === "object");
      if (container !== undefined) {
        optional ||= current.types.some(
          (t) => t.kind === "null" || t.kind === "undefined",
        );
        current = container;
      }
    }
    if (current.kind !== "object")
      throw new Error("property expression path does not name a field");
    const field = current.properties.find((p) => p.name === key);
    if (field === undefined)
      throw new Error("property expression references unknown field");
    optional ||= field.optional;
    current = field.type;
  }
  if (expression.kind === "present") {
    const nullish = (s: TypeSchema): boolean =>
      s.kind === "null" ||
      s.kind === "undefined" ||
      (s.kind === "union" && s.types.some(nullish));
    if (!optional && !nullish(current))
      throw new Error("property present requires a nullish/optional field");
    return;
  }
  const accepts = (s: TypeSchema): boolean =>
    s.kind === "union"
      ? s.types.some(accepts)
      : s.kind === "literal"
        ? s.value === expression.value
        : s.kind === "null"
          ? expression.value === null
          : expression.value !== null && s.kind === typeof expression.value;
  if (!accepts(current))
    throw new Error("property equality literal does not match schema");
  if (
    expected &&
    expression.value !== null &&
    !leafDomain(current, expression.property, config, true).some(
      (v) => v !== missing && v === expression.value,
    )
  )
    throw new Error(
      "expected equality literal must be included in the finite domain",
    );
}
