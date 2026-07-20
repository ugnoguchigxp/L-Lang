import { BenchmarkActiveCustomer } from "../concepts/active-customer";
import { bindConcept, generatePredicate, semanticTest } from "../../../src/dsl";

export type BenchmarkCustomerRecord = {
  status: "active" | "suspended";
  deletedAt: string | null;
  email: string | null;
};

const Bound = bindConcept<BenchmarkCustomerRecord>(BenchmarkActiveCustomer);
export const isBenchmarkActiveCustomer = generatePredicate(Bound);

// Benchmark oracle cases live outside this source and are never sent to the model.
semanticTest(isBenchmarkActiveCustomer, { accept: [], reject: [] });
