import { defineConcept } from "../../../src/dsl";

export const ProductArchiveReviewCandidate = defineConcept(
  "erp.product-master.archive-review-candidate",
)`
Definition:
A product master record that should be shown to a human as an archive review candidate.

Requirements:
- The product lifecycle is discontinued.
- The derived inventory state is zero.
- The derived open shipment state is none.

Exclusions:
- Products with remaining or unknown inventory.
- Products with present or unknown open shipments.

Out of scope:
- Deleting, archiving, or mutating a product record.

Leave unresolved when:
- Lifecycle, inventory state, or shipment state cannot be mapped unambiguously.
`;
