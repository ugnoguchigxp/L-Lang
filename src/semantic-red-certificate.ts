import type { PredicateExpression } from "./ir";
import {
  generatePredicateMutants,
  type PredicateMutant,
} from "./predicate-mutation";
import { sha256, stableJson } from "./semantic-fingerprint";
import {
  evaluatePredicateExpression,
  evaluateSemanticTestPlan,
} from "./semantic-test-generator";
import type {
  SemanticTestPlan,
  SemanticTestValue,
} from "./semantic-test-ir";
import type { TypeSchema } from "./semantic-source";

export const RED_CERTIFICATE_VERSION = 1;

export type RedMutantResult = {
  id: string;
  kind: PredicateMutant["kind"];
  classification: "killed" | "survived" | "equivalent" | "not-applicable";
  killedBy: string[];
  reason: string | null;
};

export type RedCertificate = {
  version: 1;
  testPlanHash: string;
  implementationSignature: string | null;
  mutants: RedMutantResult[];
  hardClauseCoverage: number;
  mutationScore: number;
};

export type CompiledRedCertificate = {
  certificate: RedCertificate;
  redCertificateHash: string;
};

export function createRedCertificate(input: {
  plan: SemanticTestPlan;
  testPlanHash: string;
  typeSchema: TypeSchema;
  hardClauseCoverage: number;
  implementation?: PredicateExpression;
}): CompiledRedCertificate {
  const mutants = generatePredicateMutants(
    input.implementation ?? null,
    input.typeSchema,
  );
  const results = mutants.map((mutant) =>
    evaluateMutant(mutant, input.plan),
  );
  const scored = results.filter(
    (result) =>
      result.classification === "killed" ||
      result.classification === "survived",
  );
  const killed = scored.filter(
    (result) => result.classification === "killed",
  ).length;
  const certificate: RedCertificate = {
    version: RED_CERTIFICATE_VERSION,
    testPlanHash: input.testPlanHash,
    implementationSignature:
      input.implementation === undefined
        ? null
        : sha256(stableJson(input.implementation)),
    mutants: results,
    hardClauseCoverage: input.hardClauseCoverage,
    mutationScore: scored.length === 0 ? 1 : killed / scored.length,
  };
  return {
    certificate,
    redCertificateHash: sha256(stableJson(certificate)),
  };
}

export function assertPreImplementationRed(
  certificate: RedCertificate,
): void {
  for (const id of ["constant-false", "constant-true"]) {
    const result = certificate.mutants.find((mutant) => mutant.id === id);
    if (result?.classification !== "killed") {
      throw new Error(
        `Test Plan is vacuous: required Red mutant ${id} was not killed`,
      );
    }
  }
}

export function parseRedCertificate(input: unknown): RedCertificate {
  const value = recordValue(input, "redCertificate");
  exactKeys(
    value,
    [
      "version",
      "testPlanHash",
      "implementationSignature",
      "mutants",
      "hardClauseCoverage",
      "mutationScore",
    ],
    "redCertificate",
  );
  if (value.version !== RED_CERTIFICATE_VERSION) {
    throw new Error("redCertificate.version must be 1");
  }
  const implementationSignature =
    value.implementationSignature === null
      ? null
      : hashValue(
          value.implementationSignature,
          "redCertificate.implementationSignature",
        );
  if (!Array.isArray(value.mutants)) {
    throw new Error("redCertificate.mutants must be an array");
  }
  const mutants = value.mutants.map((inputMutant, index) => {
    const path = `redCertificate.mutants[${index}]`;
    const mutant = recordValue(inputMutant, path);
    exactKeys(
      mutant,
      ["id", "kind", "classification", "killedBy", "reason"],
      path,
    );
    if (
      mutant.kind !== "constant" &&
      mutant.kind !== "junction-replacement" &&
      mutant.kind !== "condition-deletion" &&
      mutant.kind !== "condition-negation"
    ) {
      throw new Error(`${path}.kind is invalid`);
    }
    if (
      mutant.classification !== "killed" &&
      mutant.classification !== "survived" &&
      mutant.classification !== "equivalent" &&
      mutant.classification !== "not-applicable"
    ) {
      throw new Error(`${path}.classification is invalid`);
    }
    if (
      !Array.isArray(mutant.killedBy) ||
      !mutant.killedBy.every((item) => typeof item === "string")
    ) {
      throw new Error(`${path}.killedBy must be an array of strings`);
    }
    if (mutant.reason !== null && typeof mutant.reason !== "string") {
      throw new Error(`${path}.reason must be string or null`);
    }
    return {
      id: stringValue(mutant.id, `${path}.id`),
      kind: mutant.kind,
      classification: mutant.classification,
      killedBy: mutant.killedBy as string[],
      reason: mutant.reason,
    } satisfies RedMutantResult;
  });
  return {
    version: 1,
    testPlanHash: hashValue(
      value.testPlanHash,
      "redCertificate.testPlanHash",
    ),
    implementationSignature,
    mutants,
    hardClauseCoverage: unitNumber(
      value.hardClauseCoverage,
      "redCertificate.hardClauseCoverage",
    ),
    mutationScore: unitNumber(
      value.mutationScore,
      "redCertificate.mutationScore",
    ),
  };
}

function evaluateMutant(
  mutant: PredicateMutant,
  plan: SemanticTestPlan,
): RedMutantResult {
  if (mutant.equivalent) {
    return {
      id: mutant.id,
      kind: mutant.kind,
      classification: "equivalent",
      killedBy: [],
      reason: mutant.equivalenceReason,
    };
  }
  const result = evaluateSemanticTestPlan(plan, (value) =>
    evaluateMutantValue(mutant, value),
  );
  const killedBy = result.results
    .filter((item) => item.strength === "hard" && !item.passed)
    .map((item) => item.obligationId);
  return {
    id: mutant.id,
    kind: mutant.kind,
    classification: killedBy.length > 0 ? "killed" : "survived",
    killedBy,
    reason:
      killedBy.length > 0 ? null : "all hard obligations passed this mutant",
  };
}

function evaluateMutantValue(
  mutant: PredicateMutant,
  value: SemanticTestValue,
): boolean {
  if (mutant.constant !== null) return mutant.constant;
  if (mutant.expression === null) {
    throw new Error(`mutant ${mutant.id} has no executable behavior`);
  }
  return evaluatePredicateExpression(mutant.expression, value);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) throw new Error(`${path} contains unknown field ${unknown}`);
  const missing = allowed.find((key) => !(key in value));
  if (missing !== undefined) throw new Error(`${path} is missing ${missing}`);
}

function recordValue(
  input: unknown,
  path: string,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${path} must be an object`);
  }
  return input as Record<string, unknown>;
}

function stringValue(input: unknown, path: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return input;
}

function hashValue(input: unknown, path: string): string {
  const value = stringValue(input, path);
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${path} must be a SHA-256 hash`);
  }
  return value;
}

function unitNumber(input: unknown, path: string): number {
  if (
    typeof input !== "number" ||
    !Number.isFinite(input) ||
    input < 0 ||
    input > 1
  ) {
    throw new Error(`${path} must be a number between 0 and 1`);
  }
  return input;
}
