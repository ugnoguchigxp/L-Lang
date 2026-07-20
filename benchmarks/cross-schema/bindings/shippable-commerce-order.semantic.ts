import { BenchmarkShippableOrder } from "../concepts/shippable-order";
import { bindConcept, generatePredicate, semanticTest } from "../../../src/dsl";

export type BenchmarkCommerceOrder = {
  paymentStatus: "paid" | "pending";
  cancelledAt: string | null;
  shippingAddress: string | null;
};

const Bound = bindConcept<BenchmarkCommerceOrder>(BenchmarkShippableOrder);
export const isBenchmarkShippableOrder = generatePredicate(Bound);

// Benchmark oracle cases live outside this source and are never sent to the model.
semanticTest(isBenchmarkShippableOrder, { accept: [], reject: [] });
