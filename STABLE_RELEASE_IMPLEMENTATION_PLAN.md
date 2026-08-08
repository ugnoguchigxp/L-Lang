# Stable Release実装計画

作成日: 2026-07-23

状態: **Public Alpha待ち・未着手**

Gate: 3

前提: [Public Alpha製品化計画](./PUBLIC_ALPHA_PRODUCTIZATION_PLAN.md)完了と運用証拠

## 1. 目的

Public Alphaで外部利用可能になったPredicate / Static Judgment compilerを、互換性、再現性、障害回復、性能、supportを継続保証できるStable releaseへ移行する。

Stableは「機能が多い状態」ではなく、次を予測可能に管理できる状態と定義する。

- 同じ入力とlockから同じartifactを再現できる
- upgradeとrollbackの結果を事前に説明できる
- provider / model変更の影響をreportできる
- crash、並列build、部分障害から回復できる
- CLI / config / lock / IRの互換性をSemVerで扱える
- performanceとAPI費用がsupport target内
- unsupported useを明確に拒否できる

## 2. 着手条件

Public Alpha release後、最低限次の証拠を集める。

- 3つ以上の外部または独立workspace
- 合計30 Predicate / Judgment以上
- 10回以上のSchema変更
- 2回以上のAlpha upgrade
- approved false resolution 0
- lock / artifact integrity incident 0
- security incident 0
- provider errorとrecoveryの運用記録
- support requestの分類と解決時間

期間ではなく、必要なevent数が揃うまでStable実装を開始しない。

## 3. Stable public contract

### 3.1 Versioned specification

次を文章とJSON Schemaで仕様化する。

- Concept section grammar
- Predicate IR
- Static Judgment resolution
- Semantic Test model
- config
- lock
- review candidate
- Closure manifest / report
- CLI JSON envelope
- error code

実装だけを仕様の正としない。

### 3.2 Compatibility

| Contract | Stable policy |
| --- | --- |
| CLI command / option | minorで追加、削除・意味変更はmajor |
| JSON report | additive changeはminor、required field削除はmajor |
| Config | current + 1 previous versionを読取 |
| Lock | current + 2 previous versionを読取 |
| IR | versionごとにstrict parse、silent reinterpret禁止 |
| Generated code | formatter変更でもhash影響をmigration report |
| Prompt | versioned。変更時はimpact report |

deprecationには最低1 minor releaseのwarning期間を設ける。

## 4. Conformance suite

### 4.1 目的

provider / model adapterが異なっても、compiler contractの入力、出力、fail-closed動作が同じであることを検査する。

### 4.2 Suite

- resolved Predicate
- unresolved Predicate
- invalid IR
- refusal
- timeout
- rate limit
- oversized response
- Static Judgment true / false / unresolved
- consensus agreement / disagreement
- lock replay
- migration
- transaction recovery
- JSON / exit code

live精度ではなくprotocol conformanceをfixtureで測る。

### 4.3 Generated artifact determinism

同一fixture、source、config、lockで次を比較する。

- Linux x64
- Linux arm64
- macOS arm64
- macOS x64

line ending、path separator、locale、timezone、object orderがhashへ影響しないことを確認する。

## 5. TransactionのStable化

Core HardeningではL-Lang process間のlockとjournal recoveryを保証する。Stableでは外部readerから見た一貫性を改善する。

### 5.1 設計spike

候補:

1. generation directory + current manifest pointer
2. content-addressed artifact store + source側shim
3. repository transaction manifest + consumer-side integrity check

評価項目:

- TypeScript import互換
- Git diffの可読性
- crash consistency
- Windows将来対応
- package利用
- migration容易性

選定前に実装を開始しない。

### 5.2 Stable保証

- promotion中の状態をL-Lang readerがcurrentとして読まない
- crash後の自動recovery
- manual recovery command
- transaction inspect / abort
- stale workspace lockの安全な解消
- multi-artifact promotionの競合検出
- recovery audit

## 6. Model / Prompt migration

### 6.1 Migration report

```bash
l-lang migrate model \
  --from <model-or-prompt> \
  --to <model-or-prompt> \
  --manifest semantic-closure.json \
  --review
```

report:

- exact / equivalent / breaking / unresolved
- old / new semantic signature
- affected nodeとdependency
- token / cost / latency
- review requirement
- generated diff

既存artifactを自動上書きしない。

### 6.2 Rollout

1. fixture conformance
2. shadow candidate
3. diff
4. Project-fit regression
5. selected nodeだけapprove
6. Closure / verify

model default変更をpatch releaseへ含めない。

## 7. Repository-level Closure

Stable候補:

- manifest include
- policy inheritance
- dependency-open伝播
- required test suite
- reviewed / auto policy
- package boundary
- import graphの補助的発見

自動発見はwarning候補の提示に限定し、manifestへ黙ってedgeを追加しない。明示manifestを最終的な正とする。

Stableの`verify`は次を一括判定する。

- artifact integrity
- policy
- dependency
- test
- typecheck
- migration pending
- transaction recovery pending
- unsupported lock / config version

## 8. Performanceと費用

### 8.1 Baseline

計測:

- source scan
- type schema build
- lock lookup
- candidate typecheck
- Semantic Test
- full typecheck
- full test
- provider latency
- audit write
- promotion

### 8.2 改善候補

