# Staged Semantic TypeScript: 現状とロードマップ

最終更新: 2026-07-20

## この文書の目的

この文書は、長期化した検証セッションを切り替えても作業を再開できるように、次を一か所へまとめる。

- 原案のどこまで実装・検証できたか
- 現在どの仮説を評価中か
- 何が未実装・未証明か
- 次に何をどの順序で行うか
- 次のセッションで最初に実行すべき操作

コンセプトそのものの定義は[`concept.md`](./concept.md)、CLIと実装の利用方法は[`README.md`](./README.md)を正とする。この文書は進捗と投資判断のための索引である。

## 結論

現在地は、原案の「Semantic Generation」のうち、**自然言語Conceptを型付きBoolean Predicate IRへ変換し、決定的なTypeScriptとして検証・承認・固定するMVP**を実装した段階である。

基本経路は成立している。

```text
Concept + TypeScript Type
        ↓ OpenAI / Azure OpenAI（コンパイル時のみ）
制限されたPredicate IR
        ↓ Context validation / typecheck / semantic test
決定的なTypeScript候補
        ↓ Human approval
semantic.lock + generated TypeScript
        ↓
LLMを含まない通常ランタイム
```

Predicateトラックでは、次の問いに答えるための信頼性検証を進めている。

> 未知のConceptと未知のSchema Evolutionに対し、3サンプル・型付き2/3コンセンサスが、誤解決を増やさず単発LLMより高い再現性を示すか。

このためのSchema Evolution v2は実装済みだが、評価設計上の局所Blockerにより人間承認とlive実行を保留している。並行する原案MVPトラックでは、Static Judgmentの最小縦切りをfixtureで実装・検証した。

## コンセプトとの対応状況

| 原案の領域 | 状態 | 現在の実装・評価 |
| --- | --- | --- |
| Exact Code | 対応済み | 通常のTypeScriptを維持し、生成対象と手書きコードを分離している |
| Ontology Definition | Predicate用途で対応済み | `defineConcept`、共有Concept、型への`bindConcept`を実装 |
| Static Judgment | 最小縦切りを実装 | literalな`staticValue`、`judgeStatic`、boolean定数化、段階検査、audit、lock/replay、rollbackをfixtureで検証。live精度は未評価 |
| Semantic Generation | Predicate限定で対応済み | `generatePredicate`からBoolean Predicate IRとTypeScriptを生成 |
| Static / Generated / Runtimeの段階分離 | 一部対応 | LLMはbuild/check時だけ使用し、生成物にLLM呼び出しを残さない。Static Judgmentではliteral以外をresolver前に拒否。一般的なデータフロー段階解析は未実装 |
| Semantic Closure | 単一Predicate単位で対応 | unresolved時の停止、IR検証、型検査、テスト、人間承認を実装。依存グラフ全体のClosure判定は未実装 |
| Semantic IR | Boolean Predicate IRを実装 | `all`、`any`、`not`、`equals`、`present`に限定。自由なTypeScript生成は禁止 |
| Semantic / Boundary / Exact Zone | 一部対応 | 生成候補、承認境界、手書きコードを分離。Port/Capability生成は未実装 |
| Semantic Polymorphism | 実装・検証済み | 同一Conceptを異なるTypeScriptスキーマへ具体化できる |
| Semantic Test | 基本形を実装 | `accept`と`reject`を実装。unknown、boundary、counterfactual、invariance、mutationは未実装 |
| Semantic Lockfile | 実装済み | Predicate IRとStatic Judgment booleanを別namespaceで固定し、APIなしのreplayに対応 |
| Explainability | 一部対応 | interpreted judgement、pretty JSON、監査ログ、semantic diffを実装。独立した`semantic explain`は未実装 |
| Schema Evolution | 実装・評価中 | check/diff/approveトランザクション、型付き同値判定、ライブコンセンサスを実装 |
| OpenAI Adapter | 実装済み | OpenAI Responses APIとAzure OpenAIに対応。既定モデルは`gpt-5.4-mini` |

