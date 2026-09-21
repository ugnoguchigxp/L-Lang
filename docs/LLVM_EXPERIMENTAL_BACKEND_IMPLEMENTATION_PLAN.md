# LLVM実験backend 最小比較 実装計画

作成日: 2026-09-21。状態: 実装完了。計画基点revision: `fc72c1164db17049f2f934119d3376e46e5bf916`。

参照: [メモリー安全性とSemantic IR最適化のコンセプト](./MEMORY_SAFETY_AND_SEMANTIC_OPTIMIZATION_CONCEPT.md)、[Wasm最適化ビルド設計案](./WASM_OPTIMIZED_BUILD_DESIGN.md)、[Collection仕様](./LLANG_MODULE_COLLECTION_SPEC.md)、[Collectionメモリー安全性と最適化基盤の結果](./COLLECTION_MEMORY_SAFETY_AND_OPTIMIZATION_RESULTS.md)。

## 1. 目的

検証済み`module-collection-v1` IRから、既存の直接Wasm backendとは独立した実験用LLVM IRを生成し、一つの限定処理を最後まで実行・比較する。初回はchecked `sum(List<i32>)`だけを対象とし、次を実測する。

1. 既存reference evaluator、製品Collection Wasm、実験用直接Wasm、LLVM Wasm、LLVM Nativeが正常値と最初のfaultで一致するか。
2. LLVM IR生成、最適化、object生成、link、Wasm compile／instantiate、Native loadを含む工程別コスト。
3. 同一kernel・同一入力でのkernel時間、入出力込み時間、artifact size、linear memoryまたはNative buffer使用量。
4. LLVM WasmまたはNativeを次段階へ広げる価値があるか、現行経路を維持すべきか。

LLVM採用や性能改善を完了条件にしない。正しさ、再現性、比較可能性を満たしたうえで「拡張」「限定継続」「見送り」のいずれかを証拠付きで決定すれば完了とする。

## 2. 現在地と着手理由

Collection、Value、Effectsのdirect Wasm memory境界は個別計画で強化済みである。Collectionには検証済み型、monomorphized function、List layout、reference evaluator、native Wasm emitter、固定したBinaryen 132.0.0がある。このため、新backendの意味比較を始める接続点として最も具体的である。

一方、共通backend interface、LLVM emitter、LLVM toolchain管理、Native artifact契約は存在しない。既存の`module-collection-v1` manifest version 4とABI `llang-collection-native-v1`へ未検証のLLVM成果物を混ぜてはならない。

計画作成時のmacOS arm64環境では次を確認した。

| tool | 状態 |
| --- | --- |
| Apple Clang | `/usr/bin/clang`、Apple clang 17.0.0 |
| `llvm-as` | PATH上にない |
| `opt` | PATH上にない |
| `llc` | PATH上にない |
| `wasm-ld` | PATH上にない |
| package manager | Homebrew `/opt/homebrew/bin/brew`あり |

実装時にはstandalone LLVM toolchainを導入し、実際に使用した絶対path、version、target一覧、linkerをfreezeする。Apple Clangだけで不足toolを黙って代替しない。

## 3. 初回subset

### 3.1 source program

新しいfixtureは既存source version 4、profile `module-collection-v1`で表す。

```text
Input  = { values: List<i32> }
Output = { total: i32 }

evaluate(input):
  total = fold(input.values, 0, (sum, value) => checked(sum + value))
  return { total }
```

TypeScriptとJSONCの両sourceを既存loaderで読み、同じ`programHash`、`loweredHash`、`interfaceHash`、`layoutHash`になることを要求する。新しい構文、型、intrinsicは追加しない。

### 3.2 実験用kernel IR

`CheckedCollectionProgram`から次のversion付き内部表現だけを抽出する。

```text
LlvmKernelPlanV1 {
  operation: "checked-sum-i32"
  sourceProgramHash
  sourceLoweredHash
  inputField: "values"
  outputField: "total"
  maximumElements: 4096
  overflow: "first-checked-add"
}
```

抽出器はshapeを推測で一般化しない。entry、parameter／return type、field、fold初期値、lambda引数、演算子、評価順が完全一致する場合だけ受理し、それ以外を`UNSUPPORTED_LLVM_EXPERIMENT`で拒否する。kernel planのhashをLLVM IRと結果へ結び付ける。

