import type { BenchmarkCommerceOrder } from "../bindings/shippable-commerce-order.semantic";

export function manuallyIsShippableOrder(value: BenchmarkCommerceOrder): boolean {
  return (
    value.paymentStatus === "paid" &&
    value.cancelledAt === null &&
    value.shippingAddress !== null
  );
}