## 原案の成功仮説に対する現在の評価

| 仮説 | 評価 | 根拠または不足 |
| --- | --- | --- |
| 仮説1: 意味的判断を定数へ固定 | 機構をfixtureで支持 | true/false契約、決定的boolean生成、lock、APIなしreplay、rollbackを実装。判断精度は未評価 |
| 仮説2: Conceptから制限Predicate IRを生成 | 支持 | 複数Concept・複数Schemaで実行済み |
| 仮説3: 型検査とテストで生成Predicateを検証 | 強く支持 | Candidate専用型検査・意味テスト・全回帰・rollbackを実装 |
| 仮説4: Lockfileで再現可能ビルド | 支持 | APIなしreplayと生成コードhash検証を実装 |
| 仮説5: 手書きif文より保守しやすい | 未証明 | 人間の実装時間・修正時間・保守時間の十分な比較がない |
| 仮説6: 同一Conceptを異なるSchemaへ具体化 | 強く支持 | Cross-schema v1で27/27試行成功 |
| 仮説7: Semantic Diffがレビュー負荷を下げる | 一部支持 | diffは実装済みだが、人間のレビュー時間比較が未計測 |

## 実装済みの主要機能

### コンパイラと生成

- TypeScript Compiler APIによるSemantic Sourceの抽出
- ローカル型、共有Concept、bindingの解析
- ネスト3段、配列、primitive、literal union、null、undefinedのType Schema化
- JSON Predicate IRの厳格なparseとcontext validation
- 検証済みIRからの決定的TypeScript生成
- Candidate型検査、Candidate意味テスト、全回帰テスト
- 原子的な昇格と失敗時rollback
- literalなStatic値とConceptからのboolean Static Judgment
- runtime/dynamic値をresolver前に拒否するStatic段階検査
- Static Judgmentの決定的定数生成、audit、lock、APIなしreplay

### 再現性と監査

- `semantic.lock`
- build / replay / test / check / diff / approve
- 入力、モデル応答、IR、生成候補、diff、テスト結果のpretty JSON保存
- Source、Concept、Type、Test、Prompt、生成コードのSHA-256検証
- 生成コードとlockを変更しない読み取り専用Benchmark

### LLM信頼性

- OpenAI APIとAzure OpenAIの同一設定経路
- `gpt-5.4-mini`への統一
- 曖昧Schemaで推測せず`unresolved`を返す契約
- required nullable型に限定したPredicate IRの意味的同値判定
- 3応答を並列取得するライブ2/3コンセンサス
- 2票が揃わない場合に候補を確定しないfail-closed動作
- Oracleとhidden testを候補選択に使用しないblind評価

## 現在までの実測結果

| 評価 | 結果 | 解釈 |
| --- | --- | --- |
| Blind Cross-schema v1 | 27/27試行成功、false resolution 0 | 異なるスキーマへのSemantic Polymorphismを支持 |
| Blind Schema Evolution v1単発 | 50/54試行成功、stable 15/18ケース、false resolution 0 | 精度は高いが、単発応答の揺れが製品経路には残る |
| v1保存応答の型付きConsensus replay | 18/18ケース成功、quorum 18/18、false resolution 0 | 2/3方式の有望性を支持。ただし同じ54応答を使った事後評価 |
| 全ローカル回帰 | 60 tests pass、0 fail | PredicateとStatic Judgmentのfixture経路を含めて回帰なし |

重要な留保として、Consensus replayの18/18はheld-out結果ではない。保存済みv1応答へ後から方式を適用した結果であり、一般化性能の証明には使用しない。

## 現在対応中のマイルストーン

### Schema Evolution v2: held-out live consensus benchmark

v2はv1の結果を見てConceptを書き換える評価ではなく、新規入力に対する再現性を測るための評価である。

