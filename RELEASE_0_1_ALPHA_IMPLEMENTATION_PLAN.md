# L-Lang 0.1 Alpha 実装計画

作成日: 2026-07-21
状態: 計画済み・未着手
対象: Predicate / Static Judgment を安全にレビュー・固定・検証・配布できる最初の開発者向けリリース

M1〜M4の型、CLI、変更ファイル、テスト、実装順は[`M1_M4_EXECUTION_PLAN.md`](./M1_M4_EXECUTION_PLAN.md)を正とする。本書と詳細計画が競合する場合は、実装可能性を既存コードで確認した詳細計画を優先する。

## 1. 目的

現状の L-Lang は、Predicate と Static Judgment の生成、検証、lock、replay、explain、および複数 node の artifact-level Semantic Closure まで動作している。一方、`concept.md` が Semantic Closure の条件として要求する「必須テスト」「最終ビルドでの一括保証」と、第三者が導入できる配布形態はまだ揃っていない。人間承認は、必要とする利用者が選択できる review policy として扱う。

この計画では、新しい生成対象へ広げる前に、現在の部分実装を製品として信頼できる形へ閉じる。既定経路は、生成候補が機械検証を通過したら lock と生成物へ原子的に自動適用する。生成コードを事前確認したい利用者だけが review mode を有効にし、候補、diff、人間承認を経由する。CI では API 呼び出しなしに完全性を確認できる `0.1.0-alpha.1` を最終成果とする。

## 2. 現在の基準点

- Predicate: 制限 Boolean Predicate IR、型検査、意味テスト、生成、lock、replay、diff を実装済み
- Static Judgment: literal 入力から boolean 定数を生成する最小縦切りを実装済み
- Explain: Predicate / Static Judgment の current、stale、unlocked、integrity-error を読み取り専用で説明可能
- Closure: 明示 manifest の 4 node と依存関係を検査し、現在は `closed`
- 回帰基準: `bun run typecheck` 成功、`bun test` は 78 pass / 0 fail
- 保留事項: Schema Evolution v2 の live benchmark は評価設計 Blocker により別トラックで保留

## 3. Alpha のリリース条件

次をすべて満たした時点で `0.1.0-alpha.1` を作成できる。

1. Predicate と Static Judgment は、既定で `生成 → 機械検証 → 原子的な自動適用` を完了できる
2. review mode を有効にした場合だけ、候補と適用済み成果物を分離し、人間承認 provenance を保存できる
3. 未解決、stale、改ざん、依存先 open、必須テスト失敗があれば Closure が fail-closed し、review mode の node では未承認も blocker になる
4. boundary、counterfactual、invariance の型付きboolean意味テストを表現・実行でき、`unknown`はresolver-levelの`unresolved`として検証される
5. `semantic verify` が API を呼ばず、workspace を変更せず、Alpha の全保証を一括検査できる
6. Static Judgment の精度と unresolved 動作を blind fixture で定量評価できる
7. clean install した利用者が README の最小例を build、replay、verify でき、任意で review workflow も実行できる
8. Linux と macOS の CI で型検査、全テスト、package smoke test が成功する

## 4. 実装順序と依存関係

```text
M1 自動適用と任意 Review 基盤
        ↓
M2 Policy-aware Semantic Closure
        ↓
M3 Semantic Test 拡張
        ↓
M4 semantic verify
        ↓
M5 Static Judgment blind benchmark
        ↓
M6 package / CLI / CI と Alpha release gate
```

M1 と M2 は後続すべての安全境界になるため最優先とする。M3 以降は、自動適用か人間承認かにかかわらず、何を機械検証して成果物を適用したかを provenance と Closure に接続できる状態で実装する。

## 5. Milestone 1: 自動適用と任意 Review 基盤

### 5.1 目的

LLM または fixture が返した候補へ、必須の機械検証を適用した後、既定では lock と生成物へ原子的に自動適用する。生成コードを事前確認したい利用者は review mode を有効にし、候補作成、差分確認、人間承認を挟めるようにする。どちらの mode も同じ validator、test、transaction を使用し、安全性に差を作らない。

