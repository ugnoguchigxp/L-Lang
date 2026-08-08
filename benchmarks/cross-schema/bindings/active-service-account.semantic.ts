import { BenchmarkActiveCustomer } from "../concepts/active-customer";
import { bindConcept, generatePredicate, benchmarkProbe } from "../../../src/dsl";

export type BenchmarkServiceAccount = {
  serviceEnabled: boolean;
  blockedAt: string | null;
  primaryEmail: string | null;
};

const Bound = bindConcept<BenchmarkServiceAccount>(BenchmarkActiveCustomer);
export const isBenchmarkActiveServiceAccount = generatePredicate(Bound);

// Benchmark oracle cases live outside this source and are never sent to the model.
benchmarkProbe(isBenchmarkActiveServiceAccount);
