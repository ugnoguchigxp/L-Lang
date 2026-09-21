# Collection runtime計測安定化と最終方針 実装計画

作成日: 2026-09-21。状態: 実装完了。計画基点revision: `d4fb34bce040e9af17389f53f5021d8f61ffb725`。

実装結果: [Collection runtime計測安定化と最終方針](./COLLECTION_RUNTIME_STABILITY_AND_FINAL_DISPOSITION_RESULTS.md)。

参照: [Collection end-to-endボトルネック特定 実装結果](./COLLECTION_END_TO_END_BOTTLENECK_ATTRIBUTION_RESULTS.md)、[Collection Binaryen最適化レシピ選定 実装結果](./COLLECTION_BINARYEN_RECIPE_SELECTION_RESULTS.md)、[Collectionメモリー安全性と最適化基盤 実装結果](./COLLECTION_MEMORY_SAFETY_AND_OPTIMIZATION_RESULTS.md)、[Collection仕様](./LLANG_MODULE_COLLECTION_SPEC.md)。

## 1. 位置付け

本計画は、repository内で完結するCollection性能調査の最終計画とする。

直前の計測では、startupがholdout median share 66.7835%、固定mix share 76.4727%で首位になった。しかしsort maximumのcold totalはMAD／medianが37.7513%となり、事前固定した25% Gateを超えた。startupのscaling consistencyもmap、sort、stringで成立せず、判断は`inconclusive`となった。

次に必要なのはthresholdを緩めることでも、別の最適化候補を増やすことでもない。case順序、process間変動、lane実行順、JIT／GCを含むhost側変動を観測可能なblockへ分け、既存の判断を安定した証拠で再評価することである。

本計画の完了時には、次のどちらかを必ず確定する。

1. 安定した証拠でstartupと既存のprepared runtime lifecycleが支持される場合は、compile済みruntimeを一回構築して複数評価に再利用する利用契約を正式化する。
2. 品質Gateまたは採用Gateを満たさない場合は、現行baseline維持を最終判断とし、追加のrepository内Collection性能探索を終了する。

この完了はL-Lang全体の製品化完了を意味しない。SAAA実workload、別CPU、長時間soak、実運用TLS、live model評価は外部条件を必要とする未実証事項として残る。

## 2. 目的

1. 同じ23 caseと判断閾値を維持したまま、cold／module-cached計測を独立blockへ分割する。
2. case順序とlane順序を決定的に反転し、順序依存とprocess間変動を分離する。
3. raw sample、block median、順序lane、resource診断からデータ品質を再判定する。
4. startupが一意に選ばれた場合、既に存在するcompile-once runtime lifecycleのcorrectness、fault isolation、memory boundを固定する。
5. 採用またはbaseline維持のどちらかを、raw evidenceから再生成できる最終decisionとして保存する。

## 3. 変更しないもの

- 9 program familyと23 caseの入力、size、partition、pattern。
- `maximumUnattributedShare = 0.20`。
- `maximumRelativeMad = 0.25`。
- category share median 30%、bootstrap interval下限20%、最低3 robust caseという選定条件。
- `emitCollectionModuleWasm`が生成する製品Wasm bytes。
- ABI `llang-collection-native-v1`、manifest version 4、export、memory 128 page、fault code、fuel、評価順序。
- Binaryen version 132.0.0と製品baseline recipe。
- Bun 1.4.2、macOS arm64、Apple M4というcanonical採否環境。

結果を見た後でcase、sample除外規則、threshold、block数、判断分岐を変更しない。既存のv1 observationとdecisionも上書きせず、比較可能な過去証跡として残す。

## 4. 完了範囲

### 4.1 対象

- `collection-bottleneck-v1`と同じcorpus／workloadを参照する安定性protocol。
- 6独立block、blockごとのcase順序、cold／module-cached lane順序のcounterbalance。
- compile、instantiate、encode、host validation、evaluate、decodeの同一trace計測。
- block前後のRSS、CPU user／system time、clock overhead、process resource usage。
- overall、block内、block間、case順序別のmedian、MAD、p95、bootstrap interval。
- existing runtime objectを一回構築して複数回`evaluate`するprepared lifecycle。
- correctness、checked fault、fault後の再評価、memory bound、determinism。
- 最終decision、結果文書、roadmap／index更新。

