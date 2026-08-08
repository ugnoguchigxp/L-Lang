import { ProductArchiveReviewCandidate } from "../concepts/product-archive-review-candidate";
import { bindConcept, generatePredicate, semanticTest } from "../../../src/dsl";

export type ProductArchiveReviewInput = {
  lifecycle: "draft" | "active" | "discontinued";
  inventoryState: "zero" | "remaining" | "unknown";
  openShipmentState: "none" | "present" | "unknown";
};

const BoundConcept = bindConcept<ProductArchiveReviewInput>(
  ProductArchiveReviewCandidate,
);

export const isProductArchiveReviewCandidate = generatePredicate(BoundConcept);

semanticTest(isProductArchiveReviewCandidate, {
  accept: [
    {
      lifecycle: "discontinued",
      inventoryState: "zero",
      openShipmentState: "none",
    },
  ],
  reject: [
    {
      lifecycle: "active",
      inventoryState: "zero",
      openShipmentState: "none",
    },
    {
      lifecycle: "discontinued",
      inventoryState: "remaining",
      openShipmentState: "none",
    },
    {
      lifecycle: "discontinued",
      inventoryState: "zero",
      openShipmentState: "present",
    },
  ],
});
