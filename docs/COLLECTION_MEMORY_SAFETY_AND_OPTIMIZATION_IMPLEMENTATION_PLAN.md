# Collectionメモリー安全性と最適化基盤 実装計画

作成日: 2026-09-20。状態: 実装完了。結果は[実装結果](./COLLECTION_MEMORY_SAFETY_AND_OPTIMIZATION_RESULTS.md)を参照する。

参照: [メモリー安全性とSemantic IR最適化のコンセプト](./MEMORY_SAFETY_AND_SEMANTIC_OPTIMIZATION_CONCEPT.md)、[Collection仕様](./LLANG_MODULE_COLLECTION_SPEC.md)、[Wasm最適化ビルド設計案](./WASM_OPTIMIZED_BUILD_DESIGN.md)、[第四弾実装結果](./GENERAL_PURPOSE_LANGUAGE_PHASE4_IMPLEMENTATION_RESULTS.md)。

## 1. 目的

初回の対象を`module-collection-v1`のnative Wasm境界へ限定し、次を順番に実施する。

1. host adapterを迂回して`evaluate`を直接呼び出した場合の保証を再現可能なtestで固定する。
2. descriptor、範囲、整数演算、input/output overlap、allocatorの安全性をWasm入口で検査する。
3. `RegionMemory`の管理情報が解放済みallocation数に比例して増え続けないようにする。ただしCollection Wasm allocatorへ接続済みとは扱わない。
4. allocationとcopyのコストを決定的な計数と実測時間に分けて記録する。
5. 安全性と計測条件が揃った場合だけ、事前に固定した選択規則で最適化候補を一つ選び、採用または見送りを判断する。

安全性修正は性能向上を条件にしない。最適化候補が有効でない、または効果が測定揺らぎ以下だった場合は、見送りの記録をもって計画を完了できる。

## 2. 現在地

2026-09-20の基点は`f52a0c73d8a6c68f568c94f72e10901f47ba312a`である。着手時には実際のHEADと作業ツリーを再確認し、このhashを実装対象だと仮定しない。

確認済みの実装状態は次のとおり。

| 項目 | 現行状態 | この計画で確認すること |
| --- | --- | --- |
| Collection ABI | `llang-collection-native-v1`、固定128 page、`evaluate(inputPtr,inputLength,outputPtr,outputCapacity)` | ABIを変えずに入口検査を追加できるか |
| host runtime | encode後に`decodeCollectionFromMemory`を実行し、検査済みbytesをWasmへ渡す | host検査とWasm自身の検査を別の保証として試験する |
| Wasm entry | `inputLength`を計算に使わず、entry関数へ`input`だけを渡す | 直接呼出しでmalformed descriptorを拒否する |
| allocator | alignmentとsizeをi32加算してから`heapEnd`と比較する | wraparound前に残容量で判定する |
| output promotion | nested String/List/Record/Unionを再帰copyする | allocation/copy量と意味上必要なcopyを分離する |
| RegionMemory | free-listでbytesを再利用するが、解放済みentryをMapに保持する | metadataが反復回数に比例しないことを確認する |
| Binaryen | `132.0.0`固定。Collection buildはparse、validate、emitのみ | 固定版以外のpassや最新APIを前提にしない |

`RegionMemory`は現在、Collection native Wasmの`$alloc`実装ではない。この計画では独立した欠陥候補として直し、両者を接続した、Wasmの割当が減った、という主張には使わない。

## 3. 保証境界

対象は、検証済みCollection IRから信頼するcompilerが生成したimport-free Wasmと、その公開ABIへ渡すbytesである。任意の悪意あるWasm、memoryを書き換えられるhost、共有memory thread、任意native FFIは対象外とする。

保証を次の層に分ける。

| 層 | 保証する内容 |
| --- | --- |
| source/IR checker | 型、List上限、wireに出せないfunction値、既存の評価順序 |
| host codec/runtime | JavaScript値のshape、canonical encode、UTF-8、bounded decode、artifact interface |
| generated Wasm entry | ABI引数、memory内領域、alignment、descriptor、aggregate上限、安全な積和、input/output分離 |
| Wasm engine | linear memory外アクセスのtrap、module validation |
| 未保証 | 悪意あるhostによる検査後のmemory改変、任意Wasmの契約遵守、OS全体のmemory safety |

