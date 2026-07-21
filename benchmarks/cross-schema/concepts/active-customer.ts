import { defineConcept } from "../../../src/dsl";

export const BenchmarkActiveCustomer = defineConcept(
  "benchmark.customer.active",
)`
Definition:
An entity whose account is currently permitted to use the service.

Requirements:
- The supplied schema's authoritative availability indicator is positive.
- A usable contact point is present.

Exclusions:
- Any active exclusion state or timestamp represented by the supplied schema.

Out of scope:
- The concrete names used for availability, exclusion, and contact roles.

Leave unresolved when:
- Availability, exclusion, or contact roles require guessing.
`;
