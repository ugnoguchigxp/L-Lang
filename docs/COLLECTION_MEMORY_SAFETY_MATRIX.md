# Collection Memory Safety Matrix

対象profileは`module-collection-v1`、ABIは`llang-collection-native-v1`である。この文書は[Memory Safety Matrix JSON](../benchmarks/collection-memory-v1/memory-safety-matrix.json)から生成する。schemaは[collection-memory-safety-matrix-v1](../schemas/collection-memory-safety-matrix-v1.schema.json)に置く。

| ID | Subject | Guaranteed by | Condition | Positive vectors | Negative vectors | Limitation |
| --- | --- | --- | --- | --- | --- | --- |
| MSM1 | top-level input and output regions | generated-wasm | Pointers are four-byte aligned, lengths are within 256 KiB, contained in fixed memory, and regions do not overlap. | canonical direct ABI invocation | negative pointer; wraparound length; partial overlap; short root | Memory outside ABI and validator work regions is module-private. |
| MSM2 | nested payload containment and aliasing | generated-wasm | Every non-empty payload is claimed inside the input region before it is read and cannot overlap an earlier claim. | nested canonical List and String | root alias; duplicate String payload; misaligned List payload | A hostile host that concurrently changes memory during evaluate is outside the ABI model. |
| MSM3 | UTF-8 and canonical empty descriptors | generated-wasm | String bytes are valid scalar UTF-8 and empty String/List descriptors use pointer zero. | ASCII and four-byte scalar values | lone continuation byte; nonzero pointer with zero length | Normalization of valid Unicode scalar sequences is not performed. |
| MSM4 | List and aggregate limits | generated-wasm | Each List has at most 4096 elements and aggregate List elements do not exceed 16384. | boundary-sized descriptors | 4097 element descriptor; aggregate overflow | Limits are ABI resource policy rather than general-purpose allocation limits. |
| MSM5 | arena allocation | generated-wasm | Alignment padding and size are compared with remaining capacity before heap mutation. | maximum fitting allocation | output capacity exhaustion; i32 wraparound arguments | The arena remains evaluation-scoped and is not a public allocator. |
| MSM6 | copy bounds | generated-wasm | Source and destination ranges are checked against current memory before byte copies. | deep output promotion | insufficient output capacity | Typed scalar stores rely on validated layouts and safe arena addresses. |
| MSM7 | host value shape and canonical encoding | host-codec | Only exact plain-object shapes, i32 values, bounded Lists, and scalar strings are encoded. | runtime evaluate with canonical JavaScript input | extra fields; lone surrogate; oversized wire value | This layer does not replace generated-Wasm validation for direct callers. |
| MSM8 | fault stop and instance lifetime | generated-wasm | Validation and resource failures trap with the first fault and leave busy set. | fresh instance after a failed invocation | reuse of trapped instance | Runtime creates a fresh instance for every public evaluate call. |
| MSM9 | RegionMemory metadata | host-codec | Release deletes allocation metadata, IDs are never reused, and ID exhaustion fails closed. | 1000000 allocate/release cycles with one free block | stale handle; forged ID; double release | RegionMemory is independent from the Collection Wasm arena. |
| MSM10 | linear-memory bounds | wasm-engine | The module has fixed 128-page memory and cannot grow it. | portable artifact validation | out-of-memory-range ABI argument | Engine bounds do not establish descriptor semantics without generated validators. |

generated Wasmは検査失敗をfault code 5 `INVALID_ARTIFACT`でtrapする。実行中のindex、division、arithmetic、resource faultは既存code 1〜4を維持する。Wasm trap後は同じinstanceを再利用せず、新しいinstanceで次の評価を行う。

validatorのclaim bitmapはinput/outputと重ならないmodule-private領域を呼出しごとに選ぶ。bitmapはinput wire長により有界であり、検査完了後に参照されない。ABI利用者が所有できる領域は明示したinput/outputだけである。
