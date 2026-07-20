import { BenchmarkActiveCustomer } from "../../../cross-schema/concepts/active-customer";
import { bindConcept, generatePredicate, semanticTest } from "../../../../src/dsl";

export type EvolutionActiveCustomerRepresentation = {
  enabled: boolean;
  deleted: boolean;
  email: string | null;
};

const Bound = bindConcept<EvolutionActiveCustomerRepresentation>(BenchmarkActiveCustomer);
export const isEvolutionActiveCustomerRepresentation = generatePredicate(Bound);
semanticTest(isEvolutionActiveCustomerRepresentation, { accept: [], reject: [] });
