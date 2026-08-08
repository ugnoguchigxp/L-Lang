import { PriceRecordReviewReady } from "../concepts/price-record-review-ready";
import { bindConcept, generatePredicate, semanticTest } from "../../../src/dsl";

export type PriceReviewV2 = {
  money: {
    currency: string | null;
    validation: "missing" | "entered" | "invalid";
  };
  tax: { category: string | null };
};

const BoundConcept = bindConcept<PriceReviewV2>(PriceRecordReviewReady);

export const isPriceRecordReviewReadyV2 = generatePredicate(BoundConcept);

semanticTest(isPriceRecordReviewReadyV2, {
  accept: [
    {
      money: { currency: "JPY", validation: "entered" },
      tax: { category: "STANDARD" },
    },
  ],
  reject: [
    {
      money: { currency: null, validation: "entered" },
      tax: { category: "STANDARD" },
    },
    {
      money: { currency: "JPY", validation: "invalid" },
      tax: { category: "STANDARD" },
    },
  ],
});
