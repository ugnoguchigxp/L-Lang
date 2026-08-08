import { ProductMasterReviewReady } from "../concepts/product-master-review-ready";
import { bindConcept, generatePredicate, semanticTest } from "../../../src/dsl";

export type ProductMasterReviewInput = {
  productCode: string | null;
  displayName: string | null;
  categoryCode: string | null;
  lifecycle: "draft" | "active" | "discontinued";
};

const BoundConcept = bindConcept<ProductMasterReviewInput>(
  ProductMasterReviewReady,
);

export const isProductMasterReviewReady = generatePredicate(BoundConcept);

semanticTest(isProductMasterReviewReady, {
  accept: [
    {
      productCode: "P-100",
      displayName: "Pilot product",
      categoryCode: "STANDARD",
      lifecycle: "draft",
    },
  ],
  reject: [
    {
      productCode: null,
      displayName: "Pilot product",
      categoryCode: "STANDARD",
      lifecycle: "draft",
    },
    {
      productCode: "P-100",
      displayName: "Pilot product",
      categoryCode: "STANDARD",
      lifecycle: "active",
    },
  ],
});
