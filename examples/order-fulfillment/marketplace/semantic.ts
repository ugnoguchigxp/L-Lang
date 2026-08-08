import { FulfillableOrder } from "../../../concepts/fulfillable-order";
import { bindConcept, generatePredicate, semanticTest } from "../../../src/dsl";

export type MarketplaceOrder = {
  fulfillment: {
    authorization: "approved" | "declined";
    voided: boolean;
    deliveryLocation?: string | null;
  };
};

const FulfillableMarketplaceOrder =
  bindConcept<MarketplaceOrder>(FulfillableOrder);

export const isFulfillableMarketplaceOrder = generatePredicate(
  FulfillableMarketplaceOrder,
);

semanticTest(isFulfillableMarketplaceOrder, {
  accept: [
    {
      fulfillment: {
        authorization: "approved",
        voided: false,
        deliveryLocation: "partner-location-42",
      },
    },
  ],
  reject: [
    {
      fulfillment: {
        authorization: "declined",
        voided: false,
        deliveryLocation: "partner-location-42",
      },
    },
    {
      fulfillment: {
        authorization: "approved",
        voided: true,
        deliveryLocation: "partner-location-42",
      },
    },
    {
      fulfillment: {
        authorization: "approved",
        voided: false,
        deliveryLocation: null,
      },
    },
    {
      fulfillment: {
        authorization: "approved",
        voided: false,
      },
    },
  ],
});
