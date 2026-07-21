import { defineConcept } from "../../../src/dsl";

export const BenchmarkShippableOrder = defineConcept(
  "benchmark.order.shippable",
)`
Definition:
An order that is currently eligible to be handed to shipping.

Requirements:
- The supplied schema's authoritative payment indicator confirms payment.
- A usable shipping destination is present.

Exclusions:
- Any active cancellation or void state represented by the supplied schema.

Out of scope:
- Carrier availability and delivery timing.

Leave unresolved when:
- Payment, cancellation, or destination roles require guessing.
`;
