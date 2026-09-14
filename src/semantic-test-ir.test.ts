import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { compileSemanticContract } from "./semantic-contract";
import { scanSemanticSource } from "./semantic-source";
import {
  applySemanticTestChanges,
  parseSemanticTestPlan,
  validateSemanticTestPlan,
} from "./semantic-test-ir";

const example = fileURLToPath(
  new URL("../examples/active-customer/semantic.ts", import.meta.url),
);

describe("semantic test obligation IR", () => {
  test("strictly parses, validates, traces, and hashes a complete plan", async () => {
    const source = await scanSemanticSource(example);
    const compiled = compileSemanticContract(source);
    const plan = parseSemanticTestPlan(validPlan(compiled.contractHash));
    const validated = validateSemanticTestPlan(
      plan,
      compiled.contract,
      compiled.contractHash,
    );

    expect(validated.testPlanHash).toMatch(/^[a-f0-9]{64}$/);
    expect(validated.hardClauseCoverage).toBe(1);
    expect(plan.obligations).toHaveLength(4);
    const invariance = plan.obligations[3];
    const changed = applySemanticTestChanges(
      invariance?.kind === "invariance" ? invariance.base : null,
      invariance?.kind === "invariance" ? invariance.changes : [],
    );
    expect(changed).toMatchObject({ email: "renamed@example.com" });
  });

  test("rejects unknown fields, duplicate ids, uncovered clauses, and bad values", async () => {
    const source = await scanSemanticSource(example);
    const compiled = compileSemanticContract(source);

    expect(() =>
      parseSemanticTestPlan({
        ...validPlan(compiled.contractHash),
        unknown: true,
      }),
    ).toThrow("unknown field unknown");

    const duplicate = validPlan(compiled.contractHash);
    const first = duplicate.obligations[0];
    const second = duplicate.obligations[1];
    if (first === undefined || second === undefined) {
      throw new Error("duplicate test fixtures are missing");
    }
    second.id = first.id;
    expect(() => parseSemanticTestPlan(duplicate)).toThrow("duplicate");

    const uncovered = parseSemanticTestPlan({
      ...validPlan(compiled.contractHash),
      obligations: validPlan(compiled.contractHash).obligations.slice(0, 1),
    });
    expect(() =>
      validateSemanticTestPlan(
        uncovered,
        compiled.contract,
        compiled.contractHash,
      ),
    ).toThrow("does not cover hard contract clauses");

    const badValue = validPlan(compiled.contractHash);
    (
      badValue.obligations[0] as {
        input: Record<string, unknown>;
      }
    ).input.status = "invented";
    expect(() =>
      validateSemanticTestPlan(
        parseSemanticTestPlan(badValue),
        compiled.contract,
        compiled.contractHash,
      ),
    ).toThrow("declared union");
  });
});

function validPlan(contractHash: string): {
  version: number;
  contractHash: string;
  obligations: Array<Record<string, unknown>>;
} {
  return {
    version: 1,
    contractHash,
    obligations: [
      {
        id: "active-customer-accepted",
        kind: "example",
        sourceClauses: [
          "requirements[0]",
          "requirements[1]",
          "requirements[2]",
        ],
        strength: "hard",
        rationale: "All required roles are satisfied.",
        input: {
          status: "active",
          deletedAt: null,
          email: "customer@example.com",
        },
        expected: true,
      },
      {
        id: "suspended-customer-rejected",
        kind: "example",
        sourceClauses: ["exclusions[0]"],
        strength: "hard",
        rationale: "Suspended customers are excluded.",
        input: {
          status: "suspended",
          deletedAt: null,
          email: "customer@example.com",
        },
        expected: false,
      },
      {
        id: "deleted-customer-rejected",
        kind: "counterfactual",
        sourceClauses: ["exclusions[1]"],
        strength: "hard",
        rationale: "Deletion changes acceptance to rejection.",
        base: {
          status: "active",
          deletedAt: null,
          email: "customer@example.com",
        },
        changes: [
          {
            property: ["deletedAt"],
            value: "2026-07-23T00:00:00Z",
          },
        ],
        expectedBefore: true,
        expectedAfter: false,
      },
      {
        id: "email-value-invariant",
        kind: "invariance",
        sourceClauses: ["definition"],
        strength: "exploratory",
        rationale: "Changing one present email to another keeps acceptance.",
        base: {
          status: "active",
          deletedAt: null,
          email: "customer@example.com",
        },
        changes: [{ property: ["email"], value: "renamed@example.com" }],
      },
    ],
  };
}
