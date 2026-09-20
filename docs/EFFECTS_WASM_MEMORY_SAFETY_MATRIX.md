# Effects Wasm Memory Safety Matrix

対象profileは`module-effects-v1`、ABIは`llang-effects-session-v1`である。この文書は[Memory Safety Matrix JSON](../benchmarks/effects-memory-v1/memory-safety-matrix.json)から生成する。schemaは[effects-memory-safety-matrix-v1](../schemas/effects-memory-safety-matrix-v1.schema.json)に置く。

| ID | Subject | Guaranteed by | Positive vectors | Negative vectors | Limitation |
| --- | --- | --- | --- | --- | --- |
| EM1 | Top-level descriptors | Unsigned subtraction-form range validation before every descriptor load or store | exact-end; unaligned | invalid-base; short-capacity; wraparound | The host must not mutate exported memory during a synchronous call. |
| EM2 | Continuation transaction | Event and output validation precedes busy, state, sequence, accumulator, and result commits | valid-retry; same-sequence-retry | invalid-event; invalid-output; non-boolean-success | Terminal host failure, cancellation, disposal, and numeric faults retain their existing semantics. |
| EM3 | Caller aliasing | Contained half-open ranges reject event/output and typed payload/output overlap | adjacent-ranges; zero-length-payload | complete-overlap; partial-overlap; one-byte-overlap | Caller input ranges may alias each other when no write is performed through them. |
| EM4 | Typed module-private memory | Output and response payload ranges exclude embedded request data and result scratch | event-payload-region; maximum-payload | embedded-data-alias; result-scratch-alias | The exported memory is not an access-control boundary against direct host stores. |
| EM5 | Typed copy | The copy helper validates complete source and target ranges and rejects overlap before its loop | zero-length-copy; maximum-contained-copy | invalid-source; invalid-target; overlapping-copy | Payload syntax and canonical encoding remain host-codec responsibilities. |
| EM6 | Portable ABI compatibility | Existing exports, imports, fixed memory, layouts, statuses, manifest version, and runtime sequences are retained | public-runtime; portable-replay; direct-abi | nine-validator-mutants | Artifact bytes change because guards are added; byte identity is not an ABI promise. |

linear／typed continuation Wasmは、event descriptorを包含確認後に一度だけ読み、成功responseのoutput、typed payload、module-private領域をstate更新前に検査する。retryable boundary faultはstatus 4 `FAILED`で返り、fault 5または8へ分類される。

exported memoryを直接変更できるhost、typed payloadの意味、外部adapterと副作用の正当性はこの境界の保証対象ではない。