host codecを通る通常経路が安全でも、Wasm entry自身の保証を省略しない。逆に、Wasm入口検査を追加してもhost側の型検査、canonical encode、output decodeを削除しない。

## 4. 変更しない契約

- source version 4、manifest version 4、suite version 3を維持する。
- ABI名`llang-collection-native-v1`、export名、引数と戻り値、固定memory page数を維持する。
- boolean、i32、String、List、Record、Union、closure、genericsの言語意味を変えない。
- 左から右の評価順序、callback回数、最初に観測されるfault、checked arithmetic、stable sortを維持する。
- fuel 1,000,000、call depth 64、arena 4 MiB、List 4,096要素、tree 16,384要素、wire 256 KiB、String 16 KiBの上限を暗黙に緩和しない。
- 既存artifactを新compiler出力と同じbytesへ書き換えない。旧artifact verifierとportable suiteを維持する。
- Binaryenの最適化levelやpassを製品既定へ追加しない。
- 言語構文、raw pointer、ユーザー向けmalloc/free、GC、RCを追加しない。

Wasmへ直接渡されたABI違反bytesは、現行fault code 5の`INVALID_ARTIFACT`として扱う。通常APIへ渡した不正JavaScript値は、従来どおりhost codecの`INVALID_INPUT`または`RESOURCE_LIMIT`で拒否する。この分類を変える必要が判明した場合は、ABI版を上げる別計画へ分離する。

## 5. Memory Safety Matrix

PR-0で次のmatrixを機械可読JSONとMarkdownから生成する。各行は`guaranteed-by`、成立条件、positive vector、negative vector、残る制限を持つ。

| 対象 | 必須確認 |
| --- | --- |
| top-level region | input/outputのbase、length、capacity、memory containment、相互非overlap |
| arithmetic | base+length、count×stride、alignment round-up、heap+sizeのoverflow前検査 |
| descriptor | pointer/count、canonical empty、alignment、payload containment |
| nested value | type depth、String bytes、List count、aggregate element数、UTF-8 |
| alias | payload同士、descriptorとpayload、inputとoutput、validator作業領域の重複 |
| lifetime | evaluate中だけ有効なinput/scratch/output、呼出し後に保持しない値 |
| failure | fault設定後に後続load/storeを行わないこと、部分outputの扱い |
| resource | validation自体のfuel、走査要素数、作業memoryが上限内であること |

同じ項目をhost、Wasm、engine、未保証へ重複なく分類する。「検査関数が存在する」だけでは保証済みにせず、load/storeより前に拒否するtestを対応させる。

## 6. 直接Wasm境界の検証設計

### 6.1 test harness

製品runtimeとは別に、test専用のdirect ABI harnessを追加する。harnessは生成Wasmをinstantiateし、memoryへ指定bytesを書き、hostのencode/decode事前検査を通さず`evaluate`を呼ぶ。

harnessは次を記録する。

- entry引数と入力bytesのhash。
- returnまたはtrap、`fault_code`、output領域のbefore/after hash。
- input領域が変更されていないこと。
- canary領域が変更されていないこと。
- fault後に新しいwriteが発生していないことを判定できる差分。

test専用harnessを公開runtime APIまたは配布artifactへ含めない。

### 6.2 adversarial vectors

最低限、次を固定fixtureとして用意する。

- negative、zero、memory末尾、`0xffffffff`付近のbase/length/capacity。
- `base + length`と`output + capacity`のwraparound。
- input/outputの完全・部分・境界1 byte overlap。
- root descriptorより短い`inputLength`。
- misaligned pointer、pointer 0とnonzero count、nonzero pointerとcount 0。
- count×stride overflow、4,096超過、aggregate 16,384超過。
- payloadがinput外、memory内だが別領域、descriptor自身と重なる値。
- 重複payload、部分overlap、nested List/Record/Unionの循環相当descriptor。
- invalid UTF-8、16 KiB超過、最大4 byte UTF-8境界。
- output capacity不足、output pointer wraparound、heap開始位置との矛盾。
- validation fuel上限付近と、fault後に再利用する新instance。

