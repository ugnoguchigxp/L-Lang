# L-Lang collection modules (`module-collection-v1`)

This document defines the Phase 3 collection profile. The older
`module-bool-v1` and `module-value-v1` profiles, their source versions, ABIs,
manifests, suites, and hashes are unchanged.

## Source and types

JSONC sources use `language: "l-lang"`, source version 4, kind `module`, and
profile `module-collection-v1`. TypeScript selects the same profile explicitly
with `--profile module-collection-v1`. A graph may contain TypeScript and JSONC
files but may not mix profiles.

The profile retains boolean, signed i32, Unicode string, finite records, and
tagged unions. It adds homogeneous `List<T>`, explicit function types, and type
parameters on functions and record/union aliases. Generic calls must provide
all type arguments. Compilation records deterministic monomorphization keys;
polymorphic recursion is rejected.

Function parameters, results, local `const`/`let` bindings, lambda parameters,
and empty List literals require explicit types. A `let` may be rebound only to
the same type. Fields and List elements cannot be assigned directly. `while`,
typed `for-of`, unlabelled `break`/`continue`, return, and exhaustive tagged
union matches are supported. Module import cycles and recursive data types are
still rejected; direct and mutual function recursion are allowed.

## Lists and callbacks

List literals evaluate left-to-right. `length`, `at`, `set`, `append`, `map`,
`filter`, `fold`, and `stableSort` are fixed `llang:core` intrinsics. `set` and
`append` return new Lists. `for-of` snapshots its source List before iteration.
An invalid index produces `INDEX_OUT_OF_BOUNDS`.

Callbacks run in source order exactly once per visited element. `fold` is a
left fold. `stableSort` is a bottom-up stable merge sort and treats a negative,
zero, or positive comparator result conventionally. Equal elements retain
their input order.

Lambdas capture lexical values. Parameters and `const` values are capturable;
capturing `let` or the iteration binding is rejected. Captures are copied by
value into an arena-backed environment, so a returned closure remains valid
after its creating frame exits. Function values may be locals, parameters, or
results, but may not occur in Lists or external input/output wire types.

## Resources and faults

Each evaluation starts with fresh state. Fuel is 1,000,000, logical call depth
is 64 (entry is depth one), and cumulative arena allocation is 4 MiB. A List
holds at most 4,096 elements and an input or output tree at most 16,384 List
elements. Input and output wire limits are 256 KiB each; a string remains
limited to 16 KiB of UTF-8. Resource exhaustion is `RESOURCE_LIMIT`; checked
i32 arithmetic retains `ARITHMETIC_OVERFLOW` and `DIVISION_BY_ZERO`.

## ABI and artifacts

Build manifest version 3 uses ABI `llang-collection-memory-v1`, suite version
3, fixed 128-page memory, and source and lowered hashes. A List wire descriptor
is an eight-byte little-endian pointer/count pair. Empty Lists use the sole
canonical representation `pointer=0,count=0`. The codec verifies alignment,
count×stride arithmetic, containment, non-overlapping payload regions, UTF-8,
depth, and aggregate element limits.

The artifact exports only `memory` and
`evaluate(inputPtr,inputLength,outputPtr,outputCapacity) -> status` and imports
nothing. Status 6 is reserved for `INDEX_OUT_OF_BOUNDS`; statuses from older
ABIs are not redefined. Portable verification authenticates the sealed lowered
executable contract, validates the Wasm shell with Binaryen 132.0.0 and the
WebAssembly engine, then performs the same codec and resource checks without
source files or the compiler.

See [`../examples/module-order-batch/`](../examples/module-order-batch/) for
equivalent TypeScript and JSONC sources and a portable version-3 suite.
