import { BenchmarkActiveCustomer } from "../concepts/active-customer";
import { bindConcept, generatePredicate, semanticTest } from "../../../src/dsl";

export type BenchmarkServiceAccount = {
  serviceEnabled: boolean;
  blockedAt: string | null;
  primaryEmail: string | null;
};

const Bound = bindConcept<BenchmarkServiceAccount>(BenchmarkActiveCustomer);
export const isBenchmarkActiveServiceAccount = generatePredicate(Bound);

// Benchmark oracle cases live outside this source and are never sent to the model.
semanticTest(isBenchmarkActiveServiceAccount, { accept: [], reject: [] });