### 5.2 CLI 契約

最低限、次の非対話コマンドを提供する。

```bash
semantic build <source> [--fixture <file>]
semantic build <source> --review [--fixture <file>]
semantic diff <candidate-id>
semantic approve <candidate-id> --reviewer <id>
```

- 通常の `build` は候補を検証し、成功時に lock と生成物を原子的に自動適用する
- `build --review` は候補と検査記録だけを `.semantic/` に作成し、tracked な生成物と `semantic.lock` を変更しない
- `diff` は review mode の候補と現在の適用済み成果物の意味差分、生成差分、テスト差分を表示する
- `approve` は review mode の候補の完全性と freshness を再検査し、lock と生成物を一つの原子的操作で適用する
- `--reviewer` は空文字を拒否する。対話入力や Git identity からの暗黙補完は Alpha では行わない

設定ファイルまたは manifest node には `review: "auto" | "manual"` を持たせ、未指定時は `auto` とする。CLI の `--review` はその一回の build を `manual` として扱う。高リスク用途へ一律に manual を強制する組み込み判定は Alpha では設けず、利用者の設定を尊重する。

### 5.3 適用候補の契約

適用前の内部候補には少なくとも次を持たせる。通常 mode では transaction 中の一時データでよく、review mode のときだけ永続 candidate として保存する。

- 一意な `candidateId`
- source、Concept、Type Schema、Test、Prompt の各 hash
- resolver / model / fixture の provenance
- Predicate IR または Static Judgment result
- 生成候補の hash
- 型検査と意味テストの結果
- 作成日時

永続 candidate は strict parser で検証し、未知 field、非 canonical timestamp、不正 hash、node kind と payload の不一致を拒否する。保存後に source、Concept、Type、Test、Prompt、生成対象のいずれかが変わった場合は stale とし、適用できない。

### 5.4 Promotion provenance

適用済み lock entry には mode にかかわらず次を持たせる。

- `promotionMode: "auto" | "reviewed"`
- 適用日時
- 適用時 source / Concept / Type / Test / Prompt / generated hash
- 実行した機械検証と結果
- review mode の場合だけ `candidateId`、`reviewer`、`approvedAt`、candidate hash

lock version 1を維持し、`promotion`をoptional fieldとして追加する。新規build / approveは必ずpromotion provenanceを書き、既存entryは書き換えず`legacy-auto`として扱う。`reviewed`は人間承認記録が存在する場合だけ設定できる。

### 5.5 トランザクションと失敗時動作

- 通常 mode でも review mode でも、適用前に同一の検査を完了する
- lock と生成物は一時ファイルへ書き、両方の検証成功後に昇格する
- 片方の write、rename、post-write 検証が失敗した場合は両方を元へ戻す
- IR検証、型検査、意味テスト、Closure前提のいずれかが失敗した場合は workspace を変更しない
- review mode では candidate の改ざん、stale、reviewer 欠落でも workspace を変更しない
- 同じ candidate の再適用は idempotent success、異なる内容による ID 衝突は integrity error とする

### 5.6 主な実装対象（予定）

- `src/semantic-candidate.ts`
- `src/semantic-promotion.ts`
- `src/semantic-review.ts`
- `src/semantic-lock.ts`
- `src/semantic-compiler.ts`
- `src/static-judgment-compiler.ts`
- `src/semantic-cli.ts`
- 対応する unit / integration test と examples

### 5.7 完了条件

- Predicate / Static Judgment の両方で通常の `build → replay` が人間操作なしに成立する
- review mode では `build --review → diff → approve → replay` が成立する
- `build --review` と失敗した build / approve が tracked file を一切変更しない
- stale / tampered candidate が適用されない
- 書き込み途中の疑似障害で lock と生成物が rollback される
- auto / reviewed の promotion provenance が explain から確認できる

