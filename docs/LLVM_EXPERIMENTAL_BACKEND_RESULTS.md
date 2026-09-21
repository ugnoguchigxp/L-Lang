# LLVM実験backend 最小比較 実装結果

実施日: 2026-09-21。計画基点revision: `fc72c1164db17049f2f934119d3376e46e5bf916`。対応計画: [LLVM実験backend 最小比較 実装計画](./LLVM_EXPERIMENTAL_BACKEND_IMPLEMENTATION_PLAN.md)。

## 結論

checked `sum(List<i32>)`に限定したLLVM実験backendを実装し、reference evaluator、製品Collection Wasm、実験用direct Wasm、LLVM Wasm O0/O2/O3、LLVM Native O0/O2/O3を同じcorpusで比較した。15 semantic caseと7 Wasm ABI境界caseを使った165比較はすべて一致し、二つの出力rootでLLVM IRと最終artifactのSHA-256も一致した。

事前に固定した採否規則では、LLVM Wasmの全optimization levelが性能条件を満たさなかった。判断は`maintain-current-backend`である。LLVM経路は製品backend、公開ABI、manifest、portable artifactへ統合しない。Nativeはkernel単体で速いcaseがあるが、Wasm sandboxを持たず、隔離childのprocess時間がkernel時間を大きく上回るため`limited-experiment-only`とする。

## 実装範囲

`CheckedCollectionProgram`から完全一致するchecked List sumだけを`LlvmKernelPlanV1`へ射影する。別field、別演算、fold初期値の変更、引数順変更などは`UNSUPPORTED_LLVM_EXPERIMENT`で拒否する。LLVM IRは`llvm.sadd.with.overflow.i32`を使い、`nsw`、`nuw`、`inbounds`、`noalias`等の未証明属性を付けない。

実験ABIは`llang_checked_sum_i32(values, count, out) -> status`で、0が成功、1がoverflow、2がWasm range違反である。Wasmはimportなし、initial/maximum 2 page固定で、unsigned subtraction形式のrange検査とinput/output非重複検査をload前に行う。Nativeはrunner所有bufferだけを別processから渡し、timeout、signal、非zero終了、出力shapeを分類する。

再現手順は次の三つである。実toolchainがない場合はskipせず`TOOLCHAIN_UNAVAILABLE`になる。

```sh
bun run llvm:experiment:verify
bun run llvm:experiment:benchmark
bun run llvm:experiment:record
```

`record`は[freeze](../benchmarks/llvm-backend-v1/freeze.json)、[raw observation](../benchmarks/llvm-backend-v1/observations/darwin-arm64.json)、[decision](../benchmarks/llvm-backend-v1/decision.json)をstrict schemaで検証して更新する。

## 固定環境と入力

測定hostはmacOS arm64、Apple M4である。実行Bunは1.3.14だった。リポジトリが指定するBun 1.4.2との差を隠さずfreezeへ記録したため、このrunをBun 1.4.2の性能証拠には使わない。Binaryen 132.0.0、TypeScript 5.9.3、LLVM/LLD 23.1.1、macOS SDK 26.2を使用した。`clang`、`llvm-as`、`opt`、`llc`、`wasm-ld`の実pathと個別version、target triple、data layoutはfreezeにある。

| 対象 | SHA-256 |
| --- | --- |
| source program | `535378de8cac356701c701712b526e20e68f387ed2766364b6211dd0d334d083` |
| lowered program | `f65ae0d3d33f04a525fcdec2b79cb9b6c9f60408d6e7d48693592cf9ac48152f` |
| kernel plan | `d3faeb4a4551787ca0df661c0d69630fdca48afa505c1b1da4b2e6c246c75d4a` |
| corpus | `9684ca86ff902914cc9145f8d61a14a0699869e6f448ed97710daa8ba15855e6` |
| benchmark条件 | `cc37962b32435dc53d0d99f69a601d49a38902d3c6a34579c621664e662c16de` |

corpusはempty、i32 min/max、正負overflow、途中overflow、順序依存、4,095/4,096要素を含む。4,097要素はsource/profileのresource faultを確認する。Wasm ABIではunaligned base、memory末尾、short range、count超過、完全・1 byte overlapを直接呼び出した。input before/after hashは全kernel laneで一致した。

## Artifactとbuild cost