- 新規Concept: 4種類
  - Actionable Ticket
  - Payable Invoice
  - Deployable Release
  - Enrollable Course
- Schema変更: 6種類 × 4 Concept = 24ケース
- 反復: 3応答／ケース、合計72 API呼び出し
- 解決可能: 16ケース
- unresolved期待: 8ケース
- 対象: rename、representation、optionality、add-property、remove-role、ambiguity
- 型要素: nested object、array、union、nullable、optional、boolean representation

単発方式と型付き2/3コンセンサスを同じ応答群で比較する。

### 合格基準

| 指標 | 基準 |
| --- | ---: |
| Consensus case pass rate | 95%以上 |
| Consensus quorum rate | 90%以上 |
| Consensus false resolution | 0 |
| Workspace mutation | 0 |

### 現在の停止位置

実装とfixture検証は完了している。入力はdraftとして凍結され、API実行前ガードが有効である。ただし、モデル出力取得前の事前確認でConcept、Oracle、fixture境界の対応に局所Blockerが見つかったため、v2の人間承認とlive実行は保留している。

- Blocker記録: [`benchmarks/schema-evolution-v2/BLOCKER.md`](./benchmarks/schema-evolution-v2/BLOCKER.md)
- Review手順: [`benchmarks/schema-evolution-v2/REVIEW.md`](./benchmarks/schema-evolution-v2/REVIEW.md)
- 凍結入力: [`benchmarks/schema-evolution-v2/benchmark.json`](./benchmarks/schema-evolution-v2/benchmark.json)
- Review metadata: [`benchmarks/schema-evolution-v2/freeze.json`](./benchmarks/schema-evolution-v2/freeze.json)
- 凍結SHA-256: `1062aec2076994b6a74df1d5b8acb294d82d85be7cf7cf74be5be767071a3aa0`

Blocker解消と独立レビューの前にAPIを実行してはならない。既存v2の`benchmark.json`、期待条件、positive/negative値を変更して、同じv2を新規held-out evidenceとして再利用してはならない。

このBlockerは、v2 live評価、Consensusの信頼性主張、Predicateの実プロジェクトPilotを停止する。Static Judgment、Semantic Test拡張、`semantic explain`、Semantic Closureの検証は停止しない。

Static Judgmentの最小縦切りはfixtureで実装・検証済みである。実装範囲、検証結果、残る非目標は[`STATIC_JUDGMENT_IMPLEMENTATION_PLAN.md`](./STATIC_JUDGMENT_IMPLEMENTATION_PLAN.md)を正とする。

次の実装対象は`semantic explain`とする。PredicateとStatic JudgmentをAPIなし・読み取り専用で説明する範囲、statusモデル、回帰条件は[`SEMANTIC_EXPLAIN_IMPLEMENTATION_PLAN.md`](./SEMANTIC_EXPLAIN_IMPLEMENTATION_PLAN.md)を正とする。

## v2対応を後日再開するときに行うこと

### 1. 人間によるv2入力レビュー

[`REVIEW.md`](./benchmarks/schema-evolution-v2/REVIEW.md)に従い、モデル出力を見ずに次を確認する。

- 4つのConceptが意図した業務概念を表すか
- resolved 16ケースの3条件が妥当か
- remove-roleとambiguityの8ケースをunresolvedとする期待が妥当か
- positive/negative値がPredicateの境界を正しく表すか
- v1のConceptやSchemaを実質的に再利用していないか

承認する場合は、`freeze.json`の次の4項目だけを更新する。

```json
"status": "human-reviewed",
"humanReviewed": true,
"reviewer": "reviewer identifier",
"reviewedAt": "ISO-8601 timestamp"
```

### 2. v2を実Azure OpenAIで実行

```bash
bun run benchmark:schema-evolution:v2
```

成功・失敗にかかわらず、生応答とレポートを保存する。APIエラー以外の結果を理由に同じv2入力を調整し、再実行結果を新しいblind evidenceとして扱ってはならない。

