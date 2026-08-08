import { defineConcept } from "../../../src/dsl";

export const PriceRecordReviewReady = defineConcept("erp.price.review-ready")`
Definition:
A price record whose entered facts are ready for human review.

Requirements:
- The Exact Code amount state is entered.
- A currency code is present.
- A tax category code is present.

Exclusions:
- Missing or invalid amount facts.
- Missing currency or tax category facts.

Out of scope:
- Calculating, approving, or changing a price, discount, tax, or invoice amount.

Leave unresolved when:
- Amount, currency, or tax category roles cannot be mapped unambiguously.
`;
