# Semantic Core安定化・第四段階 実装計画

作成日：2026-09-22。状態：実装完了。実測結果は[第四段階の結果](./SEMANTIC_CORE_STABILIZATION_PHASE4_RESULTS.md)を参照。

## 目的

[第三段階の結果](./SEMANTIC_CORE_STABILIZATION_PHASE3_RESULTS.md)で確立した決定的generated differential testingを、`module-collection-v1`のList操作とcallbackへ拡張する。同じ生成programとinputを、独立oracle、reference evaluator、generated TypeScript、JSONC round-trip、native Wasmで評価し、List内容と順序、構造化output、または安定fault codeが一致することを確認する。

この段階では、Collectionの新機能や性能改善を行わない。既存のsource version 4、suite version 3、manifest version 4、ABI `llang-collection-native-v1`、resource limit、Binaryen 132.0.0、runtime lifecycleを変更せず、既に外部へ説明している意味論へ再現可能な証拠を追加する。

## この対象を選ぶ理由

[Observable Semantics](./LLANG_OBSERVABLE_SEMANTICS.md)では、Collectionの固定suiteについてreference evaluator、generated TypeScript、JSONC round-trip、native Wasmの一致を確認済みとしている。一方、生成programを独立oracleと比較する証拠はなく、次の契約は主に手書きfixtureへ依存している。

- List literalとcallbackがsource順に評価されること。
- `set`と`append`が入力Listを変更せず、新しいListを返すこと。
- `map`、`filter`、`fold`が要素をsource順に一度ずつ訪問すること。
- `fold`がleft foldであること。
- `stableSort`が同値要素の元の順序を維持すること。
- lambdaと返却closureがimmutableな外側値をcaptureすること。
- `for-of`が開始時のListをsnapshotとして反復すること。
- callback内のchecked arithmeticや`at`が安定faultを返すこと。

Collectionは既に4実行経路、checked program、native Wasm、portable runtime、固定suiteを持ち、credentialやnetworkを必要としない。Effectsのようなhost responseやschedulerの追加設計を待たずに着手できるため、次の限定subsetとして選ぶ。

## 現在の基準点

- 正本は[Collection仕様](./LLANG_MODULE_COLLECTION_SPEC.md)、[Semantic Core v1](./LLANG_SEMANTIC_CORE_V1.md)、[Observable Semantics](./LLANG_OBSERVABLE_SEMANTICS.md)とする。
- `testCollectionModuleProgram`はreference、generated TypeScript、JSONC再読込、native Wasmを同じsuite expectationと比較する。
- `src/llang-module-collection.test.ts`はcallback、capture、fold、stable sort、persistent update、index fault、recursion、returned closureを固定fixtureで検査する。
- Collection direct memory corpusはABI validation、canonical descriptor、payload overlap、allocation、fault後のinstance扱いを別責務として検査する。
- Collection性能探索の最終方針は`retain-baseline`であり、本計画から性能作業を再開しない。

実装着手時には、代表する既存Collection programについてsource、program hash、interface hash、Wasm hash、固定suite outcomeを記録する。新しいharnessのために共通処理を抽出する場合も、これらと既存CLI／suite reportを変更しない。

## 前提と不変条件

- 生成programは現行checkerを通過するvalid programに限定する。checker拒否はgenerator defectであり、semantic mismatchへ正規化しない。
- inputとoutputはJSON互換のi32、boolean、record、`List<T>`に限定する。function valueをwireへ出さない。
- 比較対象はobservable valueとfault codeである。fuel残量、arena byte数、copy回数、Wasm命令数、RSS、実行時間は比較しない。
- corpus内のfaultは`ARITHMETIC_OVERFLOW`、`DIVISION_BY_ZERO`、`INDEX_OUT_OF_BOUNDS`に限定する。`RESOURCE_LIMIT`と`INVALID_ARTIFACT`は既存固定suite／memory boundaryの責務として維持する。
- source version、profile、ABI、manifest、suite、hash定義、resource limitを変更しない。
- product Wasmのexportは`memory`、`evaluate`、`fault_code`の3件を維持する。instrumented buildを使用しない。
- generated TypeScriptは空の環境変数、標準入力なし、5秒timeoutの子processで実行する。unknown exception、timeout、process異常終了をCollection faultへ丸めない。
- API credential、外部network、新しいruntime dependencyを必要としない。

