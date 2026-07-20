import type { BenchmarkContentRecord } from "../bindings/publishable-content-record.semantic";

export function manuallyIsPublishableContent(
  value: BenchmarkContentRecord,
): boolean {
  return (
    value.publicationApproved === true &&
    value.retiredAt === null &&
    value.headline !== null &&
    value.content !== null
  );
}