### 3. 結果を判定

#### 合格した場合

- Predicate限定MVPを「実プロジェクト試験導入可能」と評価する
- 実プロジェクトの5〜10 Predicateでpilotを行う
- 手書き実装時間、Semantic Diffレビュー時間、API費用、総待ち時間を測る
- 自動承認は導入せず、`check → diff → human approve`を維持する

#### 合格基準を下回った場合

- v2入力を修正せず、失敗を次に分類する
  - Concept解釈の誤り
  - Schema role mappingの誤り
  - `unresolved`判断の誤り
  - IR表現力不足
  - 型付き同値判定不足
  - Quorum不成立
  - APIまたはAdapter障害
- 改善は実装・Prompt・IRへ行う
- 改善後は、v2を成功証拠として再利用せず、新規held-out v3を作る

#### False resolutionが1件でも出た場合

- 自動生成範囲を拡張しない
- 自動承認を禁止したままにする
- fail-closed条件と曖昧性検出を再設計する

## 推奨ロードマップ

### Gate 0: v2の独立レビューとlive実行 — Predicateトラックで保留中

目的は、型付きConsensusが未知入力でも再現するか確認すること。現在は[`BLOCKER.md`](./benchmarks/schema-evolution-v2/BLOCKER.md)に記録した評価設計上の問題により保留している。このGateはPredicateのlive評価、信頼性主張、Pilot移行を停止するが、原案の独立した未検証領域であるStatic Judgment、Semantic Test拡張、`semantic explain`、Semantic Closureの検証は停止しない。

完了条件:

- review metadataが記録されている
- 72応答の生ログと比較レポートが保存されている
- 合否と失敗分類が記録されている

### Gate 1: 実プロジェクトPilot

実際のコードベースで、Predicate生成が手書き実装より有用か測る。

対象:

- 5〜10個のpure boolean Predicate
- 副作用、認可、金額計算を含まない
- 手書き実装と期待テストを先に保存する

測定:

- 初回生成成功率
- `unresolved`率とfalse resolution
- API tokens、料金、wall-clock latency
- 手書き実装時間
- Concept作成時間
- Semantic Diffレビュー時間
- Schema変更時の修正時間

進行条件:

- false resolution 0
- 人間レビューを含む総作業時間に改善がある
- 生成物とlockの再現性が維持される

### Gate 2: 原案MVPの未実装部分を完成

Static Judgmentの最小縦切りは完了した。残る優先順位は次のとおり。

1. `semantic explain`
   - Concept、Schema role、IR条件、型付きrewrite、lock entryを一つの説明へ関連付ける
2. Semantic Closure graph
   - 複数Semantic nodeの依存関係
   - unresolved node、未承認node、stale nodeの一括検出
3. Semantic Testの拡張
   - unknown / boundary / counterfactual / invariance
   - mutation testとmodel migration test

Gate 2でも任意TypeScript生成や副作用生成は行わない。

### Gate 3: 生成対象の拡張

Predicateで得た安全境界を維持しながら、対象ごとに独立した制限IRを設計する。

候補順:

1. `generateValidation`
2. `generateMapping`
3. `generateType`
4. Port / Capability declaration

各生成対象は、PredicateのIRへ無理に追加せず、専用IR、専用Validator、専用hidden benchmarkを持たせる。

### Gate 4: 開発者体験と運用

- Language Server
- IDE上のSemantic Diff
- Concept参照追跡
- Semantic Debugger
- CI用non-interactive check
- Model migration report
- ContextStill / NightWorkersとの検証ループ

### Gate 5: 他言語・モデル

- TypeScript以外のBackend
- Local LLM
- Ontology library / Semantic package registry

この段階は、Predicate MVPとGate 1の費用対効果が確認できるまで着手しない。

## 維持すべき設計判断

