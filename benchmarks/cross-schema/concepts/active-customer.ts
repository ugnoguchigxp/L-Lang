import { defineConcept } from "../../../src/dsl";

export const BenchmarkActiveCustomer = defineConcept(
  "benchmark.customer.active",
)`
  An entity whose account is currently permitted to use the service.

  The supplied schema's authoritative availability indicator is positive,
  no exclusion state or timestamp represented by that schema is active,
  and a usable contact point is present.

  Use only semantic roles that are unambiguously represented by the supplied
  type. If availability, exclusion, or contact roles require guessing, leave
  the concept unresolved.
`;
