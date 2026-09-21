# Collection end-to-endボトルネック特定 実装計画

作成日: 2026-09-21。状態: 実装完了。計画基点revision: `4afb97def2478d05e5132f2604f439246bc579ba`。結果: [実装結果](./COLLECTION_END_TO_END_BOTTLENECK_ATTRIBUTION_RESULTS.md)。

参照: [Collection Binaryen最適化レシピ選定 実装結果](./COLLECTION_BINARYEN_RECIPE_SELECTION_RESULTS.md)、[Collectionメモリー安全性と最適化基盤 実装結果](./COLLECTION_MEMORY_SAFETY_AND_OPTIMIZATION_RESULTS.md)、[Collection仕様](./LLANG_MODULE_COLLECTION_SPEC.md)。

## 1. 目的

現行`module-collection-v1`製品baselineのend-to-end時間を、同じ一回の実行に属する加算可能なphaseへ分解し、次の改善対象を証跡付きで一つ選ぶ。

1. startup、host codec、Wasm実行、output decodeの時間比率を同一traceから測る。
2. input／output bytes、allocation／copy、arena peak、静的IR形状と時間の増え方をサイズ別に対応付ける。
3. 複数familyと固定workload mixで、単一fixtureに依存しない支配区間を確認する。
4. raw sampleから集計と優先判断を再生成し、次の最適化計画へ渡す。

本計画はボトルネックの特定までを完了範囲とする。最適化の実装、ABI変更、Binaryen候補の追加、製品既定値の変更は行わない。明確な支配区間が得られない場合は`inconclusive`を正式な完了結果とする。

## 2. 現在地と着手理由

[Collection Binaryenレシピ選定](./COLLECTION_BINARYEN_RECIPE_SELECTION_RESULTS.md)では、O2／O3系候補がartifact sizeとmedian性能を改善した一方、95% bootstrap intervalを使う退行Gateを全候補が満たさず、`retain-baseline`となった。候補の追加探索を続けても、揺らぎの原因と製品end-to-endの支配区間を分離できない。

既存計測にはcompile、instantiate、encode、host validation、evaluate、decode、end-to-endがある。ただし各phaseは独立した操作として測っており、同じ一回のend-to-end traceを加算分解した値ではない。build時間も製品実行時間とは別である。次の改善を決めるには、同一trace内の時間、固定overhead、payload増加に伴う傾き、allocation／copyを同じcase identityへ結び付ける必要がある。

既存基盤として、9 programのfrozen corpus、reference evaluator、direct harness、instrumented cost、隔離benchmark child、strict JSON、schema検証、canonical環境guard、raw sample集計を再利用できる。このため、新しい言語機能やtoolchainを追加せず、一日で診断を完了できる。

## 3. 完了範囲

### 3.1 対象

- 現行`emitCollectionModuleWasm`が返す未最適化baseline。
- `module-collection-v1`、ABI `llang-collection-native-v1`、manifest version 4。
- 既存Binaryen corpusのfold、map、filter、sort、closure、generic、composite、string、union。
- small／medium／maximumの正常終了入力と、固定した複合workload mix。
- compile、instantiate、encode、host validation、evaluate、decodeの加算可能trace。
- input／output wire bytes、allocation／copy、arena peak、Wasm bytes、静的IR形状。
- Bun 1.4.2、macOS arm64、Apple M4をcanonical採否環境とするraw観測。

### 3.2 対象外

- Binaryen recipe、pass、optimize／shrink levelの追加評価。
- WAT書換え、Semantic IR最適化、data layout変更、copy削除。
- ABI、manifest、fault、fuel、evaluation order、resource limitの変更。
- product emitterへのinstrumentation export追加。
- SAAA実データ、credential、network、長時間soak、別CPUへの一般化。
- npm公開、配備、性能改善率の対外的な主張。

対象外の改善は、本計画のdecisionで優先対象を確定した後に別計画として作る。

## 4. 不変条件

- 製品Wasm bytes、export、memory limits、contractを変更しない。
- 計測は製品artifactを入力にする。計測専用Wasmを製品性能として扱わない。
- reference、public runtime、trace runnerの正常値とfaultが一致する。
- input、output、allocator stateの既存所有権を変えない。
- compile cacheやinstance reuseを製品の既定動作として仮定しない。
- phase timer、counter、IR metricを測定対象の意味へ混入させない。
- 結果を見てcase、threshold、decision ruleを変更しない。
- canonicalでない環境はcorrectnessを実行できるが、checked-in observationを更新できない。

## 5. 計測モデル

### 5.1 一回の加算可能trace

benchmark childは各sampleで次を一度ずつ順番に実行し、同じ`traceId`へ記録する。