### 4.2 対象外

- 新しいBinaryen pass、LLVM backend統合、WAT書換え。
- global Wasm module cache、LRU cache、artifact hash cache。
- 同じ`WebAssembly.Instance`の再利用、instance pool、並行共有。
- ABI、data layout、allocator、output ownershipの変更。
- OS priority、CPU affinity、強制GC、thermal制御。
- threshold緩和、外れ値削除、測定後のcase差替え。
- SAAA実データ、別CPU、長時間soak、network、credential。

global cacheやinstance reuseは、artifact identity、memory state、fault後のpoisoning、容量上限を別途設計する必要がある。本計画では、すでに`instantiateCollectionModule`が提供している「構造検査とcompileはruntime構築時に一回、各`evaluate`は新しいinstance」という境界だけを扱う。

## 5. 安定性protocol

### 5.1 block構成

canonical runは6 blockで構成する。各blockは23 caseを一回ずつ別childで実行し、各case childは次を行う。

1. cold laneとmodule-cached laneを各5回warmupする。warmupは保存しない。
2. cold traceとmodule-cached traceを各5 sample保存する。
3. cold traceは毎回、製品runtimeと同じ構造検査、compile、instance生成から開始する。
4. module-cached traceは事前検証・compile済みmoduleだけを共有し、instance生成以降はcold traceと同じ処理を行う。
5. decode結果をreference evaluatorの結果と照合する。

合計は23 case × 6 block × 5 sample = 690 cold traceと690 module-cached traceとする。child起動時間、block間の待機、report生成時間はtraceへ含めない。

### 5.2 case順序

workload fileの23 case順を基準列とし、次の6順序を事前固定する。

| block | case順序        |
| ----: | --------------- |
|     0 | 基準列          |
|     1 | 基準列の逆順    |
|     2 | 左へ8 case回転  |
|     3 | block 2の逆順   |
|     4 | 左へ16 case回転 |
|     5 | block 4の逆順   |

各blockは`blockId`、`orderId`、`orderIndex`をraw sampleへ保存する。case順序はhash化してmanifestへ固定し、重複、欠落、未定義caseを拒否する。

### 5.3 lane順序

偶数blockはcold→module-cached、奇数blockはmodule-cached→coldの順に測る。sampleごとの二laneは同じinput、expected result、artifact、child processを使う。

lane順を変えてもcoldとcachedのraw系列は別々に保存する。二laneの時間を平均した値や、cached値をcold値から差し引いた値を主指標にしない。

### 5.4 resource診断

各childは計測範囲外で次を保存する。

- clock呼出しoverheadのmedian。
- child開始時、warmup後、終了時のRSS。
- child全体のuser CPU timeとsystem CPU time。
- block開始時のOS、CPU、Bun、Binaryen identity。

resource診断は異常blockの説明に使用するが、raw phase時間から控除しない。PID、temporary path、環境変数、usernameは保存しない。

## 6. schemaと証跡

新しい証跡は`benchmarks/collection-runtime-stability-v1`へ分離する。

- `benchmark.json`: block、warmup、sample、順序、環境、limit、threshold。
- `workload.json`: v1 workloadのpathとhash、6つのcase order。
- `observations/darwin-arm64.json`: raw trace、resource診断、block／overall summary。
- `decision.json`: quality Gate、dominance、prepared lifecycle、最終方針。
- `schemas/collection-runtime-stability-*.schema.json`: 全入力と出力のstrict schema。
- `docs/COLLECTION_RUNTIME_STABILITY_AND_FINAL_DISPOSITION_RESULTS.md`: 最終結果。

observationは次のidentityを必須にする。

```text
blockId / orderId / orderIndex / caseId / lane / sample
```

