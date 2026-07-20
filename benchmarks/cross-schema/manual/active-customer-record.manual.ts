import type { BenchmarkCustomerRecord } from "../bindings/active-customer-record.semantic";

export function manuallyIsActiveCustomer(value: BenchmarkCustomerRecord): boolean {
  return (
    value.status === "active" &&
    value.deletedAt === null &&
    value.email !== null
  );
}
