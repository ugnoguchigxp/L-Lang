# Project Fit v2 live evidence

This directory preserves both live runs needed to interpret the Project Fit
decision.

- `2026-07-24-token-gated-baseline` is the original failed baseline. Project
  Context achieved 6/6 cases, but its 4,446 additional input tokens exceeded
  the then-frozen 4,000-token Gate.
- `2026-07-24-token-observation-only` is the user-authorized revised policy
  run. Tokens remain measured, while token usage is no longer a Gate
  condition. Both initial generation and schema change passed.

Each run includes the complete JSON/Markdown report and the raw response
records. `evidence.json` fixes their SHA-256 hashes, checkpoint hashes and
counts, policy difference, safety results, and repository verification.

Credentials, authorization headers, environment-file contents, and the Azure
endpoint host are intentionally excluded.
