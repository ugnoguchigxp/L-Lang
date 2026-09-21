# Collection Binaryen最適化レシピ選定 実装計画

作成日: 2026-09-21。状態: 実装完了。計画基点revision: `0da5caeff8a5d36b56620dd127912c2c4acf7ce0`。結果: [実装結果](./COLLECTION_BINARYEN_RECIPE_SELECTION_RESULTS.md)。

参照: [Wasm最適化ビルド設計案](./WASM_OPTIMIZED_BUILD_DESIGN.md)、[Collection仕様](./LLANG_MODULE_COLLECTION_SPEC.md)、[Collectionメモリー安全性と最適化基盤の結果](./COLLECTION_MEMORY_SAFETY_AND_OPTIMIZATION_RESULTS.md)、[LLVM実験backendの結果](./LLVM_EXPERIMENTAL_BACKEND_RESULTS.md)。

## 1. 目的

現行の直接Wasm backendを維持したまま、`module-collection-v1`の製品artifactへ適用できる固定Binaryenレシピを、再現可能な候補生成と事前に固定したGateで選定する。次を一つの実装単位として完了させる。

1. 現行の未最適化artifactを基準に、明示的なBinaryen設定を隔離processで適用する。
2. 公開ABI、fault、memory safety、resource limit、決定性が変わらないことを検査する。
3. exploration用corpusで候補を測り、選定に使っていないholdoutで退行と改善を確認する。
4. 全候補とraw sample、集計、採否理由をmachine-readableに保存する。
5. 採用Gateを満たした一レシピだけを製品buildへ組み込む。該当候補がなければbaseline維持を正式な完了結果とする。

速度改善やレシピ採用そのものを完了条件にしない。既定成果物を測定前に変更せず、証拠に基づいて`adopt`または`retain-baseline`を決定する。

## 2. 現在地と着手理由

`module-collection-v1`には、検証済みIR、reference evaluator、direct Wasm emitter、raw ABI test、safe allocator、決定的cost観測がある。LLVM最小比較では全laneの意味一致と再現buildを確認した一方、LLVM Wasmは事前の性能Gateを満たさず、`maintain-current-backend`となった。この結果から、次段階はLLVM一般化ではなく、既存backendの生成後最適化を限定範囲で評価する。

現行`emitCollectionModuleWasm`はWATをparse・validateして直接binary化し、`module.optimize()`を呼ばない。Binaryen 132.0.0は固定済みだが、optimizer設定はprocess globalである。製品emitter内で設定を切り替えると、並行build間で候補設定が混ざる可能性があるため、最適化は専用child processへ隔離する。

過去のsort実験では、O2／O3がheap sortを改善する一方、selection sortを大幅に遅くした。単一kernelや最適化levelの高さだけでは既定採用を決めない。製品artifactの入出力込み時間、compile／instantiate、artifact size、memory、複数処理の退行を同時に評価する。

## 3. 対象範囲

### 3.1 対象

- source profile `module-collection-v1`。
- ABI `llang-collection-native-v1`と既存manifest version 4。
- 現行の製品Collection Wasm emitterが生成したartifact全体。
- `fold`、`map`、`filter`、`sort`、closure、generic specializationを含む代表program。
- Binaryen 132.0.0の標準optimization／shrink levelだけを使う固定候補。
- correctness、raw direct ABI、再現build、性能、artifact size、memoryの比較。

### 3.2 対象外

- 言語仕様、評価順、fault taxonomy、ABI、manifest versionの変更。
- `module-value-v1`、`module-effects-v1`、Predicate、専用sort profileへの横展開。
- `runPasses()`による独自pass列、IR書換え、`select`から`if`への特例変換。
- `trapsNeverHappen`、低memory前提、証明されていないalias／alignment前提。
- LLVM経路の製品統合、nightly探索、自動配備、hostごとの動的tuning。
- TypeScript baselineに対する一般的な速度優位の主張。

対象外の項目は、この計画の結果から別計画として起案する。選定実装へ先回りしてoptionを追加しない。

## 4. 不変条件

どの候補も次を保存しなければならない。

