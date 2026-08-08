import { InventoryRecordReviewReady } from "../concepts/inventory-record-review-ready";
import { bindConcept, generatePredicate, semanticTest } from "../../../src/dsl";

export type InventoryReviewInput = {
  sku: string | null;
  locationCode: string | null;
  countState: "not_counted" | "counted";
};

const BoundConcept = bindConcept<InventoryReviewInput>(
  InventoryRecordReviewReady,
);

export const isInventoryRecordReviewReady = generatePredicate(BoundConcept);

semanticTest(isInventoryRecordReviewReady, {
  accept: [{ sku: "SKU-100", locationCode: "TOKYO", countState: "counted" }],
  reject: [
    { sku: "SKU-100", locationCode: "TOKYO", countState: "not_counted" },
    { sku: null, locationCode: "TOKYO", countState: "counted" },
    { sku: "SKU-100", locationCode: null, countState: "counted" },
  ],
});
