import { defineConcept } from "../../../src/dsl";

export const InventoryRecordReviewReady = defineConcept(
  "erp.inventory.review-ready",
)`
Definition:
An inventory count record ready for human review.

Requirements:
- The count state is counted.
- A SKU is present.
- A location code is present.

Exclusions:
- Records not yet counted.
- Records missing SKU or location identity.

Out of scope:
- Allocating, reserving, moving, or changing inventory.

Leave unresolved when:
- Count, SKU, or location roles cannot be mapped unambiguously.
`;
