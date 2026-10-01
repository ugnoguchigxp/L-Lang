# L-Lang Semantic TDD 残作業計画

> 適用範囲（2026-09-17整理）：Semantic TypeScriptの研究・製品化計画です。未完了Gateは残りますが、全経路の現在の実装状況やJSONCの廃止・移行方針を定める文書ではありません。現在地は[ロードマップ](./PROJECT_STATUS_AND_ROADMAP.md)、実行方法は[TypeScriptガイド](./docs/guides/semantic-typescript.md)、文書分類は[一覧](./docs/README.md)を参照してください。本文の将来のpackage・CLI・CI構成は提供済み仕様ではありません。

作成日: 2026-07-23  
最終更新: 2026-10-01（実装照合・論文範囲の整理）

状態: Predicate縦断POC・Phase 6〜7の明示指定機能を実装。bounded array・時間制限・property report照合・評価runnerを含む。独立評価・拡張範囲・既定機能への昇格は未完了（Paper v1完了条件の対象外）

## 1. この文書の役割

本書は、Semantic TypeScriptの今後の未実装作業を管理する。過去の実装済み範囲は背景情報として残すが、論文v1の完了判定には使用しない。

過去記録・現在の実装・論文v1の対象・将来課題の対応は[Paper v1の範囲と文書案内](./docs/PAPER_V1_SCOPE.md)を参照する。Phase 6〜7の完了条件は各機能を将来導入するための条件であり、論文投稿の条件ではない。

実装済みの挙動はコード、テスト、[TypeScript利用ガイド](./docs/guides/semantic-typescript.md)、[`PROJECT_STATUS_AND_ROADMAP.md`](./PROJECT_STATUS_AND_ROADMAP.md)を正とする。製品化の順序は[`POST_MVP_IMPLEMENTATION_PLAN.md`](./POST_MVP_IMPLEMENTATION_PLAN.md)を正とする。

## 2. 実装済み範囲と確認時点

次は完了しており、本書のactive taskには含めない。

- ConceptからのSemantic Contractと条項trace
- Implementationと分離したTest Obligation IR
- Predicate IR MutationとRed Certificate
- trace、型、実装前Redの機械検証後に行うTest Plan自動freeze
- `tdd-plan → diff → approve`による互換用staging
- `semantic-test.lock`へのTest Plan、provenance、Red Certificate、Selection Report保存
- freeze済みTest Planをpromotion前に実行するcompiler transaction
- APIなし・書込みなしの`tdd-test`と、APIなしでtransactionを再実行する`tdd-replay`
- boundary、counterfactual、invarianceを含むsource DSLとread-only `semantic test`
- 3種類のローカルheld-out fixtureでのHard条件欠落検出

2026-07-25のrepository基準は238 pass / 0 fail、functions coverage 93.40%、lines coverage 93.07%である。これは当時の記録であり、最新CIの数値ではない。

2026-10-01に[拡張の限定初版計画](./docs/SEMANTIC_TDD_EXTENSIONS_V1_IMPLEMENTATION_PLAN.md)に基づく実装を追加した。単一候補のSelection Report v1を維持し、明示指定のBest-of-N、全候補を保存するReport v2とread-only再評価を提供する。Property Testは明示した期待式、有限domain、seed付き入力生成、局所的な反例縮小、report replayを提供する。実行例と保証境界は[拡張例](./examples/semantic-tdd-extensions/README.md)を参照する。元計画全体の完了、品質改善の実証、既定機能への昇格は宣言しない。

## 3. 拡張契約と残るFuture Work

### Phase 6: Best-of-N候補選択

実装済み。候補数最大5・逐次生成で明示指定する。新規の凍結合成制御実験とlive評価runnerを提供する。独立held-out比較と既定採用の条件は残る。

#### 目的

同一の凍結Test Planに対して複数のImplementation IR候補を生成し、hidden oracleや実装後の恣意的なテスト変更を使わずに、再現可能な一候補を選択する。

#### 契約

- 全候補へ同一のConcept、Type、Project Context、Test Planを渡す
- 候補生成は独立に行い、他候補の内容を入力へ混ぜない
- Hard obligationを一件でも落とす候補は選択対象外
- 選択規則は事前定義した決定的scoreとstable tie-breakだけを使用する
- hidden case、held-out結果、Oracleを候補選択に使用しない
- 全候補が不適格なら`unresolved`とし、最も近い候補を自動昇格しない
- 候補数、token、費用、並列数に上限を持たせる

#### 実装単位