このplanは製品Semantic IRの置換ではなく、限定subsetの決定的projectionである。将来のbackend interfaceは、このPoCで共有要件が確認できるまで導入しない。

## 4. 意味契約

### 4.1 保存する意味

- signed i32の加算を各要素ごとにchecked評価する。
- 左から右へ一度ずつ要素を読む。
- 中間和が範囲外になった時点で`ARITHMETIC_OVERFLOW`とする。最終数学値がi32へ戻る入力でも途中overflowを見逃さない。
- empty Listは0を返す。
- Listは最大4,096要素とする。
- input値は変更しない。
- 正常結果とfault分類を、既存`evaluateCollectionProgram`と製品Collection Wasmに一致させる。

LLVM IRでは`llvm.sadd.with.overflow.i32`または同値の明示的拡張・比較を使う。`nsw`／`nuw`を付けてoverflowを未定義動作へ変えない。`fast-math`、`inbounds` GEP、`noalias`、`nonnull`、`dereferenceable`、alignment、range metadataは、初回には証明なしで付与しない。

### 4.2 実験用kernel ABI

backend比較用に製品artifactとは別のABI `llang-llvm-kernel-experiment-v1`を定義する。

| 項目 | 契約 |
| --- | --- |
| function | `llang_checked_sum_i32(values, count, out) -> status`。Wasmでは`values`／`out`はi32 offset、Nativeではrunner-owned pointer |
| success status | 0。`out`へi32 resultを書く |
| overflow status | 1。`out`を結果として扱わない |
| invalid range status | 2。Wasm direct ABIだけでcaller range違反を分類する |
| count | unsigned、0〜4096 |
| element | little-endian signed i32 |
| Wasm memory | initial／maximumとも2 page、import 0、`memory`をexport |
| alignment | caller要件にせず、i32 load／storeはLLVM IRで`align 1`を明示する |
| mutation | input rangeを変更しない |

Wasm variantはfixed memoryをexportし、rangeと`count * 4`をload前に検査する。直接WasmとLLVM Wasmは同じexport、status、memory条件を使う。Native variantはprocess内pointerを受けるため、Wasmと同じsandboxや任意pointer検証を主張しない。Native runnerが所有するbufferだけを渡し、別processでtimeoutと異常終了を分類する。

このABIを`module-collection-v1`の公開ABI、manifest、portable verifierへ追加しない。

## 5. backend構成

### 5.1 比較対象

| lane | 役割 |
| --- | --- |
| reference | `evaluateCollectionProgram`。言語意味とfaultの第一oracle |
| product Wasm | 現行`emitCollectionModuleWasm`とpublic runtime。製品経路の回帰oracle |
| direct kernel Wasm | 同じkernel planから生成する小さなWAT。LLVMとのbackend比較baseline |
| LLVM Wasm O0/O2/O3 | textual LLVM IRをassemble／optimize／codegen／linkしたimport-free Wasm |
| LLVM Native O0/O2/O3 | 同じLLVM IRから生成したmacOS arm64 dylibを隔離runnerで呼ぶ |

product Wasmはfull Collection ABI、kernel lanesは実験ABIであり、kernel時間を同じものとして混ぜない。意味比較では同じ入力と期待結果を使い、性能表ではproduct end-to-endとkernel laneを別欄にする。

Nativeは初回の入力同一性を優先してdylibと隔離runnerを用いる。これは公開C ABIや配布libraryの完成を意味しない。Native executable、static library、Windows DLL、Linux shared objectは後続判断へ分離する。

### 5.2 textual LLVM IR

TypeScript emitterは、target非依存のkernel本体とtarget別wrapperを分離する。

- kernel本体: count loop、i32 load、checked add、status return。
- Wasm wrapper: memory上のrange検査とresult store。
- Native wrapper: runner-owned buffer用symbolとresult store。
- target tripleとdata layoutはtoolchainから取得した値をfreezeし、推測で埋めない。
- module identifier、source filename等にabsolute workspace pathや一時directoryを含めない。
- 未最適化`.ll`、最適化後`.ll`、object／Wasm／dylibのSHA-256を記録する。
- Wasm linkはentryなし、memory export、initial／maximum 2 page、必要symbolだけのexportを明示する。
- Native linkは固定basenameとinstall nameを使う。macOS loaderが要求するMach-O UUIDは保持し、二つのrootでartifact全体がbyte一致することを検査する。一致しないsectionが残る場合は原因を特定し、決定性を達成するまで完了扱いにしない。

