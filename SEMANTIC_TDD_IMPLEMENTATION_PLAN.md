# L-Lang Semantic TDD 残作業計画

> 適用範囲（2026-09-17整理）：Semantic TypeScriptの研究・製品化計画です。未完了Gateは残りますが、全経路の現在の実装状況やJSONCの廃止・移行方針を定める文書ではありません。現在地は[ロードマップ](./PROJECT_STATUS_AND_ROADMAP.md)、実行方法は[TypeScriptガイド](./docs/guides/semantic-typescript.md)、文書分類は[一覧](./docs/README.md)を参照してください。本文の将来のpackage・CLI・CI構成は提供済み仕様ではありません。

作成日: 2026-07-23  
最終更新: 2026-07-25  
状態: Predicate縦断POC完了、Phase 6〜7未着手

## 1. この文書の役割

本書は、実装済みのSemantic TDDを説明する履歴文書ではなく、今後の未実装作業だけを管理する。

実装済みの挙動はコード、テスト、[TypeScript利用ガイド](./docs/guides/semantic-typescript.md)、[`PROJECT_STATUS_AND_ROADMAP.md`](./PROJECT_STATUS_AND_ROADMAP.md)を正とする。製品化の順序は[`POST_MVP_IMPLEMENTATION_PLAN.md`](./POST_MVP_IMPLEMENTATION_PLAN.md)を正とする。

## 2. 現在の実装済み範囲

次は完了しており、本書のactive taskには含めない。

- ConceptからのSemantic Contractと条項trace
- Implementationと分離したTest Obligation IR
- Predicate IR MutationとRed Certificate
- trace、型、実装前Redの機械検証後に行うTest Plan自動freeze
- `tdd-plan → diff → approve`による互換用staging
- `semantic-test.lock`へのTest Plan、provenance、Red Certificate、Selection Report保存
- freeze済みTest Planをpromotion前に実行するcompiler transaction
- APIなし・書込みなしの`tdd-test`と`tdd-replay`
- boundary、counterfactual、invarianceを含むsource DSLとread-only `semantic test`
- 3種類のローカルheld-out fixtureでのHard条件欠落検出

2026-07-25のrepository基準は238 pass / 0 fail、functions coverage 93.40%、lines coverage 93.07%である。

## 3. Active task

### Phase 6: Best-of-N候補選択

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
- 全候補不適格時にworkspace mutation 0でfail-closedになる
- 単発方式に対する改善を独立held-out評価で確認するまで既定経路にしない

### Phase 7: Bounded Property Test

#### 目的

`TypeSchema`と明示的な意味境界から、安全で有限な入力を生成し、失敗時に再現可能な最小反例を返す。

#### 契約

- 任意のJavaScript generator、式、callbackを受け取らない
- generatorとshrinkerはversioned IRから決定的に構築する
- seed、生成件数、深さ、配列長、文字列長、実行時間に上限を持つ
- expected結果はConceptだけから推測せず、明示的なpropertyまたは既存のTest Obligationから導出する
- counterexampleはsecretを含まず、seedとgenerator versionで再現できる
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

Phase 6〜7は現在のmeasured developer A/Bを妨げない。実装優先度は次の条件に従う。

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

## 7. Definition of Done

- Phase 6または7のversioned contract、resource budget、audit、replayが揃う
- unit、failure-injection、temporary workspace、CLI integration testが成功する
- `semantic verify`からread-onlyに結果を検査できる
- APIなしreplayでartifact hashと選択・反例を再現できる
- 独立held-out評価を保存し、失敗を含めて結果を公開する
- README、roadmap、lock migration、既知の制限を同期する