1. versioned Best-of-N設定schema
2. 候補ごとの独立auditとresource accounting
3. Hard Gate後の決定的selection report
4. replay時にAPIなしで同じ選択結果を再現するlock契約
5. disagreement、同点、全候補不適格、API部分失敗のfixture test

#### 完了条件

- 候補順を入れ替えても同じIR hashが選ばれる
- hidden caseを選択信号へ使っていないことをテストで固定する
- 全候補不適格時に製品artifact・implementation lockへの変更0でfail-closedになる。Test Planのfreezeとaudit出力は別に記録する
- 単発方式に対する改善を独立held-out評価で確認するまで既定経路にしない

### Phase 7: Bounded Property Test

実装済み。Property config v2はbounded arrayと単一containerを含むnullable/optional union、時間上限を追加した。string/numberは明示domainへ限定する。反例は局所的に縮小し、大域的最小性は保証しない。独立評価とbuild gateへの導入は残る。

#### 目的

`TypeSchema`と明示的な意味境界から、安全で有限な入力を生成し、失敗時に再現可能な最小反例を返す。

#### 契約

- 任意のJavaScript generator、式、callbackを受け取らない
- generatorとshrinkerはversioned IRから決定的に構築する
- seed、生成件数、深さ、配列長、文字列長、実行時間に上限を持つ
- expected結果はConceptだけから推測せず、明示的なpropertyまたは既存のTest Obligationから導出する
- counterexampleには公開可能な合成domainを用い、seedとgenerator versionで再現できる。初版はsecretの自動検出・除去を保証しない
- Property Testは証拠が揃うまでHard Gateへ昇格しない

#### 最初の対応範囲

- primitive、literal union、nullable、optional
- 最大3段のobject
- bounded array
- equality、presence、all / any / notで表現できるPredicate

数値大小比較、field間比較、自由な文字列property、任意collection predicateは対象外とする。

#### 実装単位

1. Property Test IRとstrict parser
2. seed付き決定的generator
3. 型構造を壊さないshrinker
4. counterexample reportとreplay
5. generator budget、timeout、循環型、巨大unionのfailure test

#### 完了条件

- 同一seedとIRから同じ入力列を再生成できる
- 既知の欠陥Predicateを検出し、最小反例へ縮小できる
- budget超過、表現不能property、曖昧なexpectedをfail-closedで拒否する
- source DSLのexample testと結果が矛盾する場合にpromotionしない

残実装の現在地と新規合成制御実験は[完了計画](./docs/SEMANTIC_TDD_EXTENSIONS_COMPLETION_PLAN.md)と[結果](./docs/SEMANTIC_TDD_EXTENSIONS_COMPLETION_RESULTS.md)を参照する。Property reportは明示した`semantic verify --property-report`から現在の実装と照合できる。

## 4. 独立評価

Phase 6〜7を製品経路へ入れる前に、新しいheld-out入力を結果観測前にfreezeする。

測定項目:

- false acceptance / false rejection
- `unresolved`
- mutation kill rate
- counterexample再現率
- 単発候補とBest-of-Nの差
- API call、token、費用、latency
- workspace mutationとintegrity incident

既存fixtureや観測済みheld-outを、新しい成功証拠として調整・再利用しない。

## 5. 着手Gate

2026-10-01のユーザー指示により、限定初版は以下の着手順に先行して実装した。既定採用・独立評価の条件は維持する。Phase 6〜7は現在のmeasured developer A/Bを妨げない。実装優先度は次の条件に従う。

1. Private Pilotの価値Gateを先に測定する
2. A/BでSemantic Test不足が主要失敗原因と確認された場合、Phase 7を優先する
3. 応答揺れが主要失敗原因と確認された場合、Phase 6を優先する
4. Public Alphaのpackage / CLI Gateより先に既定機能へ昇格しない

## 6. 非目標

- 自由なTypeScriptまたは自由なテストコードの生成・実行
- Test Planを失敗候補に合わせて自動修正するloop
- LLM-as-a-Judgeだけによるexpected確定
- hidden oracleによる候補ランキング
- 認可、金額、暗号、transaction、副作用への適用
- 無制限の候補生成、property生成、retry

## 7. 将来機能のDefinition of Done（Paper v1対象外）

- Phase 6または7のversioned contract、resource budget、audit、replayが揃う
- unit、failure-injection、temporary workspace、CLI integration testが成功する
- `semantic verify`からread-onlyに結果を検査できる
- APIなしreplayでartifact hashと選択・反例を再現できる
- 独立held-out評価を保存し、失敗を含めて結果を公開する
- README、roadmap、lock migration、既知の制限を同期する