LLVM verifierを通した後だけcodegenする。stderrを上限付きで保存し、tool失敗をcompile errorとして結果に残す。

## 6. toolchain管理

`src/llang-llvm-toolchain.ts`へ、外部command実行を一箇所に集約する。

1. `LLANG_LLVM_BIN`が設定されていれば、そのdirectoryだけを探索する。
2. 未設定ならPATH、Homebrewの既知prefixをread-onlyで探索する。
3. `llvm-as`、`opt`、`llc`、`wasm-ld`、Native linker／clang driverが同一LLVM系列として利用可能か確認する。
4. version、target、実行pathを`benchmarks/llvm-backend-v1/freeze.json`へ保存する。
5. 欠落、version不一致、Wasm targetなしは明示的な`TOOLCHAIN_UNAVAILABLE`にする。

通常の`bun run check`は外部LLVM導入を前提にしない。emitter、parser、schema、固定LLVM IR fixtureは通常testへ含める。実toolchainを使う検証は`bun run llvm:experiment:verify`として分離し、この計画の完了時にはmacOS arm64で必ず実行する。toolがない環境で成功扱いのskipにはしない。

外部commandは引数配列で起動し、shell文字列を組み立てない。workspace外を入力にせず、専用temporary directoryを作り、symlinkと既存出力を拒否し、終了時にcleanupする。各工程にtimeout、stdout／stderr上限、artifact size上限を設ける。ネットワーク、credential、package manager操作はexperiment実行中に行わない。

## 7. correctness corpus

探索用とholdout用を測定前に固定し、同じcaseを全laneへ渡す。

### 7.1 必須case

- empty、1要素、正数、負数、0混在。
- i32 min／maxを含むがoverflowしない境界。
- 正overflow、負overflow。
- 最終数学値が範囲内へ戻るが途中でoverflowする並び。
- 同じ値を並べ替えるとoverflowの有無が変わる、評価順序を識別できる並び。
- 4,095／4,096要素。
- 4,097要素のsource/profile resource rejection。
- Wasm kernel ABIのunalignedだがcontainedなbase、memory末尾ちょうど、short range、count overflow相当、input/output overlap。

各caseはexpected status、resultまたはfault、reference上の最初のoverflow index、input before／after hashを持つ。kernel ABIで観測するのはstatusまでとし、overflow indexを公開ABIへ追加しない。順序を変えるmutantは、結果またはoverflowの有無が変わるcaseで検出する。Native laneでは不正pointerを生成せず、valid semantic corpusだけを別process runnerへ渡す。Wasm ABI adversarial caseをNative memory safetyの証拠へ流用しない。

### 7.2 differential

- TypeScript sourceとJSONC sourceが同じchecked programとkernel planになる。
- referenceとproduct Wasmが全semantic caseで一致する。
- direct kernel Wasm、LLVM Wasm O0/O2/O3、LLVM Native O0/O2/O3がreferenceのresult／faultと一致する。
- optimization levelでresult／fault分類とinput hashが変わらない。
- LLVM IRを意図的に壊すmutantを用意し、少なくともchecked-add除去、loop bound off-by-one、signed count比較、early output store、入力順序反転をcorpusが検出する。

mutantはtest内のIR置換またはfixtureに限定し、製品emitterへoptionを追加しない。

## 8. benchmark設計

### 8.1 測定対象

buildを次へ分ける。

- kernel plan生成。
- textual LLVM IR生成。
- assemble／verify。
- optimize。
- object生成。
- link。
- Wasm validation／compile。
- Native dylib load。

実行を次へ分ける。

- Collection encode／host validation。
- product Wasm instantiate。
- product Wasm evaluate。
- Collection output decode。
- direct／LLVM Wasm instantiateとkernel。
- Native child startup／dylib loadとkernel。
- 入出力込み。

Native FFIの呼出し時間とchild process起動時間を混ぜない。Wasm linear memory容量、artifact bytes、Native buffer bytes、process peak RSSを別metricにする。

### 8.2 固定条件

