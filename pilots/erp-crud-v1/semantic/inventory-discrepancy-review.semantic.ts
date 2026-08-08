import { InventoryDiscrepancyReview } from "../concepts/inventory-discrepancy-review";
import { bindConcept, generatePredicate, semanticTest } from "../../../src/dsl";

export type InventoryDiscrepancyReviewInput = {
  discrepancyState: "none" | "detected" | "unknown";
  countedBy: string | null;
};

const BoundConcept = bindConcept<InventoryDiscrepancyReviewInput>(
  InventoryDiscrepancyReview,
);

export const needsInventoryDiscrepancyReview = generatePredicate(BoundConcept);

semanticTest(needsInventoryDiscrepancyReview, {
  accept: [{ discrepancyState: "detected", countedBy: "reviewer-1" }],
  reject: [
    { discrepancyState: "none", countedBy: "reviewer-1" },
    { discrepancyState: "unknown", countedBy: "reviewer-1" },
    { discrepancyState: "detected", countedBy: null },
  ],
});
