# Semantic TypeScriptの状態・評価記録（2026-08-08）

[現在のロードマップ](../../PROJECT_STATUS_AND_ROADMAP.md) · [文書一覧](../README.md)

以前のロードマップに含まれていたSemantic TypeScriptの実装状況・評価・未完了Gateを保存した記録です。本文の「現在」「推奨」「Active」は記録時点を指します。現在のJSONC・Hybridの状態や最新CI結果とは別に扱ってください。

## Semantic TypeScriptの詳細と評価記録

以下のConcept・Project Fit・Pilot・公開Gateは主にSemantic TypeScript経路の記録です。JSONCやHybridの対応範囲と混同しないでください。

### 位置付け

L-Langは、コンセプト全体を実装した汎用言語ではない。現在は、中心価値である「抽象的なIntentをProject固有の型と検証済み履歴へ適合させ、決定的なTypeScriptへ変換する」ための、**Boolean Predicate中心の実行可能な研究MVP**である。

MVPの技術縦断は成立している。

```text
Concept + TypeScript type + bounded Project Context
        ↓ build時だけLLMを使用
restricted Boolean Predicate IR
        ↓ strict parse / context validation / typecheck / tests
deterministic TypeScript
        ↓ atomic promotion
semantic.lock + generated artifact
        ↓
APIを使わないreplay / explain / closure
```

Project Fitのlive A/BとERP CRUDの技術Pilotは合格した。ただし、実開発者が手書き実装より快適かつ速く作業できるという製品価値はまだ実測していない。Public Alphaへ進む前の最大の未証明点は精度ではなく、開発者体験と総作業時間である。

## コンセプトとの対応状況

| コンセプト領域 | 状態 | 実装済み | 主な未実装・未証明 |
| --- | --- | --- | --- |
| Exact Code | 対応済み | 通常のTypeScriptを維持し、生成対象から副作用・金額・認証などを除外 | 生成PortとExact実装を自動接続する仕組み |
| Ontology Definition | Predicate用途で実装済み | `concept`、`defineConcept`、`bindConcept`、固定セクション構文、用途別検証 | Concept間関係、Package化、状態遷移Ontology |
| Static Judgment | 最小縦断と評価基盤を実装済み | literal文字列、boolean定数化、段階検査、lock、replay、explain、rollback、blind benchmarkのstrict manifest / Oracle分離 / freeze / read-only fixture harness | 48 caseの独立dataset、live精度評価、複数値・boolean以外の結果、一般的な段階解析 |
| Semantic Generation | Predicate限定で実装済み | `generatePredicate`から制限IRとpure boolean関数を生成 | `generateType`、任意関数、Mapping、Validation、Port、状態遷移 |
| Static / Generated / Runtime | 一部実装 | LLMをbuild時へ限定し、Static Judgmentへのdynamic入力を事前拒否 | Project全体のデータフローを扱う一般的なstage checker |
| Semantic IR | PredicateとTest Obligationを実装 | `all`、`any`、`not`、`equals`、`present`、契約trace付きTest IR | Type / Mapping / Validation / Port IR |
| Semantic Closure | Project Fit-awareで実装済み | 明示manifest、Context・検証provenance、依存graph、verification-required / dependency-open | import graph自動探索 |
| Semantic Polymorphism | 実装・評価済み | 同一Conceptを異なるSchemaへ具体化 | Predicate以外での実証 |
| Semantic Test | 拡張形を実装済み | 非空の`accept` / `reject`、boundary、counterfactual、invariance、read-only runner | property generator / shrinker |
| Semantic TDD | Predicate POC実装済み | Contract trace、Test IR、実装前Red、Mutation、Test Plan自動freeze、Selection Report、read-only検証 | Best-of-N、property generator / shrinker、独立した外部評価、他IRへの展開 |
| Project Context | 限定実装済み | 到達可能な型宣言、同一Conceptの整合性検証済み履歴、compiler flagsをboundedかつsecret-freeに収集 | Projectの通常テスト、規約、隣接実装からの安全な文脈抽出、自動修正loop |
| Lock / Replay | 実装済み | 入力fingerprint、生成IR、artifact hash、promotion provenance、APIなし再生成 | lock migration policyと長期互換性の運用実績 |
| Explainability | 実装済み | Predicate / Static Judgmentのcurrent、stale、unlocked、integrity-errorをread-onlyで説明 | Project全体の意味差分と影響範囲 |
| Schema Evolution | engine実装済み・評価継続 | check / diff / approve、型付き同値、2/3 consensus、Pilot live評価 | authoritative held-out benchmarkの設計Blocker解消と独立再評価 |
| OpenAI Adapter | 実装済み | OpenAI Responses API、Azure OpenAI、structured output、resource limits | provider matrixと長期的なmodel migration評価 |
| 開発者向け製品体験 | 一部実装 | CLI、`semantic verify`、fixture、audit、benchmark、Pilot harness | 設定簡素化、診断改善、package配布、実開発者によるUX評価、LSP |

