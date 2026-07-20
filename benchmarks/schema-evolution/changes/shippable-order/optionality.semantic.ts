import { BenchmarkShippableOrder } from "../../../cross-schema/concepts/shippable-order";
import { bindConcept, generatePredicate, semanticTest } from "../../../../src/dsl";

export type EvolutionShippableOrderOptionality = {
  paymentStatus: "paid" | "pending";
  cancelledAt: string | null;
  shippingAddress?: string;
};

const Bound = bindConcept<EvolutionShippableOrderOptionality>(BenchmarkShippableOrder);
export const isEvolutionShippableOrderOptionality = generatePredicate(Bound);
semanticTest(isEvolutionShippableOrderOptionality, { accept: [], reject: [] });
