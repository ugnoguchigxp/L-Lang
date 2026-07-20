import { BenchmarkActiveCustomer } from "../concepts/active-customer";
import { bindConcept, generatePredicate, semanticTest } from "../../../src/dsl";

export type BenchmarkOpaqueCustomer = {
  mode: string;
  marker: string | null;
  channel: string | null;
};

const Bound = bindConcept<BenchmarkOpaqueCustomer>(BenchmarkActiveCustomer);
export const isBenchmarkOpaqueActiveCustomer = generatePredicate(Bound);

// This intentionally opaque schema is expected to remain unresolved.
semanticTest(isBenchmarkOpaqueActiveCustomer, { accept: [], reject: [] });
