import { BenchmarkActiveCustomer } from "../concepts/active-customer";
import { bindConcept, generatePredicate, benchmarkProbe } from "../../../src/dsl";

export type BenchmarkOpaqueCustomer = {
  mode: string;
  marker: string | null;
  channel: string | null;
};

const Bound = bindConcept<BenchmarkOpaqueCustomer>(BenchmarkActiveCustomer);
export const isBenchmarkOpaqueActiveCustomer = generatePredicate(Bound);

// This intentionally opaque schema is expected to remain unresolved.
benchmarkProbe(isBenchmarkOpaqueActiveCustomer);