正常vectorはempty、最小、最大、nested、Record/Union、String/Listを含める。host経路とdirect経路で、同じcanonical bytesに対する結果とfault codeを比較する。

## 7. Wasm入口とallocatorの実装方針

### 7.1 検査順序

`evaluate`は次の順で処理する。

1. busy状態を確認する。
2. memory byte lengthに対してinput/outputのbaseとlengthを減算比較で検査する。
3. input/outputの非overlapとoutput容量上限を検査する。
4. root layoutがinputLength内にあることを確認する。
5. 型から生成したvalidatorでdescriptorとpayloadを検査する。
6. 検査完了後だけentry関数とmaterializeを実行する。

検査失敗時はfault codeを設定してtrapし、entry関数を呼ばない。validatorが外部dataを読む各箇所は、直前までにそのload幅のcontainmentが成立していなければならない。

trapしたinstanceは現行どおり廃棄し、`busy`やarenaを暗黙に初期化して再利用しない。同じinstanceの再呼出しが拒否され、新しいinstanceでは正常入力を処理できることを試験する。materialize中のfaultではoutput内容を無効として扱い、output外とinputのbytesが変化していないことを保証する。

### 7.2 safe arithmetic

加算後の値だけでoverflowを検出しない。次の形を基本とする。

- `length <= end - base`を、`base <= end`確認後に使う。
- `count <= available / stride`を、`stride > 0`確認後に使う。
- alignment paddingを先に求め、`padding <= remaining`と`size <= remaining-padding`を確認する。
- signed i32値とunsigned address/countを混同しない。

allocatorは失敗時にheapを進めない。zero-size allocationの現行表現を固定し、正常系のoutput bytesを変える場合は理由とportable suiteの差分を記録する。

### 7.3 nested descriptorとalias

host codecとWasm validatorが異なるwire languageを受理しないよう、共通のtest vectorを一つのsourceから生成する。実装方式はPR-1で次の二案を比較し、採用理由を記録する。

- 現行non-overlap契約を保つbounded claim table。
- encoderが出す順序までcanonical contractとして固定するcursor validator。

後者が既存の有効bytesを狭める場合はABI v1へ導入しない。claim table用領域を設ける場合はinput/output/scratchとの非overlap、最大entry数、初期化、validation fuelを固定する。

## 8. RegionMemoryの有界化

`RegionMemory`はCollection Wasmとは別の変更として扱う。初期実装は解放時に`#allocations`からentryを削除し、単調増加する`id`がsafe integer上限へ達する前にfail-closedとする案を第一候補とする。

slot再利用とgeneration更新は、Map削除だけで必要条件を満たせない証拠がある場合だけ採用する。採用時はgeneration wraparound、古いhandleの復活、二重release、偽造handle、zero-length allocationを試験する。

公開診断として次を追加する場合も、mutable内部構造そのものは返さない。

- active allocation数。
- free block数。
- used/peak bytes。
- lifetime別active bytes。

100万回相当のallocate/releaseを、固定capacity・固定peak bytes・有界metadataで完了するtestを用意する。時間の長いsoakは通常unit testから分ける。

## 9. コスト計測

### 9.1 決定的な計数

製品ABIへdebug exportを追加せず、計測専用emitter/runtimeを別経路にする。通常buildのWasm bytesとmanifestは計測機能の有無で変わらない。

計測専用buildは最低限次を数える。

- static allocation site数。
- dynamic allocation callsとrequested/aligned bytes。
- shallow copy calls/bytes。
- deep promotion calls/bytes。
- validatorが走査したdescriptor、List element、String byte数。
- arena peak offset。

計数は時間ではなく決定的な整数として、同じprogram/inputで一致することをtestする。instrumentation付き時間を製品速度として報告しない。

### 9.2 時間とmemory

benchmarkは次を分離する。

- encode。
- host validation/decode。
- Wasm instantiate。
- Wasm kernel。
- output decode。
- 入出力込み。

