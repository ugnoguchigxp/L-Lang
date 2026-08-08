# ERP CRUD Private Pilot実装・評価計画

作成日: 2026-07-24

状態: **Phase 7: measured developer A/B準備**

Gate: **Private Pilot / Gate 1**

対象: **商品マスタ、価格、数量、在庫、出荷を扱うERP風CRUD**

[Project Fit Vertical Slice](./benchmarks/project-fit-v2/evidence/README.md)はGate C通過済みであり、本書のactive taskには含めない。本書には、ERP CRUD Private Pilotで今後実装・評価する作業だけを残す。

Phase 0〜2の実装とfixture検証は完了した。結果、コマンド、制約、artifact hashは[`pilots/erp-crud-v1/evidence/phase-0-2.md`](./pilots/erp-crud-v1/evidence/phase-0-2.md)へ移し、本書の作業項目から削除した。

Phase 3〜4は完了した。Azure OpenAIによる初回生成は8/8 first-pass、hidden case 25/25、false resolution 0、cooldown 8/8で合格した。結果は[`pilots/erp-crud-v1/evidence/initial-live.md`](./pilots/erp-crud-v1/evidence/initial-live.md)へ移し、本書の作業項目から削除した。

Phase 5〜6も完了した。Schema Evolutionは8/8 quorum、16/16 hidden case、false resolution 0で合格し、総合判定は「measured private pilotへConditional Go、無条件Public AlphaはNo-Go」とした。結果は[`pilots/erp-crud-v1/evidence/schema-evolution-live.md`](./pilots/erp-crud-v1/evidence/schema-evolution-live.md)と[`pilots/erp-crud-v1/evidence/go-no-go.md`](./pilots/erp-crud-v1/evidence/go-no-go.md)へ移し、本書の作業項目から削除した。

## 1. 目的

L-Langが技術的に動くことではなく、需要が見込まれるERP風CRUDで次を満たすかを測る。

- 手書き実装より意味と意図を再利用しやすい
- Schema変更時の修正時間を短縮できる
- `unresolved`を維持しながらfalse resolutionを増やさない
- 抽象的なIntentからProject適合までの総作業時間に価値がある
- API費用、latency、監査、data boundaryを運用できる

価格、数量、在庫、出荷の値は入力として扱うが、L-Langには金額計算、数量計算、在庫引当、出荷実行を行わせない。L-Langが生成するのは、業務上の条件に該当するかを決定的に分類するpure boolean Predicateだけである。

Pilotは製品リリースではない。既存の手書きbaselineと並走するシャドーモードに限定し、生成結果から業務操作を自動実行しない。

## 2. Active Gate

現在のactive gateは手書き実装に対する20%以上のmedian total-task-time改善である。技術精度、安全性、費用、cooldownは合格したが、baseline authoring timeとSchema変更時の人間の作業時間を測っていないため、価値仮説は未証明である。

次は実開発者が同じ8 taskを手書き経路とL-Lang経路で実施し、待機時間と人間の作業時間を分離して計測する。synthetic reviewer / ownerは外部ERP domain validationの代替として扱わない。

## 3. 評価対象

### 3.1 ERP領域

次の4領域、合計8 Predicateを対象とする。

| Domain | Predicate | 判定する内容 | 判定後の扱い |
| --- | --- | --- | --- |
| Product Master | `isProductMasterReviewReady` | 商品コード、名称、分類、ライフサイクルなど、レビューに必要な意味役割が揃っている | 商品マスタレビュー候補として表示 |
| Product Master | `isProductArchiveReviewCandidate` | 廃止状態、在庫状態、未完了出荷状態からアーカイブ確認対象か | アーカイブ確認候補として表示。削除しない |
| Price / Quantity | `isPriceRecordReviewReady` | 通貨、価格入力状態、税区分など、人間が価格情報を確認できる状態か | 価格レビュー候補として表示 |
| Price / Quantity | `needsQuantityDataReview` | 数量データの検証状態や単位情報から確認が必要か | 数量レビュー候補として表示 |
| Inventory | `isInventoryRecordReviewReady` | SKU、拠点、棚卸状態など、在庫記録を確認できる状態か | 在庫レビュー候補として表示 |
| Inventory | `needsInventoryDiscrepancyReview` | Exact Codeが算出した差異状態から人間の確認が必要か | 差異レビュー候補として表示 |
| Shipment | `isShipmentPreparationReviewReady` | 出荷状態、配送先検証状態、必要情報から準備確認へ進めるか | 出荷準備レビュー候補として表示 |
| Shipment | `needsShipmentExceptionReview` | 出荷例外の状態と担当情報から確認が必要か | 例外レビュー候補として表示 |

