export interface ShippingOrderInput {
  paymentStatus: "pending" | "authorized" | "paid" | "failed";
  inventoryReserved: boolean;
  holdReason?: "fraud" | "address" | null | undefined;
  cancelled?: boolean | undefined;
}

export function canShipOrder(input: ShippingOrderInput): boolean {
  return (
    (input.paymentStatus === "paid" || input.paymentStatus === "authorized") &&
    input.inventoryReserved === true &&
    (input.holdReason === null || input.holdReason === undefined) &&
    input.cancelled !== true
  );
}
