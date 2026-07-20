import { BenchmarkPublishableArticle } from "../../../cross-schema/concepts/publishable-article";
import { bindConcept, generatePredicate, semanticTest } from "../../../../src/dsl";

export type EvolutionPublishableArticleRemoveRole = {
  reviewStatus: "approved" | "draft";
  archivedAt: string | null;
  title: string | null;
  articleId: string;
};

const Bound = bindConcept<EvolutionPublishableArticleRemoveRole>(BenchmarkPublishableArticle);
export const isEvolutionPublishableArticleRemoveRole = generatePredicate(Bound);
semanticTest(isEvolutionPublishableArticleRemoveRole, { accept: [], reject: [] });
