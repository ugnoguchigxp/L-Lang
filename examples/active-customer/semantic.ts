import { concept, generatePredicate, semanticTest } from "../../src/dsl";

export type Customer = {
  status: "active" | "suspended";
  deletedAt: string | null;
  email: string | null | undefined;
};

const ActiveCustomer = concept<Customer>`
Definition:
A customer that is currently active and contactable.

Requirements:
- status is "active".
- deletedAt is null.
- email is present.

Exclusions:
- Customers whose status is "suspended".
- Customers whose deletedAt is not null.

Out of scope:
- Email address syntax and deliverability.

Leave unresolved when:
- The schema does not expose status, deletion, or email roles unambiguously.
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
