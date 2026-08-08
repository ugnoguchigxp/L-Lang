import { defineConcept } from "../../../src/dsl";

export const ProductMasterReviewReady = defineConcept(
  "erp.product-master.review-ready",
)`
Definition:
A draft product master record ready for human review.

Requirements:
- The lifecycle is draft.
- A product code is present.
- A display name is present.
- A category code is present.

Exclusions:
- Active or discontinued product records.
- Records missing any required review identity.

Out of scope:
- Publishing, approving, deleting, or pricing a product.

Leave unresolved when:
- The schema cannot map product identity and lifecycle roles unambiguously.
`;
