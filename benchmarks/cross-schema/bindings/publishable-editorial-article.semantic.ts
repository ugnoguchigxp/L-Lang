import { BenchmarkPublishableArticle } from "../concepts/publishable-article";
import { bindConcept, generatePredicate, semanticTest } from "../../../src/dsl";

export type BenchmarkEditorialArticle = {
  reviewStatus: "approved" | "draft";
  archivedAt: string | null;
  title: string | null;
  body: string | null;
};

const Bound = bindConcept<BenchmarkEditorialArticle>(BenchmarkPublishableArticle);
export const isBenchmarkPublishableArticle = generatePredicate(Bound);

// Benchmark oracle cases live outside this source and are never sent to the model.
semanticTest(isBenchmarkPublishableArticle, { accept: [], reject: [] });