全identityを一度だけ許可し、6 block、23 case、2 lane、5 sampleの完全直積にならないraw evidenceを拒否する。summaryとdecisionはraw observationだけから完全再生成する。

## 7. 集計

### 7.1 保存する集計

- case・lane・block別のmedian、MAD、p95、95% bootstrap interval。
- case・laneの全block統合median、MAD、p95、95% bootstrap interval。
- caseごとのblock medianに対するMAD／median。
- forward block群とreverse block群のmedian差。
- orderIndexの前半／後半におけるmedian差。固定順序上どちらか片側にしか現れない
  caseは比較不能を`null`で保存する。
- cold category shareとmodule-cached total。
- coldとmodule-cachedのsample対応を使ったpaired ratio。paired ratioは
  `cachedTotalNs / coldTotalNs` と定義し、1未満を改善とする。
- blockごとのcategory winnerとholdout case vote。

bootstrapはbenchmark seed、case ID、lane、block IDから決定的seedを作る。raw sampleとratioは丸めず、表示時だけ小数6桁へ丸める。

### 7.2 禁止する処理

- IQR、z-score、目視判断によるsample除外。
- 最小値だけの採用。
- warmup sampleのraw evidenceへの昇格。
- block失敗後に成功blockだけを残すresume。
- coldとcachedの異なるsample数での比較。
- process resource値による事後的な重み付け。

resumeする場合は、完了blockの完全なhashとcase orderを検証する。不完全blockはblock全体を破棄して再実行し、一部caseだけを継ぎ足さない。

## 8. データ品質Gate

次を一つでも満たさなければ、最終方針を`retain-baseline`、理由を`insufficient-stability`とする。

1. 全690 cold、690 cached sampleがschemaと完全matrix検査に合格する。
2. 全sampleでreference、public runtime、trace childの正常結果が一致する。
3. checked overflow faultがreference、public runtime、direct harnessで一致する。
4. 全caseでcold unattributed shareのp95が20%以下である。
5. holdout全caseでcold totalのoverall MAD／medianが25%以下である。
6. holdout全caseで6つのblock medianのMAD／medianが15%以下である。
7. holdout各caseのforward／reverse median差が、小さい方を分母として20%以下である。
8. block、lane、case orderを変えてもhash、Wasm、cost、静的metricが一致する。
9. summaryとdecisionをraw observationだけから完全再生成できる。

Gate 6と7は今回新設するため、値を結果観測前にschema constとして固定する。既存Gate 4と5は変更しない。

## 9. dominanceとprepared lifecycleの判断

### 9.1 category選定

データ品質Gate通過後、既存と同じ条件で`startup`、`host-input`、`wasm-evaluate`、`host-output`を評価する。

- holdout過半数でshare median 30%以上。
- qualifying caseのうち最低3件で95% interval下限20%以上。
- mediumからmaximumへのcategory時間とtotal時間の増加方向が一致する。
- holdout case voteと固定mixの首位が一致する。
- 6 blockのうち最低5 blockで同じcategoryが首位になる。

複数候補は丸め前のmedian share、interval下限、絶対時間の順で選ぶ。完全同点、block首位不足、首位不一致は`retain-baseline`とする。

### 9.2 prepared lifecycle採用Gate

選定categoryが`startup`の場合だけ、既存のmodule-cached laneをprepared lifecycle候補として評価する。

1. 全正常caseでcoldと同じ結果を返す。
2. faultを返した評価の後も、同じruntime objectの次評価が新しいinstanceで正常に完了する。
3. runtime object間でmemory、fault、allocator stateを共有しない。
4. holdout過半数でcached totalのpaired median reductionが30%以上である。
5. 最低3 holdout caseでreductionの95% bootstrap interval下限が20%以上である。
6. どのholdout caseもpaired ratioの95% bootstrap interval上限が1.05以下である。
7. artifact hash、contract、memory limit、ABI、fault semanticsを変更しない。

