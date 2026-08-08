import { describe, expect, test } from "bun:test";

import type { PredicateExpression } from "./ir";
import type { SemanticContract } from "./semantic-contract";
import { sha256, stableJson } from "./semantic-fingerprint";
import { createRedCertificate } from "./semantic-red-certificate";
import {
  evaluatePredicateExpression,
  evaluateSemanticTestPlan,
} from "./semantic-test-generator";
import {
  validateSemanticTestPlan,
  type SemanticTestPlan,
  type SemanticTestValue,
} from "./semantic-test-ir";
import type { TypeSchema } from "./semantic-source";

describe("Semantic TDD frozen held-out Predicate evaluation", () => {
  for (const fixture of heldOutFixtures()) {
    test(`${fixture.name} rejects every independently faulty Predicate IR`, () => {
      const validated = validateSemanticTestPlan(
        fixture.plan,
        fixture.contract,
        fixture.plan.contractHash,
      );
      const accepted = evaluateSemanticTestPlan(validated.plan, (value) =>
        evaluatePredicateExpression(fixture.oracle, value),
      );
      expect(accepted.hardPassed).toBe(true);
      expect(validated.hardClauseCoverage).toBe(1);

      const red = createRedCertificate({
        plan: validated.plan,
        testPlanHash: validated.testPlanHash,
        typeSchema: fixture.contract.typeSchema,
        hardClauseCoverage: validated.hardClauseCoverage,
        implementation: fixture.oracle,
      });
      expect(red.certificate.mutationScore).toBe(1);
      expect(
        red.certificate.mutants.filter(
          (mutant) => mutant.classification === "survived",
        ),
      ).toEqual([]);

      for (const faulty of fixture.faulty) {
        const evaluated = evaluateSemanticTestPlan(validated.plan, (value) =>
          evaluatePredicateExpression(faulty, value),
        );
        expect(evaluated.hardPassed).toBe(false);
      }
    });
  }
});

type HeldOutFixture = {
  name: string;
  contract: SemanticContract;
  plan: SemanticTestPlan;
  oracle: PredicateExpression;
  faulty: PredicateExpression[];
};

function heldOutFixtures(): HeldOutFixture[] {
  return [
    createFixture({
      name: "EligibleShipment",
      typeName: "Shipment",
      discriminant: "status",
      goodLiteral: "ready",
      badLiteral: "pending",
      nullable: "cancelledAt",
      present: "address",
      irrelevant: "label",
    }),
    createFixture({
      name: "VisibleDocument",
      typeName: "Document",
      discriminant: "visibility",
      goodLiteral: "published",
      badLiteral: "draft",
      nullable: "deletedAt",
      present: "title",
      irrelevant: "editorNote",
    }),
    createFixture({
      name: "EnabledFeature",
      typeName: "Feature",
      discriminant: "state",
      goodLiteral: "enabled",
      badLiteral: "disabled",
      nullable: "archivedAt",
      present: "owner",
      irrelevant: "displayName",
    }),
  ];
}

function createFixture(input: {
  name: string;
  typeName: string;
  discriminant: string;
  goodLiteral: string;
  badLiteral: string;
  nullable: string;
  present: string;
  irrelevant: string;
}): HeldOutFixture {
  const schema: TypeSchema = {
    kind: "object",
    properties: [
      {
        name: input.discriminant,
        optional: false,
        type: {
          kind: "union",
          types: [
            { kind: "literal", value: input.goodLiteral },
            { kind: "literal", value: input.badLiteral },
          ],
        },
      },
      {
        name: input.nullable,
        optional: false,
        type: {
          kind: "union",
          types: [{ kind: "string" }, { kind: "null" }],
        },
      },
      {
        name: input.present,
        optional: false,
        type: {
          kind: "union",
          types: [{ kind: "string" }, { kind: "null" }],
        },
      },
      {
        name: input.irrelevant,
        optional: false,
        type: { kind: "string" },
      },
    ],
  };
  const contract: SemanticContract = {
    version: 1,
    conceptId: `held-out:${input.name}`,
    conceptName: input.name,
    typeName: input.typeName,
    clauses: [
      {
        id: "definition",
        section: "definition",
        text: `A ${input.name} satisfies the operational boundary.`,
        normative: false,
      },
      {
        id: "requirements[0]",
        section: "requirements",
        text: `${input.discriminant} is ${input.goodLiteral}.`,
        normative: true,
      },
      {
        id: "requirements[1]",
        section: "requirements",
        text: `${input.present} is present.`,
        normative: true,
      },
      {
        id: "exclusions[0]",
        section: "exclusions",
        text: `${input.nullable} is not null.`,
        normative: true,
      },
    ],
    typeSchema: schema,
  };
  const contractHash = sha256(stableJson(contract));
  const accepted: Record<string, SemanticTestValue> = {
    [input.discriminant]: input.goodLiteral,
    [input.nullable]: null,
    [input.present]: "present",
    [input.irrelevant]: "alpha",
  };
  const plan: SemanticTestPlan = {
    version: 1,
    contractHash,
    obligations: [
      {
        id: "accepted",
        kind: "example",
        sourceClauses: ["requirements[0]", "requirements[1]"],
        strength: "hard",
        rationale: "All requirements and exclusions hold.",
        input: accepted,
        expected: true,
      },
      {
        id: "wrong-state",
        kind: "counterfactual",
        sourceClauses: ["requirements[0]"],
        strength: "hard",
        rationale: "Changing only the state reverses acceptance.",
        base: accepted,
        changes: [
          {
            property: [input.discriminant],
            value: input.badLiteral,
          },
        ],
        expectedBefore: true,
        expectedAfter: false,
      },
      {
        id: "excluded",
        kind: "example",
        sourceClauses: ["exclusions[0]"],
        strength: "hard",
        rationale: "The exclusion must reject.",
        input: { ...accepted, [input.nullable]: "2026-07-23" },
        expected: false,
      },
      {
        id: "missing-role",
        kind: "example",
        sourceClauses: ["requirements[1]"],
        strength: "hard",
        rationale: "The required role must be present.",
        input: { ...accepted, [input.present]: null },
        expected: false,
      },
      {
        id: "irrelevant-field",
        kind: "invariance",
        sourceClauses: ["definition"],
        strength: "exploratory",
        rationale: "Presentation metadata is irrelevant.",
        base: accepted,
        changes: [{ property: [input.irrelevant], value: "beta" }],
      },
    ],
  };
  const conditions: PredicateExpression[] = [
    {
      kind: "equals",
      property: [input.discriminant],
      value: input.goodLiteral,
    },
    { kind: "equals", property: [input.nullable], value: null },
    { kind: "present", property: [input.present] },
  ];
  const oracle: PredicateExpression = {
    kind: "all",
    conditions,
  };
  return {
    name: input.name,
    contract,
    plan,
    oracle,
    faulty: conditions.map((_condition, removed) => ({
      kind: "all",
      conditions: conditions.filter((_item, index) => index !== removed),
    })),
  };
}