- 実行したBun versionとBinaryen 132.0.0をfreezeする。package指定のBun 1.4.2と異なる場合は性能結果の制約として明記する。
- 実行OS、architecture、CPU、LLVM全tool versionを記録する。
- explorationとholdoutのdataset hashを固定する。
- performance datasetはsmall 64、medium 1,024、maximum 4,096要素を含み、overflowしない値列を使う。correctness用overflow caseの時間を通常kernel性能へ混ぜない。
- warmup、iteration、sample数、lane順序のseedをmanifestへ保存する。
- lane順序をcounterbalanceし、同じprocess内のglobal optimizer設定を復元する。
- raw samplesを保存し、median、MAD、p95をrawから再生成する。
- instrumentationを使った時間を製品性能と扱わない。

### 8.3 採否規則

correctness、memory boundary、reproducibilityのいずれかが失敗したlaneは性能に関係なく却下する。その後、holdoutで次を評価する。

| 判断 | 条件 |
| --- | --- |
| LLVM Wasmを次段階へ拡張 | direct kernel Wasmに対してkernel medianが5%以上悪化せず、少なくともmedium／maximumの一方で10%以上改善し、artifactが2倍以下。build costを併記する |
| Nativeを限定継続 | LLVM Wasmよりkernelで有意な差があり、child／load／FFIを含む利用想定でも価値が残る。sandbox差を受容する用途を別途定義できる |
| 現行経路を維持 | 効果が揺らぎ以下、build／配布依存が過大、または意味・資源契約を揃えられない |

5%／10%／2倍は初回PoCの選別値で、一般性能の主張ではない。信頼区間または反復間のばらつきが差を覆う場合は「不明」とする。LLVM O3を既定採用せず、各levelを独立結果として扱う。

## 9. 成果物

### 実装

- `src/llang-llvm-kernel-ir.ts`: subset抽出、strict parser、hash。
- `src/llang-llvm-emitter.ts`: target非依存kernelとtarget wrapperのLLVM IR生成。
- `src/llang-llvm-toolchain.ts`: discovery、version freeze、bounded process実行。
- `src/llang-llvm-wasm.ts`: direct WAT baseline、LLVM Wasm shape検査、runner。
- `src/llang-llvm-native-runner.ts`: isolated childとNative library呼出し。
- `src/llang-llvm-report.ts`: raw sample集計と事前規則による採否。
- `src/llang-llvm-experiment.ts`: corpus、build、differential、benchmark、report生成。
- 対応するunit／integration／mutation test。

### fixtureと証跡

- `examples/llvm-sum-i32/`: TypeScript／JSONC sourceと利用説明。
- `benchmarks/llvm-backend-v1/freeze.json`。
- `benchmarks/llvm-backend-v1/corpus.json`。
- `benchmarks/llvm-backend-v1/benchmark.json`。
- `benchmarks/llvm-backend-v1/observations/<os>-<arch>.json`。
- `benchmarks/llvm-backend-v1/decision.json`。
- `schemas/llvm-kernel-plan-v1.schema.json`。
- `schemas/llvm-experiment-corpus-v1.schema.json`。
- `schemas/llvm-experiment-benchmark-v1.schema.json`。
- `schemas/llvm-experiment-freeze-v1.schema.json`。
- `schemas/llvm-experiment-observation-v1.schema.json`。
- `schemas/llvm-experiment-decision-v1.schema.json`。
- `docs/LLVM_EXPERIMENTAL_BACKEND_RESULTS.md`。

raw build artifactとtemporary dylibは既定でGit管理しない。再現に必要な未最適化／最適化LLVM IRをchecked-in fixtureにする場合は、toolchain依存部分と決定的部分を分離し、hashと生成commandを記録する。

## 10. 実装単位

### PR-0: baselineとtoolchain freeze

- 基点revision、既存Collection hashes、product Wasm bytes/hash、Bun／Binaryen／TypeScriptを固定する。
- standalone LLVM toolchainを発見し、version、target、path、linker、macOS SDKを記録する。
- source、corpus、schema、測定条件、採否規則を結果観測前に固定する。

出口: 同じ入力とtoolchainを再実行でき、欠落toolを成功として扱わない。

### PR-1: strict kernel projection

- TS／JSONC fixtureを既存loaderでchecked programへ変換する。
- checked sumだけを受理する`LlvmKernelPlanV1`抽出器を実装する。
- 近似shape、別演算、別field、unchecked表現を拒否するmutation testを追加する。

出口: source差に依存せず同じkernel hashになり、未対応IRがfail-closedになる。

### PR-2: referenceとdirect Wasm baseline

