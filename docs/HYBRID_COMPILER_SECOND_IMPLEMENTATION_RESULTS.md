# Hybrid Compiler Second Implementation Results

> 分類：本文の日付・基点revision・実行条件に対する結果記録です。過去の数値・未完了事項を現在の全経路へ一般化しません。現在の対応範囲は[ロードマップ](../PROJECT_STATUS_AND_ROADMAP.md)、利用方法は[例の一覧](../examples/README.md)を参照してください。

## Status

2026-09-16、ブランチ`hybrid-compiler`、開始commit`5e160c7`で、
[第二実装計画](./HYBRID_COMPILER_SECOND_IMPLEMENTATION_PLAN.md)のH2
「Canonical Type IR + Projections」を実装した。

2026-09-17に実装差分全体を再レビューし、型provenance、入力境界、diagnostic、
prototype-sensitive fieldの防御を追加した。既存fixtureのCanonical Type、semantic、
Wasm、JSON Schema、実装仕様のhashはレビュー前後で変わっていない。

この結果が示すのは、H1のRestricted TypeScript Predicate Importが扱う型を、
TypeScript固有表現からCanonical Type IRへ意味を落とさず正規化し、同じ型契約から
既存WasmContract、JSON Schema、短い実装仕様を決定的に生成できることに限られる。
任意のTypeScript型、JSON Schemaからの逆変換、Zod生成、自然言語要求の確定、
artifact配布の完成を示すものではない。

## 実装した縦断

H1の経路へCanonical Type IRと二つのprojectionを追加した。

```text
same-file TypeScript type + restricted export function
  -> TypeScript AST / TypeChecker
  -> TypeSchema
  -> TypeScript Type Provider
  -> Canonical Type IR v1
       |-> WasmContract -> existing Wasm backend
       |-> JSON Schema Draft 2020-12 + mapping status
       `-> implementation-derived Markdown specification
