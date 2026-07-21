import { defineConcept } from "../src/dsl";

export const ActiveCustomer = defineConcept("customer.active")`
Definition:
A customer that is currently permitted to use the service.

Requirements:
- The concrete schema's authoritative availability state permits service.
- A usable contact address is present.

Exclusions:
- Any active exclusion state represented by the concrete schema.

Out of scope:
- How availability, exclusion, and contact roles are named by a schema.

Leave unresolved when:
- Availability, exclusion, or contact roles cannot be mapped without guessing.
`;
