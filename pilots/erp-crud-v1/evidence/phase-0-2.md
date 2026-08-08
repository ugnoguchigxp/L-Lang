# ERP CRUD Private Pilot — Phase 0–2 evidence

Recorded: 2026-07-24

Result: **passed for fixture-only preflight**

Phase 0–2 established the ERP safety boundary, strict Pilot harness, four-domain workspace, eight initial Predicates, eight Schema-change variants, handwritten baselines, hidden cases, and report generation.

## Measured result

| Check | Result |
| --- | ---: |
| Pilot cases | 8/8 resolved |
| First-pass fixture Project Fit | 8/8 |
| Hidden cases | 25/25 |
| False resolutions | 0 |
| Business writes | 0 |
| External I/O | 0 |
| Workspace mutations | 0 |
| Confidential-data incidents | 0 |
| Full repository tests | 210 pass, 0 fail |
| Coverage | 94.03% functions / 94.06% lines |

The live command was also exercised while the input was still `draft`. It failed closed before any provider call with `Pilot inputs must be frozen before live execution`.

## Safety boundary

- The Pilot generates only pure boolean review-candidate flags.
- Price calculation, quantity calculation, inventory allocation, shipment confirmation, CRUD writes, and external I/O are outside the Semantic Zone.
- Synthetic fixtures are used.
- The mandatory 60-second cooldown was verified with an injected clock after success, HTTP 429, and terminal failure.
- Aggregate token usage is observational, not a pass/fail gate. API-call, cost, wall-clock, per-response output, and safety limits remain enforced.

## Artifact integrity

| Artifact | SHA-256 |
| --- | --- |
| `manifest.json` | `c22f2b8eb339fee424abb235800ea81b3bc18edb9df576358a5d7cd602a7e18d` |
| draft `freeze.json` | `e06e749b1f577812efb9188522a9f7caa30c8f6d8ae92336712da6ea2f3c8276` |
| fixture `report.json` | `b293132dcea38a41a3a2833ffd0043d18ca62b35b67b5e938f87fd0a3cc71cae` |
| fixture `report.md` | `0289bfb22e96ec2b33d82666b4f340fa6726b4c7f7bf8e13e5fd7baa9a4c87c3` |

The machine-readable record is [`phase-0-2.json`](./phase-0-2.json).

## Limits of this evidence

No OpenAI or Azure OpenAI API was called. Token, latency, and human-work fields in the fixture report are placeholders, so this result does not show a time or cost advantage and is not a Pilot Go/No-Go decision.

The next active step is Phase 3: an independent review of business meaning, hidden-case sufficiency, data classification, owner authority, and budget, followed by a one-way transition from `draft` to `frozen`.