## 対象subset

### 型と値

- i32、boolean。
- `List<i32>`。
- stable sortの同値順を観測する`Item { key: i32, ordinal: i32 }`と`List<Item>`。
- input／output用の有限record。outputはList内容、元List、更新後List、集計値を観測できる形にする。
- 空、1要素、重複、負数、i32境界近傍を含む小さいList。通常generated corpusはresource limitから十分離す。

### program系統

生成器は少なくとも次の5系統を持つ。各系統は中立なcase modelからoracle表現とL-Lang sourceを別々に組み立てる。

1. **transform-reduce**：外側`const`をcaptureする`map`と`filter`、left `fold`を組み合わせ、変換後Listと集計値を返す。callback順序、訪問回数、capture、fold方向を観測する。
2. **stable-record-sort**：`List<Item>`を`key`でsortし、同じkeyを持つitemの`ordinal`順をoutputに残す。ascending／descending comparatorと同値群を含める。
3. **persistent-update**：`set`、`append`、`at`を使い、元Listと更新後Listを同じoutputへ含める。valid indexと`INDEX_OUT_OF_BOUNDS`を含める。
4. **snapshot-iteration**：反復対象をlocalへ保持し、`for-of`本体で別のList値を再代入する。反復回数と最終Listから、開始時snapshotだけを訪問したことを観測する。
5. **returned-closure**：helperが外側parameterをcaptureしたlambdaを返し、そのfunction valueを`map`または`invoke`で使う。frame終了後もcapture値が維持されることを観測する。

正常caseに加えて、選択されたcallback／式でのoverflow、division by zero、index faultを含める。非選択`if` branchに同じfaultを置くcaseも作り、Collection経路でも選択されない式を評価しないことを確認する。

## 独立oracle

oracleはcompilerのloader、checker、checked IR、reference evaluator、source emitter、Wasm emitter、Collection ABI codecをimportしない。generator専用の中立表現とplainな配列／recordを直接評価する。

oracleは次を独立に実装する。

- BigIntを使ったchecked i32加減乗除、division by zero、truncation、remainder。
- List literalのleft-to-right評価。
- `set`と`append`で入力を変更しないcopy-on-write結果。
- `map`、`filter`、left `fold`のsource-order一回訪問。
- 元のindexをtie-breakに使う明示的なstable sort。hostの`Array.prototype.sort`の安定性をoracleにしない。
- immutableなcapture environmentとreturned closure。
- `for-of`開始時のList snapshot。
- `at`の範囲検査。
- record／Listの順序を保ったdeep value比較。

oracleはresource counterを模倣しない。generated corpusでresource limitが出た場合は期待faultではなく、generator budget違反またはlane defectとして扱う。

## observable outcomeとlane

各inputについて次の5 laneを必須とする。

1. 独立oracle。
2. reference evaluator。
3. generated TypeScript child process。
4. emitted JSONCを再読込したreference evaluator。
5. native Wasm runtime。

outcomeは次のstrict unionへ正規化する。

- `{ kind: "value", value: JsonCompatibleCollectionValue }`
- `{ kind: "fault", code: "ARITHMETIC_OVERFLOW" | "DIVISION_BY_ZERO" | "INDEX_OUT_OF_BOUNDS" }`

value比較はarray順を保持し、record key順には依存しない。NaN、Infinity、undefined、function、class instance、cyclic value、未知fieldは受理しない。未知exception、invalid child output、timeout、signal終了、checker／emitter失敗、JSONC hash不一致はrunner errorとし、semantic outcomeへ変換しない。

JSONC round-trip後はprogram hashとinterface hashが元programと一致することを必須とする。Wasmは通常のpublic runtimeを使用し、instrumented counterやdirect ABI helperをlaneにしない。

## 決定性とcorpus

- format：`llang-collection-differential-v1`
- fixed seed：`20260923`
- 通常test：24 program、各8 input、合計192 input
- 明示的corpus：64 program、各8 input、合計512 input
- case index：uint32。seedとcase indexだけから独立生成する。
- 単一再生：seed、case index、input indexを指定する。

最初の固定24 caseで5 program系統、正常／fault mode、空／単一／重複List、両sort方向が必ず現れるよう、系統とmodeの選択を乱数任せにしない。乱数はliteral、capture値、List値、offset等のprogram固有値へ使う。

