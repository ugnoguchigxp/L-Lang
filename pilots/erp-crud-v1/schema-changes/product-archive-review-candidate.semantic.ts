import { ProductArchiveReviewCandidate } from "../concepts/product-archive-review-candidate";
import { bindConcept, generatePredicate, semanticTest } from "../../../src/dsl";

export type ProductArchiveReviewV2 = {
  status: "draft" | "active" | "discontinued";
  stock: { state: "zero" | "remaining" | "unknown" };
  shipping: { openWork: "none" | "present" | "unknown" };
};

const BoundConcept = bindConcept<ProductArchiveReviewV2>(
  ProductArchiveReviewCandidate,
);

export const isProductArchiveReviewCandidateV2 =
  generatePredicate(BoundConcept);

semanticTest(isProductArchiveReviewCandidateV2, {
  accept: [
    {
      status: "discontinued",
      stock: { state: "zero" },
      shipping: { openWork: "none" },
    },
  ],
  reject: [
    {
      status: "active",
      stock: { state: "zero" },
      shipping: { openWork: "none" },
    },
    {
      status: "discontinued",
      stock: { state: "remaining" },
      shipping: { openWork: "none" },
    },
  ],
});
