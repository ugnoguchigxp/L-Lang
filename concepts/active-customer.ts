import { defineConcept } from "../src/dsl";

export const ActiveCustomer = defineConcept("customer.active")`
  A customer that is currently permitted to use the service.

  The concrete schema's authoritative availability state permits service,
  no exclusion state represented by that schema is active,
  and a usable contact address is present.

  Schemas may encode availability and exclusion differently. Use only roles
  that are unambiguously represented by the supplied type. If those roles
  cannot be mapped without guessing, leave the concept unresolved.
`;