全条件を満たす場合、最終方針を`adopt-prepared-lifecycle`とする。これは新しいcache実装ではなく、同一のtrusted artifactを複数回評価する利用者がruntime objectを一回だけ構築する契約の明文化である。

選定categoryがstartup以外の場合、またはprepared lifecycle Gateを満たさない場合は`retain-baseline`とする。本計画内で別categoryの最適化実装へ分岐しない。

## 10. 製品変更の上限

`adopt-prepared-lifecycle`の場合に許可する変更は次だけとする。

- Collection仕様へruntime構築と`evaluate`の寿命を追記する。
- 同一artifactを反復評価するrepository内の製品経路で、runtime objectをloop外に構築する。
- compile-once、instance-per-evaluate、fault isolationを固定する回帰testを追加する。
- CLI help、example、結果文書へ利用例を追加する。

公開関数名、引数、戻り値、ABI、manifest、artifact、memory layoutは変更しない。呼出しごとに異なるartifactまたはcontractを扱う経路へ暗黙cacheを追加しない。

`retain-baseline`の場合は、benchmark、schema、decision、結果文書、index以外の製品codeを変更しない。

## 11. command

```sh
bun run collection:stability:verify
bun run collection:stability:benchmark
bun run collection:stability:report
bun run collection:stability:record
```

- `verify`: schema、完全matrix、correctness、fault、determinism、checked-in decision再生成を行う。
- `benchmark`: canonical環境で6 blockを実行し、raw observationをstdoutへ出す。
- `report`: checked-in raw observationからsummaryとdecisionを再生成する。
- `record`: canonical環境だけでobservationとdecisionをtransactionalに更新する。

child timeout、stdout／stderr、JSON、artifact、temporary directoryの上限は既存bottleneck benchmark以上に緩めない。recordは同時実行をexclusive lockで拒否し、途中失敗時に既存証跡をbyte単位で復元する。

## 12. 実装順序

### PR-0: protocolとschema固定

- 既存workload hash、6 block、case order、lane order、sample数、新規Gateを固定する。
- benchmark、workload、observation、decision schemaを作る。
- v1証跡を変更しない検査を追加する。

完了条件: threshold、case、order、完全matrixをschemaとsemantic validatorの両方で固定する。

### PR-1: block runner

- 既存childをblock、lane order、resource snapshotへ拡張する。
- cold／cachedの意味、結果照合、加算可能phaseを維持する。
- timeout、output bound、cleanup、resume単位を実装する。

完了条件: 1 blockの23 case × 2 lane × 5 sampleが欠落なく再生成できる。

### PR-2: 安定性集計

- block内／block間、forward／reverse、order前半／後半を集計する。
- raw値を使うbootstrap、paired ratio、品質Gateを実装する。
- 欠落、重複、sample再配分、丸め境界、完全同点をunit testで拒否する。

完了条件: syntheticな安定、process変動、順序偏り、同点を決定的に分類する。

### PR-3: lifecycle safety

- runtime object再利用の正常値、fault後、複数runtime、memory boundを検証する。
- compile-once／instance-per-evaluateという現行境界をtestと仕様へ固定する。
- global cache、instance reuseが混入していないことを確認する。

完了条件: prepared lifecycleがABIとfault isolationを変えない。

### PR-4: canonical recordと最終decision

- Bun 1.4.2／Apple M4で6 blockを記録する。
- rawからdecisionを再生成する。
- `adopt-prepared-lifecycle`または`retain-baseline`を確定する。

完了条件: `inconclusive`を次作業へ持ち越さず、理由付きの最終方針を一つ保存する。

### PR-5: 許可された製品反映

- `adopt-prepared-lifecycle`の場合だけ、仕様、利用例、反復経路を更新する。
- `retain-baseline`の場合は製品codeを変更せず結果文書だけを更新する。
- roadmapと文書indexを最終状態へ更新する。

完了条件: decisionで許可されていない製品差分が存在しない。

### PR-6: 最終レビューと品質Gate

- 計測公平性、schema、rollback、concurrency、保証境界をレビューする。
- 専用test、typecheck、lint、format、docs、`bun run check`を実行する。
- checked-in v1／stability証跡の再生成一致を確認する。

