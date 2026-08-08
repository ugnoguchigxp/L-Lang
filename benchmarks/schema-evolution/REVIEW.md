# Blind Schema Evolution freeze protocol

> **Status: blocked before input freeze.** Keep `freeze.json` as `draft` and
> do not run the live benchmark. See
> [`BLOCKER.md`](./BLOCKER.md) for the recorded evaluation-design issues and
> resume conditions.

This held-out benchmark is independent from prior evaluation inputs. Do not
use model output while finalizing it or alter `benchmark.json` after freeze.

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

## Freeze

After the design blocker is resolved, independently review the replacement
input and record the following in `freeze.json`:

```json
"status": "frozen"
```

Then run the live benchmark. The command refuses API execution while the input
is still `draft` or if a frozen SHA-256 changes.