- TypeScript Program reuse
- incremental typecheck
- affected test選択と最終full gateの分離
- content hash cache
- manifest node並列read-only検査
- provider request concurrency limit
- audit圧縮 / retention

cache hitは必ず入力hashとtool versionへ結びつける。性能のために検証を省略しない。

### 8.3 Stable target

最終値はAlpha実測から固定する。少なくとも次を公開する。

- fixture build p50 / p95
- replay p50 / p95
- verify p50 / p95
- live resolution p50 / p95
- 1 Predicateあたりtoken / cost
- cache hit率

target未達でも正しさを犠牲にした最適化を行わない。

## 9. Securityとprovenance

- threat model更新
- dependency / supply-chain scan
- release artifact provenance
- package checksum
- generated artifact provenance
- secret redaction conformance
- audit retention / deletion policy
- vulnerability disclosure process
- malicious Concept / type / fixture fuzz
- symlink / path traversal / race検査

必要に応じて外部security reviewを実施する。認可、金額、transactionを対象外とする方針は維持する。

## 10. Supportと運用

### 10.1 Support matrix

- Bun version
- TypeScript version
- OS / architecture
- provider API version
- lock / config version
- package upgrade path

### 10.2 Diagnostics

`l-lang doctor --json`:

- runtime / TypeScript version
- config validation
- workspace permission
- transaction状態
- lock version
- provider設定の存在。secret値は表示しない
- network checkは明示option時だけ

### 10.3 Incident classification

- integrity
- migration
- provider
- performance
- semantic correctness
- security / privacy
- documentation / UX

各incidentに回避策、修正版、影響versionを記録する。

## 11. Stable実装Phase

### Phase 0: Alpha evidence review

- 着手条件のevent数を確認
- Alpha incidentとsupport requestを分類
- Stableで保証する契約を確定
- unsupported範囲を再確認

### Phase 1: Specification / compatibility

- versioned spec
- JSON Schema
- SemVer policy
- deprecation
- lock / config migration

### Phase 2: Conformance / determinism

- provider contract suite
- cross-platform artifact hash
- migration fixtures
- malicious input suite

### Phase 3: Transaction / Closure

- atomicity spike
- stable transaction実装
- repository-level Closure
- recovery command

### Phase 4: Performance / operations

- baseline profile
- incremental処理
- retention
- doctor
- support matrix

### Phase 5: Security / release candidate

- threat model
- supply-chain / provenance
- external review判断
- upgrade / rollback rehearsal
- Stable RC

## 12. 最終検証

Stable RCで次を実行できるscriptを用意する。

```bash
bun install --frozen-lockfile
bun run check
bun run test:conformance
bun run test:determinism
bun run test:transaction-recovery
bun run test:migration
bun run package:smoke
l-lang verify semantic-closure.json --json --offline
l-lang doctor --json
git diff --check
```

期待結果:

- supported OS / architectureでconformance成功
- 同じfixtureとlockから同じgenerated hash
- crash / parallel transactionからpreviousまたはnextの一貫状態へ回復
- supported lock / config versionのmigrationとrollback成功
- repository Closureがclosed
- `verify`のnetwork call / mutation 0
- `doctor`がsecretを表示しない
- package install / upgrade / downgrade rehearsal成功

失敗時:

- Stable tagを作成しない
- Alpha / Beta channelを維持する
- compatibility、determinism、transaction、migration、security、performanceの分類を付ける
- 修正後に全platformのStable gateを再実行する
- unsupported platformだけの失敗はsupport matrixから除外する判断を文書化し、黙って無視しない

## 13. Stable release条件

- 着手条件の運用証拠を満たす
- versioned specification公開
- compatibility / deprecation policy公開
- conformance suite成功
- supported OSでartifact hash一致
- current + supported previous lock / configを読取可能
- migration dry-run / apply / rollback成功
- crash / parallel transaction test成功
- repository Closure / verify成功
- performance target公開・達成
- security gate成功
- clean install / upgrade / downgrade rehearsal成功
- approved false resolution 0を維持

## 14. 中止条件

- Stable contractを満たすために自由なコード生成が必要になる
- provider/model変更で既存lockを再現不能
- cross-platform hash差を説明・正規化できない
- migration rollbackが成立しない
- integrity / security incidentが未解決
- performance改善に検証skipが必要
- support対象を維持する人員・運用がない

中止時はAlphaを継続し、Stableと表示しない。

## 15. Scope Expansion Gate

Stable後も新機能を自動的に追加しない。次の順で独立した計画を作る。

1. `generateValidation`
2. `generateMapping`
3. collection Predicate IR
4. `generateType`
5. Port / Capability declaration

各機能の着手条件:

- 専用IR
- strict parser / resource budget
- context validator
- deterministic generator
- hidden benchmark
- rollback / review / explain / Closure接続
- false resolution基準
- Pilot計画

既存Predicate IRへ無理に演算を追加しない。

## 16. Stableでも行わないこと

- runtime LLM
- arbitrary TypeScript generation
- authorization / money / transaction生成
- Oracleやhidden caseのmodel入力
- Schema Evolutionの無条件自動approve
- model出力を見た後のheld-out dataset調整

## 17. Definition of Done

- Stable release条件をすべて満たす
- upgrade / rollback / recoveryを再現可能な手順として公開
- 互換性とsupport期限を明記
- Alpha既知制限の解消／継続を項目ごとに説明
- release後monitoringとincident response ownerを決定
- Scope Expansionは別計画として承認されるまで開始しない
