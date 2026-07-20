import { concept, generatePredicate, semanticTest } from "../../src/dsl";

export type Customer = {
  status: "active" | "suspended";
  deletedAt: string | null;
  email: string | null | undefined;
};

const ActiveCustomer = concept<Customer>`
  An active customer has status "active", has not been deleted
  (deletedAt is null), and has a present email address.
`;

export const isActiveCustomer = generatePredicate(ActiveCustomer);

semanticTest(isActiveCustomer, {
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
