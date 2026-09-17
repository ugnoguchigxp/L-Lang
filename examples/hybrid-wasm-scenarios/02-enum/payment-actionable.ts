export interface PaymentInput {
  status: "pending" | "authorized" | "paid" | "failed";
}

export function isPaymentActionable(input: PaymentInput): boolean {
  return input.status === "authorized" || input.status === "paid";
}
