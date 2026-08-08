import { ActiveCustomer } from "../../../concepts/active-customer";
import {
  bindConcept,
  generatePredicate,
  semanticTest,
} from "../../../src/dsl";

export type CustomerRecord = {
  status: "active" | "suspended";
  deletedAt: string | null;
  email: string | null | undefined;
};

const ActiveCustomerRecord = bindConcept<CustomerRecord>(ActiveCustomer);

export const isActiveCustomerRecord = generatePredicate(ActiveCustomerRecord);

semanticTest(isActiveCustomerRecord, {
  accept: [
    {
      status: "active",
      deletedAt: null,
      email: "customer@example.com",
    },
  ],
  reject: [
    {
      status: "suspended",
      deletedAt: null,
      email: "customer@example.com",
    },
    {
      status: "active",
      deletedAt: "2026-01-01T00:00:00Z",
      email: "customer@example.com",
    },
    { status: "active", deletedAt: null, email: null },
    { status: "active", deletedAt: null, email: undefined },
  ],
});
