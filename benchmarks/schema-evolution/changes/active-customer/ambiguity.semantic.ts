import { BenchmarkActiveCustomer } from "../../../cross-schema/concepts/active-customer";
import { bindConcept, generatePredicate, semanticTest } from "../../../../src/dsl";

export type EvolutionActiveCustomerAmbiguity = {
  accountStateA: "active" | "suspended";
  accountStateB: "active" | "suspended";
  deletedAt: string | null;
  email: string | null;
};

const Bound = bindConcept<EvolutionActiveCustomerAmbiguity>(BenchmarkActiveCustomer);
export const isEvolutionActiveCustomerAmbiguity = generatePredicate(Bound);
semanticTest(isEvolutionActiveCustomerAmbiguity, { accept: [], reject: [] });
