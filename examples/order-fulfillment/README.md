# 注文フルフィルメントのSemantic Polymorphism

このexampleは、1つの共通Concept `FulfillableOrder`を、構造の異なる3つの
TypeScript schemaへ適用します。同じ業務上の意味から、semantic compilerが
schema固有の決定的なTypeScriptを生成する様子を比較できます。

共通Conceptは[`concepts/fulfillable-order.ts`](../../concepts/fulfillable-order.ts)にあり、この業務Conceptで意味のある5セクションすべてを使用しています。型と`semanticTest`は各`semantic.ts`に置くため、構造化された意味定義とTypeScriptの型安全性を同時に確認できます。Definition欠落、未分割の自由文、不正なセクションはLLM呼び出し前にコンパイルエラーになります。

このexampleでは、次の条件をすべて満たす注文を「フルフィルメント可能」とします。

1. 支払いまたは与信が確認済みである
2. キャンセル、保留、voidのいずれも有効ではない
3. 配送先の値が`null`でも`undefined`でもない

在庫数、配送業者の空き、配送時刻、価格は、範囲・時刻・算術比較をまだ扱わない
現在のPredicate IRの対象外であるため、このConceptには含めません。`present`は
空文字列の妥当性までは判定せず、`null`と`undefined`だけを除外します。

## シナリオ

| シナリオ | 支払い確認 | 除外状態 | 配送先 |
| --- | --- | --- | --- |
| ECストア | `paymentStatus === "paid"` | `cancelledAt === null` | `shippingAddress`が存在 |
| 倉庫管理 | `paymentConfirmed === true` | `holdReason === null` | `destinationCode`が存在 |
| マーケットプレイス | nestedな`authorization === "approved"` | nestedな`voided === false` | optionalな`deliveryLocation`が存在 |

各`semantic.ts`と同じディレクトリにある生成ファイルは通常のTypeScriptです。
DSLをimportせず、APIを呼ばず、実行時の意味判断も行いません。

## fixtureから再ビルド

repository rootで次を実行します。

```bash
bun run semantic build examples/order-fulfillment/storefront/semantic.ts \
  --fixture examples/order-fulfillment/storefront/openai-response.fixture.json

bun run semantic build examples/order-fulfillment/warehouse/semantic.ts \
  --fixture examples/order-fulfillment/warehouse/openai-response.fixture.json

bun run semantic build examples/order-fulfillment/marketplace/semantic.ts \
  --fixture examples/order-fulfillment/marketplace/openai-response.fixture.json
```

entryが`semantic.lock`に存在すれば、replayはresolverやAPIを呼びません。

```bash
bun run semantic replay examples/order-fulfillment/storefront/semantic.ts
bun run semantic replay examples/order-fulfillment/warehouse/semantic.ts
bun run semantic replay examples/order-fulfillment/marketplace/semantic.ts
```

## 任意の適用前Review

1シナリオを適用前に確認する場合は、次のように実行します。

```bash
bun run semantic build examples/order-fulfillment/marketplace/semantic.ts \
  --review \
  --fixture examples/order-fulfillment/marketplace/openai-response.fixture.json

bun run semantic diff <review-id>
bun run semantic approve <review-id> --reviewer <id>
```

`build --review`は生成物と`semantic.lock`を変更せず、検証済み候補を
`.semantic/reviews/`へ保存します。approve時には、適用前にsourceと候補を
再検証します。

## 一括テストとClosure

生成済みの3つのStatic Predicateを一括テストできます。

```bash
bun run semantic:fulfillment:test
```

3つのartifactの状態も、API呼び出しなしで一括検査できます。

```bash
bun run semantic closure examples/order-fulfillment/semantic-closure.json
```
