import { describe, expect, test } from "bun:test";

import { isFulfillableMarketplaceOrder } from "./marketplace/is-fulfillable-marketplace-order.generated";
import { isFulfillableStorefrontOrder } from "./storefront/is-fulfillable-storefront-order.generated";
import { isFulfillableWarehouseRequest } from "./warehouse/is-fulfillable-warehouse-request.generated";

describe("FulfillableOrder across schemas", () => {
  test("compiles the storefront representation", () => {
    expect(
      isFulfillableStorefrontOrder({
        paymentStatus: "paid",
        cancelledAt: null,
        shippingAddress: "1-2-3 Shibuya, Tokyo",
      }),
    ).toBeTrue();
    expect(
      isFulfillableStorefrontOrder({
        paymentStatus: "pending",
        cancelledAt: null,
        shippingAddress: "1-2-3 Shibuya, Tokyo",
      }),
    ).toBeFalse();
    expect(
      isFulfillableStorefrontOrder({
        paymentStatus: "paid",
        cancelledAt: "2026-07-21T09:00:00Z",
        shippingAddress: "1-2-3 Shibuya, Tokyo",
      }),
    ).toBeFalse();
    expect(
      isFulfillableStorefrontOrder({
        paymentStatus: "paid",
        cancelledAt: null,
        shippingAddress: null,
      }),
    ).toBeFalse();
  });

  test("compiles the warehouse representation", () => {
    expect(
      isFulfillableWarehouseRequest({
        paymentConfirmed: true,
        holdReason: null,
        destinationCode: "TYO-01",
      }),
    ).toBeTrue();
    expect(
      isFulfillableWarehouseRequest({
        paymentConfirmed: false,
        holdReason: null,
        destinationCode: "TYO-01",
      }),
    ).toBeFalse();
    expect(
      isFulfillableWarehouseRequest({
        paymentConfirmed: true,
        holdReason: "manual inspection",
        destinationCode: "TYO-01",
      }),
    ).toBeFalse();
    expect(
      isFulfillableWarehouseRequest({
        paymentConfirmed: true,
        holdReason: null,
        destinationCode: null,
      }),
    ).toBeFalse();
    expect(
      isFulfillableWarehouseRequest({
        paymentConfirmed: true,
        holdReason: null,
        destinationCode: undefined,
      }),
    ).toBeFalse();
  });

  test("compiles the nested marketplace representation", () => {
    expect(
      isFulfillableMarketplaceOrder({
        fulfillment: {
          authorization: "approved",
          voided: false,
          deliveryLocation: "partner-location-42",
        },
      }),
    ).toBeTrue();
    expect(
      isFulfillableMarketplaceOrder({
        fulfillment: {
          authorization: "declined",
          voided: false,
          deliveryLocation: "partner-location-42",
        },
      }),
    ).toBeFalse();
    expect(
      isFulfillableMarketplaceOrder({
        fulfillment: {
          authorization: "approved",
          voided: true,
          deliveryLocation: "partner-location-42",
        },
      }),
    ).toBeFalse();
    expect(
      isFulfillableMarketplaceOrder({
        fulfillment: {
          authorization: "approved",
          voided: false,
          deliveryLocation: null,
        },
      }),
    ).toBeFalse();
    expect(
      isFulfillableMarketplaceOrder({
        fulfillment: {
          authorization: "approved",
          voided: false,
        },
      }),
    ).toBeFalse();
  });
});
