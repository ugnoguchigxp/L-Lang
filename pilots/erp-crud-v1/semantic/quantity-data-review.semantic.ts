import { QuantityDataReview } from "../concepts/quantity-data-review";
import { bindConcept, generatePredicate, semanticTest } from "../../../src/dsl";

export type QuantityReviewInput = {
  quantityState: "valid" | "invalid" | "unknown";
  unitCode: string | null;
};

const BoundConcept = bindConcept<QuantityReviewInput>(QuantityDataReview);

export const needsQuantityDataReview = generatePredicate(BoundConcept);

semanticTest(needsQuantityDataReview, {
  accept: [
    { quantityState: "invalid", unitCode: "EA" },
    { quantityState: "valid", unitCode: null },
  ],
  reject: [
    { quantityState: "valid", unitCode: "EA" },
    { quantityState: "unknown", unitCode: "EA" },
  ],
});
