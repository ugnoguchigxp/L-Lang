import { concept, generatePredicate, semanticTest } from "../../src/dsl";
export type Input = {approved: boolean; verified: boolean; blocked: boolean; noise: string[]};
const Meaning = concept<Input>`
Definition:
Synthetic permissions predicate.
Requirements:
- approved and verified are true and blocked is false.
`;
export const eligible = generatePredicate(Meaning);
semanticTest(eligible, {accept: [{"approved": true, "verified": true, "blocked": false, "noise": []}], reject: [{"approved": false, "verified": false, "blocked": false, "noise": []}]});
