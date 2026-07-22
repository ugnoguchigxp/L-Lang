import { defineConcept } from "../../src/dsl";

export const Cat = defineConcept("animal.cat")`
Definition:
A domesticated animal that is a biological cat.

Exclusions:
- Mechanical or virtual cat-shaped objects.
`;
