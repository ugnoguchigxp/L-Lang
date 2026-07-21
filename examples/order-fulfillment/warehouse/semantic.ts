import { FulfillableOrder } from "../../../concepts/fulfillable-order";
import {
  bindConcept,
  generatePredicate,
  semanticTest,
} from "../../../src/dsl";

export type WarehouseRequest = {
  paymentConfirmed: boolean;
  holdReason: string | null;
  destinationCode: string | null | undefined;
};

const FulfillableWarehouseRequest =
  bindConcept<WarehouseRequest>(FulfillableOrder);

export const isFulfillableWarehouseRequest = generatePredicate(
  FulfillableWarehouseRequest,
);

semanticTest(isFulfillableWarehouseRequest, {
  accept: [
    {
      paymentConfirmed: true,
      holdReason: null,
      destinationCode: "TYO-01",
    },
  ],
  reject: [
    {
      paymentConfirmed: false,
      holdReason: null,
      destinationCode: "TYO-01",
    },
    {
      paymentConfirmed: true,
      holdReason: "manual inspection",
      destinationCode: "TYO-01",
    },
    {
      paymentConfirmed: true,
      holdReason: null,
      destinationCode: null,
    },
    {
      paymentConfirmed: true,
      holdReason: null,
      destinationCode: undefined,
    },
  ],
});
