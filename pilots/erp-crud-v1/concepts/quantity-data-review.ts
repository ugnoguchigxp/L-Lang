import { defineConcept } from "../../../src/dsl";

export const QuantityDataReview = defineConcept(
  "erp.quantity.needs-data-review",
)`
Definition:
A quantity record that should be shown to a human for data-quality review.

Requirements:
- The Exact Code quantity state is invalid, or the unit code is absent.

Exclusions:
- Records with a valid or unknown quantity state and a present unit code.

Out of scope:
- Calculating, allocating, reserving, or changing a quantity.

Leave unresolved when:
- Quantity validation state or unit roles cannot be mapped unambiguously.
`;
