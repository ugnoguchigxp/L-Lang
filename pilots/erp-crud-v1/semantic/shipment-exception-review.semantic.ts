import { ShipmentExceptionReview } from "../concepts/shipment-exception-review";
import { bindConcept, generatePredicate, semanticTest } from "../../../src/dsl";

export type ShipmentExceptionReviewInput = {
  exceptionState: "none" | "open";
  assigneeId: string | null;
};

const BoundConcept = bindConcept<ShipmentExceptionReviewInput>(
  ShipmentExceptionReview,
);

export const needsShipmentExceptionReview = generatePredicate(BoundConcept);

semanticTest(needsShipmentExceptionReview, {
  accept: [{ exceptionState: "open", assigneeId: "operator-1" }],
  reject: [
    { exceptionState: "none", assigneeId: "operator-1" },
    { exceptionState: "open", assigneeId: null },
  ],
});
