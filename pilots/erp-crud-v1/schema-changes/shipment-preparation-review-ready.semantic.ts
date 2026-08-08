import { ShipmentPreparationReviewReady } from "../concepts/shipment-preparation-review-ready";
import { bindConcept, generatePredicate, semanticTest } from "../../../src/dsl";

export type ShipmentPreparationReviewV2 = {
  workflow: { status: "draft" | "queued" | "preparing" | "shipped" };
  destination: {
    code: string | null;
    validation: "valid" | "invalid" | "unknown";
  };
  inventory: { status: "ready" | "not_ready" | "unknown" };
};

const BoundConcept = bindConcept<ShipmentPreparationReviewV2>(
  ShipmentPreparationReviewReady,
);

export const isShipmentPreparationReviewReadyV2 =
  generatePredicate(BoundConcept);

semanticTest(isShipmentPreparationReviewReadyV2, {
  accept: [
    {
      workflow: { status: "queued" },
      destination: { code: "TOKYO", validation: "valid" },
      inventory: { status: "ready" },
    },
  ],
  reject: [
    {
      workflow: { status: "draft" },
      destination: { code: "TOKYO", validation: "valid" },
      inventory: { status: "ready" },
    },
    {
      workflow: { status: "queued" },
      destination: { code: null, validation: "valid" },
      inventory: { status: "ready" },
    },
  ],
});
