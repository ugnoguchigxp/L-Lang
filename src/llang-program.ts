import {
  type PredicateExpression,
  parsePredicateExpression,
  PredicateProfileError,
  PredicateStructureError,
} from "./ir";
import {
  LLANG_DIAGNOSTIC_LIMIT,
  type LlangDiagnostic,
  pointer,
  reportFor,
} from "./llang-diagnostics";
import {
  type LlangJsoncDocument,
  parseLlangJsonc,
  rangeForPath,
} from "./llang-jsonc";
import { fingerprintFor } from "./stable-hash";
import { lowerPredicate } from "./wasm-core";
import { parseContract, type WasmContract } from "./wasm-contract";
import { unicodeScalarLength } from "./unicode-length";

export type LlangProgram = {
  language: "l-lang";
  version: 1;
  id: string;
  profile: "predicate-i32-v1";
  description?: string;
  contract: WasmContract;
  body: PredicateExpression;
};

export type CheckedLlangProgram = {
  program: LlangProgram;
  sourceHash: string;
  programHash: string;
  document: LlangJsoncDocument;
};

const known = new Set([
  "language",
  "version",
  "id",
  "profile",
  "description",
  "contract",
  "body",
]);

function makeDiagnostic(
  document: LlangJsoncDocument,
  code: string,
  message: string,
  path: (string | number)[],
  hint?: string,
  severity: "error" | "warning" = "error",
): LlangDiagnostic {
  return {
    code,
    severity,
    message,
    file: document.file,
    range: rangeForPath(document, path),
    path: pointer(path),
    related: [],
    ...(hint ? { hint } : {}),
  };
}

