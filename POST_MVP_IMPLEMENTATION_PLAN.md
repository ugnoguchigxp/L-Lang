# L-Lang Post-MVP実装計画

作成日: 2026-07-23

状態: **Private Pilot Phase 7: measured developer A/B**

対象期間: Core Hardening完了からStable release判定まで

## 1. この文書の役割

本書は、研究MVP以降の実装順と段階移行条件を管理する索引である。個別の変更内容、テスト、完了条件は次の計画書を正とする。

| 順序 | 計画書 | 目的 | 着手条件 |
| ---: | --- | --- | --- |
| 1 | [Private Pilot実装・評価計画](./PRIVATE_PILOT_IMPLEMENTATION_PLAN.md) | 実開発者のA/Bで、作業時間、追加指示量、修正回数を測る | 実行中 |
| 2 | [Public Alpha製品化計画](./PUBLIC_ALPHA_PRODUCTIZATION_PLAN.md) | 外部利用者向けpackage、CLI、設定、CI、障害処理を提供する | Pilotの価値Gate合格 |
| 3 | [Stable Release実装計画](./STABLE_RELEASE_IMPLEMENTATION_PLAN.md) | 互換性、長期運用、性能、provenanceを安定契約にする | Public Alphaの運用証拠が揃う |

次段階の作業を先行実装しても、その段階の着手条件を満たしたことにはしない。

## 2. 既存計画書との関係

未完了の詳細計画だけを維持する。

- [`RELEASE_0_1_ALPHA_IMPLEMENTATION_PLAN.md`](./RELEASE_0_1_ALPHA_IMPLEMENTATION_PLAN.md)
- [`SEMANTIC_TDD_IMPLEMENTATION_PLAN.md`](./SEMANTIC_TDD_IMPLEMENTATION_PLAN.md)
- [`PRIVATE_PILOT_IMPLEMENTATION_PLAN.md`](./PRIVATE_PILOT_IMPLEMENTATION_PLAN.md)

優先順位は次のとおりとする。

1. 現在のコードとテストで確認できる挙動
2. 本書と、本書から参照する段階別計画
3. 現在も未実装で、段階別計画と競合しない既存詳細計画
4. 原案と履歴文書

既存Alpha計画のM1〜M4に含まれる自動昇格、互換用candidate staging、Project Fit-aware Closure、Semantic Test拡張、`semantic verify`は実装済みである。

## 3. 現在の基準点

2026-07-25時点:

- Bun 1.3.14
- TypeScript strict mode
- `bun run typecheck`: 成功
- `bun test`: 238 pass / 0 fail
- 1,220 expectations / 60 files
- line coverage: 93.07%
- function coverage: 93.40%
- root Semantic Closure: 4/4 nodeがProject Fit verifiedかつ`closed`
- Predicate / Static Judgmentのbuild、replay、互換用staging、explainを実装済み
- Project Fit-aware Closure、拡張Semantic Test、read-only `semantic verify`を実装済み
- Schema Evolutionは評価設計Blockerによりlive未実行

Core HardeningとAlpha M1〜M4は完了した。ただし、次の製品・評価Gateは未解消である。

- 実開発者による手書き実装とのmeasured A/Bを完了していない
- Project Contextは型、検証済み履歴、compiler flagsに限定される
- Semantic Testのproperty generator / shrinkerを実装していない
- Schema Evolutionの独立held-out評価を完了していない
- Static Judgmentのlive精度を独立検証していない
- package、CI、安定したmachine-readable CLI契約がない

## 4. 固定する設計原則

全段階で次を維持する。

1. LLMはbuild/check時だけ使用し、runtimeへ持ち込まない
2. LLMから自由なTypeScriptを受け取らない
3. 生成対象ごとに専用IR、parser、validator、generatorを持つ
4. model入力へSemantic Test、Oracle、hidden caseを渡さない
5. 曖昧な入力は推測せず`unresolved`にする
6. 通常buildは機械検証後に自動昇格できる
7. `--review`は互換用stagingに限定し、通常buildはProject Gate通過後に自動昇格する
8. 認可、金額、暗号、transaction、副作用を生成対象にしない
9. 凍結済み評価入力を結果に合わせて変更しない
10. 検証結果がない作業を完了扱いにしない

## 5. 段階間の依存関係

```text
現行 Research MVP
        │
        ▼
Gate 0: Core Hardening（完了）
  正しさ / crash consistency / strict input / CI
        │
        ▼
Gate 1: Private Pilot
  実案件での精度 / 費用 / 時間 / Project適合
        │
        ▼
Gate 2: Public Alpha
  package / stable CLI / config / migration / support
        │
        ▼
Gate 3: Stable
  互換性 / 長期運用 / performance / provenance
        │
        ▼
Gate 4: Scope Expansion
  Validation / Mapping / Collection IR / Type generation
```

Gateを飛ばして新しい生成対象へ進まない。

## 6. Gate判定

### Gate 0: Core Hardening — 完了

進行条件:

