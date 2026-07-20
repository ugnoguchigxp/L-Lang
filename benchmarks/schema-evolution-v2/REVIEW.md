# Blind Schema Evolution v2 review

> **Status: blocked before human approval.** Do not change `freeze.json` to
> `human-reviewed` and do not run the live benchmark. See
> [`BLOCKER.md`](./BLOCKER.md) for the recorded evaluation-design issues and
> resume conditions.

This held-out benchmark is independent from v1. Do not use model output while reviewing or alter `benchmark.json` after approval.

## What is frozen

- Four new Concepts: actionable ticket, payable invoice, deployable release, and enrollable course.
- Six schema changes per Concept, for 24 cases and 72 model calls.
- Each resolved schema has exactly three condition-bearing fields. Their `condition`, `positive`, and `negative` values define the oracle and hidden tests.
- `remove-role` and `ambiguity` cases contain no condition-bearing fields and must remain unresolved.
- Nested objects, arrays, unions, nullable fields, optional fields, renames, and boolean representations are included.

## Expected matrix

| Change | Cases | Expected |
| --- | ---: | --- |
| add-property | 4 | resolved |
| rename | 4 | resolved |
| representation | 4 | resolved |
| optionality | 4 | resolved |
| remove-role | 4 | unresolved |
| ambiguity | 4 | unresolved |

## Approval

After independent review, edit only these fields in `freeze.json`:

```json
"status": "human-reviewed",
"humanReviewed": true,
"reviewer": "reviewer identifier",
"reviewedAt": "ISO-8601 timestamp"
```

Then run `bun run benchmark:schema-evolution:v2`. The command refuses API execution while the review is still draft or if the frozen SHA-256 changes.