- export名、function signature、memoryのinitial／maximum、import 0件。
- 入力validation順序、status、fault code、最初に観測されるfault。
- signed i32 checked arithmeticと左から右の評価順。
- input不変、output ownership、allocatorとarenaの上限。
- direct callerに対するrange、overflow、overlap、unaligned accessの既存契約。
- source、program、lowered IR、interface、layout、ABIのhash。
- host verifier、rebuild verifier、portable packageの既存互換性。

最適化後にもBinaryen validationを実行する。構造検査とdifferential testを通過しないbinaryは計測対象にせず、失敗候補として記録する。optimizerがWasm trapを未到達と仮定する設定は使わない。

## 5. レシピ契約

### 5.1 version付き設定

実験用schema `collection-binaryen-recipe-v1`は次の値を持つ。

```text
CollectionBinaryenRecipeV1 {
  schemaVersion: 1
  recipeId
  binaryenVersion: "132.0.0"
  optimizeLevel: 0 | 1 | 2 | 3 | 4
  shrinkLevel: 0 | 1 | 2
  debugInfo: false
  lowMemoryUnused: false
  passes: []
}
```

未知field、範囲外level、Binaryen version不一致、非空`passes`、危険設定はstrictに拒否する。設定の省略を暗黙の既定値として受理しない。レシピのcanonical JSON hashをartifact記録へ含める。

### 5.2 初回候補

| recipeId | optimize | shrink | 役割 |
| --- | ---: | ---: | --- |
| `baseline-v1` | 0 | 0 | 現行emitter。optimizerを実行しない比較基準 |
| `binaryen-o2-v1` | 2 | 0 | 中程度の速度候補 |
| `binaryen-o3-v1` | 3 | 0 | 高い速度候補 |
| `binaryen-o2s-v1` | 2 | 1 | 速度とsizeの均衡候補 |
| `binaryen-o2sz-v1` | 2 | 2 | size優先候補 |

候補は計測開始前にfreezeし、結果を見て追加・削除しない。候補を変える場合はexperiment revisionとcorpus partitionを更新し、旧結果と混ぜない。

### 5.3 process隔離

親processは最適化前Wasm、canonical recipe、出力pathを専用temporary directoryへ渡す。child processは一候補だけを読み、Binaryen global設定を一度設定し、parse、pre-validation、optimize、post-validation、emitを行って終了する。

- shell文字列を組み立てず、引数配列で起動する。
- workspace外の入力、symlink、既存出力、過大なinput／outputを拒否する。
- timeout、stdout／stderr上限、exit分類を設ける。
- child間でBinaryen moduleやglobal settingを共有しない。
- parentは受け取ったbinaryを再度compile・shape検査してから保存する。
- temporary directory名や絶対pathを決定的artifactへ含めない。

## 6. corpus

### 6.1 program corpus

既存例をそのまま性能代表にせず、同じprofileで次のfixtureを固定する。

| family | 必須内容 |
| --- | --- |
| fold | checked sum、負数混在、empty、境界値 |
| map | checked算術、record field更新、generic specialization |
| filter | sparse／dense、predicate closure、順序保存 |
| map-filter-fold | 中間Listとarena allocationを伴う合成処理 |
| sort | sorted、reverse、duplicate、偏り、stable ordering識別 |
| closure | captureあり／なし、複数呼出し、checked fault |

各familyはsmall、medium、maximumの有効入力を持つ。correctness corpusにはoverflow、resource limit、invalid UTF-8やrecord／union boundaryなど、そのprogramで到達可能な既存faultを加える。性能入力は正常終了caseとし、fault処理時間を通常性能へ混ぜない。

### 6.2 explorationとholdout

- program family、input shape、sizeごとに探索用とholdout用を作る。
- holdoutはrecipeの採否規則をfreezeした後まで集計結果を表示しない。
- 同一seedから生成した近似caseを両partitionへ重複させない。
- corpus canonical JSON、generator version、partition、各input hashを保存する。
- 選定後にholdoutで閾値未達または退行が出た候補を調整して再採用しない。次revisionの新実験とする。

### 6.3 adversarial direct ABI

既存raw ABI suiteに対し、全候補で少なくとも次を再実行する。

- memory末尾ちょうど、1 byte short、offset加算overflow。
- unalignedだが包含された入力。
- input／output overlap、descriptor overlap、module-private range。
- maximum要素、maximum直前／直後、allocator exhaustion。
- malformed descriptor、tag、length、UTF-8、record／union payload。
- fault後の再実行、memoryとinputのbefore／after hash。

