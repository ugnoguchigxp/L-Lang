import { describe, expect, test } from "bun:test";

import { validatePredicateContext } from "./context-validator";
import { scanSemanticSource } from "./semantic-source";

const example = new URL(
  "../examples/active-customer/semantic.ts",
  import.meta.url,
).pathname;
const polymorphicCustomer = new URL(
  "../examples/semantic-polymorphism/customer/semantic.ts",
  import.meta.url,
).pathname;
const polymorphicAccount = new URL(
  "../examples/semantic-polymorphism/account/semantic.ts",
  import.meta.url,
).pathname;

describe("semantic source scanner", () => {
  test("extracts a closed concept, predicate, type, and tests", async () => {
    const source = await scanSemanticSource(example);

    expect(source.concept.name).toBe("ActiveCustomer");
    expect(source.concept.typeName).toBe("Customer");
    expect(source.predicate.name).toBe("isActiveCustomer");
    expect(source.tests.acceptSource).toContain("customer@example.com");
    expect(source.tests.rejectSource).toContain("undefined");
    expect(source.concept.typeDeclaration).toContain("export type Customer");
  });

  test("validates property names and literal compatibility with TypeChecker", async () => {
    const source = await scanSemanticSource(example);

    expect(() =>
      validatePredicateContext(
        { kind: "equals", property: ["status"], value: "active" },
        source,
      ),
    ).not.toThrow();
    expect(() =>
      validatePredicateContext(
        { kind: "equals", property: ["missing"], value: true },
        source,
      ),
    ).toThrow("does not exist");
    expect(() =>
      validatePredicateContext(
        { kind: "equals", property: ["status"], value: "unknown" },
        source,
      ),
    ).toThrow("not assignable");
    expect(() =>
      validatePredicateContext(
        { kind: "present", property: ["status"] },
        source,
      ),
    ).toThrow("only valid for nullable or optional");
  });

  test("resolves one imported concept into different typed bindings", async () => {
    const customer = await scanSemanticSource(polymorphicCustomer);
    const account = await scanSemanticSource(polymorphicAccount);

    expect(customer.concept.id).toBe("customer.active");
    expect(account.concept.id).toBe(customer.concept.id);
    expect(account.concept.hash).toBe(customer.concept.hash);
    expect(account.concept.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(account.concept.specification).toBe(customer.concept.specification);
    expect(account.concept.definitionPath).toBe(customer.concept.definitionPath);
    expect(customer.concept.shared).toBe(true);
    expect(account.concept.typeName).toBe("ServiceAccount");
    expect(customer.concept.typeName).toBe("CustomerRecord");
    expect(account.concept.typeDeclaration).toContain("enabled: boolean");
    expect(customer.concept.typeDeclaration).toContain('status: "active" | "suspended"');
  });
});
