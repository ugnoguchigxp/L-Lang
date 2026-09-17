export interface Order {
  paymentStatus: "paid" | "pending" | "failed";
  inventoryReserved: boolean;
  holdReason?: string | null | undefined;
  cancelled?: boolean | undefined;
}

export function canShip(order: Order): boolean {
  return (
    order.paymentStatus === "paid" &&
    order.inventoryReserved === true &&
    (order.holdReason === null || order.holdReason === undefined) &&
    order.cancelled !== true
  );
}

export interface ReviewRequest {
  priority: "normal" | "high";
  approved: boolean;
  reviewer?: string | null | undefined;
}

export function needsManualReview(request: ReviewRequest): boolean {
  return (
    request.priority === "high" ||
    request.approved !== true ||
    (request.reviewer !== null && request.reviewer !== undefined)
  );
}
