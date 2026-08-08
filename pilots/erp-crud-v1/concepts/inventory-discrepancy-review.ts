import { defineConcept } from "../../../src/dsl";

export const InventoryDiscrepancyReview = defineConcept(
  "erp.inventory.needs-discrepancy-review",
)`
Definition:
An inventory discrepancy fact that should be shown to a human for review.

Requirements:
- Exact Code reports that a discrepancy was detected.
- The counter identity is present.

Exclusions:
- No discrepancy or an unknown discrepancy state.
- A detected discrepancy without counter identity.

Out of scope:
- Calculating the discrepancy, changing stock, or allocating inventory.

Leave unresolved when:
- Discrepancy state or counter identity cannot be mapped unambiguously.
`;
