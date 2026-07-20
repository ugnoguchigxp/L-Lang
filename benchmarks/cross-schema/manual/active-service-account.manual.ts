import type { BenchmarkServiceAccount } from "../bindings/active-service-account.semantic";

export function manuallyIsActiveServiceAccount(value: BenchmarkServiceAccount): boolean {
  return (
    value.serviceEnabled === true &&
    value.blockedAt === null &&
    value.primaryEmail !== null
  );
}
