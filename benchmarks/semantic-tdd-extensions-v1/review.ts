import { concept, generatePredicate, semanticTest } from "../../src/dsl";
export type Input = {approved: boolean; verified: boolean; blocked: boolean; noise: string[]};
const Meaning = concept<Input>`
Definition:
Synthetic review predicate.
Requirements:
- approved and verified are not both true and blocked is true.
`;
export const eligible = generatePredicate(Meaning);
semanticTest(eligible, {accept: [{"approved": false, "verified": false, "blocked": true, "noise": []}], reject: [{"approved": false, "verified": false, "blocked": false, "noise": []}]});
