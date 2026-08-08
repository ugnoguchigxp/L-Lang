import { FulfillableOrder } from "../../../concepts/fulfillable-order";
import {
  bindConcept,
  generatePredicate,
  semanticTest,
} from "../../../src/dsl";

export type StorefrontOrder = {
  paymentStatus: "pending" | "paid" | "failed";
  cancelledAt: string | null;
  shippingAddress: string | null;
};

const FulfillableStorefrontOrder =
  bindConcept<StorefrontOrder>(FulfillableOrder);

export const isFulfillableStorefrontOrder = generatePredicate(
  FulfillableStorefrontOrder,
);

semanticTest(isFulfillableStorefrontOrder, {
  accept: [
    {
      paymentStatus: "paid",
      cancelledAt: null,
      shippingAddress: "1-2-3 Shibuya, Tokyo",
    },
  ],
  reject: [
    {
      paymentStatus: "pending",
      cancelledAt: null,
      shippingAddress: "1-2-3 Shibuya, Tokyo",
    },
    {
      paymentStatus: "paid",
      cancelledAt: "2026-07-21T09:00:00Z",
      shippingAddress: "1-2-3 Shibuya, Tokyo",
    },
    {
      paymentStatus: "paid",
      cancelledAt: null,
      shippingAddress: null,
    },
  ],
});
