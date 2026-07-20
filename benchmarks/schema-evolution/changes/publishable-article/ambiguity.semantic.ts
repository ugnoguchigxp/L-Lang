import { BenchmarkPublishableArticle } from "../../../cross-schema/concepts/publishable-article";
import { bindConcept, generatePredicate, semanticTest } from "../../../../src/dsl";

export type EvolutionPublishableArticleAmbiguity = {
  reviewStateA: "approved" | "draft";
  reviewStateB: "approved" | "draft";
  archivedAt: string | null;
  title: string | null;
  body: string | null;
};

const Bound = bindConcept<EvolutionPublishableArticleAmbiguity>(BenchmarkPublishableArticle);
export const isEvolutionPublishableArticleAmbiguity = generatePredicate(Bound);
semanticTest(isEvolutionPublishableArticleAmbiguity, { accept: [], reject: [] });
