import { defineConcept } from "../../../src/dsl";

export const ShipmentPreparationReviewReady = defineConcept(
  "erp.shipment.preparation-review-ready",
)`
Definition:
A queued shipment whose derived facts are ready for human preparation review.

Requirements:
- The shipment lifecycle is queued.
- A destination code is present.
- Address validation is valid.
- Inventory preparation is ready.

Exclusions:
- Shipments outside the queued lifecycle.
- Missing destination, invalid or unknown address, or inventory not ready.

Out of scope:
- Reserving inventory, confirming shipment, dispatching goods, or calling a carrier.

Leave unresolved when:
- Shipment lifecycle, destination, address, or inventory roles cannot be mapped unambiguously.
`;
