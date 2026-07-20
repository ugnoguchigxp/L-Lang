import { BenchmarkPublishableArticle } from "../concepts/publishable-article";
import { bindConcept, generatePredicate, semanticTest } from "../../../src/dsl";

export type BenchmarkOpaqueDocument = {
  state: string;
  marker: string | null;
  fieldA: string | null;
  fieldB: string | null;
};

const Bound = bindConcept<BenchmarkOpaqueDocument>(BenchmarkPublishableArticle);
export const isBenchmarkOpaquePublishableDocument = generatePredicate(Bound);

// This intentionally opaque schema is expected to remain unresolved.
semanticTest(isBenchmarkOpaquePublishableDocument, { accept: [], reject: [] });