linear memory容量、arena peak、プロセスpeak RSS、定常RSS、Wasm file sizeを別metricにする。初回の対象runtimeはBun 1.4.2、OS/CPUは実行環境を記録し、未実行OSの成功を記録しない。

入力はexplorationとholdoutへ固定分割し、small/medium/maximum、empty、偏り、nested、String長の偏りを含める。warmup、反復数、実行順、集計方法、許容回帰を測定前にmanifestへ固定する。

## 10. 最適化候補の選択と採否

安全性修正とbaseline計測が完了するまで製品最適化を実装しない。候補は次の優先順とし、baselineのdynamic copy bytesで最上位の適用可能候補を一つだけ選ぶ。

1. 最終output promotionの重複copy削減。
2. `map`/`filter`の過剰確保または不要copy削減。
3. 既知calleeのdispatch削減。

候補が総copy bytesまたはdynamic allocation bytesの30%以上を占めない場合、初回は最適化を見送る。複数候補を同時実装しない。Binaryen O2/O3や独自passの追加を、この三候補の代用にしない。

採用順序は次のとおり。

1. direct ABI adversarial testと全correctness testが通る。
2. reference evaluator、通常Wasm、最適化Wasmが正常値、fault、最初のerror、fuel/resource outcomeまで一致する。
3. 既存portable artifact、replay、manifest verifierの互換性を維持する。
4. holdoutでcopyまたはallocationの主指標が10%以上減る。
5. 入出力込み時間が5%以上悪化せず、kernel時間の改善が測定揺らぎを上回る。
6. Wasm bytesが20%以上増えず、validation時間とcompile時間を記録する。

4〜6の閾値は初回fixture用の工学的Gateであり、一般性能の主張ではない。正しさまたは安全性で不合格なら速度に関係なく却下する。資源課金を減らすことで従来`RESOURCE_LIMIT`だった入力が成功する場合は意味変更として却下し、別契約へ分離する。

## 11. 実装単位

### PR-0: baselineと契約freeze

- 対象revision、Bun、Binaryen、Collection ABI、上限、fault分類を記録する。
- Memory Safety Matrix schema、fixture manifest、exploration/holdout分割を追加する。
- 現行Wasm bytes、正常結果、fault、portable verificationをbaselineとして保存する。

### PR-1: direct ABI harnessとnegative corpus

- host codecを通さないtest harnessを追加する。
- top-level引数、descriptor、alias、overflow、UTF-8、resource vectorを追加する。
- 現在の失敗を安全性欠陥、既存engine trap、hostのみの保証、未再現へ分類する。

### PR-2: Wasm entry validator

- 型別validator生成を実装する。
- `inputLength`、output capacity、alignment、nested payload、aggregate上限を検査する。
- fault後にentry/load/storeが進まないことを検証する。

### PR-3: safe allocatorとcopy boundary

- alignment、heap残容量、count×stride、concat lengthをoverflow前に検査する。
- input/output/copy領域のoverlapを拒否する。
- 最大正常値と1超過、`0xffffffff`近傍をdirect testする。

### PR-4: RegionMemory metadata bound

- 解放済みallocation metadataを保持し続けない。
- stale/forged/double-release、ID枯渇、free-list結合を試験する。
- Collection allocatorと未接続であることを文書とAPI名で明確にする。

### PR-5: instrumentationとcost artifact

- product artifactと分離した計測buildを追加する。
- allocation/copy/validation/arena metricをraw JSONへ保存する。
- metric schema、environment、source/program/lowered/Wasm hashを固定する。

### PR-6: baseline benchmarkとdecision record

- counterbalanced order、warmup、反復、exploration/holdoutを実行する。
- kernelとend-to-end、linear memoryとRSSを分離する。
- 一候補を選ぶか、閾値未達で見送るdecision recordを生成する。

### PR-7: 条件付き一候補最適化

- PR-6で選ばれた候補だけを実装する。見送りならコードを追加しない。
- 値、fault順、fuel、resource outcome、artifact互換性をdifferential testする。
- holdout結果で採用、修正再評価、却下を記録する。

### PR-8: 統合、文書、再現