実装完了時に、固定24 generated case全体とprogram hash配列のdigestを試験へ固定する。program source自体がseedとcase indexで変化し、固定24 caseが十分に異なるprogram hashを持つことを検査する。case数を増やすだけで同一sourceを繰り返す状態を合格にしない。

## reproductionとCLI

failure artifactには次を含める。

- format、version、seed、case index、input index。
- program系統、mode、generator固有parameter。
- source、独立oracle model、input、全lane outcome。
- program hash、interface hash。利用可能ならWasm hash。
- 単一case／inputを再生する引数。
- runner errorの場合はstage、安定したmessage、生成済みcase model、source、input集合。

CLIは`--seed`、`--start-case`、`--cases`、`--input-index`、`--failure-out`だけを受理する。重複、未知、欠損、非整数、uint32範囲外、複数caseとinput indexの併用を拒否する。

- 一致：終了code 0、stdoutへmachine-readable JSON。
- semantic mismatch：終了code 1、stderrへreproduction。
- 引数、生成、checker、runner、child、artifact書き込み等の運用失敗：終了code 2。

failure artifactは既存atomic writerを使い、一時fileからrenameする。書き込み失敗で以前の完全なartifactを途中状態へ置き換えない。

## mutation試験

固定corpusが実装と同じ誤りを共有して偶然通ることを避けるため、oracle境界と比較器へ次のmutationを注入する。

- 必須5 laneの一つを欠落させる。
- `set`が元Listを直接変更する。
- `append`が元Listを共有または上書きする。
- `map`／`filter`が逆順、重複、または一部要素だけを訪問する。
- `fold`をright foldにする、またはinitial valueを無視する。
- sortの同値群を逆転して不安定にする。
- comparatorの符号を反転する。
- closure captureを現在値または誤った外側値へ置き換える。
- `for-of`がsnapshotではなく伸長中のListを読む。
- `at`の上端判定を一つ緩める。
- 非選択branchを先行評価する。
- outcome objectのproperty順へ依存する。

各意味論mutationは少なくとも一つの固定caseで期待結果と異なることを確認する。無限反復を起こすmutationは実runnerへ入れず、bounded oracle mutationとして差を観測する。

## 実装構成

| 対象 | 内容 |
| --- | --- |
| `src/llang-collection-differential-harness.ts` | strict outcome、deep比較、source load、generated TS child、JSONC round-trip、native Wasmの5 lane実行。製品APIにはしない |
| `src/llang-collection-differential-oracle.ts` | compiler／runtimeをimportしないcase model、独立oracle、mutation |
| `src/llang-collection-differential.ts` | 決定的generator、比較、reproduction、range実行 |
| `src/llang-collection-differential-cli.ts` | strict option parser、range実行、atomic failure artifact |
| `src/llang-collection-differential.test.ts` | 決定性、coverage、oracle boundary、mutation、固定corpus、replay、CLI異常系 |
| `src/llang-module-collection-source-json.ts` | checked IRのbranch名を公開JSONC grammarへ変換する共通serializer |
| `package.json` | `collection:differential` script |
| `QUALITY_GATES.md` | Collection意味論変更時の固定／明示corpus Gate |
| 文書 | 第四段階結果、Observable Semantics、文書一覧。実装事実が変わる箇所だけ更新 |

既存の`testCollectionModuleProgram`、suite schema、CLI reportは公開挙動を維持する。共通化が必要でも、unknown exceptionを`invalid-input`へ変換する既存compatibility境界と、新しいstrict differential runnerの運用失敗境界を混同しない。

## 作業項目

### SC4-01：既存baselineの固定

- 代表Collection programのsource、program／interface／Wasm hash、固定suite outcomeを記録する。
- `src/llang-module-collection.test.ts`、module smoke、portable verificationを着手前に実行する。
- 既存suite version、report shape、CLI、artifact、runtime lifecycleが変わらないことを確認する。

完了条件：新しい差分runnerの都合で既存契約を変更していないことをbyte hashとoutcomeで比較できる。

### SC4-02：strict 5 lane harness

- structured value／faultのstrict outcome captureとdeep比較を実装する。
- generated TypeScriptを隔離child processで実行する。
- JSONC round-tripのprogram／interface hashを検査する。
- native Wasmをpublic runtimeで実行する。
- unknown exceptionと運用失敗をsemantic faultへ丸めない。