```

主な実装は次である。

- [`canonical-type-ir.ts`](../src/canonical-type-ir.ts)：
  Canonical Predicate Type IR v1、strict parser、canonical hash
- [`typescript-type-provider.ts`](../src/typescript-type-provider.ts)：
  既存TypeSchemaからCanonical Type IRへのlossless mappingと分類済みdiagnostic
- [`canonical-type-json-schema.ts`](../src/canonical-type-json-schema.ts)：
  Draft 2020-12 projection、mapping status、明示的`undefined`のdiagnostic
- [`hybrid-specification.ts`](../src/hybrid-specification.ts)：
  型表、判定木、projection statusを含む決定的なMarkdown renderer
- [`wasm-core.ts`](../src/wasm-core.ts)：
  `contractFromCanonicalType`による既存WasmContractへのlowering
- [`typescript-predicate-importer.ts`](../src/typescript-predicate-importer.ts)：
  Provider、Canonical Type、projectionを一つのinspection結果へ統合

既存`TypeSchema`と`contractFromType`は互換比較用に維持した。Predicate IR、Wasm ABI、
compiler/backend version、Resolution Lock、Build Manifest、Capability Packageは変更して
いない。

## Canonical Type IR v1

初期profileは、一つのflat recordと次のfield意味を保持する。

- requiredとoptional
- non-nullとnullable
- 明示的`undefined`の禁止と許可
- boolean
- UTF-8 open string
- closed string enum

field名とenum値は一意かつlexicographic orderでなければならない。unknown key、空record、
上限超過、重複、非canonical order、未対応value kindはstrict parserが拒否する。
TypeScriptのdeclaration order、source path、format、mtimeはCanonical Type hashへ含めない。

TypeScript Providerは、boolean、`true | false`、string、string literal union、optional、
`null`、`undefined`をlosslessに変換する。number、array、nested record、mixed union、
値を持たないnullish unionは近似せず、分類済みdiagnosticを返す。unsupported結果から
partial Canonical Type IRは返さない。

## JSON Schema projection

JSON互換範囲について、top-level object、`properties`、`required`、nullable、enum、
boolean、string、`additionalProperties: false`をDraft 2020-12として生成する。

JSONには明示的`undefined`がない。そのため該当fieldが一つでもある場合、projectionは
成功結果のまま次を返す。

```text
status: requires-host-adapter
diagnostic: EXPLICIT_UNDEFINED_NOT_JSON
```

この状態をlosslessへ読み替えず、field pathをdiagnosticと`x-l-lang-canonical-type`へ
残す。Ajvと既存`encodeInput`の比較では、JSON-compatible値の合否が一致した。一方、
required fieldへ明示的`undefined`を渡すhost値はWasm入力契約が受理するが、JSON Schema
単独では受理できず、JSON直列化するとfield自体が失われることをテストで固定した。

## 実装仕様projection

生成するMarkdownには次を含める。

- `Implementation-derived specification`という明示ラベル
- function名とinput parameter名
- Canonical fieldの型、presence、null、undefined表
- 既存judgement rendererによる判定木
- JSON Schema mapping statusとdiagnostic
- 業務要求への適合を証明しないという固定注記

rendererはIntent、要求ID、業務目的を命名から推測しない。同じCanonical Type IR、
Predicate IR、function名、parameter名、projectionから同じcontentとhashを返す。
Markdownはファイルへ自動保存せず、inspection JSON内の説明projectionとして返す。

## ImporterとCLI

`ImportedTypeScriptPredicate`と`hybrid inspect-ts`の成功JSONへ、次を追加した。

- `input.canonicalType`
- `input.canonicalTypeHash`
- `input.mapping`
- `projections.jsonSchema`
- `projections.specification`

既存`input.schema`、`contract`、`semanticHash`は維持した。CLIは引き続き対象module、
model client、network adapter、Binaryen、Lock writerを読み込まず、`apiCalls: 0`、
`writes: 0`を返す。JSON Schemaが`requires-host-adapter`でもinspection自体は成功する。

実行例は次である。

```bash
bun run hybrid inspect-ts examples/hybrid-order/can-ship.ts --function canShip
```

## H1互換性の実測

二つのH1 fixtureについて、旧TypeSchema経路とCanonical Type IR経路のWasmContract、
Wasm bytes、実行結果を比較した。contractとbytesは一致し、H1のhashを維持した。

| Function | Canonical Type hash | H1 semantic hash | H1 Wasm hash | JSON Schema status |
| --- | --- | --- | --- | --- |
| `canShip` | `b13eaa780859bc44c6836956488a8cb898f92ef75973a418fb41337f242da7c1` | `e92e379d4b51cab9e551b945f74fe381f2e539396ef03dc8aeebcac0403d8e69` | `b9d6849e6d5d91beab447ba6d318c0ee531cdd450b6701b28bef4a6cfbb5c582` | `requires-host-adapter` |
| `needsManualReview` | `64394ff905bd6753c68d2e9e4ae95e73ba4da6ee0edf1bd39d64955ab7dad2f7` | `d50530d67a204c5ff30f99f7d8261db8a9ec04cc518dc20682fca6f33c8ba6f3` | `31e35f6157e4f5b7255f95a90784fb6fe5525d2af4aced75727d364389dabe4b` | `requires-host-adapter` |

両functionは同じsource fileなので、H1 source hashは共通して
`3778b7a5836194cb18642d117ba411c7a10e94913fdcea078be768ba44d1db2e`である。

`canShip`のJSON Schema hashは
`13a9120947870847a9fe3cc5c6fc00f47d52ecba058ab47e7485f905b4077315`、
実装仕様hashは
`795290ff0bbe9812e605da87d62ead5107810ff009e67c1645625f7944669bd7`である。

`needsManualReview`のJSON Schema hashは
`ca764fee6af71b1d2842aa000785c1efb334c457b695d7ff64ca92a0cc297dab`、
実装仕様hashは
`c9790bd34df4af2919dc72e0538b09c6aca0d0935c9659649a4d7df55b03683b`である。

## 実測した品質Gate

環境はmacOS 26.6.2、Bun 1.3.14、TypeScript 5.9.3、Binaryen 132.0.0である。

| Gate | 結果 |
| --- | --- |
| `bun install --frozen-lockfile` | 成功、dependency変更なし |
| `bun audit` | 成功、脆弱性0件 |
| `bun run format:check` | 成功 |
| `bun run lint` | 成功 |
| `bun run ci:docs` | 成功 |
| `bun run typecheck` | 成功 |
| `bun test` | 成功、404 tests / 85 files / 0 failures |
| `bun run coverage` | 成功、404 tests / 85 files、overall functions・linesとも90%閾値通過 |
| `bun run ci:smoke` | 成功 |
| `bun run ci:protected` | 成功 |
| `git diff --check` | 成功 |

targeted testでは43 testsを実行し、Canonical parser、Provider、JSON Schema、仕様表示、
CLI、H1 importer、意味一致、旧新Wasm経路を確認した。その後の境界追加を含む全suiteは
404 testsで成功した。

UbuntuとWindowsのCIはこのローカル作業では実行していない。そのため、3 OSでの成功は
未確認である。

## 計画との差分と観測事項

- AjvへJavaScript objectを直接渡した場合、optional propertyの`undefined`は欠損に近い
  扱いになる。required propertyではJSON Schemaが拒否する一方、明示的`undefined`を
  許すWasm入力契約は受理する。この差を隠さずhost adapter要件としてテストした。
- CLI実装は既にimporter結果をspreadしていたため、projection追加のためのCLI本体変更は
  不要だった。CLI testで新しいJSON契約を固定した。
- lintはexhaustiveなCanonical value switchにも明示的な防御分岐を要求したため、
  到達不能な未対応kindを`UNSUPPORTED_TYPE`としてfail closedにした。
- 新規dependencyは追加しなかった。既存Ajvをprojection testにだけ使用した。

## コードレビュー後のhardening

実装後レビューでは、次を修正した。

- JSON Schemaの`properties`をprototype-sensitiveな代入で組み立てず、`__proto__`も
  own schema fieldとして保持する。
- Canonical Type strict parserはown enumerable data propertyだけを読み、継承値、
  symbol key、getter、sparse array、arrayの追加fieldを拒否する。検査中にgetterを
  実行しない。
- same-file input typeがimport由来のalias、base interface、mapped typeを推移的に
  取り込む経路を拒否する。source hashへ含まれない型定義をlosslessとは扱わない。
- call signature、construct signature、index signatureを持つ入力をrecordへ近似しない。
- module scopeで`undefined`がshadowされているnullish比較を拒否する。一方、
  `input.undefined`というproperty名は通常のdataとして扱う。
- TypeScript diagnostic内の絶対pathを伏せ、公開error messageを共通上限内へ収める。
  unsupported expressionのsource全文をerrorへ反射しない。
- source sizeを読み込み後だけでなく読み込み前にも確認し、通常のoversize入力で
  全byteを確保しない。

各問題には再現テストを追加し、修正前に失敗、修正後に成功することを確認した。

## 未実施と次の判断

未実施事項は次である。

- Ubuntu / Windows CIでの確認
- Canonical Type IRの永続artifact化とprovenance付きLock / Manifest
- Zod、OpenAPI、Rust型、JSON Schema入力等の追加projection / Provider
- number、nested record、array、tuple、refinement、arbitrary string比較
- JSON SchemaからCanonical Type IRへの逆変換
- boolean以外のstructured outputとWasm memory ABI
- natural-language Requirement Contract、SAAA、Coding Agentとの自動接続

次は対応型を広げる前に、実利用の優先順位を選ぶ。保存・再利用が先ならCanonical Type
hash、Semantic IR hash、source hash、toolchainを連結するartifact化を、TypeScript hostで
の導入が先ならlosslessな共通範囲だけのZod projectionを、boolean以外の戻り値が先なら
H3 Structured Outputを独立計画として設計する。