- Collection仕様、Memory Safety Matrix、結果文書、roadmap、docs indexを更新する。
- clean directoryからbaseline、direct negative suite、cost artifactを再生成する。
- 全品質Gateと対象smokeを同じrevisionで実行する。

PR-2とPR-3は一つの安全性releaseとして統合する。入口検査だけ、またはallocatorだけを安全性完了として公開しない。PR-7は条件付きであり、最適化コードを追加しない決定も正式な完了結果とする。

## 12. 受け入れ条件

| ID | 検証 | 合格条件 |
| --- | --- | --- |
| MSO1 | scope | 対象profile、revision、ABI、runtime、Binaryen版が固定される |
| MSO2 | matrix | 各保証に層、条件、positive/negative vector、残る制限がある |
| MSO3 | direct path | host codecなしでWasm entryを呼ぶtestがある |
| MSO4 | top-level bounds | input/outputの負値、範囲外、wraparoundをload/store前に拒否する |
| MSO5 | overlap | input/outputの完全・部分overlapを拒否する |
| MSO6 | root length | root layout未満のinputLengthを拒否する |
| MSO7 | descriptor | pointer/count/alignment/canonical emptyを検査する |
| MSO8 | multiplication | count×strideをoverflow前に拒否する |
| MSO9 | nested bounds | nested String/List/Record/Unionをinput領域内へ制限する |
| MSO10 | alias | payload overlapとdescriptor overlapを契約どおり拒否する |
| MSO11 | UTF-8 | invalid、境界、上限超過をWasm entryで拒否する |
| MSO12 | aggregate limits | depth、List、tree、String、wire上限をWasm側でも適用する |
| MSO13 | validation budget | adversarial入力でもvalidatorの処理量と作業memoryが有界である |
| MSO14 | fail stop | fault確定後にentryや追加accessを進めず、失敗instanceを再利用しない |
| MSO15 | allocator | alignmentとheap更新がoverflowせず、失敗時にheapを進めない |
| MSO16 | copy bounds | 全copyのsource/destination/lengthを事前検査する |
| MSO17 | canary | 拒否入力でinput外・output外のcanaryが不変である |
| MSO18 | normal parity | host経路とdirect canonical経路の正常結果が一致する |
| MSO19 | fault parity | 現行のindex、division、arithmetic、resource fault意味が不変である |
| MSO20 | artifact compatibility | ABI、manifest、旧portable artifact、verifierが互換である |
| MSO21 | metadata bound | RegionMemoryの管理情報が反復allocation総数に比例しない |
| MSO22 | stale handles | release後、偽造、二重release、世代違いをfail-closedで拒否する |
| MSO23 | region separation | RegionMemoryとCollection Wasm allocatorを同一実装と報告しない |
| MSO24 | metric determinism | allocation/copy/validation計数が同一入力でbyte一致する |
| MSO25 | no product instrumentation | 通常artifactのexport、manifest、bytesへ計測機能が混入しない |
| MSO26 | timing separation | encode/validate/instantiate/kernel/decode/end-to-endを別計測する |
| MSO27 | memory separation | arena、linear memory、peak RSS、steady RSSを別metricにする |
| MSO28 | frozen benchmark | 入力、順序、warmup、反復、閾値、environmentを結果前に固定する |
| MSO29 | single candidate | 同時に一つだけ最適化し、選択規則と成立条件を保存する |
| MSO30 | semantic preservation | 値、最初のfault、評価順、fuel、resource outcomeが一致する |
| MSO31 | honest decision | 改善なし、回帰、却下、見送りを成功結果から除外しない |
| MSO32 | reproducibility | clean directoryからdirect suite、metric、decisionを再生成できる |
| MSO33 | Binaryen isolation | global設定を変更する場合は直列化と復元を検証する。変更しない場合も記録する |
| MSO34 | no unsupported claim | 全Wasm、任意host、本番省メモリ、安全性一般を主張しない |
| MSO35 | regression | Value、Collection、Effects、ABI、smoke、portable verificationが通る |
| MSO36 | complete evidence | MSO1〜MSO35の対応表と未解決事項を結果文書へ残す |

## 13. test構成

