import { BenchmarkActiveCustomer } from "../../../cross-schema/concepts/active-customer";
import { bindConcept, generatePredicate, semanticTest } from "../../../../src/dsl";

export type EvolutionActiveCustomerRename = {
  lifecycle: "active" | "suspended";
  removedAt: string | null;
  contactAddress: string | null;
};

const Bound = bindConcept<EvolutionActiveCustomerRename>(BenchmarkActiveCustomer);
export const isEvolutionActiveCustomerRename = generatePredicate(Bound);
semanticTest(isEvolutionActiveCustomerRename, { accept: [], reject: [] });
