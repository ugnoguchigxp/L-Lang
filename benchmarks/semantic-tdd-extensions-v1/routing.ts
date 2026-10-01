import { concept, generatePredicate, semanticTest } from "../../src/dsl";
export type Input = {approved: boolean; verified: boolean; blocked: boolean; noise: string[]};
const Meaning = concept<Input>`
Definition:
Synthetic routing predicate.
Requirements:
- approved or verified is true and blocked is false.
`;
export const eligible = generatePredicate(Meaning);
semanticTest(eligible, {accept: [{"approved": false, "verified": true, "blocked": false, "noise": []}], reject: [{"approved": false, "verified": false, "blocked": false, "noise": []}]});