## 現在の実測

### Repository品質

品質Gateの定義と実測値の記録方法は[`QUALITY_GATES.md`](../../QUALITY_GATES.md)を正とする。変動するテスト件数とcoverage値は各CI runで生成し、この文書へ複製しない。

| 検証 | 結果 |
| --- | --- |
| `bun run typecheck` | 成功 |
| `bun test` | 全test成功を要求 |
| `bun run ci:protected` | Schema Evolution freeze manifestと記録済みhashの一致を要求 |
| `bun run coverage` | repository 90% / transaction 95%のfunctions・lines閾値を要求 |

### Semantic Polymorphism

- Blind Cross-schema: 27/27 trial成功
- opaque schemaは推測せず`unresolved`
- false resolution: 0

### Project Fit v2 live A/B

凍結済み6 caseを、type-onlyとbounded Project Contextで比較した。

| Stage | type-only | Project Context |
| --- | ---: | ---: |
| 初回生成 first-pass fit | 0/18 | 18/18 |
| Schema変更 first-pass fit | 1/18 | 18/18 |

- 両stageともGate通過
- false resolution、workspace mutation、context contamination、integrity incident: 0
- 推定費用: $0.07683525
- 生response、report、artifact hashは[`benchmarks/project-fit-v2/evidence`](../../benchmarks/project-fit-v2/evidence/README.md)に保存

この結果は、現在の限定されたPredicate領域ではProject Contextが型情報だけより明確に有効だったことを示す。任意の実装や未知の実Project全体へ一般化できる証明ではない。

### ERP CRUD Private Pilot

合成したERP風のshadow-only protocolで、初回生成とSchema Evolutionを実行した。

| 指標 | 結果 |
| --- | ---: |
| 初回生成 | 8/8 first-pass |
| Schema Evolution | 8/8 quorum |
| hidden case | 41/41 |
| API attempt / cooldown | 32/32 |
| false resolution / business write / external I/O | 0 / 0 / 0 |
| 推定費用 | $0.032007 |

技術・安全Gateは合格した。証跡は[`pilots/erp-crud-v1/evidence/go-no-go.md`](../../pilots/erp-crud-v1/evidence/go-no-go.md)に保存している。

ただし、参加者とdomain ownerは合成設定であり、手書きbaselineとL-Langの作業時間を測っていない。したがって、これは外部のERP妥当性やVibe codingの生産性を証明する結果ではない。

## 現在の未完了Gate

### 1. 開発者価値の実測

同じ8 taskを手書きとL-Langで実施し、次を測る。

- Concept記述からProject回帰通過までの総時間
- 初回適合率
- 追加指示量と修正回数
- Schema変更時の追従時間
- `unresolved`とfalse resolution
- API費用、latency、失敗からの復帰

これは人間による承認を製品Gateにするためではない。L-Langの中心価値である「抽象的な指示でも快適にProjectへ適合する」を実利用で検証するために行う。

合格基準は、false resolution 0を維持しつつ、median total-task-timeが手書きより20%以上短いこととする。詳細は[`PRIVATE_PILOT_IMPLEMENTATION_PLAN.md`](../../PRIVATE_PILOT_IMPLEMENTATION_PLAN.md)を正とする。

### 2. Project単位の一コマンド検証 — 完了

M2〜M4は2026-07-25に完了した。

- Closureはverified Project Contextとpromotion時の機械検証provenanceを必須化
- `verification-required`と`dependency-open`を実装
- source DSLへboundary / counterfactual / invarianceを追加
- `semantic test`をAPIなし・read-onlyの独立commandとして実装
- `semantic verify <manifest>`でClosure、決定的再生成、Semantic Test、typecheckを統合
- root manifestは4/4 Project Fit verified、4/4決定的再生成、3/3 Predicate testでpass

人間Reviewの有無はClosureやverifyの合格条件ではない。既存のreview candidate経路は互換用stagingに留める。