依存：SC4-01。完了条件：手書きの小さいCollection programが5 laneで一致し、lane欠落とunknown child結果を拒否する。

### SC4-03：中立case modelとgenerator

- 5 program系統をseed／case indexから決定的に生成する。
- 最初の24 caseに全系統、正常／fault、空／重複、sort方向を配置する。
- source node、type、closure、List、wire、arena、fuel上限に十分な余裕を持つ生成budgetを定数化する。
- sourceとinputの両方をcase固有にする。

依存：SC4-02とinterfaceを共有して開始。完了条件：固定caseがcheckerを通り、構文／系統coverageとprogram hash多様性を検査できる。

### SC4-04：独立Collection oracle

- checked arithmetic、persistent List、callback順序、left fold、stable sort、capture、snapshot、index faultを実装する。
- compiler／runtime実装をimportしていないことをmodule境界と試験で確認する。
- 手書きboundary vectorで空、重複、負数、i32境界、faultを固定する。

依存：SC4-03と並行可能。完了条件：全mutationが少なくとも一つの反例を持つ。

### SC4-05：比較とreproduction

- 各generated caseを5 laneで実行し、strict outcomeを比較する。
- mismatchにsource、model、input、全lane、hash、replay引数を保存する。
- 一つのcase／inputだけを実行するAPIを設ける。

依存：SC4-02〜SC4-04。完了条件：意図的なlane差分を検出し、同じ引数で再現できる。

### SC4-06：CLIと運用境界

- strict option parserとuint32 range検査を実装する。
- success／mismatch／runner errorを終了code 0／1／2で区別する。
- mismatchと生成後runner errorをatomicに保存する。
- timeout、invalid child JSON、書き込み失敗、既存artifact保持を試験する。

依存：SC4-05。完了条件：通常range、単一replay、全引数異常系、artifact異常系が通る。

### SC4-07：固定corpusとmutation回帰

- 通常testへ24 program／192 inputを組み込む。
- 明示scriptで64 program／512 inputを実行する。
- generated case digestとprogram hash digestを固定する。
- 既存Collection module、suite、memory、runtime lifecycle試験を同時に実行する。

依存：SC4-05、SC4-06。完了条件：全固定caseが5 laneで一致し、全mutationが検出される。

### SC4-08：文書と品質Gate

- 実施結果に対象revision、corpus規模、系統coverage、hash digest、mutation、発見した不具合、全Gate結果、未保証範囲を記録する。
- Observable Semanticsと品質Gateは実装済みの事実だけを更新する。
- frozen install、audit、format、lint、docs、typecheck、full test、coverage、smoke、protected input、diff checkを実行する。

依存：SC4-07。完了条件：すべての必須Gateが成功し、未実行項目を成功として記載していない。

## 実装順序

```text
SC4-01 baseline
  -> SC4-02 strict harness
      -> SC4-03 generator ----+
      -> SC4-04 oracle -------+-> SC4-05 comparison／reproduction
                                      -> SC4-06 CLI
                                      -> SC4-07 corpus／mutation
                                          -> SC4-08 docs／quality gates
```

SC4-03とSC4-04は中立case modelのinterfaceを先に固定した後なら並行できる。それ以外は前段のbaselineと失敗分類を確認してから進める。

## 受け入れ条件

- [x] 既存Collection source／suite／manifest／ABI／runtime lifecycle／公開CLIが変わらない。
- [x] representative baselineのprogram／interface hashとoutcomeが維持され、Wasm byte hashの変更は既存compiler defectの修正として記録される。
- [x] 固定corpusに5 program系統と全必須Collection操作が現れる。
- [x] 空、単一、重複、負数、i32境界近傍のListが含まれる。
- [x] `set`／`append`後も元Listが変化しないことをoutputで観測する。
- [x] map／filter／left foldの順序と訪問回数をoutputで観測する。
- [x] stable sortの同値item順を`ordinal`で観測する。
- [x] lambda capture、returned closure、`for-of` snapshotを観測する。
- [x] arithmetic／division／index faultと非選択branchの遅延評価を観測する。
- [x] oracleがloader、checker、evaluator、emitter、ABI codecに依存しない。
- [x] oracle、reference、generated TypeScript、JSONC round-trip、native Wasmの5 laneが一致する。
- [x] lane欠落、永続性、順序、fold、sort安定性、capture、snapshot、index境界のmutationを検出する。
- [x] 同じseed／case index／input indexから同じprogram、input、反例を再現できる。
- [x] mismatch／runner artifactがatomicに保存され、source、model、input、全lane、hash、replay情報を含む。
- [x] 通常testで24 program／192 input、明示scriptで64 program／512 inputを実行する。
- [x] exact fuel／arena／timing／RSSの一致を成功条件へ含めない。
- [x] API credential、network、新規dependency、Binaryen設定変更を必要としない。
- [x] full quality gatesが成功し、coverage閾値を下げない。

