# Private Pilot workspace

Pilot data in this directory must be synthetic or anonymized. Do not add
credentials, authorization headers, environment files, provider endpoints,
personal data, or production records.

Pilot-generated predicates are shadow-only advisory flags. They must not call
CRUD writes, databases, external APIs, authorization decisions, price
decisions, inventory allocation, or shipment confirmation.

Tracked evidence may contain reports, sanitized raw model responses, and
artifact hashes. Duplicate checkpoints and sensitive connection metadata stay
outside the tracked workspace.

## Review and freeze

`review.json` is a control artifact, not a self-attestation. Before a live run,
an identified ERP domain reviewer who is independent from implementation must:

- approve every safety decision;
- assign a real owner to all eight cases in both `manifest.json` and
  `review.json`;
- confirm stop and Go / No-Go authority; and
- record a valid review timestamp.

The following command remains fail-closed until that review is complete:

```bash
bun run pilot:freeze pilots/erp-crud-v1/manifest.json --frozen
```

After approval and freeze, configure the provider without writing credentials
or endpoints into this workspace:

```bash
OPENAI_API_KEY=... \
OPENAI_INPUT_COST_PER_MILLION_TOKENS=... \
OPENAI_OUTPUT_COST_PER_MILLION_TOKENS=... \
bun run pilot:run pilots/erp-crud-v1/manifest.json --live
```

The live runner issues one initial-generation task for each case. It writes a
checkpoint before each API attempt, waits 60 seconds after success, HTTP 429,
and terminal failure, and refuses to repeat an uncertain pending call. Token
usage is measured but has no aggregate pass/fail limit. API-call, estimated
cost, wall-clock, per-response output, freeze-integrity, and safety limits
remain fail-closed.
