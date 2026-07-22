import { describe, expect, test } from "bun:test";

import {
  parseConceptSpecification,
  validateConceptSpecificationForUse,
} from "./concept-specification";

describe("fixed-section Concept specification", () => {
  test("parses the five sections into a canonical compiler specification", () => {
    const parsed = parseConceptSpecification(validConcept());

    expect(parsed.syntax).toBe("sections");
    expect(parsed.structure).toEqual({
      definition: "An order eligible for fulfillment intake.",
      requirements: ["Payment is confirmed.", "A destination is present."],
      exclusions: ["Cancelled orders."],
      outOfScope: ["Inventory availability."],
      unresolvedWhen: ["The payment role cannot be mapped uniquely."],
    });
    expect(parsed.specification).toContain("Requirements:\n- Payment is confirmed.");
    expect(parsed.specification).toContain("Leave unresolved when:");
  });

  test("rejects unsectioned prose", () => {
    expect(() => parseConceptSpecification("A biological cat.")).toThrow(
      "missing required section Definition:",
    );
  });

  test("allows Definition-only and partial Concepts without rendering omitted sections", () => {
    const definitionOnly = parseConceptSpecification(`
      Definition:
      A domesticated biological cat.
    `);
    expect(definitionOnly.structure).toEqual({
      definition: "A domesticated biological cat.",
    });
    expect(definitionOnly.specification).toBe(
      "Definition:\nA domesticated biological cat.",
    );

    const withExclusion = parseConceptSpecification(`
      Definition:
      A domesticated biological cat.

      Exclusions:
      - Mechanical cat-shaped objects.
    `);
    expect(withExclusion.structure).toEqual({
      definition: "A domesticated biological cat.",
      exclusions: ["Mechanical cat-shaped objects."],
    });
  });

  test("applies usage-specific requirements before resolution", () => {
    const definitionOnly = parseConceptSpecification(`
      Definition:
      A domesticated biological cat.
    `).structure;
    expect(() =>
      validateConceptSpecificationForUse(definitionOnly, "static-judgment"),
    ).not.toThrow();
    expect(() =>
      validateConceptSpecificationForUse(definitionOnly, "predicate"),
    ).toThrow("must include Requirements: or Exclusions:");
  });

  test("rejects TOML, missing Definition, unknown, empty, duplicate, and reordered sections", () => {
    const cases = [
      'format = "l-lang-concept-v1"\n\n[definition]\ntext = "Legacy TOML"',
      validConcept().replace("Definition:", "Description:"),
      validConcept().replace("Leave unresolved when:", "Unknown:") ,
      validConcept().replace("- Cancelled orders.", ""),
      validConcept().replace(
        "- Cancelled orders.",
        "- Cancelled orders.\n- Cancelled orders.",
      ),
      validConcept().replace(
        "- Inventory availability.",
        "- Payment is confirmed.",
      ),
      validConcept().replace(
        "Requirements:",
        "Temporary:",
      ).replace(
        "Exclusions:",
        "Requirements:",
      ).replace(
        "Temporary:",
        "Exclusions:",
      ),
    ];

    for (const input of cases) {
      expect(() => parseConceptSpecification(input)).toThrow();
    }
  });

  test("requires every list line to be an explicit one-line item", () => {
    expect(() =>
      parseConceptSpecification(
        validConcept().replace("- A destination is present.", "A destination is present."),
      ),
    ).toThrow('must be a one-line "- item"');
  });
});

function validConcept(): string {
  return `
    Definition:
    An order eligible for fulfillment intake.

    Requirements:
    - Payment is confirmed.
    - A destination is present.

    Exclusions:
    - Cancelled orders.

    Out of scope:
    - Inventory availability.

    Leave unresolved when:
    - The payment role cannot be mapped uniquely.
  `;
}
