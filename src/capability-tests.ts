import {
  contentHash,
  exampleInput,
  identifier,
  list,
  type PromptSource,
  unique,
} from "./prompt-source";
import { encodeInput, record, WasmError } from "./wasm-contract";

export type CapabilityCase = {
  id: string;
  requirementIds: string[];
  input: Record<string, unknown>;
  undefinedFields: string[];
  expected:
    | { kind: "value"; value: boolean }
    | { kind: "error"; code: "INVALID_INPUT" };
};
export type CapabilitySuite = {
  version: 1;
  sourceRevision: string;
  cases: CapabilityCase[];
};
export type CaseResult = {
  id: string;
  origin: "source" | "suite";
  requirementIds: string[];
  expected: CapabilityCase["expected"];
  actual: { kind: "value"; value: boolean } | { kind: "error"; code: string };
  status: "pass" | "fail" | "error";
};
export function invalid(message: string): never {
  throw new WasmError("INVALID_CAPABILITY", message);
}
export function parseCapabilitySuite(
  input: unknown,
  source: PromptSource,
): CapabilitySuite {
  const s = record(input, ["version", "sourceRevision", "cases"]);
  if (s.version !== 1 || s.sourceRevision !== contentHash(source))
    invalid("suite version or source revision mismatch");
  const known = new Set(source.requirements.map((r) => r.id));
  const cases = list(s.cases, "cases").map((raw): CapabilityCase => {
    const c = record(raw, [
      "id",
      "requirementIds",
      "input",
      "undefinedFields",
      "expected",
    ]);
    const requirementIds = list(c.requirementIds, "requirementIds").map(
      identifier,
    );
    unique(requirementIds);
    if (!requirementIds.length || requirementIds.some((id) => !known.has(id)))
      invalid("unknown or missing requirement id");
    if (!c.input || typeof c.input !== "object" || Array.isArray(c.input))
      invalid("test input must be an object");
    const undefinedFields = list(c.undefinedFields, "undefinedFields").map(
      identifier,
    );
    unique(undefinedFields);
    const e = record(c.expected, ["kind", "value", "code"]);
    let expected: CapabilityCase["expected"];
    if (
      e.kind === "value" &&
      typeof e.value === "boolean" &&
      !Object.hasOwn(e, "code")
    )
      expected = { kind: "value", value: e.value };
    else if (
      e.kind === "error" &&
      e.code === "INVALID_INPUT" &&
      !Object.hasOwn(e, "value")
    )
      expected = { kind: "error", code: "INVALID_INPUT" };
    else return invalid("unsupported expectation");
    const result = {
      id: identifier(c.id),
      requirementIds,
      input: c.input as Record<string, unknown>,
      undefinedFields,
      expected,
    };
    const value = caseInput(result);
    if (expected.kind === "value") encodeInput(source.contract, value);
    else {
      let rejected = false;
      try {
        encodeInput(source.contract, value);
      } catch (error) {
        if (!(error instanceof WasmError) || error.code !== "INVALID_INPUT")
          throw error;
        rejected = true;
      }
      if (!rejected) invalid("error expectation requires an invalid input");
    }
    return result;
  });
  unique(cases.map((c) => c.id));
  for (const value of [true, false])
    if (
      !cases.some(
        (c) => c.expected.kind === "value" && c.expected.value === value,
      )
    )
      invalid("suite needs positive and negative cases");
  for (const r of source.requirements)
    if (
      r.level !== "should" &&
      !cases.some((c) => c.requirementIds.includes(r.id))
    )
      invalid(`uncovered requirement ${r.id}`);
  return { version: 1, sourceRevision: contentHash(source), cases };
}
export function caseInput(
  c: Pick<CapabilityCase, "input" | "undefinedFields">,
) {
  return exampleInput({ ...c, id: "case", expected: false });
}
export function runCapabilityCases(
  source: PromptSource,
  suite: CapabilitySuite,
  evaluate: (input: unknown) => boolean,
): CaseResult[] {
  const cases = [
    ...source.examples.map((c) => ({
      ...c,
      requirementIds: [] as string[],
      expected: { kind: "value" as const, value: c.expected },
      origin: "source" as const,
    })),
    ...suite.cases.map((c) => ({ ...c, origin: "suite" as const })),
  ];
  return cases.map((c) => {
    let actual: CaseResult["actual"];
    try {
      actual = { kind: "value", value: evaluate(caseInput(c)) };
    } catch (e) {
      actual = {
        kind: "error",
        code: e instanceof WasmError ? e.code : "EXECUTION_ERROR",
      };
    }
    const status =
      actual.kind === "error" && actual.code !== "INVALID_INPUT"
        ? "error"
        : JSON.stringify(actual) === JSON.stringify(c.expected)
          ? "pass"
          : "fail";
    return {
      id: c.id,
      origin: c.origin,
      requirementIds: c.requirementIds,
      expected: c.expected,
      actual,
      status,
    };
  });
}