## 6. Milestone 2: Policy-aware Semantic Closure

### 6.1 目的

現在の artifact-level graph を、`concept.md` の最終ビルド条件を表す release gate へ拡張する。

### 6.2 Node status

各 node は少なくとも次を区別する。

- `current`: current、integrity valid、promotion時の必須test pass、依存先currentで、設定されたreview policyを満たす
- `review-required`: `review: "manual"` だが、有効な人間承認 provenance がない
- `unlocked`: まだ build / check されておらず lock entry がない
- `stale`: source または関連入力 hash が変化した
- `dependency-open`: 自 node は有効だが依存先がcurrentでない
- `integrity-error`: lock、生成物、manifest、provenance の構造または hash が不正

優先順位を仕様化し、同時に複数異常がある場合でも text / JSON が安定した status と blockers を返す。

### 6.3 依存関係

Alphaでは明示manifestを正とする。import graphによる自動発見はM1〜M4では実装せず、後続計画へ分離する。

### 6.4 Exit code

- `0`: 全 node closed
- `2`: 正常に検査できたが open blocker がある
- `1`: manifest、I/O、schema、integrity など検査自体のエラー

### 6.5 完了条件

- 既定の `review: "auto"` では、人間承認なしでも機械検証済みの自動適用 entry を closed と判定する
- `review: "manual"` の node だけは、人間承認がなければ artifact を open とする
- promotionされなかった`unresolved`と未実行は最終Closureでは`unlocked`としてfail-closedし、詳細理由はaudit reportに残る
- 必須テスト結果、review policy、promotion provenance が node report に含まれる
- 依存先の open が推移的に伝播する
- Closure は API / resolver を呼ばず、tracked file を変更しない

## 7. Milestone 3: Semantic Test 拡張

### 7.1 設計原則

Runtime Predicate の返り値は boolean のまま維持する。`unknown` は「入力を実行したら第三の値が返る」という意味ではなく、候補生成時に resolver が安全に分類できないことへの期待値として扱う。

### 7.2 実装対象

1. Boundary Test
   - accepted / rejected の境界ケースを名前付きで保存する
   - accepted / rejected は生成 Predicate へ決定的に適用する
2. Counterfactual Test
   - base input と一つの差分から期待する boolean 変化を検査する
   - mutation 適用後の型整合性を事前検査する
3. Invariance Test
   - 同一意味を表す構造化入力群が同一結果になることを検査する
   - 基準結果を暗黙決定せず、明示された expected または適用済み基準を要求する

`unknown`はboolean Predicateの第三のruntime値にはしない。resolverが意味を確定できず`unresolved`を返すcompile-time結果として既存compiler / consensus testで検証する。ユーザーDSLとしてのresolver-level unknown testは専用Judgment/Test IRの別計画とする。

Semantic Mutation Test と Model Migration Test は設計 spike と fixture schema までを Alpha に含め、モデルを使う本評価は M5 または後続版へ分離する。

### 7.3 DSL と IR

- 既存の `semanticTest` をoptionalな`boundary`、`counterfactual`、`invariance` fieldで後方互換に拡張する
- test 定義は source hash と独立した `testHash` を持ち、変更時に適用済み lock と review candidate を stale にする
- model / resolver 入力へ hidden expected value や oracle を渡さない
- test report はケース ID、期待、実結果、失敗分類を JSON で安定出力する

### 7.4 完了条件

- 3種類の拡張testがfixtureで成功・失敗を再現できる
- resolver-levelのunresolved fixtureがpromotionされない既存保証を維持する
- test 変更後、既存の自動適用・人間承認のどちらも stale になる
- 保存済み candidate / lock の replay では API 呼び出しがない

## 8. Milestone 4: `semantic verify`

### 8.1 目的

利用者と CI が、Alpha の安全条件を一つの read-only コマンドで確認できるようにする。

```bash
semantic verify <manifest> [--json]
```

### 8.2 検査内容

