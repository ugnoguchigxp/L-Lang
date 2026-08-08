import { InventoryRecordReviewReady } from "../concepts/inventory-record-review-ready";
import { bindConcept, generatePredicate, semanticTest } from "../../../src/dsl";

export type InventoryReviewV2 = {
  item: { sku: string | null };
  site: { code: string | null };
  count: { lifecycle: "not_counted" | "counted" };
};

const BoundConcept = bindConcept<InventoryReviewV2>(InventoryRecordReviewReady);

export const isInventoryRecordReviewReadyV2 = generatePredicate(BoundConcept);

semanticTest(isInventoryRecordReviewReadyV2, {
  accept: [
    {
      item: { sku: "SKU-100" },
      site: { code: "TOKYO" },
      count: { lifecycle: "counted" },
    },
  ],
  reject: [
    {
      item: { sku: "SKU-100" },
      site: { code: "TOKYO" },
      count: { lifecycle: "not_counted" },
    },
    {
      item: { sku: null },
      site: { code: "TOKYO" },
      count: { lifecycle: "counted" },
    },
  ],
});
