import { BenchmarkActiveCustomer } from "../../../cross-schema/concepts/active-customer";
import { bindConcept, generatePredicate, semanticTest } from "../../../../src/dsl";

export type EvolutionActiveCustomerAddProperty = {
  status: "active" | "suspended";
  deletedAt: string | null;
  email: string | null;
  loyaltyTier: "standard" | "gold";
};

const Bound = bindConcept<EvolutionActiveCustomerAddProperty>(BenchmarkActiveCustomer);
export const isEvolutionActiveCustomerAddProperty = generatePredicate(Bound);
semanticTest(isEvolutionActiveCustomerAddProperty, { accept: [], reject: [] });