候補ごとのtrap、status、fault、state mutationをbaselineと比較する。host wrapperが先に拒否した結果だけでWasm自身の安全性を証明しない。

## 7. 再現性とartifact検証

各recipeとprogramを異なる二つのtemporary root、異なる生成順でbuildし、最適化後WasmのSHA-256が一致することを要求する。次を分離して記録する。

- 決定的情報: source／IR／recipe／corpus hash、tool version、Wasm hash、size、imports／exports、memory limits。
- 観測情報: OS、CPU、Bun、process条件、時刻、raw timing、RSS。

baselineは現行emitterの出力とbyte-for-byte一致しなければならない。`baseline-v1`のためにbinaryを再serializeして差分を生じさせない。候補Wasmは既存rebuild verifierと同じsource／IR hashへ結び付けるが、採用前に製品manifestの意味を拡張しない。

採用候補を製品buildへ組み込む段階では、固定recipe IDとrecipe hashをbuild implementation側のversion付き定数として持つ。既存manifest readerが未知設定を無視する形でfieldを足さない。manifest変更が必要だと判明した場合は、製品統合を止め、version migrationを別計画へ分離する。

## 8. benchmark設計

### 8.1 測定区間

buildでは次を個別に測る。

- Collection parse／validation／lowering。
- WAT生成、Binaryen parse、pre-validation。
- optimize、post-validation、binary emit。
- Wasm compile。

実行では次を個別に測る。

- input encodeとhost validation。
- compile済みmoduleのinstantiate。
- `evaluate`呼出し。
- output decode。
- encodeからdecodeまでのend-to-end。

artifact bytes、initial／maximum linear memory、arena peak、allocation／copy count、process peak RSSを時間とは別metricにする。instrumented artifactのallocation／copy値は診断にだけ使い、その実行時間を製品性能として扱わない。

### 8.2 固定環境

採否に使うcanonical runは次を満たす。

- package指定のBun 1.4.2。
- package lockのBinaryen 132.0.0。
- macOS arm64、Apple M4の同一host、電源接続、固定並行数。
- warmup、sample数、iteration、timeout、lane順序seedをfreeze。
- lane順序をcounterbalanceし、候補ごとに別processを使う。
- raw sampleを保存し、median、MAD、p95を再生成できる。

別OS／CPUの値は補助観測として別fileへ保存し、canonical採否と混ぜない。package指定Bunと異なる環境ではcorrectnessを実行できるが、採否結果を確定しない。

### 8.3 採否Gate

候補は次の順で評価する。

1. 全correctness、raw ABI、memory safety、resource limitがbaselineと一致する。
2. 二rootのWasm hashが全programで一致する。
3. compile／instantiateを含むholdout全caseでend-to-end medianの退行が5%以内である。
4. mediumまたはmaximumのholdoutの過半数でend-to-end medianが10%以上改善する。
5. artifact sizeがbaselineの1.5倍以下で、arena peakとprocess peak RSSが10%を超えて悪化しない。
6. 差がMADと95% bootstrap intervalで測定揺らぎから分離できる。

1または2の失敗は即時却下する。3〜6をすべて満たす候補だけを`eligible`とする。複数候補がeligibleの場合は、全holdoutの幾何平均speedup、artifact size、build時間の順で決定的に順位付けする。同点規則もreport generatorへ固定する。

ばらつきが閾値を覆う場合は`inconclusive`とし、採用しない。size候補が小さくても速度Gateを単独で迂回させない。初回の製品既定値は一つだけとし、複数profileや利用者指定flagを追加しない。

## 9. 実装成果物

### 9.1 code

- `src/llang-collection-binaryen-recipe.ts`: strict parser、canonicalization、hash、候補定義。
- `src/llang-collection-optimize-child.ts`: 一process一recipeのBinaryen実行。
- `src/llang-collection-optimized-wasm.ts`: parent側のbounded runner、再検査、artifact生成。
- `src/llang-collection-recipe-experiment.ts`: corpus build、differential、benchmark orchestration。
- `src/llang-collection-recipe-report.ts`: raw集計、bootstrap、事前規則による採否。
- 対応するunit、integration、mutation、reproducibility test。

### 9.2 fixtureと証跡