- source / Concept / Type / Test / Prompt hash
- lock schema、review policy、promotion provenance
- 生成物 hash と決定的再生成可能性
- unresolved / unlocked / stale / integrity error
- artifact dependency graph と Closure
- TypeScript typecheck
- manifest内Predicateのread-only Semantic Test

外部コマンドは引数配列で実行し、shell 展開を使わない。設定で許可された command だけを実行し、API credentials が存在しても network resolver を呼ばない。

### 8.3 出力と exit code

- text は人間向けの短い summary と remediation を返す
- JSON は versioned schema、各 check の duration / status / diagnostics を返す
- `0`: 全保証成功
- `2`: 検査は完了したが open / test failure がある
- `1`: 設定不正、I/O、子プロセス起動不能など検査自体のエラー。検査できたintegrity errorはopenとして`2`

### 8.4 完了条件

- clean workspace と intentionally broken fixture の両方で exit code が契約どおり
- 実行前後で `git status --short` 相当の tracked 差分が増えない
- API adapter を spy 化した統合テストで呼び出し 0
- Closure 単体と verify 内の Closure 判定が一致する

## 9. Milestone 5: Static Judgment blind benchmark

### 9.1 目的

Static Judgment が fixture で動くことと、意味判断が実用的に正しいことを分離して測る。モデル精度を主張する前に、false resolution と unresolved の安全性を定量化する。

### 9.2 評価セット

- 48 ケースを目安に、positive / negative / ambiguous を均衡させる
- 4〜6 Concept、表現差、境界例、否定、欠落情報、多言語 paraphrase を含める
- expected label と判定理由はモデル入力から隔離する
- dataset、oracle、freeze metadata を hash で凍結する
- 人間レビュー完了前は live 実行できない guard を設ける

### 9.3 指標

- resolved accuracy
- false resolution 数（ambiguous を true / false に確定した件数）
- unresolved recall / precision
- 同一入力 3 回の安定性
- API tokens、料金、wall-clock latency
- model migration 時の judgment 変化率

Alpha の最低 gate は false resolution 0 とする。accuracy や unresolved rate の数値閾値は、凍結前の pilot fixture を使って決め、held-out 結果を見て変更しない。

### 9.4 v2 Blocker との境界

Schema Evolution v2 の Blocker はこの benchmark の fixture 実装を止めない。ただし同じ評価設計上の誤りを避けるため、Concept、oracle、positive / negative / ambiguous の対応を独立レビューし、既存 v2 データを新規 evidence として流用しない。live 実行は別承認とし、Alpha パッケージ作成そのものの blocker にはしない。精度主張を伴う公開判断だけを止める。

### 9.5 完了条件

- fixture replay が deterministic で workspace mutation 0
- freeze 前レビュー手順と live 実行 guard がテストされている
- report が raw response、個別結果、集計、失敗分類を分離して保存する
- false resolution が一件でもあれば release note に制限を明記し、該当用途で review mode を選べることを案内する

## 10. Milestone 6: Package / CLI / CI

### 10.1 Package

- version を `0.1.0-alpha.1` とする
- package 名は npm availability と scope 方針を確認して別途確定する
- `private: false`、`bin`、`exports`、`types`、`files` を明示する
- TypeScript source を直接配布せず、ESM JavaScript と declaration を `dist/` に build する
- runtime dependency と dev dependency を分離する
- package tarball に `.env`、fixture の生 API 応答、`.semantic/`、benchmark secret が入らないことを検査する
- `npm pack --dry-run` と temporary directory への clean install smoke test を追加する

### 10.2 CLI quality

- `semantic --help`、`semantic --version`、各 subcommand の help
- unknown option / command の安定した diagnostic と exit code
- cwd に依存しない path 解決
- JSON mode では stdout を機械可読 JSON のみにし、ログは stderr へ送る
- secrets や生 prompt / response を既定出力へ含めない

### 10.3 Documentation

