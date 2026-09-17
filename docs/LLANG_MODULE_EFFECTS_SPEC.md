# L-Lang effects runtime (`module-effects-v1`)

This document records the implemented Phase 4 runtime contracts. The profile
uses ABI `llang-effects-session-v1`. Grants and credentials are runtime inputs;
they are never embedded in a program manifest.

## Values

`bytes` is an immutable octet sequence with strict bounds, canonical base64
fixtures, and explicit fatal UTF-8 encode/decode. The streaming decoder carries
an incomplete sequence across chunks and rejects an incomplete EOF. `i64` uses
checked signed 64-bit BigInt operations and little-endian wire bytes. `f64`
accepts finite binary64 values only and canonicalizes negative zero. A decimal
is a signed i64 coefficient plus compile-time scale 0–18; scale-changing
multiply, divide, and rescale require `toward-zero` or `half-even` explicitly
and use checked i128 intermediates.

## Operations, grants, and budgets

Every host operation pins an ID, version, request/response/error types, effect,
resource kind, cancellation capability, idempotency, and signature hash. A
session verifies all requirements against the host registry before dispatch.
The declared effect set does not grant authority. Operation and target grants
are checked again at every dispatch.

The shared session ledger independently accounts for host requests, tasks,
concurrent IO/tasks, open resources/streams, sent/received bytes, memory, and
fuel. Child tasks do not receive copied budgets.

## Session and resources

Request IDs contain session, task, generation, and sequence. Unknown and
duplicate responses fail closed. Cancellation advances the generation so late
responses are recorded but cannot resume state. At the exact deadline the
timeout wins over a simultaneous completion. Transcripts contain redacted
targets and payload hashes, not payloads or credentials.

Resource handles carry kind, owning scope, ID, and generation. Stale or
cross-scope handles are rejected. Scope disposal closes resources in reverse
acquisition order, keeps cleanup failures separate, and makes close idempotent.
Structured tasks have a finite queue and concurrency, return results in spawn
order, and propagate runtime faults to siblings. Pull streams permit only one
outstanding read, cap chunks at 64 KiB, distinguish EOF from empty bytes, and
propagate early consumer cancellation.

The import-free Wasm session exports fixed 512-page memory plus `start`,
`resume`, `cancel`, `dispose`, and `fault_code`. The initial event ABI uses
16-byte little-endian envelopes. Requests contain generation, sequence,
operation index, and an i32 payload; responses contain generation, sequence,
success flag, and an i32 value. Wasm owns the continuation index and computed
accumulator. The host transports events only. Portable fixture replay verifies
the exact request sequence and never invokes an adapter.

Portable effects bundles use build and replay-suite version 5 (version 4 is
already used by the native collection complement). The manifest pins the
program hash, operation requirements, effect set, exact ABI layout, Wasm hash,
and byte length. Verification rejects unknown manifest fields, symlinked or
changed Wasm, mismatched request sequences, unused events, and suite/program
hash mismatches.

## Initial adapters

The local file adapter uses handle-based reads. Writes go to an exclusive
same-directory temporary file and become visible only on explicit commit;
non-replacing commit uses a hard-link publication step and abort removes only
its own temporary file. Traversal and symlink escapes are rejected.

The initial HTTP adapter is deliberately loopback-only. It accepts only literal
loopback IP hosts (not DNS names), does not follow redirects, separates
credential injection from program headers, returns 4xx/5xx as responses, caps
request bodies and pull chunks, and distinguishes timeout/cancellation from an
HTTP response. General network support remains refused until the adapter can
pin and recheck the connected address across DNS, proxy, and redirect paths.

The Node file adapter verifies the opened read handle against the path's
device/inode after open. Node does not expose portable directory-relative
`openat`/rename handles, so write publication cannot guarantee protection from
an actively hostile concurrent parent-directory replacement. Such an
environment is outside this adapter's supported capability and must use a host
adapter with native directory-handle operations; the limitation is not
reported as race-safe support.
