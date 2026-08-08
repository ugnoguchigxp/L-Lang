import { InventoryDiscrepancyReview } from "../concepts/inventory-discrepancy-review";
import { bindConcept, generatePredicate, semanticTest } from "../../../src/dsl";

export type InventoryDiscrepancyReviewV2 = {
  variance: { status: "none" | "detected" | "unknown" };
  audit: { countedBy: string | null };
};

const BoundConcept = bindConcept<InventoryDiscrepancyReviewV2>(
  InventoryDiscrepancyReview,
);

export const needsInventoryDiscrepancyReviewV2 =
  generatePredicate(BoundConcept);

semanticTest(needsInventoryDiscrepancyReviewV2, {
  accept: [
    {
      variance: { status: "detected" },
      audit: { countedBy: "reviewer-1" },
    },
  ],
  reject: [
    {
      variance: { status: "none" },
      audit: { countedBy: "reviewer-1" },
    },
    {
      variance: { status: "detected" },
      audit: { countedBy: null },
    },
  ],
});