- README に install から `build → replay → verify` までの既定経路と、任意の `build --review → diff → approve` を追加する
- Alpha の保証範囲と非保証範囲を明記する
- `concept.md` の理想、roadmap の進捗、実装計画の release gate を同期する
- migration / lock version 変更がある場合は手順を提供する

### 10.4 CI

- Linux と macOS
- dependency install の lockfile 固定
- typecheck、全 unit / integration test、fixture replay、Closure、verify、package smoke test
- live API test は通常 CI から分離し、明示承認された workflow だけで実行する

### 10.5 完了条件

- tarball を空の sample project に install し、README の最小経路が成功する
- package 内容と CLI JSON output の snapshot がレビュー済み
- CI の通常経路は network model call 0
- release checklist と既知の制限が文書化されている

## 11. テスト戦略

各 milestone で次の層を維持する。

1. Parser / schema unit test
2. hash、freshness、status 優先順位の unit test
3. temporary workspace を使う transaction / rollback integration test
4. CLI text / JSON / exit-code test
5. API adapter call count 0 を保証する replay / explain / closure / verify test
6. 全回帰 `bun run typecheck && bun test`
7. M6で追加するpackage smoke test

特に promotion / review と verify では、正常系より先に stale、tamper、partial write、missing test、dependency open、unknown field、invalid timestamp をテーブル駆動で固定する。

## 12. 実装単位

レビュー可能性を保つため、次の単位でコミットまたは PR を分ける。

1. 共通の機械検証 pipeline とrollback-safe auto-promotion
2. Promotion provenance と lock migration
3. 任意 review mode の Candidate / diff / approve
4. Policy-aware Closure と explain 対応
5. Boundary / Counterfactual / Invariance Test
7. `semantic verify`
8. Static Judgment benchmark fixture / freeze guard
9. package build / CLI quality / CI
10. Alpha docs / clean-install release rehearsal

各単位は、それ以前の全テスト成功と `git diff --check` を完了条件とする。機能実装と大規模なファイル再配置は同じ単位に混ぜない。

## 13. 見積もり

単独実装の目安は 12〜20 人日とする。

| Milestone | 目安 |
| --- | ---: |
| M1 自動適用と任意 Review | 3〜5日 |
| M2 Closure 拡張 | 1〜2日 |
| M3 Semantic Test 拡張 | 3〜4日 |
| M4 semantic verify | 1〜2日 |
| M5 Static Judgment benchmark | 2〜3日 |
| M6 Package / CLI / CI | 2〜4日 |

lock migration と package 名の調整、live benchmark の実行待ちは含めない。最初の実装着手点は M1 の共通機械検証 pipeline と atomic auto-promotion とする。その後、同じ pipeline の適用直前で停止する review mode を追加する。

## 14. Alpha で行わないこと

- Git commit、push、merge の自動実行
- runtime LLM judgment
- 任意 TypeScript、DB、network、transaction、認可、金額計算の生成
- Boolean Predicate IR への Mapping / Validation / Type / Port の混在
- 独自文法、独自 VM、他言語 backend
- Language Server、IDE plugin、Semantic Debugger
- import graph 自動発見だけに依存した Closure
- Schema Evolution v2 Blocker を回避するための凍結データ改変

これらは Alpha の安全性と導入可能性を確認した後に、専用 IR と独立 benchmark を持つ別計画として扱う。

## 15. 着手時チェックリスト

- [x] M1 の通常 build と review mode の public CLI 契約を先に test として固定する
- [x] 既存 `semantic.lock` fixture の migration 方針を決定する
- [x] 通常 build の全機械検証と atomic auto-promotion を統合テストで固定する
- [x] `build --review` が lock / generated file を変更しないことを統合テストで固定する
- [x] auto-promotion / approve の atomicity と rollback fault injection を用意する
- [ ] review policy と promotion provenance を Explain と Closure の共通 parser から参照させる
- [x] 各 milestone 後に roadmap の対応表と全回帰件数を更新する
