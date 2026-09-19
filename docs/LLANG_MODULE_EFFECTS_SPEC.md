# L-Lang effects runtime (`module-effects-v1`)

This document records the implemented Phase 4 runtime contracts. The profile
uses ABI `llang-effects-session-v1`. Grants and credentials are runtime inputs;
they are never embedded in a program manifest.

The JSONC frontend is defined by
[`llang-module-v5.schema.json`](../schemas/llang-module-v5.schema.json). Its
restricted TypeScript counterpart is a literal `defineEffects` declaration;
both lower to the same checked typed effect graph. The original single-source
linear i32 form remains accepted as a compatibility form.

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

Typed graphs use the `typed-wire-v1` layout: a 32-byte request descriptor, a
24-byte response event, and a 12-byte result descriptor. Payloads are bounded
canonical UTF-8 JSON bytes with explicit type tags; bytes, i64, and decimal
remain tagged and are never coerced through JavaScript number. Wasm owns the
state, generation, sequence, response-type check, and result copy. Await,
task-join, and stream-pull states share this continuation ABI. Task execution
uses the structured scope and shared ledger; stream execution permits one
outstanding pull, closes the producer at EOF or cancellation, and enforces the
declared chunk count.

An effects graph may import relative `.ts` and `.llang.jsonc` modules in either
direction. Every imported module must declare the same profile and expected
module name; cycles, duplicate modules, operation signature conflicts,
symlinks, and root escapes are rejected. Builds flatten the checked graph for
generated TypeScript and JSONC while retaining every original source path and
hash in the manifest. Generated TypeScript is executable through `EffectsHost`;
generated JSONC recompiles to the same typed program; Wasm embeds canonical
request payloads.

Source `file` and `http` nodes compile directly to versioned `file.read`,
`file.write`, and `http.request` operations. Programs do not call Node APIs or
`fetch`; the host-owned adapters still perform grants, address checks,
credential injection, cancellation, byte limits, atomic commit, and cleanup.

Portable effects bundles use build and replay-suite version 5 (version 4 is
already used by the native collection complement). The manifest pins the
program hash, operation requirements, effect set, exact ABI layout, Wasm hash,
and byte length. Verification rejects unknown manifest fields, symlinked or
changed Wasm, mismatched request sequences, unused events, and suite/program
hash mismatches.

### Static bundle inspection

`llang module inspect` accepts only typed version-5 `module-effects-v1`
bundles built with all three TypeScript, JSONC, and Wasm targets. It parses the
verified flattened JSONC in memory, regenerates TypeScript and Wasm with the
pinned toolchain, and compares the TypeScript/Wasm bytes, interface, lowered
hash, Wasm contract, and continuation states. The original `programHash`
includes source inventory and is retained for provenance; it is not compared
with the flattened source's different program hash.

Inspection does not instantiate Wasm, import generated TypeScript, invoke an
adapter, grant authority, access credentials, or create a runtime transcript.
Declared operations and effects remain requirements on a future host, not
permissions. Task continuation states distinguish the internal `task.join`
step, which needs no host grant, from each child operation, which still does.
Original source bodies are not present in the portable bundle, and internal
consistency is not publisher authentication or a general proof of semantic
equivalence.

### Runtime execution evidence

`llang module execute` accepts only an inspected version-5 typed all-target
bundle and an `llang-effects-grant` version-1 document bound to that bundle
identity. Execution instantiates the bundled Wasm bytes rather than a newly
emitted replacement. File, HTTP, and wall-clock built-ins and embedding-host
operations all pass through the same grant, resource-ledger, and recording
boundary.

Before the first host dispatch, the runtime durably publishes an execution
intent and appends a request event to a single-writer JSON Lines journal. Each
event commits to the previous event hash. Responses, stream chunks,
cancellation, cleanup, and the terminal state are appended in observed order.
Payload and response bodies, credential values and environment-variable names,
absolute file roots, HTTP paths and queries, full error messages, and stacks
are excluded. The journal retains typed-wire hashes and byte counts instead.

The final `effects-execution.json` binds the bundle identity, grant commitment,
bundled Wasm hash, transcript and result hashes, resource usage and peaks, and
cleanup outcome. Evidence is explicitly unsigned and caller-retained. A stale
execution can be finalized with `module recover-execution`; pending requests
become unknown outcomes and are never replayed. This evidence does not prove
host identity, remote-service truth, business correctness, exactly-once side
effects, or rollback.

## Initial adapters

The local file adapter uses handle-based reads. Writes go to an exclusive
same-directory temporary file and become visible only on explicit commit;
non-replacing commit uses a hard-link publication step and abort removes only
its own temporary file. Before publication or abort, the path must still name
the regular file with the device/inode recorded at creation. Traversal and
symlink escapes are rejected, and cleanup never recursively removes a path.

The HTTP adapter supports DNS names and public Internet addresses for origins
granted by the host. It resolves before connecting, rejects private, loopback,
link-local, documentation, multicast, and reserved destinations by default,
then pins one permitted address into the socket lookup while retaining the
original host name for HTTP Host and TLS SNI. A host can explicitly grant an
exact private address or CIDR (the loopback compatibility adapter does this).
Redirects and retries are not automatic, and proxy routing is not supported.
Credentials are injected from host-owned configuration and credential headers
from the program are rejected. HTTP 4xx/5xx remain responses; DNS, TLS,
connection, timeout, and cancellation failures remain IO errors. Request
bodies and pull chunks are bounded.

The Node file adapter verifies the opened read handle against the path's
device/inode after open. Node does not expose portable directory-relative
`openat`/rename handles, so write publication cannot guarantee protection from
an actively hostile concurrent parent-directory replacement. Such an
environment is outside this adapter's supported capability and must use a host
adapter with native directory-handle operations; the limitation is not
reported as race-safe support.

## Verification and operational evidence

Phase 4 correctness is covered by typed boundary and negative tests, fixture
replay, temporary-file and loopback HTTP integration, portable bundle checks,
and Bun 1.4.2 CI on Ubuntu, macOS, and Windows. The consolidated E01–E16 mapping
and the pinned CI run are recorded in the
[Phase 4 results](./GENERAL_PURPOSE_LANGUAGE_PHASE4_IMPLEMENTATION_RESULTS.md).

Soak tests, SAAA capability checks, Internet TLS deployment tests, and
long-running performance or memory claims are not inferred from the correctness
suite. They require representative workloads and an explicit observation
period. Until those records exist, the supported adoption path is local use
with explicit grants; no production-scale throughput, latency, or memory claim
is made.