各Predicateに最低1件のSchema変更scenarioを持たせる。変更にはrename、nullable / optional変更、flatからnestedへの移動、status表現の変更を含める。

### 3.2 Semantic / Exact境界

現在のPredicate IRは数値大小比較、field間比較、集計、`some` / `every`を扱わない。価格・数量・在庫の算術や集計は手書きのExact Codeで行い、L-Langには次のような型付き派生事実だけを渡す。

```ts
type InventoryReviewInput = {
  sku: string;
  locationCode: string | null;
  countState: "not_counted" | "counted";
  discrepancyState: "none" | "detected" | "unknown";
  reviewerId?: string | null;
};
```

例えば`recordedQuantity !== countedQuantity`の計算はExact Codeの責務とし、L-Langは`discrepancyState === "detected"`という意味判断だけを生成する。この境界により、L-Langが価格や在庫数を決定したように扱わない。

### 3.3 選定条件

すべてのPredicateは次を満たす。

- pure
- deterministic
- boolean result
- 入力がローカルrecord型で表現できる
- 判定に外部I/Oを必要としない
- 期待するpositive / negative caseを事前定義できる
- 結果がadvisory flagであり、業務操作へ直接接続されない

### 3.4 除外条件

- 人命、医療、法務、信用判断へ直接影響する
- 認証・認可境界
- 価格、割引、税額、請求額の算出または決定
- 与信、取引可否、承認可否の決定
- 発注、送金、在庫引当、出荷確定の自動実行
- 自動削除、自動公開、外部通知
- runtime contextや外部データが不可欠
- Conceptの正解についてdomain owner間で合意できない
- test用に実データや個人情報が必要

### 3.5 シャドーモード

- L-Langの判定結果をUIまたはreportへ表示するだけにする
- CRUD APIのcreate / update / delete、workflow transition、外部I/Oを呼ばない
- 手書きbaselineの業務結果を変更しない
- baselineとL-Langの差分をcase単位で記録する
- false resolution、integrity incident、data boundary違反が1件でもあればlive実行を停止する

## 4. Pilot protocol

### 4.1 事前固定

モデル出力を見る前に各Predicateについて保存する。

- business definition
- 手書きbaseline実装
- positive / negative / boundary case
- 期待するSchema変更後の実装
- 計測開始点と終了点
- domain owner
- confidential data classification

手書きbaselineを先に固定し、L-Lang結果を見てbaselineを有利／不利に変更しない。

### 4.2 Blind boundary

モデル入力:

- Concept
- target TypeScript declaration
- target symbol metadata
- boundedかつsecret-freeなProject Context

モデル入力へ含めない:

- baseline実装
- Semantic Test values
- hidden boundary cases
- expected IR
- expected Project Gate result

### 4.3 実行経路

```text
Frozen Concept / Type / Cases / Baseline
                ↓
isolated pilot workspaceでsemantic build
                ↓
Candidate + Diff + Audit
                ↓
Project全体の機械検証
                ↓
Hidden caseでscoring
                ↓
baselineとの差分と作業時間を記録
                ↓
Schema変更scenario
                ↓
semantic check / automatic project-fit gate
                ↓
手書き変更との時間・品質比較
```

live LLM candidateは隔離したPilot workspaceで通常`build`のProject Gateを通し、成功時だけ同workspace内で自動昇格する。Pilotの生成物はERPのCRUD command、database、external APIへ接続しない。

## 6. 計測項目

### 6.1 正しさ

| Metric | 定義 |
| --- | --- |
| Resolved | candidate IRが確定した |
| Unresolved | fail-closedで候補を確定しなかった |
| Invalid | local validationを通らなかった |
| False resolution | resolvedだがhidden caseまたはProject回帰で意味的に誤り |
| Escaped false resolution | 自動昇格後に誤りと判明 |
| First-pass project fit | 最初のcandidateが追加指示なしで全Gateを通過 |
| Gate rejection | 型、Semantic Test、Project回帰のいずれかでcandidateを拒否 |

### 6.2 時間

- Concept作成時間
- L-Langのwall-clock latency
- 初回適合までの追加指示量
- 再生成回数
- Gate失敗後の修正時間
- 手書きbaseline実装時間
- Schema変更時の手書き修正時間
- Schema変更時のL-Lang再生成・検証時間
- total task time