完了条件: 対応必須のレビュー指摘、未完了checkbox、未説明の製品差分がない。

## 13. 受け入れ条件

### protocol

- [x] CRS1: 基点revision、既存workload hash、環境、全thresholdが固定される。
- [x] CRS2: 6 blockと6つのcase orderが結果観測前に固定される。
- [x] CRS3: cold／cached lane順がblock parityでcounterbalanceされる。
- [x] CRS4: 690 cold、690 cached sampleの完全matrixを要求する。
- [x] CRS5: warmup、child起動、report時間がraw traceへ混入しない。
- [x] CRS6: 強制GC、外れ値除外、raw時間の補正を行わない。
- [x] CRS7: v1 observationとdecisionを変更しない。

### correctnessと安全性

- [x] CRS8: reference、public runtime、trace childの全正常値が一致する。
- [x] CRS9: checked faultとfault後の正常評価が一致する。
- [x] CRS10: compile-onceでも各evaluateは新しいinstanceを使う。
- [x] CRS11: runtime object間でmemory、fault、allocator stateを共有しない。
- [x] CRS12: ABI、manifest、export、memory page、artifact hashが不変である。
- [x] CRS13: path、symlink、size、timeout、stdout／stderr、既存outputを制限する。
- [x] CRS14: concurrent recordを拒否し、失敗時に全証跡を復元する。

### 集計と判断

- [x] CRS15: block内／block間のmedian、MAD、p95、bootstrap intervalをrawから生成する。
- [x] CRS16: forward／reverseとorder前半／後半の差を保存する。
- [x] CRS17: sample ratio、threshold、tie-breakへ丸め値を使わない。
- [x] CRS18: unattributed p95 20% Gateを維持する。
- [x] CRS19: overall MAD／median 25% Gateを維持する。
- [x] CRS20: block median MAD／median 15% Gateを適用する。
- [x] CRS21: forward／reverse差20% Gateを適用する。
- [x] CRS22: block首位が6 block中5 block以上一致する。
- [x] CRS23: qualifying caseとrobust caseの包含関係を検査する。
- [x] CRS24: 複数候補と完全同点を決定的に処理する。
- [x] CRS25: summaryとdecisionをraw observationだけから再生成する。

### 最終方針

- [x] CRS26: startup選定時だけprepared lifecycle Gateを評価する。
- [x] CRS27: holdout過半数でpaired median reduction 30%以上を要求する。
- [x] CRS28: 最低3 caseでreduction interval下限20%以上を要求する。
- [x] CRS29: 全holdout caseでpaired ratioの95% interval上限1.05以下を要求する。
- [x] CRS30: 採用時もglobal cacheとinstance reuseを追加しない。
- [x] CRS31: 不採用時は製品codeを変更しない。
- [x] CRS32: 最終decisionが`adopt-prepared-lifecycle`または`retain-baseline`になる。
- [x] CRS33: 結果文書に観測値、判断理由、未実証範囲を記録する。
- [x] CRS34: roadmapと文書indexが最終方針を正しく示す。

### 品質

- [x] CRS35: dedicated test、typecheck、lint、format、docsが成功する。
- [x] CRS36: 全`bun run check`が成功する。
- [x] CRS37: v1とstability証跡のverify／reportが完全一致する。
- [x] CRS38: コードレビューで対応必須の指摘が残らない。

## 14. 完了後に残るもの

本計画完了後、repository内のCollection memory safety、Binaryen recipe比較、LLVM最小比較、end-to-end attribution、runtime lifecycle判断は一巡する。追加の性能作業は、実SAAA workloadまたは別環境で新しい証拠が得られた場合にだけ再開する。

L-Lang全体では、次は実装量を増やす段階ではなく、外部利用条件を伴う評価段階である。SAAA接続、長時間soak、実運用TLS、live model／人間評価は、このrepositoryだけでは完了できないため本計画の完了判定へ含めない。
