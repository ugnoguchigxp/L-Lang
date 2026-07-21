import { defineConcept } from "../../src/dsl";

export const Cat = defineConcept("animal.cat")`
Definition:
A domesticated animal that is a biological cat.

Requirements:
- The described entity is a living biological cat.

Exclusions:
- Mechanical or virtual cat-shaped objects.

Out of scope:
- Breed, color, age, and ownership.

Leave unresolved when:
- The description does not distinguish a biological cat from a cat-shaped object.
`;
