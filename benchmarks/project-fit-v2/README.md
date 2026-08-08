# Project Fit Protocol v2

Status: **frozen**

This is the only supported Project Fit protocol. It contains six new Predicate cases across support operations and catalog governance. Every case has three A/B trials and two separately gated stages: initial generation and schema change.

The type-only arm receives the abstract intent and target TypeScript type. The Project Context arm receives the same inputs plus bounded, versioned Project Context. Hidden Oracles and fixtures are never sent to a resolver.

Fixture results validate the harness only. This protocol was frozen for the
user-authorized live A/B run on 2026-07-24. Any input or threshold change
requires a new protocol and freeze.

## Commands

```bash
bun run project-fit:fixture
bun run project-fit:benchmark
```

Live execution checkpoints every call atomically. Completed responses are reused on resume. A pending response has uncertain upstream state, so the runner refuses to repeat it and requires a new run ID. Schema-change calls run only after the initial-generation gate passes.

Gate C requires Project Context first-pass fit in at least five of six cases
in each stage, at least one-case improvement over type-only, no
false-resolution increase, no more than ten percentage points
unresolved-rate regression, and the frozen latency and cost budgets. Input
and output tokens are measured and reported but are not Gate conditions.
API-call, cost, and response-size safety ceilings remain enforced.

## Frozen live result

The first user-authorized Azure OpenAI `gpt-5-4-mini` run completed all 36 initial
generation calls with a 60-second cooldown after every API attempt. There
were no 429 retries, API errors, false resolutions, or pending checkpoint
entries.

Project Context achieved first-pass fit in 6/6 cases and 18/18 trials;
type-only achieved 0/6 cases and 0/18 trials. The stage gate failed only
because Project Context added 4,446 input tokens against the frozen 4,000
token ceiling. The schema-change stage was therefore not run. The decision
was `Iterate`. That report remains preserved as the baseline before the
user-authorized removal of token-based acceptance conditions.

The revised frozen run completed 72/72 calls and passed both the initial and
schema-change gates. Project Context achieved 6/6 cases and 18/18 trials in
both stages. Type-only achieved 0/6 cases in both stages, with 0/18 initial
trials and 1/18 schema-change trials. There were no false resolutions, 429
responses, API errors, workspace mutations, or pending checkpoint entries.
The estimated cost was $0.07683525 using the configured public token rates.

The version-controlled reports, raw response records, artifact hashes, policy
difference, and repository verification are preserved in
[`evidence/`](./evidence/README.md).
