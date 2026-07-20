import { BenchmarkPublishableArticle } from "../../../cross-schema/concepts/publishable-article";
import { bindConcept, generatePredicate, semanticTest } from "../../../../src/dsl";

export type EvolutionPublishableArticleAddProperty = {
  reviewStatus: "approved" | "draft";
  archivedAt: string | null;
  title: string | null;
  body: string | null;
  wordCount: number;
};

const Bound = bindConcept<EvolutionPublishableArticleAddProperty>(BenchmarkPublishableArticle);
export const isEvolutionPublishableArticleAddProperty = generatePredicate(Bound);
semanticTest(isEvolutionPublishableArticleAddProperty, { accept: [], reject: [] });
