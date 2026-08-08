import { BenchmarkShippableOrder } from "../concepts/shippable-order";
import { bindConcept, generatePredicate, benchmarkProbe } from "../../../src/dsl";

export type BenchmarkOpaqueOrder = {
  phase: string;
  flag: string | null;
  target: string | null;
};

const Bound = bindConcept<BenchmarkOpaqueOrder>(BenchmarkShippableOrder);
export const isBenchmarkOpaqueShippableOrder = generatePredicate(Bound);

// This intentionally opaque schema is expected to remain unresolved.
benchmarkProbe(isBenchmarkOpaqueShippableOrder);
