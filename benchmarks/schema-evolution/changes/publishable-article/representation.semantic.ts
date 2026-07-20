import { BenchmarkPublishableArticle } from "../../../cross-schema/concepts/publishable-article";
import { bindConcept, generatePredicate, semanticTest } from "../../../../src/dsl";

export type EvolutionPublishableArticleRepresentation = {
  publicationApproved: boolean;
  retired: boolean;
  title: string | null;
  body: string | null;
};

const Bound = bindConcept<EvolutionPublishableArticleRepresentation>(BenchmarkPublishableArticle);
export const isEvolutionPublishableArticleRepresentation = generatePredicate(Bound);
semanticTest(isEvolutionPublishableArticleRepresentation, { accept: [], reject: [] });
