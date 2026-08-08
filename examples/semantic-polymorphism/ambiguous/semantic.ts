import { ActiveCustomer } from "../../../concepts/active-customer";
import {
  bindConcept,
  generatePredicate,
  semanticTest,
} from "../../../src/dsl";

export type AmbiguousAccount = {
  mode: string;
  marker: string | null;
  channel: string | null | undefined;
};

const AmbiguousActiveAccount = bindConcept<AmbiguousAccount>(ActiveCustomer);

export const isAmbiguousActiveAccount = generatePredicate(AmbiguousActiveAccount);

semanticTest(isAmbiguousActiveAccount, {
  accept: [{ mode: "usable", marker: null, channel: "contact" }],
  reject: [{ mode: "unusable", marker: null, channel: null }],
});
