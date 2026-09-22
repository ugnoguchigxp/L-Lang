# Semantic Core安定化・第四段階 実施結果

実施日：2026-09-22。対象：[第四段階 実装計画](./SEMANTIC_CORE_STABILIZATION_PHASE4_IMPLEMENTATION_PLAN.md)。

## 実装結果

`module-collection-v1`へ決定的generated differential testingを追加した。同じ生成programとinputを、独立oracle、reference evaluator、generated TypeScript、JSONC round-trip、native Wasmの5 laneで評価し、構造化valueまたは安定fault codeを比較する。

generatorはseed `20260923`とcase indexだけから、次の5系統を生成する。

- `transform-reduce`：captureを含むmap／filterとleft fold。
- `stable-record-sort`：recordの昇順／降順sortと同値要素の元順序。
- `persistent-update`：`set`、`append`、`at`と更新前後のList。
- `snapshot-iteration`：`for-of`開始時snapshotと反復中の別List値への再代入。
- `returned-closure`：helper終了後も維持されるimmutable capture。

各programは8 inputを持ち、空・単一・重複・負数・i32境界近傍、正常結果、overflow、division by zero、index fault、非選択branchの遅延評価を含む。通常testは24 program／192 input、`bun run collection:differential`は64 program／512 inputを実行する。固定24 caseは24種類、明示64 caseは64種類のprogram hashを持つ。

oracleは依存ゼロの専用moduleへ分離し、Collection loader、checker、evaluator、source emitter、Wasm emitter、ABI codecをimportしない。plainな配列とrecord、BigInt checked arithmetic、明示的なstable insertion sort、copy-on-write、immutable capture、snapshot iterationを独立に実装した。import境界は回帰testで固定する。比較はList順を保持し、record property順には依存せず、疎なarray、追加property、symbol、accessor、循環値等をJSON互換値へ正規化しない。

## CLIと再現

```sh
bun run collection:differential

bun run src/llang-collection-differential-cli.ts \
  --seed 20260923 --start-case <caseIndex> --cases 1 \
  --input-index <inputIndex> \
  --failure-out artifacts/collection-differential-failure.json
```

CLIは`--seed`、`--start-case`、`--cases`、`--input-index`、`--failure-out`だけを受理する。重複、未知、欠損、非整数、uint32範囲外、複数caseとinput indexの併用を拒否する。一致は終了code 0、semantic mismatchは1、runnerまたはartifact書き込み等の運用失敗は2である。

mismatch artifactはsource、oracle model、input、全lane outcome、program／interface／Wasm hash、単一再生引数を保持する。生成後のchecker、emitter、child process等の失敗もrunner errorとしてstage、該当input index、case、source、model、input集合とともにatomic writeする。generated TypeScriptは空の環境変数、標準入力なし、5秒timeoutの子processで実行する。

## 固定証拠

| 証拠 | SHA-256 digest |
| --- | --- |
| 固定24 generated case | `3633dcc4dd95a65b55a4848084912a0e5a5f5dfbc745630f8d13daf5008ed22f` |
| program hash配列 | `135f31f0ba840a78a09b8d79308bf211a090e1147281fc90a78e13a01baaba0b` |
| interface hash配列 | `e81c8ead559c8a2eed3a701764a930e3e65fbfc6622857672d10eb5fd505f94b` |
| Wasm hash配列 | `97063baa87fb81bc973d68757d2daf6e78e87c7fc4bc8171fcf7029851eee837` |

source version 4、suite version 3、manifest version 4、ABI `llang-collection-native-v1`、public export、resource limit、Binaryen 132.0.0と最適化設定は変更していない。既存fixtureのprogram／interface hashとobservable outcomeも維持した。native compiler修正によりWasm byte hashは変化するため、不変とは主張しない。

## mutation検出

固定試験で次の誤りを検出する。

- 5 laneの欠落とoutcome objectのproperty順依存。
- callback順序の反転、重複、一部欠落、right fold、fold initial valueの無視、非選択branchの先行評価。
- stable sortの同値群反転とcomparator符号反転。
- `set`／`append`による元Listの変更。
- closureの誤ったcapture。
- `for-of`のlive iteration化。
- `at`の上端判定緩和。

## 実装中に修正した不具合

generated corpusが既存実装の不具合を2件検出した。

1. Collection JSONC emitterはchecked IRの`if`を内部field名`whenTrue`／`whenFalse`のまま出力していた。公開JSONC grammarの`then`／`else`へ再帰的に変換し、nested expression／statementをround-tripできるよう修正した。
2. native `stableSort`はrecord等のaggregate要素について、挿入対象keyを元slotへのpointerとして保持していた。要素shiftでそのslotが上書きされ、別recordが複製される場合があった。aggregate keyを専用scratchへ浅くcopyしてからshiftするよう修正し、異なるrecordと同値順を固定回帰testで確認した。

2件とも言語仕様、ABI、export、Binaryen recipeの変更ではなく、既存契約へ実装を合わせる修正である。

コードレビューでは、独立oracleを依存ゼロの専用moduleへ分離し、JSONC serializerの二重実装を共通helperへ統合した。またrunner errorへstage／input indexを追加し、strict outcomeがaccessorや疎なarrayを受理しないよう境界を強化した。fold初期値をcase固有にして、callback重複／欠落とinitial value無視のmutationも検出対象へ追加した。

## 検証結果

| 検証 | 結果 |
| --- | --- |
| 固定corpus | 24 program／192 input、5 lane一致、24種類のprogram hash、全digest一致 |
| 明示corpus | 64 program／512 input、5 lane一致、64種類のprogram hash |
| Collection関連test | 71 test、373 expectation、0 fail |
| install／audit | frozen lockfileに変更なし、109 packageに既知脆弱性なし |
| format／lint／typecheck | 成功。新規差分テスト群の警告0。全体lintは既存警告87件、終了code 0 |
| full test | 153 file、817 test、0 fail |
| coverage | 817 test、0 fail。全体functions 92.62%／lines 91.57%、`semantic-transaction.ts` functions 98.36%／lines 96.88%で既定閾値を通過 |
| smoke／protected／docs | semantic、L-Lang、module、effects smoke、protected input、24 command／3 versionの文書契約が成功 |
| Collection memory matrix | 再生成成功、checked-in成果物に差分なし |
| `git diff --check` | 成功 |

## 保証範囲

固定seedの有限corpusについて、List内容と順序、persistent update、map／filter／left fold、record stable sort、lambda capture、returned closure、`for-of` snapshot、checked arithmeticとindex faultが、独立oracleと5実行経路で一致したことを確認する。

これは全Collection programの形式的同値性証明ではない。string intrinsic、Unicode境界、nested List、generic／union、再帰、invalid source、malformed wire input、`RESOURCE_LIMIT`、exact fuel／arena／timing／RSS、性能は対象外である。direct ABIとmemory safetyは既存の専用corpusが引き続き責任を持つ。
