# L-Lang 0.1 Alpha 残作業計画

> 適用範囲（2026-09-17整理）：Semantic TypeScriptの研究・製品化計画です。未完了Gateは残りますが、全経路の現在の実装状況やJSONCの廃止・移行方針を定める文書ではありません。現在地は[ロードマップ](./PROJECT_STATUS_AND_ROADMAP.md)、実行方法は[TypeScriptガイド](./docs/guides/semantic-typescript.md)、文書分類は[一覧](./docs/README.md)を参照してください。本文の将来のpackage・CLI・CI構成は提供済み仕様ではありません。

作成日: 2026-07-22
最終更新: 2026-07-25
状態: M1〜M4完了、M5評価基盤実装済み・dataset/live未完了、M6未完了

## 1. この文書の役割

本書は0.1 Alphaまでに残る実装とrelease Gateだけを管理する。完了済みM1〜M4の設計・手順は削除し、実装済み仕様はコード、テスト、[TypeScript利用ガイド](./docs/guides/semantic-typescript.md)、[`PROJECT_STATUS_AND_ROADMAP.md`](./PROJECT_STATUS_AND_ROADMAP.md)を正とする。

現在の基準:

- `semantic build`の機械検証後自動昇格
- 互換用`--review` staging
- crash-safe transaction、workspace lock、recovery
- Project Fit-aware Closure
- boundary、counterfactual、invarianceとread-only `semantic test`
- Closure、決定的再生成、Semantic Test、typecheckを統合した`semantic verify`
- 238 pass / 0 fail
- functions coverage 93.40%、lines coverage 93.07%

## 2. 残る順序

```text
Gate 1: measured developer A/B
        │
        ├── M5 Static Judgment blind benchmark
        │
        ▼
Gate 2再判定
        │
        ▼
M6 package / CLI / CI
        │
        ▼
0.1 Alpha
```

M5のfixture、freeze guard、read-only reportはA/Bと並行実装できる。外部公開を前提とするM6と0.1 Alpha判定は、Private Pilotの価値Gate合格後に行う。

## 3. Milestone 5: Static Judgment blind benchmark

### 3.1 目的

Static Judgmentがfixtureで動くことと、意味判断が実用的に正しいことを分離して測定する。false resolutionと`unresolved`を、結果観測前に固定した独立入力で評価する。

### 3.2 評価セット

- 48 caseを目安にpositive / negative / ambiguousを均衡させる
- 4〜6 Conceptを含める
- 表現差、境界、否定、欠落情報、多言語paraphraseを含める
- expected labelと理由をmodel入力から隔離する
- dataset、Oracle、freeze metadataをSHA-256で固定する
- `frozen`になる前はlive実行できない
- 観測済みfixtureやSchema Evolution入力を新しいblind evidenceとして再利用しない

### 3.3 指標

- resolved accuracy
- false resolution
- unresolved precision / recall
- 同一入力3回の安定性
- token、費用、latency
- model migration時のjudgment変化率
- workspace mutation、context contamination、integrity incident

Alphaで精度を主張する最低条件はfalse resolution 0とする。数値閾値はheld-out結果を見る前に固定する。

### 3.4 実装単位

完了:

1. strictなbenchmark manifest / Oracle / fixture / freeze schema
2. frozen inputの完全被覆とSHA-256検証
3. Oracleをmodel requestから隔離するread-only fixture runner
4. false resolution、unexpected unresolved、resolved accuracy、stability report
5. fixture replay、tamper、draft、symbolic link、false resolutionのtest

未完了:

1. 48 caseの独立datasetと事前閾値
2. live runnerのcall、token、retry、cooldown budget
3. raw response、case result、aggregate reportの分離保存

### 3.5 完了条件

- fixture replayが決定的でworkspace mutation 0
- freeze前のlive実行をテストで拒否する
- model-visible inputにOracle、expected、hidden理由が含まれない
- 成功、`unresolved`、API error、budget超過をすべてreportする
- false resolutionが一件でもあれば精度主張を停止し、原因と再評価条件を残す

## 4. Milestone 6: Package / CLI / CI

### 4.1 Package

- versionを`0.1.0-alpha.1`へ更新する
- npm package名とscopeを確定する
- `private: false`、`bin`、`exports`、`types`、`files`を明示する
- ESM JavaScriptとdeclarationを`dist/`へbuildする
- runtime dependencyとdev dependencyを分離する
- tarballへ`.env`、生API response、`.semantic/`、benchmark Oracleを含めない
- `npm pack --dry-run`とtemporary directoryへのclean-install smoke testを追加する

### 4.2 CLI contract

- `semantic --help`、`semantic --version`、subcommand help
- unknown command / optionのstable diagnosticとexit code
- workspace root基準でcwdに依存しないpath解決
- JSON modeではstdoutを単一のversioned JSONだけにする
- logとdiagnosticはstderrへ分離する
- secret、生prompt、生responseを既定出力へ含めない
- operational errorを検査失敗のexit code `2`と混同しない

### 4.3 CI

- LinuxとmacOS
- lockfile固定install
- format、lint、typecheck、unit / integration test、coverage
- fixture replay、Closure、`semantic verify`
- package contents snapshot、clean-install smoke test
- 通常CIのmodel API call 0
- live評価は明示的な別workflowへ隔離する

### 4.4 Documentation

- installから`build → replay → verify`までをclean projectで再現する
- 任意の`build --review → diff → approve`を互換機能として分離する
- Alphaの保証範囲、非保証範囲、data boundaryを日英READMEへ記載する
- package、CLI JSON、lockのmigration policyを記載する
- troubleshootingとsupport範囲を提供する

### 4.5 完了条件

- tarballを空のsample projectへinstallしてREADME最小経路が成功する
- Linux / macOSで同じfixtureから同じartifact hashを生成する
- package内容とCLI JSON contractのsnapshot testが成功する
- `semantic verify`がAPIなし・read-onlyでrelease条件を検査する
- 既知の制限とrelease checklistが同期されている

## 5. 0.1 Alpha Gate

次をすべて満たすまで公開Alphaと判定しない。

- measured developer A/Bでfalse resolution 0
- median total-task-timeが手書きより20%以上短い
- M5のblind evidenceと制限が記録されている
- package clean-install、Linux / macOS CI、offline verifyが成功する
- unbounded API call、token、retry、outputがない
- lock corruption、lost update、workspace mutation、secret混入がない
- READMEの既定経路を新規workspaceで再現できる

Gate未達の場合は研究MVPとして継続し、package公開や適用範囲拡大を先行させない。

## 6. 非目標

- 自由なTypeScript生成
- runtime LLM判断
- 認可、金額、暗号、transaction、副作用生成
- Predicate以外の新IRをAlpha条件へ追加すること
- hidden Oracleを候補選択やpromptへ使うこと
- model精度を一回のfixture成功だけで主張すること

## 7. 直近の実装順

1. M5 manifest / Oracle / freeze contract
2. M5 read-only fixture runnerとreport
3. M5 live budget / checkpoint基盤
4. measured developer A/Bの結果判定
5. Gate合格後にM6 package / CLI / CI
