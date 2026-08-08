import { QuantityDataReview } from "../concepts/quantity-data-review";
import { bindConcept, generatePredicate, semanticTest } from "../../../src/dsl";

export type QuantityReviewV2 = {
  validation: { state: "valid" | "invalid" | "unknown" };
  measurement: { unit: string | null };
};

const BoundConcept = bindConcept<QuantityReviewV2>(QuantityDataReview);

export const needsQuantityDataReviewV2 = generatePredicate(BoundConcept);

semanticTest(needsQuantityDataReviewV2, {
  accept: [
    { validation: { state: "invalid" }, measurement: { unit: "EA" } },
    { validation: { state: "valid" }, measurement: { unit: null } },
  ],
  reject: [{ validation: { state: "valid" }, measurement: { unit: "EA" } }],
});
