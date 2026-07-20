import { describe, expect, test } from "bun:test";

import { isActiveCustomer } from "./is-active-customer.generated";

describe("isActiveCustomer", () => {
  test("accepts an active, non-deleted customer with an email", () => {
    expect(
      isActiveCustomer({
        status: "active",
        deletedAt: null,
        email: "customer@example.com",
      }),
    ).toBe(true);
  });

  test.each([
    {
      status: "suspended" as const,
      deletedAt: null,
      email: "customer@example.com",
    },
    {
      status: "active" as const,
      deletedAt: "2026-07-20T00:00:00Z",
      email: "customer@example.com",
    },
    { status: "active" as const, deletedAt: null, email: null },
    { status: "active" as const, deletedAt: null, email: undefined },
  ])("rejects an ineligible customer", (customer) => {
    expect(isActiveCustomer(customer)).toBe(false);
  });
});
