import { defineConcept } from "../../../src/dsl";

export const BenchmarkPublishableArticle = defineConcept(
  "benchmark.article.publishable",
)`
Definition:
An article that is currently eligible for public release.

Requirements:
- The supplied schema's authoritative review or approval indicator is positive.
- Both a usable title and body are present.

Exclusions:
- Any active archive or retirement state represented by the supplied schema.

Out of scope:
- Editorial quality and publication scheduling.

Leave unresolved when:
- Approval, exclusion, title, or body roles require guessing.
`;