1. 製品runtimeと同じWasm構造検査と`WebAssembly.Module`生成: `compileNs`
2. `WebAssembly.Instance`生成: `instantiateNs`
3. input wire encoding: `encodeNs`
4. encoded inputのhost validation: `hostValidationNs`
5. export `evaluate`呼出し: `evaluateNs`
6. output wire decoding: `decodeNs`

`totalNs`は1の直前から6の直後までを一つの高分解能clockで測る。`accountedNs`は6 phaseの合計、`unattributedNs = totalNs - accountedNs`とする。負値、非safe integer、phase合計がtotalを超える異常値を拒否する。clock呼出しとrunner bookkeepingの固定費は空の対照loopで測り、raw値と補助診断に保存するが、sample値から恣意的に差し引かない。

事前検証・compile済みmoduleだけを再利用し、instance生成以降はcold traceと同じ処理を行うmodule-cached traceも診断用に測る。これはcompile除外時の傾向確認にだけ使い、製品end-to-endの主指標へ混ぜない。

### 5.2 時間の分類

| category        | phase                                     |
| --------------- | ----------------------------------------- |
| `startup`       | compile + instantiate                     |
| `host-input`    | encode + host validation                  |
| `wasm-evaluate` | evaluate                                  |
| `host-output`   | decode                                    |
| `unattributed`  | totalからaccountedを引いたrunner overhead |

category shareはsampleごとに`categoryNs / totalNs`から求め、その後にmedianとbootstrap intervalを計算する。median時間同士を割ってshareを作らない。

### 5.3 bytesとcost

各caseに次を保存する。

- encoded input bytes、encoded output bytes。
- product Wasm bytes、initial／maximum linear memory。
- allocation calls／bytes、copy calls／bytes、arena peak。
- program、lowered IR、interface、layout、artifactのhash。

instrumented costは既存`measureCollectionCost`から取得し、時間計測とは別に実行する。counter付きartifactの時間をproduct時間へ使用しない。

### 5.4 静的IR形状

既存checked programとproduct WATから、診断専用の決定的projectionを作る。

- function、basic block相当、loop、callの数。
- load、store、memory copy、allocator call、validation callの数。
- collection intrinsic、closure、generic specializationの数。
- WAT文字数ではなくtoken化した命令数。

未知命令や解析不能なWATを0件として扱わず、metric生成を失敗させる。絶対path、時刻、環境情報をprojectionへ含めない。静的metricは相関の補助情報であり、単独で因果関係を主張しない。

## 6. corpusとworkload

### 6.1 再利用するcase

`benchmarks/collection-binaryen-v1/corpus.json`と各programをhashで参照し、sourceを複製しない。`workload.json`には本計画専用のcase ID、partition、入力生成規則、sizeだけを固定する。correctness caseはtrace runnerの意味一致に使うが、性能集計へ含めない。

fold、map、filter、closureは64／1,024／4,096要素、sortとcompositeは64／256／512要素を使う。stringは16／1,024／16,384 Unicode scalarの入力を使う。genericとunionはサイズ傾向の対象にせず、固定scalar／variant入力による構造対照として残す。各サイズ列をexplorationとholdoutへ同じ値で複製せず、patternと値を変えた独立入力にする。

### 6.2 固定workload mix

repository内の公開fixtureだけで、次の呼出し列を固定する。

- linear collection: fold、map、filter。
- allocation heavy: composite、sort。
- call／capture heavy: closure、generic。
- codec shape: string、union。

mixはcase IDと反復回数だけを持ち、hidden inputや本番データを含めない。cold traceとmodule-cached traceを分ける。これはSAAA実workloadの代替ではなく、単一caseの順位が複合呼出しでも維持されるかを確認する公開proxyである。

## 7. 集計とdecision

### 7.1 rawから再生成する値

- phase／categoryごとのmedian、MAD、p95。
- sample単位shareのmedianと固定seed 95% bootstrap interval。
- size増加に対するtotal、category、wire bytes、allocation／copy bytesの傾き。
- family別とworkload mix別の順位。
- unattributed shareとclock overhead。

表示用の丸め前のraw ratioで判定する。NaN、Infinity、重複sample identity、欠落case、recipeやpartitionの混在を拒否する。

### 7.2 データ品質Gate

次を一つでも満たさなければ`inconclusive`とする。

1. 全caseでreference、public runtime、trace resultが一致する。
2. 全raw sampleとdecisionがschemaに合格する。
3. 全sampleで`unattributedNs >= 0`かつunattributed shareが20%以下である。
4. holdout各caseでtotalのMAD／medianが25%以下である。
5. 二回生成した静的metric、hash、cost projectionが一致する。
6. checked-in decisionをraw observationだけから完全再生成できる。

### 7.3 優先対象の選定