- unit: safe arithmetic helper、layout、RegionMemory、metric集計。
- direct adversarial: handcrafted memoryとraw ABI引数。
- differential: reference evaluator、通常Wasm、安全性修正Wasm、条件付き最適化Wasm。
- property-based: 型別canonical value、境界値、descriptor mutation。seedとcase数を固定する。
- mutation: inputLength無視、overflow後比較、alignment省略、nested検査省略、fault後続行を個別に検出する。
- compatibility: 既存manifest version 4、suite version 3、relocated artifact、sourceなしverify。
- benchmark: exploration/holdout、順序交替、raw sample保存、null/negative result保持。

testが実装と同じhelperだけをoracleにしない。境界vectorは独立に期待値を持ち、Wasm memoryのbefore/afterを直接確認する。

## 14. 成果物

予定する主要成果物は次のとおり。実装時に既存命名との整合を確認し、不要な並行frameworkを作らない。

```text
docs/COLLECTION_MEMORY_SAFETY_MATRIX.md
docs/COLLECTION_MEMORY_SAFETY_AND_OPTIMIZATION_RESULTS.md
schemas/collection-memory-safety-matrix-v1.schema.json
schemas/collection-cost-observation-v1.schema.json
benchmarks/collection-memory-v1/
  benchmark.json
  freeze.json
  fixtures/
  holdout/
  expected/
src/llang-collection-direct-harness.ts
src/llang-collection-cost.ts
src/llang-collection-memory.test.ts
```

direct harnessとinstrumentationは内部test/benchmark用であり、公開言語機能またはproduction runtimeとして文書化しない。

## 15. 品質Gate

小さな変更ごとに対象testを実行し、統合時にBun 1.4.2で次を実行する。

```sh
bun run format
bun run check
bun run coverage
bun run ci:docs
bun run ci:protected
bun run ci:smoke
bun test src/llang-region-memory.test.ts
bun test src/llang-module-collection.test.ts
bun test src/llang-collection-memory.test.ts
git diff --check
```

benchmark runnerを追加した場合は、fresh output directoryでbaselineとholdoutを実行し、raw observationからsummaryを再生成してhash一致を確認する。外部network、credential、LLM APIは不要とする。

## 16. 実装後の自己レビュー

実装完了後、次の順で再レビューする。

1. 本計画を先頭から読み直し、PR-0〜PR-8とMSO1〜MSO36の対応表を作る。
2. correctness、memory safety、resource semantics、reproducibility、compatibility、performance validityの六観点で確認する。
3. direct ABIをhost codec経由だけで試験していないか確認する。
4. 計測機能が製品artifactへ混入していないか確認する。
5. 最適化がfault順、fuel、resource outcomeを変えていないか確認する。
6. null、回帰、却下、未測定OS、未解決境界を結果文書へ残す。
7. 全Gate、Git状態、変更一覧、未実行事項を確認する。

## 17. 停止して設計判断を求める条件

次はこの計画だけで決めず、利用者の明示判断を求める。

- ABI名、export、fault code、manifest版、source版を変更する必要がある。
- 有効な既存canonical bytesを拒否するwire contract変更が必要になる。
- fuelやmemory上限、RESOURCE_LIMITになる入力集合を変更する。
- input mutation、共有memory、永続instance、GC/RCを導入する。
- Binaryenの製品既定passを変更する。
- Rust/C/LLVM backend、別runtime、外部SAAA統合へ対象を広げる。
- live workload、外部network、credential、費用のある測定が必要になる。

再現されたmemory safety欠陥の、既存ABI内で可能なfail-closed修正は停止理由にしない。最小修正、negative test、保証境界の更新まで進める。

## 18. 完了の定義

この計画は、直接Wasm境界の安全性修正、RegionMemory metadataの有界化、決定的なcost計測、baseline decision record、全回帰Gateが揃った時点で完了する。

最適化の完了は「高速化コードが入ったこと」ではない。条件付きPR-7で候補が採用された場合はその効果と成立条件を記録し、見送った場合は測定値と見送り理由を記録する。どちらの場合も、Collection以外のprofile、任意Wasm、本番host、長時間soak、全OSでの省メモリ性を実証したとは扱わない。
