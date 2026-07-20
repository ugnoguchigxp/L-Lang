import { BenchmarkPublishableArticle } from "../../../cross-schema/concepts/publishable-article";
import { bindConcept, generatePredicate, semanticTest } from "../../../../src/dsl";

export type EvolutionPublishableArticleRename = {
  approvalState: "approved" | "draft";
  retiredAt: string | null;
  headline: string | null;
  content: string | null;
};

const Bound = bindConcept<EvolutionPublishableArticleRename>(BenchmarkPublishableArticle);
export const isEvolutionPublishableArticleRename = generatePredicate(Bound);
semanticTest(isEvolutionPublishableArticleRename, { accept: [], reject: [] });
