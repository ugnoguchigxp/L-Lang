import type { BenchmarkFulfillmentRequest } from "../bindings/shippable-fulfillment-request.semantic";

export function manuallyIsShippableRequest(
  value: BenchmarkFulfillmentRequest,
): boolean {
  return (
    value.paymentCaptured === true &&
    value.voidedAt === null &&
    value.destinationCode !== null
  );
}
