import { ShipmentPreparationReviewReady } from "../concepts/shipment-preparation-review-ready";
import { bindConcept, generatePredicate, semanticTest } from "../../../src/dsl";

export type ShipmentPreparationReviewInput = {
  lifecycle: "draft" | "queued" | "preparing" | "shipped";
  destinationCode: string | null;
  addressValidation: "valid" | "invalid" | "unknown";
  inventoryPreparation: "ready" | "not_ready" | "unknown";
};

const BoundConcept = bindConcept<ShipmentPreparationReviewInput>(
  ShipmentPreparationReviewReady,
);

export const isShipmentPreparationReviewReady = generatePredicate(BoundConcept);

semanticTest(isShipmentPreparationReviewReady, {
  accept: [
    {
      lifecycle: "queued",
      destinationCode: "TOKYO",
      addressValidation: "valid",
      inventoryPreparation: "ready",
    },
  ],
  reject: [
    {
      lifecycle: "draft",
      destinationCode: "TOKYO",
      addressValidation: "valid",
      inventoryPreparation: "ready",
    },
    {
      lifecycle: "queued",
      destinationCode: null,
      addressValidation: "valid",
      inventoryPreparation: "ready",
    },
    {
      lifecycle: "queued",
      destinationCode: "TOKYO",
      addressValidation: "invalid",
      inventoryPreparation: "ready",
    },
    {
      lifecycle: "queued",
      destinationCode: "TOKYO",
      addressValidation: "valid",
      inventoryPreparation: "not_ready",
    },
  ],
});
