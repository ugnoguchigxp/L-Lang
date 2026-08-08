import { ShipmentExceptionReview } from "../concepts/shipment-exception-review";
import { bindConcept, generatePredicate, semanticTest } from "../../../src/dsl";

export type ShipmentExceptionReviewV2 = {
  exception: { status: "none" | "open" };
  ownership: { assigneeId: string | null };
};

const BoundConcept = bindConcept<ShipmentExceptionReviewV2>(
  ShipmentExceptionReview,
);

export const needsShipmentExceptionReviewV2 = generatePredicate(BoundConcept);

semanticTest(needsShipmentExceptionReviewV2, {
  accept: [
    { exception: { status: "open" }, ownership: { assigneeId: "operator-1" } },
  ],
  reject: [
    { exception: { status: "none" }, ownership: { assigneeId: "operator-1" } },
    { exception: { status: "open" }, ownership: { assigneeId: null } },
  ],
});
