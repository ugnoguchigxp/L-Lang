import { PriceRecordReviewReady } from "../concepts/price-record-review-ready";
import { bindConcept, generatePredicate, semanticTest } from "../../../src/dsl";

export type PriceReviewInput = {
  currencyCode: string | null;
  amountState: "missing" | "entered" | "invalid";
  taxCategoryCode: string | null;
};

const BoundConcept = bindConcept<PriceReviewInput>(PriceRecordReviewReady);

export const isPriceRecordReviewReady = generatePredicate(BoundConcept);

semanticTest(isPriceRecordReviewReady, {
  accept: [
    {
      currencyCode: "JPY",
      amountState: "entered",
      taxCategoryCode: "STANDARD",
    },
  ],
  reject: [
    {
      currencyCode: null,
      amountState: "entered",
      taxCategoryCode: "STANDARD",
    },
    {
      currencyCode: "JPY",
      amountState: "invalid",
      taxCategoryCode: "STANDARD",
    },
    {
      currencyCode: "JPY",
      amountState: "entered",
      taxCategoryCode: null,
    },
  ],
});
