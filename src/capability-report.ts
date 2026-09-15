import type { CapabilityReport } from "./capability-package";
import { type CaseResult, invalid } from "./capability-tests";
import { identifier, list, stringValue, unique } from "./prompt-source";
import { record } from "./wasm-contract";

function expectation(input: unknown, actual = false): CaseResult["actual"] {
  const e = record(input, ["kind", "value", "code"]);
  if (
    e.kind === "value" &&
    typeof e.value === "boolean" &&
    !Object.hasOwn(e, "code")
  )
    return { kind: "value", value: e.value };
  if (
    e.kind === "error" &&
    !Object.hasOwn(e, "value") &&
    (actual || e.code === "INVALID_INPUT")
  )
    return { kind: "error", code: stringValue(e.code, "error code") };
  return invalid("invalid report expectation");
}
/** Validates structure and internal consistency, not author authenticity or SAAA acceptance. */
export function parseCapabilityReport(input: unknown): CapabilityReport {
  const r = record(input, [
    "version",
    "verifier",
    "packageHash",
    "status",
    "acceptance",
    "apiCalls",
    "results",
    "requirements",
    "unchecked",
    "passed",
    "failed",
    "errors",
    "diagnostics",
  ]);
  if (
    r.version !== 1 ||
    r.verifier !== "capability-predicate-v1" ||
    r.acceptance !== "not-run" ||
    r.apiCalls !== 0 ||
    (r.packageHash !== null &&
      (typeof r.packageHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(r.packageHash)))
  )
    invalid("invalid report contract");
  if (!Array.isArray(r.results) || r.results.length > 256)
    invalid("invalid report results");
  const results = r.results.map((raw): CaseResult => {
    const c = record(raw, [
      "id",
      "origin",
      "requirementIds",
      "expected",
      "actual",
      "status",
    ]);
    if (c.origin !== "source" && c.origin !== "suite")
      invalid("invalid test origin");
    const requirementIds = list(c.requirementIds, "requirementIds").map(
      identifier,
    );
    unique(requirementIds);
    const expected = expectation(c.expected) as CaseResult["expected"];
    const actual = expectation(c.actual, true);
    const status =
      actual.kind === "error" && actual.code !== "INVALID_INPUT"
        ? "error"
        : JSON.stringify(actual) === JSON.stringify(expected)
          ? "pass"
          : "fail";
    if (status !== c.status) invalid("inconsistent test status");
    return {
      id: identifier(c.id),
      origin: c.origin,
      requirementIds,
      expected,
      actual,
      status,
    };
  });
  unique(results.map((c) => `${c.origin}:${c.id}`));
  const requirements = list(r.requirements, "requirements").map((raw) => {
    const q = record(raw, ["id", "caseIds"]);
    const caseIds = list(q.caseIds, "caseIds").map(identifier);
    unique(caseIds);
    return { id: identifier(q.id), caseIds };
  });
  unique(requirements.map((q) => q.id));
  if (results.length) {
    if (r.packageHash === null) invalid("results require a package hash");
    for (const c of results) {
      if (
        c.origin === "source"
          ? c.requirementIds.length !== 0
          : !c.requirementIds.length ||
            c.requirementIds.some(
              (id) => !requirements.some((q) => q.id === id),
            )
      )
        invalid("invalid requirement mapping");
    }
    for (const q of requirements) {
      const ids = results
        .filter((c) => c.origin === "suite" && c.requirementIds.includes(q.id))
        .map((c) => c.id);
      if (JSON.stringify(ids) !== JSON.stringify(q.caseIds))
        invalid("inconsistent requirement mapping");
    }
  }

  if (!Array.isArray(r.unchecked) || r.unchecked.length > 130)
    invalid("invalid unchecked items");
  const unchecked = r.unchecked.map((v) => stringValue(v, "unchecked"));
  if (!unchecked.includes("SAAA acceptance"))
    invalid("missing unchecked acceptance");
  const diagnostics = list(r.diagnostics, "diagnostics").map((v) =>
    stringValue(v, "diagnostic"),
  );
  const passed = results.filter((c) => c.status === "pass").length;
  const failed = results.filter((c) => c.status === "fail").length;
  const errors =
    results.filter((c) => c.status === "error").length + diagnostics.length;
  const status = errors ? "error" : failed ? "fail" : "pass";
  if (
    r.passed !== passed ||
    r.failed !== failed ||
    r.errors !== errors ||
    r.status !== status ||
    (!errors && (!results.length || r.packageHash === null))
  )
    invalid("inconsistent report totals");
  return {
    version: 1,
    verifier: "capability-predicate-v1",
    packageHash: r.packageHash as string | null,
    status,
    acceptance: "not-run",
    apiCalls: 0,
    results,
    requirements,
    unchecked,
    passed,
    failed,
    errors,
    diagnostics,
  };
}