- `benchmarks/collection-binaryen-v1/recipes.json`。
- `benchmarks/collection-binaryen-v1/corpus.json`。
- `benchmarks/collection-binaryen-v1/freeze.json`。
- `benchmarks/collection-binaryen-v1/observations/<os>-<arch>.json`。
- `benchmarks/collection-binaryen-v1/decision.json`。
- `schemas/collection-binaryen-recipe-v1.schema.json`。
- `schemas/collection-binaryen-corpus-v1.schema.json`。
- `schemas/collection-binaryen-freeze-v1.schema.json`。
- `schemas/collection-binaryen-observation-v1.schema.json`。
- `schemas/collection-binaryen-decision-v1.schema.json`。
- `docs/COLLECTION_BINARYEN_RECIPE_SELECTION_RESULTS.md`。

raw sampleは上限を決めたJSONへ保存する。temporary Wasm、warmup出力、process logはGit管理しない。decisionは全candidateのstatusと理由を持ち、勝者だけを残さない。

### 9.3 command

- `bun run collection:binaryen:verify`: recipe、schema、corpus、全correctness、raw ABI、reproducibility。
- `bun run collection:binaryen:benchmark`: freeze済み条件でraw observation生成。
- `bun run collection:binaryen:report`: rawから集計とdecisionを再生成。
- `bun run collection:binaryen:record`: canonical環境確認後にchecked-in evidenceを更新。

verifyは外部networkを使わない。benchmarkとrecordは環境差を検出して失敗し、異なる環境の結果をcanonical fileへ上書きしない。

## 10. 変更単位

### PR-0: baselineと品質Gateの固定

- 計画基点のbaseline Wasm hash、exports、memory、既存testを記録する。
- CIの全OSがpackage scriptのsharded testを使うよう統一し、Unixだけraw `bun test`を呼ぶ差を解消する。
- 新実験のfixture命名、schema version、結果statusを固定する。

完了条件: `bun run check`とUbuntu／macOS／Windows CIが同じtest入口を使い、baselineに製品差分がない。

### PR-1: recipe schemaとstrict parser

- recipe型、schema、canonical JSON、hash、全初回候補を実装する。
- unknown field、version、危険設定、非空passesのnegative testを追加する。

完了条件: 同じrecipeが順序に依存せず同じhashとなり、曖昧な設定を一件も受理しない。

### PR-2: optimizer process隔離

- bounded child runnerと一process一recipe実行を実装する。
- validation前後、timeout、size上限、cleanup、exit分類を試験する。
- 並行buildで設定が混ざらないstress testを追加する。

完了条件: 異なるlevelを並行実行しても各artifactが逐次実行時とbyte一致する。

### PR-3: artifact構造・ABI検証

- import／export、signature、memory、custom metadata、baseline bindingを比較する。
- 既存raw ABI suiteを全candidateへparameterizeする。
- optimizer無効baselineのbyte一致を検査する。

完了条件: 構造またはdirect ABI差を意図的に入れたmutantをすべて検出する。

### PR-4: corpusとdifferential

- six family、三size、correctness／exploration／holdout partitionを固定する。
- reference、baseline、全candidateのresult／fault／input hashを比較する。
- 評価順、checked arithmetic、resource boundaryのmutation testを追加する。

完了条件: 全valid candidateが全caseで一致し、意味を変えるmutantをcorpusが検出する。

### PR-5: 再現build

- 二root、生成順変更、並行実行でartifact hashを比較する。
- 決定的manifestと環境観測を分離する。
- checked-in freezeとschema検証を追加する。

完了条件: 全candidate／programが再現し、pathや時刻を混入するmutantを検出する。

### PR-6: benchmarkとraw記録

- build、compile、instantiate、evaluate、decode、end-to-endを分離して測る。
- size、linear memory、arena、allocation／copy、RSSを記録する。
- warmup、counterbalance、raw sample上限、環境freezeを実装する。

完了条件: raw observationだけから全集計を再生成でき、instrumented時間が製品metricへ混ざらない。

### PR-7: holdout採否

- Gate、bootstrap interval、eligible／rejected／inconclusive、順位規則を実装する。
- explorationを除いたholdoutだけでdecisionを生成する。
- threshold境界と同点のunit testを追加する。

