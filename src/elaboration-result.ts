import { type PredicateExpression, parsePredicateExpression } from "./ir";
import { assertKnownKeys, validateDiagnostics } from "./semantic-limits";

export type ElaborationResult =
  | {
      outcome: "resolved";
      body: PredicateExpression;
      diagnostics: string[];
    }
  | {
      outcome: "unresolved";
      body: null;
      diagnostics: string[];
    };

export function parseElaborationResult(input: unknown): ElaborationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("elaboration must be an object");
  const value = input as Record<string, unknown>;
  assertKnownKeys(value, ["outcome", "body", "diagnostics"], "elaboration");
  const diagnostics = validateDiagnostics(
    value.diagnostics,
    "elaboration.diagnostics",
  );

  if (value.outcome === "unresolved") {
    if (value.body !== null) {
      throw new Error("unresolved elaboration must have a null body");
    }

    return { outcome: "unresolved", body: null, diagnostics };
  }

  if (value.outcome === "resolved") {
    if (value.body === null) {
      throw new Error("resolved elaboration must have a body");
    }

    return {
      outcome: "resolved",
      body: parsePredicateExpression(value.body, "elaboration.body"),
      diagnostics,
    };
  }

  throw new Error("elaboration.outcome must be resolved or unresolved");
}
