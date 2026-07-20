import { BenchmarkShippableOrder } from "../../../cross-schema/concepts/shippable-order";
import { bindConcept, generatePredicate, semanticTest } from "../../../../src/dsl";

export type EvolutionShippableOrderRepresentation = {
  paymentCaptured: boolean;
  cancelled: boolean;
  shippingAddress: string | null;
};

const Bound = bindConcept<EvolutionShippableOrderRepresentation>(BenchmarkShippableOrder);
export const isEvolutionShippableOrderRepresentation = generatePredicate(Bound);
semanticTest(isEvolutionShippableOrderRepresentation, { accept: [], reject: [] });
