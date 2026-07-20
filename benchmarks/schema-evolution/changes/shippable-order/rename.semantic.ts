import { BenchmarkShippableOrder } from "../../../cross-schema/concepts/shippable-order";
import { bindConcept, generatePredicate, semanticTest } from "../../../../src/dsl";

export type EvolutionShippableOrderRename = {
  settlementState: "paid" | "pending";
  voidedAt: string | null;
  destination: string | null;
};

const Bound = bindConcept<EvolutionShippableOrderRename>(BenchmarkShippableOrder);
export const isEvolutionShippableOrderRename = generatePredicate(Bound);
semanticTest(isEvolutionShippableOrderRename, { accept: [], reject: [] });