待機時間と人間の実作業時間を分ける。

### 6.3 費用

- API call数
- input / output / total token
- Predicate単位の費用
- successful candidate単位の費用
- unresolvedを含む総費用
- retryによる追加費用

### 6.4 運用

- lock / artifact integrity incident
- transaction recovery発生数
- CLI error分類
- Project Gate間の不整合
- auditから判断を再現できた割合
- confidential data handling違反

## 7. Pilot実装Phase

### Phase 7: Measured developer A/B

同じ8 taskを実開発者が手書き経路とL-Lang経路で実施する。

- 初回実装とSchema変更を別々に計測
- baseline authoring、review、修正時間を記録
- Concept authoring、生成、review、修正時間を記録
- provider latencyと60秒cooldownを人間の実作業時間から分離
- task順序を交差させ、学習効果を一方だけに寄せない
- false resolution、business write、external I/Oは引き続き0を要求
- median total-task-timeが手書き比20%以上改善した場合だけPublic Alphaを再判定

## 8. 合格基準

すべて必須:

| Metric | 基準 |
| --- | ---: |
| Escaped false resolution | 0 |
| Lock / artifact integrity incident | 0 |
| Replay reproducibility | 100% |
| Hidden case pass after promotion | 100% |
| Budget overrun | 0 |
| Confidential data incident | 0 |
| Business write / external I/O | 0 |
| Cooldown violation | 0 |
| Shadow resultによる業務状態変更 | 0 |

価値判定:

- 初回またはSchema変更のどちらかで、median total task timeを手書き比20%以上短縮
- first-pass project fitが80%以上
- 対象範囲内のunresolved率が30%以下
- cost / latencyが事前budget内

価値判定を満たさない場合、技術的成功だけでPublic Alphaへ進まない。

## 9. 中止条件

直ちにPilotを停止:

- escaped false resolutionが1件
- authorization、金額決定、在庫引当、出荷確定、secretなど除外対象が混入
- L-Langの結果からCRUD writeまたは外部I/Oが実行される
- hidden caseまたはbaselineがmodel入力へ送信
- freeze後の入力変更を検出
- lock corruptionまたはreplay不一致
- API budget guardが機能しない
- API attempt後の60秒cooldownを省略
- raw auditへ不適切な個人情報またはsecretを保存

case単位で停止:

- domain ownerが期待意味に合意できない
- Conceptが制限IRで表現できない
- baselineの正しさを確定できない
- Schema変更scenarioが作為的である

停止したcaseを成功率の分母から除外せず、除外理由をreportする。

## 10. 成功時の成果物

- versioned Pilot report JSON
- 人間向けsummary
- case別raw metricへのhash参照
- false resolution / unresolved / invalidの分類
- API token / cost / latency
- attempt単位のcooldown実施記録
- 手書きbaseline vs L-Langの時間比較
- 追加指示量と再生成回数
- data handling結果
- shadow-only / business write 0の検証結果
- Public Alphaへ進むGo / No-Go decision

結果は[Public Alpha製品化計画](./PUBLIC_ALPHA_PRODUCTIZATION_PLAN.md)の基準点として使用する。

## 11. 失敗時の分類

失敗を次へ分類する。

- Concept specification不足
- Schema role mapping誤り
- IR表現力不足
- context validator不足
- Semantic Test不足
- consensus不成立
- provider / adapter障害
- Project fit diagnostic不足
- total task time悪化
- API費用過大

改善後に再評価する場合、既存Pilot入力を新しいblind evidenceとして再利用せず、新しいPilot versionを作る。

## 12. Definition of Done

- 実開発者による手書き/L-Lang両経路の時間記録がある
- 初回実装とSchema変更を別々に比較できる
- 待機時間と人間の実作業時間を分離している
- 全8 taskを成功・失敗にかかわらず集計する
- false resolution、business write、external I/O、cooldown違反が0
- median total-task-time改善率を計算する
- 改善率20%以上ならPublic Alphaを再判定し、未達ならNo-Goを維持する

## 13. Active planの維持規則

本書は未実装作業だけを扱う。

- Phase完了後、そのPhaseの作業手順と期待結果を本書から削除する
- 完了結果、実行コマンド、計測値、失敗、artifact hashは`pilots/erp-crud-v1/evidence/`へ移す
- 本書には次の未完了Phase、active Blocker、再開条件だけを残す
- 失敗したPhaseは削除せず、未完了作業と再検証条件へ書き換える
- Project Fitなど上位で完了済みの実装手順を本書へ戻さない