### 3. Static Judgment blind benchmark

strictなmanifest、model input、Oracle、fixture、freeze契約とread-only runnerは実装済みである。draft、hash変更、symbolic linkをfail-closedで拒否し、false resolution、unexpected unresolved、resolved accuracy、3回の安定性を集計する。Oracleとexpected理由はmodel requestへ含めない。fixture runnerは`profile`に関係なく`evidenceEligible: false`を返し、harness検証をmodel精度の証拠と誤認させない。

残る作業は、結果観測前に48 caseの独立datasetと閾値を固定し、budget付きlive runnerで実測することである。harnessのfixture成功だけをStatic Judgment精度の根拠にはしない。

### 4. Schema Evolutionの独立held-out評価

authoritativeなSchema Evolution benchmarkには、ConceptとOracleの境界に設計上のBlockerがある。現入力を結果に合わせて修正して成功証拠として再利用せず、[`benchmarks/schema-evolution/BLOCKER.md`](../../benchmarks/schema-evolution/BLOCKER.md)の条件に従って新しい独立入力を設計・freezeする。

このGateはSchema Evolutionの一般的な信頼性主張を止めるが、初回Predicate生成とProject Fitの実測を止めない。

### 5. Project Contextの拡張

実開発者A/Bで追加指示や失敗の原因を分類してから、必要な文脈だけを増やす。優先候補は次のとおり。

- Project内の関連する型付きテスト
- package / tsconfig / lint規約
- 検証済みの隣接Predicateと過去の修正履歴
- 失敗した回帰の要約

raw source全体、secret、hidden oracle、任意のclass実装を無制限にモデルへ渡してはならない。Contextはbounded、deterministic、secret-free、hashableを維持する。

### 6. 専用IRの拡張

Predicateの価値Gateを通過した後だけ、Validation IR、Mapping IR、状態遷移IRの順で小さな縦断を追加する。自由なTypeScript生成や副作用生成には進まない。

## 推奨する着手順

live API費用、人間参加者、独立datasetを必要とする評価は、[`RESEARCH_EVALUATION_PREREQUISITES.md`](../../RESEARCH_EVALUATION_PREREQUISITES.md)の事前条件と別途の明示承認を満たしてから開始する。

1. 実開発者によるmeasured A/Bを実行し、追加指示と失敗原因を採取
2. Static Judgmentの48 case独立datasetを設計・freezeしてlive評価
3. A/Bの失敗分類に基づきProject Contextを拡張
4. Schema Evolutionの新しいheld-out入力を設計し、独立freeze後にlive評価
5. Private Pilotの価値Gateを通過した場合だけPublic Alpha製品化へ進む
6. Predicateで再現可能な価値を確認した後だけ専用IRを拡張

## Activeな計画書

完了済みの一時的な実装計画書は削除し、現在も判断や作業が残る文書だけを保持する。

| 文書 | 役割 |
| --- | --- |
| [`POST_MVP_IMPLEMENTATION_PLAN.md`](../../POST_MVP_IMPLEMENTATION_PLAN.md) | Gate全体の順序 |
| [`PRIVATE_PILOT_IMPLEMENTATION_PLAN.md`](../../PRIVATE_PILOT_IMPLEMENTATION_PLAN.md) | measured developer A/B |
| [`SEMANTIC_TDD_IMPLEMENTATION_PLAN.md`](../../SEMANTIC_TDD_IMPLEMENTATION_PLAN.md) | Predicate POC後に残るTDD評価と拡張 |
| [`RELEASE_0_1_ALPHA_IMPLEMENTATION_PLAN.md`](../../RELEASE_0_1_ALPHA_IMPLEMENTATION_PLAN.md) | 0.1 Alphaの残作業 |
| [`PUBLIC_ALPHA_PRODUCTIZATION_PLAN.md`](../../PUBLIC_ALPHA_PRODUCTIZATION_PLAN.md) | Pilot合格後の製品化 |
| [`STABLE_RELEASE_IMPLEMENTATION_PLAN.md`](../../STABLE_RELEASE_IMPLEMENTATION_PLAN.md) | Public Alpha後の安定化 |

コンセプトの正本は[`concept.md`](../../concept.md)、利用方法の正本は[`README.md`](../../README.md)と[`README.en.md`](../../README.en.md)、実装済み仕様の正本はコードとテスト、live評価の正本は各evidence directoryである。
