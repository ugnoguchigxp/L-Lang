# ERP CRUD Private Pilot — Phase 3–4 readiness

Recorded: 2026-07-24

Status: **historical readiness snapshot; superseded by [`initial-live.md`](./initial-live.md)**

The Phase 3 review gate and Phase 4 live execution path are implemented. This is readiness evidence, not live provider evidence and not completion of either phase.

## Implemented controls

- Strict `review.json` with an identified independent reviewer, valid timestamp, nine mandatory decisions, and eight case approvals.
- Matching real owners are required in `manifest.json` and `review.json`; `pending`, `private-pilot-owner`, `TBD`, and `TODO` cannot be frozen.
- `freeze.json` cannot transition to `frozen` while the review is incomplete.
- OpenAI and Azure OpenAI live execution with one initial-generation task per case.
- Atomic pre-call checkpoint and refusal to repeat an uncertain pending call.
- API-call, estimated-cost, wall-clock, and per-response output guards.
- Usage measurement without an aggregate token pass/fail gate.
- Mandatory 60-second cooldown after success, HTTP 429, and terminal failure.
- Bounded HTTP 429 retry, sanitized response evidence, and versioned JSON/Markdown reports.

## Injected-provider verification

| Scenario | Result |
| --- | --- |
| Normal eight-case live path | 8 attempts, 8 cooldowns, passed |
| First attempt receives HTTP 429 | 9 attempts, 9 cooldowns, one retry, passed |
| Terminal transport failure | 1 attempt, 1 cooldown |
| Resume after uncertain pending call | Rejected without another provider call |
| Hidden cases/baselines in model request | 0 |

The full repository result is 215 tests passed, 0 failed, with 1,108 expectations. Coverage passed at 94.10% functions and 94.00% lines.

## Real workspace guard evidence

At the time of this readiness snapshot, [`review.json`](../review.json) remained `draft`.

- `pilot:freeze ... --frozen` was rejected with `Pilot review must be approved before freezing inputs`.
- `pilot:run ... --live` was rejected before provider connection with `Pilot inputs must be frozen before live execution`.
- Provider API calls: **0**

## Gate recorded at this snapshot

This gate was subsequently satisfied using synthetic John Doe-based Pilot identities at the user's direction. That authorization allowed the synthetic shadow run but is not presented as external ERP domain validation.

After that review, the next executable commands are:

```bash
bun run pilot:freeze pilots/erp-crud-v1/manifest.json --frozen
bun run pilot:run pilots/erp-crud-v1/manifest.json --live
```

The machine-readable record and hashes are in [`phase-3-4-readiness.json`](./phase-3-4-readiness.json).
