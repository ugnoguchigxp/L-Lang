import { judgeStatic, staticValue } from "../../src/dsl";
import { Cat } from "./cat";

const mike = staticValue(`
  A small domesticated calico animal that meows.
`);

export const mikeIsCat = judgeStatic(mike, Cat);
