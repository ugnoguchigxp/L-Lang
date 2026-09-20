# L-Lang value modules (`module-value-v1`)

This document defines the implemented Phase 2 value-module profile. The older
`module-bool-v1` profile and its version-1 build and suite formats remain
unchanged.

## Source and types

JSONC sources use `language: "l-lang"`, `version: 3`, `kind: "module"`, and
`profile: "module-value-v1"`. TypeScript sources select the profile explicitly
with `--profile module-value-v1`. A module graph cannot mix profiles.

The scalar types are `boolean`, signed 32-bit `i32` (`number` in the restricted
TypeScript frontend), and Unicode `string`. Named, non-recursive records and
tagged unions may contain scalars or other named values. Records contain only
required fields. Unions contain 2–16 variants and use `tag` as their
discriminator. Type expansion is limited to depth 8 and 4,096 nodes.

Functions require annotations on parameters, results, and local `const`
bindings. The supported control forms are immutable blocks, `if`/`else`,
conditional expressions, and exhaustive `switch`/`match`. Assignment, loops,
recursion, optional fields, arbitrary unions, exceptions, spread, getters, and
function values are rejected.

`concat` and `scalarLength` are the only string intrinsics. TypeScript imports
them as named imports from `llang:core`. Strings are not normalized. Lone
surrogates and invalid UTF-8 are rejected; equality is exact and length counts
Unicode scalar values.

## Numeric and execution semantics

`+`, `-`, `*`, unary minus, `/`, and `%` use exact signed i32 semantics.
Overflow produces `ARITHMETIC_OVERFLOW`; zero division produces
`DIVISION_BY_ZERO`. Division truncates toward zero. Calls, constructor fields,
and arguments evaluate left to right once. Logical operators, `if`, and match
evaluate only the selected path.

Evaluation has 100,000 fuel units, a 16 KiB UTF-8 limit per string, and a 64
KiB limit for each input or output wire payload. Exhaustion is
`RESOURCE_LIMIT`. Business failures are ordinary tagged-union values and are
not converted to runtime faults.

## Wasm ABI

Build manifest version 2 uses ABI `llang-value-memory-v1`. A module exports only
`memory` and `evaluate`, imports nothing, and fixes memory at 16 pages.

```text
evaluate(inputPtr:i32, inputLength:i32,
         outputPtr:i32, outputCapacity:i32) -> i32
```

Status 0 is success; 1 is invalid input, 2 arithmetic overflow, 3 division by
zero, 4 resource limit, and 5 invalid artifact. Business-error variants return
status 0.

All scalar slots are four-byte little-endian values. Strings are an eight-byte
pointer/byte-length pair. Record fields are stored inline in field-name order.
Unions start with a numeric tag ordered by ASCII tag name and use the maximum
variant payload layout. Padding and inactive payload bytes are zeroed. The
runtime creates a new instance per call and copies the decoded result before
discarding it.

The generated `evaluate` validates top-level containment and non-overlap before
loading the typed root. It then validates booleans and the selected union
variant in layout order. A string descriptor is loaded only from the contained
root, and its bytes are scanned as UTF-8 only after the payload is contained in
the input wire. Malformed direct calls return status 1 before output writes;
they do not rely on the host codec to prevent an out-of-bounds read.

Unaligned but contained accesses, zero-length string pointers, immutable string
payload aliases, and nonzero input padding remain accepted for ABI
compatibility. The encoder still emits an aligned, zero-filled canonical form.
Memory outside the declared input and output is module-private and may be used
as the evaluation arena. The caller must not change memory while `evaluate` is
running. Allocation, zero, and copy helpers check complete ranges before
mutation; output string copies are bounded by `outputCapacity`.

The build manifest records `interfaceHash` (profile and input/output types),
`layoutHash` (ABI and layouts), fixed resource limits, toolchain versions, and
artifact hashes. Portable verification requires only the manifest, Wasm bytes,
and a version-2 suite.

## Suite results

Version-2 suite expectations are discriminated:

```json
{ "kind": "value", "value": { "tag": "ok", "total": 600 } }
{ "kind": "invalid-input" }
{ "kind": "fault", "code": "ARITHMETIC_OVERFLOW" }
```

Object field order is ignored when comparing values. Artifact corruption,
decode errors, traps, and timeouts never satisfy a business-error expectation.

See [`../examples/module-order-line/`](../examples/module-order-line/) for
equivalent TypeScript and JSONC graphs and a portable suite.
The direct-call guarantee and its limitations are indexed in the
[Value Wasm Memory Safety Matrix](./VALUE_WASM_MEMORY_SAFETY_MATRIX.md).
