import { ProductMasterReviewReady } from "../concepts/product-master-review-ready";
import { bindConcept, generatePredicate, semanticTest } from "../../../src/dsl";

export type ProductMasterReviewV2 = {
  identity: {
    code: string | null;
    name: string | null;
    category: string | null;
  };
  state: "draft" | "active" | "discontinued";
};

const BoundConcept = bindConcept<ProductMasterReviewV2>(
  ProductMasterReviewReady,
);

export const isProductMasterReviewReadyV2 = generatePredicate(BoundConcept);

semanticTest(isProductMasterReviewReadyV2, {
  accept: [
    {
      identity: { code: "P-100", name: "Pilot product", category: "STANDARD" },
      state: "draft",
    },
  ],
  reject: [
    {
      identity: { code: null, name: "Pilot product", category: "STANDARD" },
      state: "draft",
    },
    {
      identity: { code: "P-100", name: "Pilot product", category: "STANDARD" },
      state: "active",
    },
  ],
});