候補categoryは`startup`、`host-input`、`wasm-evaluate`、`host-output`とする。各categoryについて次を数える。

- holdoutの過半数でshare medianが30%以上。
- そのうち少なくとも三caseで95% interval下限が20%以上。
- mediumからmaximumへのcategory時間増加がtotal増加と同じ向きである。
- workload mixでもcategory順位が単独caseの多数決と一致する。

全条件を満たすcategoryが一つなら、それを`selectedTarget`とする。複数なら、holdout全caseにおけるsample単位shareのmedian、interval下限、絶対時間の順で決定的に選ぶ。同点なら`inconclusive`とする。

選定後、bytes／cost／IR metricを使って次の診断labelを付ける。

| selectedTarget  | 診断label                               |
| --------------- | --------------------------------------- |
| `startup`       | `compile`または`instantiate`の大きい方  |
| `host-input`    | `encode`または`validation`の大きい方    |
| `wasm-evaluate` | `kernel-ir`、`allocation-copy`、`mixed` |
| `host-output`   | `decode`                                |

labelは事前に固定したphase shareとサイズ傾向から選び、自由記述だけで決めない。`selectedTarget`は次計画の対象を決める診断結果であり、性能改善や製品変更の承認ではない。

## 8. 成果物

### 8.1 code

- `src/llang-collection-bottleneck-child.ts`: 同一traceのbounded child runner。
- `src/llang-collection-bottleneck-metrics.ts`: cost／IR／WAT metric projection。
- `src/llang-collection-bottleneck-report.ts`: raw集計、bootstrap、decision。
- `src/llang-collection-bottleneck-experiment.ts`: corpus、workload、correctness、記録の統合。
- 対応するunit、integration、determinism、boundary test。

### 8.2 schemaと証跡

- `schemas/collection-bottleneck-benchmark-v1.schema.json`。
- `schemas/collection-bottleneck-workload-v1.schema.json`。
- `schemas/collection-bottleneck-observation-v1.schema.json`。
- `schemas/collection-bottleneck-decision-v1.schema.json`。
- `benchmarks/collection-bottleneck-v1/benchmark.json`。
- `benchmarks/collection-bottleneck-v1/workload.json`。
- `benchmarks/collection-bottleneck-v1/observations/darwin-arm64.json`。
- `benchmarks/collection-bottleneck-v1/decision.json`。
- `docs/COLLECTION_END_TO_END_BOTTLENECK_ATTRIBUTION_RESULTS.md`。

observationには環境とraw timingを含め、decisionには集計と優先対象だけを含める。絶対path、temporary directory、credential、環境変数を保存しない。

### 8.3 command

```sh
bun run collection:bottleneck:verify
bun run collection:bottleneck:benchmark
bun run collection:bottleneck:report
bun run collection:bottleneck:record
```

`verify`はcorrectness、静的metric、schema、checked-in decision再生成を行う。`benchmark`はcanonical環境だけでraw観測を標準出力へ出す。`record`だけがchecked-in証跡をtransactionalに更新できる。

## 9. 実装順序と本日中の時間枠

### PR-0: 契約とfixture固定（30分）

- benchmark、workload、schema、category、thresholdを結果観測前に固定する。
- 既存corpus／artifact hashとの参照関係を定義する。

完了条件: malformed、重複key、欠落case、非canonical環境をtestで拒否する。

### PR-1: 加算可能trace runner（90分）

- child process、high-resolution timer、raw `ns`、cold／cached traceを実装する。
- timeout、file size、stdout／stderr、symlink、既存outputを制限する。

完了条件: phase合計、total、unattributedが同一trace identityで検査され、製品artifactと結果が変わらない。

### PR-2: bytes／cost／IR metric（60分）

- wire bytes、既存cost、WAT token metricを決定的projectionにする。
- 未知形状と重複identityをfail-closedにする。

完了条件: 二回生成と逆順生成がbyte一致し、意図的なmetric欠落を検出する。

### PR-3: corpus／workload orchestration（60分）

- 既存corpusを参照し、caseと固定mixを隔離childで実行する。
- reference、public runtime、trace runnerの結果を比較する。

完了条件: 全対象caseが一度だけ現れ、correctness caseが性能集計へ混入しない。

### PR-4: reportとdecision（60分）

- median、MAD、p95、bootstrap interval、size傾向をrawから生成する。
- data quality Gateと優先対象選定を実装する。

完了条件: threshold境界、同点、揺らぎ、欠落、丸め前判定をunit testで固定する。

### PR-5: canonical recordと結果文書（60分）

- Bun 1.4.2、Apple M4で観測を記録する。
- decisionと保証境界を結果文書、index、roadmapへ反映する。

