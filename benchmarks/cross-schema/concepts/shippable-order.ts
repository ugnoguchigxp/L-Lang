import { defineConcept } from "../../../src/dsl";

export const BenchmarkShippableOrder = defineConcept(
  "benchmark.order.shippable",
)`
  An order that is currently eligible to be handed to shipping.

  The supplied schema's authoritative payment indicator confirms payment,
  no cancellation or void state represented by that schema is active,
  and a usable shipping destination is present.

  Use only semantic roles that are unambiguously represented by the supplied
  type. If payment, cancellation, or destination roles require guessing,
  leave the concept unresolved.
`;