- reference evaluatorとproduct Collection Wasmのcorpus結果を固定する。
- 実験ABIのdirect WAT emitterとraw harnessを実装する。
- Wasm range、count、overlap、input immutabilityをdirect callで検査する。

出口: 製品意味とkernel意味が一致し、backend比較の独立baselineができる。

### PR-3: LLVM IR emitter

- target非依存checked loopとWasm／Native wrapperを生成する。
- canonical formattingとhashを固定する。
- verifier、checked-add mutation、absolute path混入検査を追加する。

出口: 固定programから決定的なLLVM IRを生成し、unsupported attributeを含めない。

### PR-4: LLVM Wasm pipeline

- O0／O2／O3のassemble、optimize、codegen、linkを実装する。
- import/export/memory、size、validationを検査する。
- direct Wasmと全corpusでdifferentialを行う。

出口: LLVM Wasmがtrapや意味差なしに全caseを処理する。

### PR-5: LLVM Native pipeline

- macOS arm64 dylibを生成し、隔離childからrunner-owned bufferで呼ぶ。
- timeout、signal、exit code、stderr、cleanupを分類する。
- valid corpusでreferenceとdifferentialを行う。

出口: Native laneがWasmと区別された信頼境界で実行できる。

### PR-6: mutationとreproducibility

- 5種類以上のLLVM／Wasm mutantを固定corpusで検出する。
- 二つのtemporary rootでIRとartifact hashを比較する。
- toolchain pathやtimestampが決定的成果物へ混入しないことを確認する。

出口: validator自身と同じ式だけをoracleにせず、意味欠落を検出できる。

### PR-7: benchmarkと採否

- build phase、kernel、end-to-end、memory、artifact sizeを測る。
- raw samplesから表を決定的に再生成する。
- 事前規則で「拡張」「限定継続」「維持」の判断を一つ記録する。

出口: 速度倍率の印象ではなく、正しさとコストを含む判断が残る。

### PR-8: 文書と品質Gate

- CLI reference、roadmap、docs index、QUALITY_GATES、SECURITYを更新する。
- 結果文書へ環境、件数、coverage、hash、未実行OS、保証外を記録する。
- 全体Gateと外部toolchain Gateを実行する。

出口: 実装、証跡、仕様が同じ限定範囲を述べる。

## 11. 受け入れ条件

| ID | 完了条件 |
| --- | --- |
| LLB1 | freezeがrevision、Bun、Binaryen、TypeScript、LLVM各tool、target、linkerを固定する。 |
| LLB2 | TS／JSONC fixtureが同じchecked programとkernel planになる。 |
| LLB3 | kernel projectionがchecked sum以外を明示的に拒否する。 |
| LLB4 | kernel planがsource program／lowered hashへ結び付く。 |
| LLB5 | referenceとproduct Collection Wasmが全semantic corpusで一致する。 |
| LLB6 | direct kernel Wasmが同じresult／faultに一致する。 |
| LLB7 | LLVM Wasm O0／O2／O3が同じresult／faultに一致する。 |
| LLB8 | LLVM Native O0／O2／O3がvalid corpusで同じresult／faultに一致する。 |
| LLB9 | empty、境界i32、途中overflow、最大Listを検査する。 |
| LLB10 | checked additionを`nsw`／`nuw`や通常addで代用しない。 |
| LLB11 | input順序を保存し、順序を変えるmutantをoverflow outcomeが変わるcaseで検出する。 |
| LLB12 | Wasm kernelがrangeとcount×4をload前に検査する。 |
| LLB13 | Wasm kernelがinput/output overlapを拒否する。 |
| LLB14 | 全laneがinputを変更しない。 |
| LLB15 | LLVM IRとartifactへabsolute temporary path、timestamp、credentialを含めない。 |
| LLB16 | `llvm-as`／`opt` verifier失敗をcodegen前に停止する。 |
| LLB17 | toolchain欠落やversion不一致を成功扱いのskipにしない。 |
| LLB18 | external processにtimeout、output上限、artifact size上限がある。 |
| LLB19 | Nativeを別processで実行し、signal／timeout／非zero終了を分類する。 |
| LLB20 | Native結果をWasm sandbox保証として報告しない。 |
| LLB21 | O0／O2／O3でresult、fault分類、input hashが変わらない。 |
| LLB22 | 5種類以上のmutantを固定caseが検出する。 |
| LLB23 | 二つの出力rootで決定的IRとartifact hashが一致する。 |
| LLB24 | build工程と実行工程の時間を分離する。 |
| LLB25 | kernelとend-to-end、linear memoryとRSS、artifact bytesを分離する。 |
| LLB26 | explorationとholdout、warmup、sample、seedを測定前に固定する。 |
| LLB27 | raw sampleからsummaryとdecisionを再生成できる。 |
| LLB28 | 採否規則を結果観測後に緩めない。 |
| LLB29 | 既存Collection source、ABI、manifest version、portable artifactを変更しない。 |
| LLB30 | 製品build、verify、suite、direct memory safety testが回帰成功する。 |
| LLB31 | 外部LLVMを通常build、runtime、配布artifactの必須依存にしない。 |
| LLB32 | LLVM実験artifactを既存portable verifierが製品artifactとして受理しない。 |
| LLB33 | 全体check、coverage、docs、protected、smoke、`git diff --check`が成功する。 |
| LLB34 | macOS arm64の実toolchain integrationを実行し、Ubuntu／Windows等の未実行OSを明記する。 |
| LLB35 | 結果文書がsubset、Native信頼境界、性能主張の範囲、採否を明記する。 |

