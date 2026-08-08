import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { validatePredicateContext } from "./context-validator";
import { scanBenchmarkSource, scanSemanticSource } from "./semantic-source";

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
const structuredFulfillment = new URL(
  "../examples/order-fulfillment/storefront/semantic.ts",
  import.meta.url,
).pathname;
const benchmarkProbe = new URL(
  "../benchmarks/cross-schema/bindings/active-customer-record.semantic.ts",
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
    expect(source.tests.boundarySource).toContain(
      "empty-email-is-still-present",
    );
    expect(source.tests.counterfactualSource).toContain(
      "suspension-changes-eligibility",
    );
    expect(source.tests.invarianceSource).toContain("contact-address-spelling");
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
    expect(account.concept.definitionPath).toBe(
      customer.concept.definitionPath,
    );
    expect(customer.concept.shared).toBe(true);
    expect(account.concept.typeName).toBe("ServiceAccount");
    expect(customer.concept.typeName).toBe("CustomerRecord");
    expect(account.concept.typeDeclaration).toContain("enabled: boolean");
    expect(customer.concept.typeDeclaration).toContain(
      'status: "active" | "suspended"',
    );
  });

  test("parses a shared fixed-section Concept into a canonical specification", async () => {
    const source = await scanSemanticSource(structuredFulfillment);

    expect(source.concept.structure).toMatchObject({
      requirements: [
        expect.stringContaining("payment or authorization"),
        expect.stringContaining("delivery destination"),
      ],
      exclusions: [
        expect.stringContaining("cancellation"),
        expect.stringContaining("hold"),
        expect.stringContaining("void"),
      ],
    });
    expect(source.concept.specification).toContain("Requirements:\n-");
    expect(source.concept.specification).toContain("Out of scope:\n-");
    expect(source.concept.specification).toContain("Leave unresolved when:\n-");
  });

  test("isolates benchmarkProbe from normal semantic sources", async () => {
    const source = await scanBenchmarkSource(benchmarkProbe);

    expect(source.sourceForm).toBe("benchmark-probe");
    expect(source.probe.predicateName).toBe("isBenchmarkActiveCustomer");
    await expect(scanSemanticSource(benchmarkProbe)).rejects.toThrow(
      "benchmarkProbe is restricted to research benchmark runners",
    );
    await expect(scanBenchmarkSource(example)).rejects.toThrow(
      "research benchmark sources must use benchmarkProbe instead of semanticTest",
    );
  });

  test("parses boundary, counterfactual, and invariance sections", async () => {
    const source = await scanTemporarySource(`
      semanticTest(isCustomer, {
        accept: [{ state: "ready", profile: { score: 1 } }],
        reject: [{ state: "waiting", profile: { score: 0 } }],
        boundary: [
          {
            name: "ready-boundary",
            input: { state: "ready", profile: { score: 0 } },
            expected: "accepted",
          },
        ],
        counterfactual: [
          {
            name: "state-change",
            base: {
              input: { state: "ready", profile: { score: 1 } },
              expected: "accepted",
            },
            variants: [
              {
                name: "waiting",
                input: { state: "waiting", profile: { score: 1 } },
                expected: "rejected",
              },
            ],
          },
        ],
        invariance: [
          {
            name: "score-does-not-change-result",
            expected: "accepted",
            inputs: [
              { state: "ready", profile: { score: 1 } },
              { state: "ready", profile: { score: 2 } },
            ],
          },
        ],
      });
    `);

    expect(source.tests.boundarySource).toContain("ready-boundary");
    expect(source.tests.counterfactualSource).toContain("state-change");
    expect(source.tests.invarianceSource).toContain(
      "score-does-not-change-result",
    );
  });

  test("rejects malformed advanced semantic test sections", async () => {
    for (const invalid of [
      {
        name: "unknown field",
        cases: `accept: [{ state: "ready" }], reject: [{ state: "waiting" }], extra: []`,
        message: "semanticTest contains unknown field extra",
      },
      {
        name: "non-array boundary",
        cases: `accept: [{ state: "ready" }], reject: [{ state: "waiting" }], boundary: true`,
        message: "semanticTest.boundary must be an array literal",
      },
      {
        name: "duplicate boundary name",
        cases: `accept: [{ state: "ready" }], reject: [{ state: "waiting" }], boundary: [{ name: "same", input: { state: "ready" }, expected: "accepted" }, { name: "same", input: { state: "ready" }, expected: "accepted" }]`,
        message: "semanticTest.boundary contains duplicate name same",
      },
      {
        name: "empty counterfactual variants",
        cases: `accept: [{ state: "ready" }], reject: [{ state: "waiting" }], counterfactual: [{ name: "change", base: { input: { state: "ready" }, expected: "accepted" }, variants: [] }]`,
        message:
          "semanticTest.counterfactual[0].variants must be a non-empty array literal",
      },
      {
        name: "empty invariance inputs",
        cases: `accept: [{ state: "ready" }], reject: [{ state: "waiting" }], invariance: [{ name: "same", expected: "accepted", inputs: [] }]`,
        message:
          "semanticTest.invariance[0].inputs must be a non-empty array literal",
      },
    ]) {
      await expect(
        scanTemporarySource(`semanticTest(isCustomer, { ${invalid.cases} });`),
      ).rejects.toThrow(invalid.message);
    }
  });
});

async function scanTemporarySource(cases: string) {
  const root = await mkdtemp(resolve(tmpdir(), "l-lang-semantic-source-"));
  const sourcePath = resolve(root, "semantic.ts");
  await writeFile(
    resolve(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        skipLibCheck: true,
      },
    }),
    "utf8",
  );
  await writeFile(sourcePath, renderTemporarySource(cases), "utf8");
  try {
    return await scanSemanticSource(sourcePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function renderTemporarySource(cases: string): string {
  return `
    type Concept<T> = { readonly input?: T };
    type Predicate<T> = (value: T) => boolean;
    declare function concept<T>(strings: TemplateStringsArray): Concept<T>;
    declare function generatePredicate<T>(concept: Concept<T>): Predicate<T>;
    declare function semanticTest<T>(predicate: Predicate<T>, cases: unknown): void;
    type Customer = { state: "ready" | "waiting"; profile: { score: number } };
    const CustomerConcept = concept<Customer>\`
      Definition:
      A customer with a state.

      Requirements:
      - The customer has a state.
    \`;
    const isCustomer = generatePredicate(CustomerConcept);
    ${cases}
  `;
}