- Semantic Testがvacuous successにならない
- 競合buildを検出または直列化できる
- 疑似crash後にartifactとlockを回復できる
- CLIとIRがunknown inputをfail-closedで拒否する
- critical pathのfailure-injection testが成功する
- CIでtypecheck、test、coverage、format、lintを検証できる

中止条件:

- silent successが残る
- lock entryを失う並列実行が再現する
- transaction recoveryに未定義状態が残る
- malformed inputでuncaught crash、hang、過大なresource消費が起きる

### Gate 1: Private Pilot

進行条件:

- 2ドメイン、5〜10 Predicateで評価を完了
- escaped false resolution 0
- replay reproducibility 100%
- lock corruption 0
- 総作業時間またはSchema変更対応時間に測定可能な改善がある
- API費用とlatencyが事前budget内

中止条件:

- escaped false resolutionが1件以上
- 手書き実装より総作業時間が増え、改善余地を説明できない
- confidential dataの送信または監査ログへの不適切な保存
- Project Gateだけではfalse resolutionを防げず、改善しても価値が出ない

### Gate 2: Public Alpha

進行条件:

- clean installからREADME quick startを再現できる
- versioned package、CLI、config、lock readerを提供
- Linux / macOS CIが成功
- API error、timeout、rate limit、budget超過を安定errorへ分類
- `semantic verify`がAPIなし、read-onlyでrelease条件を検査
- Alpha利用規約とsupport範囲が明記されている

中止条件:

- upgradeで既存lockを読めない
- CLI errorやJSON schemaがreleaseごとに無秩序に変わる
- secretまたはsource dataの送信境界を説明できない
- unbounded API call、token、retryが残る

### Gate 3: Stable

進行条件:

- IR、Concept、lock、CLIの互換性policyを公開
- conformance suiteを複数provider/model adapterで通過
- 複数OSで同じ入力から同じ生成hashを得る
- crash-safe / parallel-safe transactionを継続運用で確認
- Alpha/Beta利用者のupgradeをmigration report付きで完了
- 性能と可用性のsupport targetを満たす

中止条件:

- model更新のたびに既存artifactを無条件で再解決する必要がある
- lock migrationが再現性を壊す
- provider固有差をIR contractで吸収できない
- 運用負荷またはAPI費用が継続利用に見合わない

## 7. 共通指標

全段階で同じ定義を使用する。

| 指標 | 定義 |
| --- | --- |
| Resolution rate | 全caseに対する`resolved`の割合 |
| False resolution | `resolved`だがOracle、hidden case、Project回帰で意味的に誤りと判定されたcase |
| Escaped false resolution | 自動昇格後に意味的誤りと判明したcase |
| Unresolved rate | fail-closedで候補を確定しなかった割合 |
| First-pass project fit | 最初のcandidateが追加指示なしで全Gateを通過した割合 |
| Replay reproducibility | 同じSemantic入力とlockから期待hashを再現できた割合 |
| Correction effort | 初回適合までの追加指示量、再生成回数、修正時間 |
| Total task time | Concept作成、生成、修正、検証を含む総時間 |
| API cost | caseまたはPredicate単位のtokenと費用 |
| Integrity incident | lock、生成物、auditの不整合またはlost update |

成功結果だけでなく、失敗、`unresolved`、API error、Gate失敗を保存する。

## 8. 計画書の更新規則

- 各計画の開始時に状態を`実装中`へ変更する
- 実装・検証が完了した項目はactiveな実装計画から削除し、残作業だけを維持する
- 完了結果、実行コマンド、commitはstatus / roadmapまたはrelease noteへ記録し、activeな実装手順へ残さない
- 仕様変更は、理由と影響するGateを追記してから実装する
- 中止条件に該当した場合は次段階へ進まず、原因と再開条件を記録する
- 計画更新時は、冒頭の状態、現在地、着手順から完了済みの記述を同時に除去する
- 完了時に未解決事項と次の着手点だけを残す
- 新しいheld-out評価は、モデル出力を見る前に入力・Oracle・hashを`frozen`へ固定する

## 9. 直近の着手順

1. [`PRIVATE_PILOT_IMPLEMENTATION_PLAN.md`](./PRIVATE_PILOT_IMPLEMENTATION_PLAN.md)のmeasured developer A/Bを実行
2. A/Bで得た失敗分類に基づきProject Contextを拡張
3. Schema Evolutionの独立held-out入力を再設計して評価
4. Pilotの価値Gate合格後だけPublic Alphaへ進む

現在地と完了済み成果は[`PROJECT_STATUS_AND_ROADMAP.md`](./PROJECT_STATUS_AND_ROADMAP.md)を正とする。

## 10. 全段階で行わないこと

- Schema Evolution Blockerを残したまま現在の評価を成功証拠として実行する
- 現在の評価入力を結果に合わせて修正し、同じProtocolをheld-outとして再利用する
- runtime LLMを追加する
- 任意TypeScript生成を追加する
- repositoryへの自動mergeを追加する
- Core Hardening中にLSP、他言語backend、独自runtimeへ着手する
- benchmark結果を改善するためにOracleやhidden caseをモデル入力へ渡す
