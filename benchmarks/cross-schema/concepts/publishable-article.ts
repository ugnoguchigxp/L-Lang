import { defineConcept } from "../../../src/dsl";

export const BenchmarkPublishableArticle = defineConcept(
  "benchmark.article.publishable",
)`
  An article that is currently eligible for public release.

  The supplied schema's authoritative review or approval indicator is
  positive, no archive or retirement state represented by that schema is
  active, and both a usable title and body are present.

  Use only semantic roles that are unambiguously represented by the supplied
  type. If approval, exclusion, title, or body roles require guessing, leave
  the concept unresolved.
`;
