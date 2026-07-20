import { BenchmarkShippableOrder } from "../../../cross-schema/concepts/shippable-order";
import { bindConcept, generatePredicate, semanticTest } from "../../../../src/dsl";

export type EvolutionShippableOrderRemoveRole = {
  paymentStatus: "paid" | "pending";
  cancelledAt: string | null;
  orderId: string;
};

const Bound = bindConcept<EvolutionShippableOrderRemoveRole>(BenchmarkShippableOrder);
export const isEvolutionShippableOrderRemoveRole = generatePredicate(Bound);
semanticTest(isEvolutionShippableOrderRemoveRole, { accept: [], reject: [] });