| lane | bytes | SHA-256 | build合計の目安 |
| --- | ---: | --- | ---: |
| product Wasm | 2,004 | `bdab7f6d…85f29` | 製品経路のため本表では未計測 |
| direct kernel Wasm | 260 | `01acde64…8f95` | Binaryenによるprocess内生成 |
| LLVM Wasm O0 | 271 | `ac4a2be3…bb8` | 142.5 ms |
| LLVM Wasm O2 | 250 | `19fbdf4f…917` | 157.2 ms |
| LLVM Wasm O3 | 250 | `19fbdf4f…917` | 145.9 ms |
| LLVM Native O0 | 16,856 | `8c946efb…a19` | 264.6 ms |
| LLVM Native O2 | 16,824 | `6391955b…888` | 261.1 ms |
| LLVM Native O3 | 16,824 | `6391955b…888` | 245.0 ms |

build合計は当該runのemit、assemble、optimize、reassemble、codegen、linkの和を丸めた値で、raw値はfreezeにある。O2とO3はこのkernelでは同じoptimized IRとartifactになった。Native Mach-Oはloaderが要求するUUIDを保持したまま二つのrootでbyte一致した。absolute temporary path、timestamp、credentialは決定的IRとartifactへ含まれない。

## Holdout測定

各caseはwarmup 20、100 iteration、7 sample、seed 20260921でlane順を回転した。単位は1 iterationあたりnsで、kernel laneとend-to-end laneを別scopeとして保存する。

| case | direct Wasm | LLVM Wasm O0 | LLVM Wasm O2 | LLVM Wasm O3 |
| --- | ---: | ---: | ---: | ---: |
| small 64 | 597 | 833 | 707 | 736 |
| medium 1,024 | 2,604 | 3,320 | 3,450 | 2,799 |
| maximum 4,096 | 6,446 | 4,804 | 6,732 | 6,377 |

値はmedianである。MADとp95を含むraw sampleはobservationから再集計でき、テストがchecked-in summaryとdecisionの完全一致を確認する。smallは測定揺らぎが大きく、一般的な速度倍率の根拠にはしない。

LLVM Wasmのdirect比は、O0がmaximumで25.5%改善した一方mediumで27.5%、smallで39.5%悪化した。O2は全holdoutで改善条件を満たさず、O3もmediumで7.5%、smallで23.3%悪化した。artifact比はO0 1.042、O2/O3 0.962でsize条件内だが、全caseの最大5%悪化条件を満たさない。

Native kernel中央値はmediumで1.45〜1.79 µs、maximumで2.52〜2.89 µsだった。child起動、dylib load、FFIを含むprocess中央値はoptimizationごとに約34〜36 ms、観測peak RSS中央値は約36.3 MBである。Native input bufferは`max(4, count×4)+4` bytes、Wasm linear memoryは131,072 bytes固定としてraw sampleへ分離記録した。

## 変異・失敗境界

テストはchecked-add除去、loop開始位置変更、signed count predicate、range検査前のoutput store、入力順序反転の5種類を検出する。LLVM verifierはcodegen前に実行し、tool timeoutは`LLVM_TOOL_TIMEOUT`、出力超過は`LLVM_TOOL_OUTPUT_LIMIT`、artifact超過は`LLVM_ARTIFACT_LIMIT`として失敗する。kernel Wasmは製品Collection verifierのexport/ABI検査を通らないことも固定した。

この結果が保証するのは、固定toolchainと限定kernelにおける意味一致、Wasm direct ABI境界、入力不変性、再現buildである。String、Bytes、一般Record/Union、closure、generics、再帰、sort、effects、async、resource handle、任意LLVM IR、第三者native libraryは対象外である。Nativeは任意pointerのmemory safety、Wasm sandbox、公開C ABI、code signing、配布互換性を提供しない。Ubuntu、Windows、Linux native、x86-64では実toolchain integrationを実行していない。

## 受け入れ条件との対応

- LLB1〜LLB9、LLB12〜LLB14、LLB21: freeze、strict projection、165 differential比較、境界corpus、input hashで確認した。
- LLB10〜LLB11、LLB22: checked overflowと順序を含む5 mutantで確認した。
- LLB15〜LLB19、LLB23: path非混入、verifier、tool失敗、上限、隔離Native、二重build hashで確認した。
- LLB20、LLB24〜LLB28: trust boundary、build/kernel/end-to-end/process/memory/artifactの別記録、固定sample条件、raw再生成、事前規則で確認した。
- LLB29〜LLB32: 製品ABI/manifestを変更せず、外部LLVMを通常依存にせず、製品portable verifierが実験artifactを拒否するテストで確認した。
- LLB33〜LLB35: 全品質Gate、macOS arm64実toolchain、本文のsubset・Native境界・性能範囲・採否で確認した。レビュー後の全体テストは759件、カバレッジ閾値、docs、protected、smoke、`git diff --check`が成功した。