完了条件: 全候補の採否がmachine-readableな理由を持ち、手編集なしで同じdecisionを再生成できる。

### PR-8: 条件付き製品統合と結果文書

- eligible候補がある場合だけ、固定recipeをCollection build内部へ統合する。
- 統合後に全repo test、rebuild verifier、portable package、三OS CIを実行する。
- eligible候補がなければ製品emitterを変更せず、baseline維持を記録する。
- 結果、保証境界、未実証事項、rollback手順を文書化する。

完了条件: `adopt`または`retain-baseline`の一方が証拠と一致し、製品の既定動作がdecisionなしに変わらない。

## 11. 受け入れ条件

### recipeと隔離

- [x] CBR1: 全recipeがversion、Binaryen version、明示level、空passesを持つ。
- [x] CBR2: parserがunknown field、暗黙値、危険設定を拒否する。
- [x] CBR3: recipe hashがcanonical JSONから決定的に生成される。
- [x] CBR4: optimizerは一process一recipeで実行される。
- [x] CBR5: 並行候補でBinaryen global設定が混ざらない。
- [x] CBR6: childのtimeout、output上限、異常終了、cleanupが検証される。

### correctnessと安全性

- [x] CBR7: 最適化前後にBinaryen validationを通す。
- [x] CBR8: import、export、signature、memory limitsがbaselineと一致する。
- [x] CBR9: reference、baseline、全候補の正常結果が一致する。
- [x] CBR10: fault codeと最初のfaultが一致する。
- [x] CBR11: direct ABIのrange、overflow、overlap、unaligned caseが一致する。
- [x] CBR12: fault後のinput、memory、allocator stateの契約が一致する。
- [x] CBR13: checked arithmetic、評価順、boundary mutantを検出する。
- [x] CBR14: host側拒否だけでWasm安全性を合格にしない。

### corpusと再現性

- [x] CBR15: six program familyと三sizeを含む。
- [x] CBR16: correctness、exploration、holdoutをhash付きで分離する。
- [x] CBR17: holdoutを候補調整に再利用しない。
- [x] CBR18: baselineが現行emitterとbyte一致する。
- [x] CBR19: 二root、順序変更、並行実行でcandidate hashが一致する。
- [x] CBR20: path、時刻、可変環境情報が決定的artifactへ入らない。

### 測定と採否

- [x] CBR21: build区間と実行区間を分離して記録する。
- [x] CBR22: end-to-end、artifact size、memory、RSSを独立metricにする。
- [x] CBR23: raw sampleからmedian、MAD、p95、intervalを再生成できる。
- [x] CBR24: canonical Bun、Binaryen、OS、CPU、順序seedをfreezeする。
- [x] CBR25: 非canonical環境が採否fileを上書きできない。
- [x] CBR26: correctness／reproducibility失敗候補を性能で救済しない。
- [x] CBR27: 5%退行、10%改善、1.5倍size、10%memoryのGateを実装する。
- [x] CBR28: 揺らぎが閾値を覆う結果を`inconclusive`にする。
- [x] CBR29: 全候補の結果と却下理由を保存する。

### 統合と品質

- [x] CBR30: decision前に製品既定artifactを変更しない。
- [x] CBR31: 採用時はrecipe IDとhashを固定し、暗黙fallbackしない。
- [x] CBR32: manifest互換を保てない場合は製品統合を停止する。
- [x] CBR33: 不採用時にbaseline維持を正常な完了結果として記録する。
- [x] CBR34: Ubuntu／macOS／Windows CIが同じsharded test入口を使う。
- [x] CBR35: `bun run check`、専用verify、schema、rebuild検査が合格する。
- [x] CBR36: 結果文書が保証範囲、未実証事項、rollbackを明記する。

## 12. 完了後の判断

`adopt`の場合も、確認できるのはfreezeしたCollection corpusとcanonical host上での改善である。ほかのprofile、別CPU、長時間稼働、実SAAA workloadへの一般化は主張しない。固定recipeの変更は同じ評価を再実行し、通常のdependency更新に紛れ込ませない。

`retain-baseline`の場合は、候補ごとの失敗Gateとraw evidenceを保存してこの計画を完了とする。その後は無制限なpass探索へ進まず、IR形状、data layout、encode／decode、実workloadのどこが支配的かを結果から特定し、次の計画を別に作る。
