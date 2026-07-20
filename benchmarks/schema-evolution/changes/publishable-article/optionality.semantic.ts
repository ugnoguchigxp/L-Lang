import { BenchmarkPublishableArticle } from "../../../cross-schema/concepts/publishable-article";
import { bindConcept, generatePredicate, semanticTest } from "../../../../src/dsl";

export type EvolutionPublishableArticleOptionality = {
  reviewStatus: "approved" | "draft";
  archivedAt: string | null;
  title?: string;
  body?: string;
};

const Bound = bindConcept<EvolutionPublishableArticleOptionality>(BenchmarkPublishableArticle);
export const isEvolutionPublishableArticleOptionality = generatePredicate(Bound);
semanticTest(isEvolutionPublishableArticleOptionality, { accept: [], reject: [] });
