import { BenchmarkActiveCustomer } from "../../../cross-schema/concepts/active-customer";
import { bindConcept, generatePredicate, semanticTest } from "../../../../src/dsl";

export type EvolutionActiveCustomerOptionality = {
  status: "active" | "suspended";
  deletedAt: string | null;
  email?: string;
};

const Bound = bindConcept<EvolutionActiveCustomerOptionality>(BenchmarkActiveCustomer);
export const isEvolutionActiveCustomerOptionality = generatePredicate(Bound);
semanticTest(isEvolutionActiveCustomerOptionality, { accept: [], reject: [] });
