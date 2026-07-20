import { BenchmarkActiveCustomer } from "../../../cross-schema/concepts/active-customer";
import { bindConcept, generatePredicate, semanticTest } from "../../../../src/dsl";

export type EvolutionActiveCustomerRemoveRole = {
  status: "active" | "suspended";
  deletedAt: string | null;
  customerId: string;
};

const Bound = bindConcept<EvolutionActiveCustomerRemoveRole>(BenchmarkActiveCustomer);
export const isEvolutionActiveCustomerRemoveRole = generatePredicate(Bound);
semanticTest(isEvolutionActiveCustomerRemoveRole, { accept: [], reject: [] });