## 非対象

- string intrinsic、Unicode境界、nested List、generic type、union matchのgenerated corpus。既存固定suiteは維持する。
- direct／mutual recursion、polymorphic recursion、call-depth上限のgenerated探索。
- invalid source、mutable capture、iteration binding capture、malformed wire inputの自動生成。
- `RESOURCE_LIMIT`の発生点やfuel／arena消費量のtarget間完全一致。
- direct ABI negative corpus、memory alias、UTF-8、allocator、fault後instanceの再検証。既存memory safety suiteを維持する。
- Binaryen recipe、Wasm最適化、startup、instance pooling、global cache、性能計測の再開。
- shrinker、coverage-guided fuzzing、全Collection programの形式的同値性証明。
- source schema、language version、suite／manifest version、ABI、resource limitの変更。

これらを追加する場合は、第四段階の完了条件へ途中で混ぜず、独立した計画と証拠範囲を作る。

## 禁止事項と要相談事項

次は本計画だけでは実施しない。

- resource counterの意味をtarget間で統一したとみなす変更。
- Collection仕様またはABIのobservable behavior変更。
- 製品Wasmへの計測export追加。
- 既存fixtureをgenerated corpusへ置き換えて削除すること。
- mismatchを消すためのoutcome正規化拡大、case削除、seed変更。

実装中にtarget間で異なる`RESOURCE_LIMIT`、既存仕様と実装の矛盾、ABI変更が必要なdefectを発見した場合は作業を止め、再現case、影響範囲、選択肢を提示して別判断を求める。

## 失敗時の扱い

- checker拒否、budget超過、hash不一致はgenerator／runner defectとしてcase全体を保存する。
- lane mismatchでは、まず単一case／inputを再生し、独立oracleとCollection仕様を照合する。
- compiler／runtime defectなら、最小の手書き固定回帰testを追加してから修正する。generated seedだけを回帰証拠にしない。
- generator／oracle defectでも、発見した反例を固定testへ昇格してから修正する。
- timeout、child異常終了、invalid JSON、unknown exception、artifact書き込み失敗は終了code 2とし、Collection faultへ変換しない。
- 既存baselineが変化した場合はharness作業を中断し、generator追加と同じ変更で正当化しない。

## 検証コマンド

局所検証：

```sh
bun test src/llang-collection-differential.test.ts --timeout 30000
bun run collection:differential
bun test src/llang-module-collection.test.ts --timeout 30000
bun test src/llang-collection-memory.test.ts --timeout 30000
bun run collection:memory:matrix
bun run ci:module-smoke
```

単一case replay：

```sh
bun run src/llang-collection-differential-cli.ts \
  --seed <seed> --start-case <caseIndex> --cases 1 \
  --input-index <inputIndex> \
  --failure-out artifacts/collection-differential-failure.json
```

最終検証は[品質Gate](../QUALITY_GATES.md)の必須項目を実行する。

```sh
bun install --frozen-lockfile
bun audit
bun run format:check
bun run lint
bun run ci:docs
bun run typecheck
bun run test
bun run coverage
bun run ci:smoke
bun run ci:protected
git diff --check
```

## 完了時に残す証拠

- 既存Collection baselineが不変であるhashとoutcome。
- fixed seed、program／input数、系統／構文／mode coverage。
- generated case digestとprogram hash digest。
- 5 lane一致とmutation検出結果。
- 単一case replay、mismatch／runner artifactのschema。
- 発見したcompiler、runtime、generator、oracle、runnerの問題と修正内容。
- 同一revisionで実行した全品質Gateの結果。
- exact resource量、性能、invalid input、再帰等を保証しない明示的な境界。
