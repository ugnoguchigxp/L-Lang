import { ActiveCustomer } from "../../../concepts/active-customer";
import {
  bindConcept,
  generatePredicate,
  semanticTest,
} from "../../../src/dsl";

export type ServiceAccount = {
  enabled: boolean;
  blockedAt: string | null;
  contactAddress: string | null | undefined;
};

const ActiveServiceAccount = bindConcept<ServiceAccount>(ActiveCustomer);

export const isActiveServiceAccount = generatePredicate(ActiveServiceAccount);

semanticTest(isActiveServiceAccount, {
  accept: [
    {
      enabled: true,
      blockedAt: null,
      contactAddress: "customer@example.com",
    },
  ],
  reject: [
    {
      enabled: false,
      blockedAt: null,
      contactAddress: "customer@example.com",
    },
    {
      enabled: true,
      blockedAt: "2026-01-01T00:00:00Z",
      contactAddress: "customer@example.com",
    },
    { enabled: true, blockedAt: null, contactAddress: null },
    { enabled: true, blockedAt: null, contactAddress: undefined },
  ],
});
