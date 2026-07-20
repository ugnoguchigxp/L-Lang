import { BenchmarkPublishableArticle } from "../concepts/publishable-article";
import { bindConcept, generatePredicate, semanticTest } from "../../../src/dsl";

export type BenchmarkContentRecord = {
  publicationApproved: boolean;
  retiredAt: string | null;
  headline: string | null;
  content: string | null;
};

const Bound = bindConcept<BenchmarkContentRecord>(BenchmarkPublishableArticle);
export const isBenchmarkPublishableContent = generatePredicate(Bound);

// Benchmark oracle cases live outside this source and are never sent to the model.
semanticTest(isBenchmarkPublishableContent, { accept: [], reject: [] });
