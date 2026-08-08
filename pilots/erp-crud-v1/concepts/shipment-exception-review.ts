import { defineConcept } from "../../../src/dsl";

export const ShipmentExceptionReview = defineConcept(
  "erp.shipment.needs-exception-review",
)`
Definition:
An open shipment exception assigned for human review.

Requirements:
- The exception state is open.
- An assignee identity is present.

Exclusions:
- Shipments without an exception.
- Unassigned open exceptions.

Out of scope:
- Resolving an exception, changing shipment state, or contacting an external system.

Leave unresolved when:
- Exception state or assignee identity cannot be mapped unambiguously.
`;