- LLMはコンパイル時だけ使用し、runtimeへ持ち込まない
- LLMから自由なTypeScriptを受け取らず、制限IRを介する
- hidden testやOracleをモデル入力またはConsensus選択へ渡さない
- 曖昧な入力は推測せず`unresolved`にする
- `compatible`判定でも自動承認しない
- 生成コードと`semantic.lock`の変更は、型検査・テスト・人間承認後だけ行う
- 保存済みBenchmark入力を結果に合わせて書き換えない
- 同じBenchmarkの再実行を新しいheld-out evidenceとして数えない
- Exact Code、特に副作用・認可・金額・トランザクションを生成対象にしない

## 現時点で意図的に行わないこと

- 任意関数または任意TypeScriptの生成
- 自動承認、自動merge
- Runtime LLM Judgment
- DB、network、transaction、lock、secretアクセスの生成
- 独自VM、独自GC、独自ランタイム
- v2結果を見る前の追加チューニング

## 主要ファイル

| 用途 | ファイル |
| --- | --- |
| コンセプト原案 | [`concept.md`](./concept.md) |
| 利用方法 | [`README.md`](./README.md) |
| DSL | [`src/dsl.ts`](./src/dsl.ts) |
| Source scanner | [`src/semantic-source.ts`](./src/semantic-source.ts) |
| Predicate IR | [`src/ir.ts`](./src/ir.ts) |
| Type context validation | [`src/context-validator.ts`](./src/context-validator.ts) |
| Deterministic generator | [`src/generator.ts`](./src/generator.ts) |
| Compiler transaction | [`src/semantic-compiler.ts`](./src/semantic-compiler.ts) |
| Schema Evolution | [`src/semantic-evolution.ts`](./src/semantic-evolution.ts) |
| Semantic Diff | [`src/semantic-diff.ts`](./src/semantic-diff.ts) |
| Type-aware equivalence | [`src/predicate-equivalence.ts`](./src/predicate-equivalence.ts) |
| Live consensus | [`src/semantic-consensus.ts`](./src/semantic-consensus.ts) |
| Schema Evolution v2 runner | [`src/schema-evolution-v2.ts`](./src/schema-evolution-v2.ts) |
| OpenAI / Azure adapter | [`src/openai.ts`](./src/openai.ts) |
| Static Judgment実装計画 | [`STATIC_JUDGMENT_IMPLEMENTATION_PLAN.md`](./STATIC_JUDGMENT_IMPLEMENTATION_PLAN.md) |
| Semantic Explain実装計画 | [`SEMANTIC_EXPLAIN_IMPLEMENTATION_PLAN.md`](./SEMANTIC_EXPLAIN_IMPLEMENTATION_PLAN.md) |
| Static Judgment scanner | [`src/static-judgment-source.ts`](./src/static-judgment-source.ts) |
| Static Judgment compiler | [`src/static-judgment-compiler.ts`](./src/static-judgment-compiler.ts) |

## 再開時の確認コマンド

```bash
# 実装の回帰確認
bun run typecheck
bun test

# Static Judgmentのfixture buildとAPIなしreplay
bun run semantic:judgment:fixture
bun run semantic:judgment:replay

# v2 review状態の確認
sed -n '1,80p' benchmarks/schema-evolution-v2/freeze.json

# 人間承認後だけ実行
bun run benchmark:schema-evolution:v2
```

型検査と全テストは、2026-07-20時点で`60 pass / 0 fail`である。Static Judgmentのfixture build/replayは同一生成hashで成功する。最後のv2コマンドは現在、局所Blockerと独立レビュー未完了のためAPIを呼ぶ前に停止する。

## 次回この文書を更新するタイミング

- v2 human review完了時
- v2 live benchmark完了時
- Gate 1 pilotの対象決定時
- 原案MVPの未実装領域へ着手するとき
- 合否基準または安全境界を変更するとき

更新時は、成功結果だけでなく、失敗、未解決、API障害、false resolution、評価上の留保も残す。