完了条件: `report`がrawからchecked-in decisionを完全再生成し、結果文書の数値と一致する。

### PR-6: 最終レビューと品質Gate（60〜90分）

- 仕様整合、失敗時処理、計測公平性、schema、文書、CI影響を再レビューする。
- 専用test、typecheck、lint、docs、format、全`bun run check`を実行する。

完了条件: 対応必須のレビュー指摘がなく、全品質検査が成功する。

見積もりは合計6〜7時間。時間超過時もthreshold、corpus、品質検査は削らない。追加の可視化、別OS観測、最適化実装を後続へ送る。

## 10. 受け入れ条件

### 契約と安全性

- [x] CBA1: 計画基点revision、既存corpus／freeze hash、runtime、環境条件を固定する。
- [x] CBA2: benchmark、workload、observation、decisionをstrict JSONとschemaで検証する。
- [x] CBA3: duplicate key、unknown field、非finite値、過大file、symlinkを拒否する。
- [x] CBA4: childにtimeout、出力量、artifact size、cleanupの上限がある。
- [x] CBA5: product Wasm bytes、contract、export、memory limitsが変更されない。
- [x] CBA6: reference、public runtime、trace runnerの正常値とfaultが一致する。

### traceとmetric

- [x] CBA7: 一sample内でcompileからdecodeまでを一回ずつ測る。
- [x] CBA8: total、accounted、unattributedをraw integer nanosecondsで保存する。
- [x] CBA9: startup、host-input、wasm-evaluate、host-outputのshareをsample単位で計算する。
- [x] CBA10: cold traceとcached診断traceを混在させない。
- [x] CBA11: clock overheadを別に記録し、恣意的にraw時間から控除しない。
- [x] CBA12: input／output wire bytesとWasm bytesをcaseへ結び付ける。
- [x] CBA13: allocation／copy／arena metricを時間とは別のproduct-independent診断として記録する。
- [x] CBA14: IR／WAT metricが決定的で、未知形状を0として受理しない。
- [x] CBA15: instrumentation時間をproduct性能として使用しない。

### corpusと再現性

- [x] CBA16: 9 program familyを含み、scalableな7 familyは二つ以上のsize、generic／unionは固定構造対照を持つ。
- [x] CBA17: correctness、exploration、holdoutのidentityと用途を分離する。
- [x] CBA18: fixed workload mixが全familyを事前固定順序で含む。
- [x] CBA19: case重複、欠落、partition混入を拒否する。
- [x] CBA20: metric、cost、hashが二回生成と順序変更で一致する。
- [x] CBA21: temporary path、時刻、環境変数が決定的artifactへ入らない。

### 集計と判断

- [x] CBA22: rawからmedian、MAD、p95、95% bootstrap intervalを再生成する。
- [x] CBA23: category shareをmedian時間の比ではなくsample単位ratioから集計する。
- [x] CBA24: size増加に対する時間、wire、allocation、copyの傾向を保存する。
- [x] CBA25: data quality Gateを一つでも外れた結果を`inconclusive`にする。
- [x] CBA26: threshold比較に表示用の丸め値を使わない。
- [x] CBA27: 複数候補、同点、揺らぎを決定的に処理する。
- [x] CBA28: decisionがselected target、診断label、根拠case、却下理由を持つ。
- [x] CBA29: raw observationだけからchecked-in decisionを完全再生成する。

### 統合と完了

- [x] CBA30: canonical環境以外からchecked-in observationを更新できない。
- [x] CBA31: record失敗時に既存証跡を復元する。
- [x] CBA32: 結果文書が実測値、優先対象、保証境界、未実証事項を記録する。
- [x] CBA33: 製品最適化、ABI変更、追加Binaryen探索を本計画へ混入させない。
- [x] CBA34: 専用verify、schema、typecheck、lint、docs、formatが成功する。
- [x] CBA35: `bun run check`が成功し、追加ファイルにlint warningがない。
- [x] CBA36: 最終レビューで対応必須の指摘が残っていない。

## 11. 完了後の分岐

- `startup`: compile cacheまたはmodule lifecycleを、公開APIと失敗分離を保った別計画で検討する。
- `host-input`: codec、validation重複、input layoutを、raw ABIとuntrusted input境界を維持して検討する。
- `wasm-evaluate`: IR形状またはallocation／copyを特定し、一候補だけの意味保存最適化計画を作る。
- `host-output`: decodeまたはoutput layoutを、output ownershipを維持して検討する。
- `inconclusive`: sample数を無条件に増やさず、clock overhead、case設計、隔離条件のどれがGateを外したかを結果へ残す。

どの結果でも本計画は完了とする。次計画では今回のholdoutを調整用に再利用せず、選ばれた一対象だけを実装・評価する。
