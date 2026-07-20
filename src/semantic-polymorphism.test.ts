import { describe, expect, test } from "bun:test";

import { validatePredicateContext } from "./context-validator";
import type { PredicateExpression } from "./ir";
import { parseElaborationResult, parseOpenAIResponse } from "./openai";
import { scanSemanticSource } from "./semantic-source";

const cases = {
  customer: example("customer"),
  account: example("account"),
  ambiguous: example("ambiguous"),
};

describe("semantic polymorphism", () => {
  test("elaborates one concept into schema-specific predicates", async () => {
    const customerSource = await scanSemanticSource(cases.customer.source);
    const accountSource = await scanSemanticSource(cases.account.source);
    const customer = await readFixture(cases.customer.fixture);
    const account = await readFixture(cases.account.fixture);

    expect(customer.outcome).toBe("resolved");
    expect(account.outcome).toBe("resolved");
    if (customer.outcome !== "resolved" || account.outcome !== "resolved") return;

    validatePredicateContext(customer.body, customerSource);
    validatePredicateContext(account.body, accountSource);
    expect(customerSource.concept.id).toBe("customer.active");
    expect(accountSource.concept.hash).toBe(customerSource.concept.hash);
    expect(propertyNames(customer.body)).toEqual(["status", "deletedAt", "email"]);
    expect(propertyNames(account.body)).toEqual([
      "enabled",
      "blockedAt",
      "contactAddress",
    ]);
  });

  test("keeps an opaque schema unresolved instead of guessing", async () => {
    const ambiguous = await readFixture(cases.ambiguous.fixture);

    expect(ambiguous.outcome).toBe("unresolved");
    expect(ambiguous.body).toBeNull();
    expect(ambiguous.diagnostics.join(" ")).toContain("Cannot determine");
  });
});

function example(name: string): { source: string; fixture: string } {
  const directory = new URL(
    `../examples/semantic-polymorphism/${name}/`,
    import.meta.url,
  );
  return {
    source: new URL("semantic.ts", directory).pathname,
    fixture: new URL("openai-response.fixture.json", directory).pathname,
  };
}

async function readFixture(path: string) {
  const response = parseOpenAIResponse(
    JSON.parse(await Bun.file(path).text()) as unknown,
  );
  return parseElaborationResult(JSON.parse(response.outputText) as unknown);
}

function propertyNames(expression: PredicateExpression): string[] {
  switch (expression.kind) {
    case "all":
    case "any":
      return expression.conditions.flatMap(propertyNames);
    case "not":
      return propertyNames(expression.condition);
    case "equals":
    case "present":
      return [expression.property.join(".")];
  }
}
