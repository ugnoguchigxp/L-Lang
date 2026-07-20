import { BenchmarkShippableOrder } from "../../../cross-schema/concepts/shippable-order";
import { bindConcept, generatePredicate, semanticTest } from "../../../../src/dsl";

export type EvolutionShippableOrderAddProperty = {
  paymentStatus: "paid" | "pending";
  cancelledAt: string | null;
  shippingAddress: string | null;
  warehouseId: string;
};

const Bound = bindConcept<EvolutionShippableOrderAddProperty>(BenchmarkShippableOrder);
export const isEvolutionShippableOrderAddProperty = generatePredicate(Bound);
semanticTest(isEvolutionShippableOrderAddProperty, { accept: [], reject: [] });
