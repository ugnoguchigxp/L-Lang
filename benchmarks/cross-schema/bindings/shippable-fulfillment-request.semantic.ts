import { BenchmarkShippableOrder } from "../concepts/shippable-order";
import { bindConcept, generatePredicate, semanticTest } from "../../../src/dsl";

export type BenchmarkFulfillmentRequest = {
  paymentCaptured: boolean;
  voidedAt: string | null;
  destinationCode: string | null;
};

const Bound = bindConcept<BenchmarkFulfillmentRequest>(BenchmarkShippableOrder);
export const isBenchmarkShippableRequest = generatePredicate(Bound);

// Benchmark oracle cases live outside this source and are never sent to the model.
semanticTest(isBenchmarkShippableRequest, { accept: [], reject: [] });
