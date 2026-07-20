import type { BenchmarkEditorialArticle } from "../bindings/publishable-editorial-article.semantic";

export function manuallyIsPublishableArticle(
  value: BenchmarkEditorialArticle,
): boolean {
  return (
    value.reviewStatus === "approved" &&
    value.archivedAt === null &&
    value.title !== null &&
    value.body !== null
  );
}