## 12. 検証コマンド案

```sh
npx -y bun@1.4.2 test src/llang-llvm-kernel-ir.test.ts src/llang-llvm-emitter.test.ts src/llang-llvm-wasm.test.ts --timeout 30000
npx -y bun@1.4.2 run llvm:experiment:verify
npx -y bun@1.4.2 run llvm:experiment:benchmark
npx -y bun@1.4.2 test src/llang-module-collection.test.ts src/llang-collection-memory.test.ts --timeout 30000
npx -y bun@1.4.2 run ci:module-smoke
npx -y bun@1.4.2 run format
npx -y bun@1.4.2 run check
npx -y bun@1.4.2 run coverage
npx -y bun@1.4.2 run ci:docs
npx -y bun@1.4.2 run ci:protected
npx -y bun@1.4.2 run ci:smoke
git diff --check
```

script名は実装時に`package.json`とCLI referenceへ同時追加する。benchmarkはnetwork、credential、real external serviceを使わない。

## 13. レビュー観点

- subset抽出器が名前の一致だけで意味を推測していないか。
- checked overflowと最初のfaultを全optimization levelで保存しているか。
- LLVM optimizerへ成立未証明のattribute／metadataを渡していないか。
- Wasm addressをsigned値として比較していないか。
- Native pointerをWasmと同じ検査済み範囲だと誤記していないか。
- product Wasm end-to-endと小さなkernel時間を同じ指標で比較していないか。
- toolchain path、SDK、temporary directoryがhashを不安定にしていないか。
- command injection、symlink、既存出力上書き、無制限stderr、停止しないchildを防いでいるか。
- fixture成功を一般Collection、String、Record、closure、effectsの対応へ拡張していないか。
- 改善しなかった結果やbuild costを省いていないか。

## 14. 保証外と後続候補

初回はString、Bytes、Record／Unionの一般lowering、closure、genericsの一般形、再帰、stable sort、effects、async、session、resource handleをLLVMへ実装しない。任意LLVM IR、任意native code、第三者libraryのmemory safetyも保証しない。

LLVM NativeはWasm sandboxを持たず、OS process、dynamic loader、FFIの信頼境界を追加する。公開C ABI、長期library互換、配布、code signing、notarization、remote executionは対象外である。

初回結果が拡張を支持した場合だけ、次を一件ずつ計画する。

1. scalar関数、if、while、直接callへのsubset拡張。
2. List map／filterまたはsort kernelの一つ。
3. 証明済みalias／readonly／alignment情報の付与。
4. Linux x86-64／arm64とLLVM WasmのCI matrix。
5. version付き実験artifactとoffline verifier。

既存製品backendへの統合、自動backend選択、LLVM成果物の配備は、PoCの採否後に別計画とする。

## 15. 完了条件

LLB1〜LLB35を満たし、[LLVM実験backend 最小比較 実装結果](./LLVM_EXPERIMENTAL_BACKEND_RESULTS.md)へ実装、corpus、toolchain、artifact、測定、採否、未保証範囲を対応付けた時点で完了とする。

LLVMが高速でなかった場合も、比較が正しく再現でき、現行経路を維持する判断を記録できれば完了である。LLVM導入、対応型の多さ、速度向上を成功条件にはしない。
