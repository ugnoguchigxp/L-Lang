# Value Wasm Memory Safety Matrix

対象profileは`module-value-v1`、ABIは`llang-value-memory-v1`である。この文書は[Memory Safety Matrix JSON](../benchmarks/value-memory-v1/memory-safety-matrix.json)から生成する。schemaは[value-memory-safety-matrix-v1](../schemas/value-memory-safety-matrix-v1.schema.json)に置く。

| ID | Subject | Guaranteed by | Condition | Positive vectors | Negative vectors | Limitation |
| --- | --- | --- | --- | --- | --- | --- |
| VMM1 | top-level input and output regions | generated-wasm | Lengths are within 64 KiB, ranges are contained in fixed memory, and input and output do not overlap. | canonical and unaligned direct ABI invocation | short root; wraparound length; partial overlap | The host must not mutate memory concurrently during evaluate. |
| VMM2 | typed root validation | generated-wasm | Boolean slots, union tags, records, and the selected union payload are checked in layout order. | nested record and every selected variant | boolean 2; unknown tag; invalid selected payload | Safe immutable payload aliasing and nonzero input padding remain accepted for ABI compatibility. |
| VMM3 | string containment and UTF-8 | generated-wasm | A descriptor is loaded from the contained root, its payload is contained in the input, and only then is UTF-8 read. | empty, ASCII, two-, three-, and four-byte scalar strings | 0xffffffff pointer; truncated scalar; overlong encoding; surrogate | Valid strings are not Unicode-normalized. |
| VMM4 | arena allocation | generated-wasm | Requested bytes and alignment padding are compared with remaining memory before arena mutation. | fitting record and string allocations | constant allocation exhaustion | The arena is evaluation-scoped and is not a public allocator. |
| VMM5 | copy, zero, and output capacity | generated-wasm | Whole source and destination ranges are checked before copying or zeroing and output strings reserve aligned capacity. | portable order-line output | insufficient output capacity; mutated unchecked copy | A fault may leave bytes inside the declared output region zeroed or partially constructed, and the disjoint module-private arena may also change. |
| VMM6 | host value shape and canonical encoding | host-codec | The public runtime accepts exact typed values and writes canonical little-endian wire data. | public runtime evaluation | extra field; fractional i32; lone surrogate | Host validation does not replace generated-Wasm validation for direct callers. |
| VMM7 | fault classification and instance lifetime | generated-wasm | Invalid input returns status 1 before writes, runtime faults preserve their first status, and a later valid direct call can reuse the synchronous instance. | valid call after rejected input | malformed pointer; resource exhaustion | The public runtime still creates a fresh instance per evaluation. |
| VMM8 | linear-memory and artifact shape | wasm-engine | Memory is fixed at 16 pages and the artifact has no imports, start function, shared memory, or growth allowance. | portable artifact verification | unexpected export; wrong memory maximum | Engine bounds alone do not establish typed descriptor semantics. |

generated Wasmは、top-level rangeを確認してから型別rootを読み、string payloadの包含を確認してからUTF-8を走査する。不正なdirect ABI入力はstatus 1 `INVALID_INPUT`で返す。arithmetic、division、resource、internal artifact faultは既存status 2〜5を維持する。

public runtimeは呼出しごとにfresh instanceを生成する。direct ABIでは同期評価中にhostがmemoryを変更しないことを前提とし、安全なimmutable payload alias、unaligned access、非zero input paddingの既存受理範囲を維持する。
