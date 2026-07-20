import { BenchmarkShippableOrder } from "../../../cross-schema/concepts/shippable-order";
import { bindConcept, generatePredicate, semanticTest } from "../../../../src/dsl";

export type EvolutionShippableOrderAmbiguity = {
  paymentStateA: "paid" | "pending";
  paymentStateB: "paid" | "pending";
  cancelledAt: string | null;
  shippingAddress: string | null;
};

const Bound = bindConcept<EvolutionShippableOrderAmbiguity>(BenchmarkShippableOrder);
export const isEvolutionShippableOrderAmbiguity = generatePredicate(Bound);
semanticTest(isEvolutionShippableOrderAmbiguity, { accept: [], reject: [] });