function objectValue(input: unknown): Record<string, unknown> | null {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

function validateSemantics(
  document: LlangJsoncDocument,
  body: PredicateExpression,
  contract: WasmContract,
): LlangDiagnostic[] {
  const diagnostics: LlangDiagnostic[] = [];
  const fields = new Map(contract.fields.map((field) => [field.name, field]));
  function visit(expression: PredicateExpression, path: (string | number)[]) {
    if ("conditions" in expression) {
      const seen = new Map<string, { path: (string | number)[] }>();
      expression.conditions.forEach((condition, index) => {
        const conditionPath = [...path, "conditions", index];
        const fingerprint = fingerprintFor(condition);
        const prior = seen.get(fingerprint);
        if (prior) {
          const item = makeDiagnostic(
            document,
            "LLW001",
            "condition duplicates an earlier condition",
            conditionPath,
            undefined,
            "warning",
          );
          item.related.push({
            message: "first identical condition is here",
            range: rangeForPath(document, prior.path),
            path: pointer(prior.path),
          });
          diagnostics.push(item);
        } else seen.set(fingerprint, { path: conditionPath });
        visit(condition, conditionPath);
      });
      return;
    }
    if ("condition" in expression) {
      visit(expression.condition, [...path, "condition"]);
      return;
    }
    if (expression.property.length !== 1) {
      diagnostics.push(
        makeDiagnostic(
          document,
          "LLP001",
          "predicate-i32-v1 supports a single property segment",
          [...path, "property"],
        ),
      );
      return;
    }
    const name = expression.property[0] as string;
    const field = fields.get(name);
    if (!field) {
      diagnostics.push(
        makeDiagnostic(
          document,
          "LLT001",
          `unknown contract field ${JSON.stringify(name)}`,
          [...path, "property", 0],
          `available fields: ${[...fields.keys()].map((value) => JSON.stringify(value)).join(", ")}`,
        ),
      );
      return;
    }
    if (expression.kind === "present") {
      if (!(field.nullable || field.undefinable || field.optional))
        diagnostics.push(
          makeDiagnostic(
            document,
            "LLT001",
            "present requires a nullable, undefinable or optional field",
            path,
          ),
        );
      return;
    }
    const literal = expression.value;
    const valid =
      (literal === null && field.nullable) ||
      (typeof literal === "boolean" && field.kind === "boolean") ||
      (typeof literal === "string" &&
        field.kind === "enum" &&
        field.values.includes(literal));
    if (!valid)
      diagnostics.push(
        makeDiagnostic(
          document,
          "LLT001",
          `value ${JSON.stringify(literal)} is not valid for field ${JSON.stringify(name)}`,
          [...path, "value"],
          field.kind === "enum"
            ? `allowed values: ${field.values.map((value) => JSON.stringify(value)).join(", ")}`
            : undefined,
        ),
      );
  }
  visit(body, ["body"]);
  return diagnostics;
}

export function checkLlangProgram(text: string, file = "<input>") {
  const syntax = parseLlangJsonc(text, file);
  if (!syntax.document) return { report: syntax.report };
  const document = syntax.document;
  const root = objectValue(document.value);
  const diagnostics: LlangDiagnostic[] = [];
  if (!root)
    diagnostics.push(
      makeDiagnostic(document, "LLS001", "program must be an object", []),
    );
  if (!root) return { report: reportFor(diagnostics) };
  for (const key of Object.keys(root)) {
    if (diagnostics.length > LLANG_DIAGNOSTIC_LIMIT) break;
    if (!known.has(key))
      diagnostics.push(
        makeDiagnostic(
          document,
          "LLS001",
          `unknown program field ${JSON.stringify(key)}`,
          [key],
        ),
      );
  }
  for (const key of [
    "language",
    "version",
    "id",
    "profile",
    "contract",
    "body",
  ])
    if (!Object.hasOwn(root, key))
      diagnostics.push(
        makeDiagnostic(
          document,
          "LLS001",
          `missing required program field ${JSON.stringify(key)}`,
          [],
        ),
      );
  if (root.language !== "l-lang")
    diagnostics.push(
      makeDiagnostic(document, "LLS001", 'language must be "l-lang"', [
        "language",
      ]),
    );
  if (root.version !== 1)
    diagnostics.push(
      makeDiagnostic(document, "LLS001", "version must be 1", ["version"]),
    );
  if (
    typeof root.id !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(root.id)
  )
    diagnostics.push(
      makeDiagnostic(document, "LLS001", "id is invalid", ["id"]),
    );
  if (root.profile !== "predicate-i32-v1")
    diagnostics.push(
      makeDiagnostic(document, "LLS001", 'profile must be "predicate-i32-v1"', [
        "profile",
      ]),
    );
  if (
    Object.hasOwn(root, "description") &&
    (typeof root.description !== "string" ||
      !root.description.length ||
      unicodeScalarLength(root.description) > 4096)
  )
    diagnostics.push(
      makeDiagnostic(
        document,
        "LLS001",
        "description must be a non-empty string of at most 4096 characters",
        ["description"],
      ),
    );
  let contract: WasmContract | undefined;
  try {
    contract = parseContract(root.contract);
  } catch (error) {
    diagnostics.push(
      makeDiagnostic(
        document,
        "LLS001",
        error instanceof Error ? error.message : String(error),
        ["contract"],
      ),
    );
  }
  let body: PredicateExpression | undefined;
  try {
    body = parsePredicateExpression(root.body, "body");
  } catch (error) {
    diagnostics.push(
      makeDiagnostic(
        document,
        error instanceof PredicateProfileError ? "LLP001" : "LLS001",
        error instanceof Error ? error.message : String(error),
        error instanceof PredicateStructureError
          ? error.diagnosticPath
          : ["body"],
      ),
    );
  }
  if (contract && body) {
    diagnostics.push(...validateSemantics(document, body, contract));
    if (!diagnostics.some((item) => item.severity === "error")) {
      try {
        lowerPredicate(body, contract);
      } catch (error) {
        diagnostics.push(
          makeDiagnostic(
            document,
            "LLP001",
            error instanceof Error ? error.message : String(error),
            ["body"],
          ),
        );
      }
    }
  }
  const report = reportFor([...syntax.report.diagnostics, ...diagnostics]);
  if (!report.ok || !contract || !body) return { report };
  const program: LlangProgram = {
    language: "l-lang",
    version: 1,
    id: root.id as string,
    profile: "predicate-i32-v1",
    ...(typeof root.description === "string"
      ? { description: root.description }
      : {}),
    contract,
    body,
  };
  return {
    report,
    checked: {
      program,
      sourceHash: document.sourceHash,
      programHash: fingerprintFor({
        language: program.language,
        version: program.version,
        profile: program.profile,
        contract: program.contract,
        body: program.body,
      }),
      document,
    } satisfies CheckedLlangProgram,
  };
}
