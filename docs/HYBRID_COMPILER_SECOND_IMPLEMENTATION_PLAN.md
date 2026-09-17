# Hybrid Compiler Second Implementation Plan

> 分類：実装時の設計・作業記録。本文の予定表現やチェックリストは当時の計画です。完了範囲は対応する結果文書、現在の実行方法は[例の一覧](../examples/README.md)、実行環境・CI対象OSは[品質Gate](../QUALITY_GATES.md)を参照してください。

## Status

- 作成日：2026-09-16
- 対象ブランチ：`hybrid-compiler`
- 前提：[第一実装結果](./HYBRID_COMPILER_FIRST_IMPLEMENTATION_RESULTS.md)
- 対象段階：H2 `Canonical Type IR`
- 実装名：`Canonical Predicate Contract v1`
- 状態：機能実装済み。[実装結果](./HYBRID_COMPILER_SECOND_IMPLEMENTATION_RESULTS.md)を参照。以下は設計時点の手順・受け入れ条件。

本計画は、第一実装で取り込めるようになった制限TypeScript Predicateを、
TypeScript固有の型表現から切り離し、一つのcanonical contractから既存Wasm契約、
JSON Schema、短い実装仕様を決定的に投影する第二の縦断を定義する。

この段階では型の対応範囲を広げない。現在の`predicate-i32-v1`で意味を保持できる
型だけをCanonical Type IR v1へ移し、Frontendとbackendの境界を固定する。

## 1. 次にH2を選ぶ理由

第一実装によって、次の経路は成立した。

```text
TypeScript AST / TypeChecker
  -> TypeSchema
  -> Predicate IR
  -> WasmContract
  -> Wasm意味一致
```

ただし、現状の`TypeSchema`は既存semantic scannerの内部表現であり、次の責務が
まだ分離されていない。

- TypeScriptから得た型情報
- 言語非依存として保持する型の意味
- 現行Wasm ABIが扱える物理契約
- JSONなど別transportへ投影したときに失われる情報

この状態でimported Predicateをartifact化すると、TypeScript固有表現を保存形式へ
固定するか、既存Prompt Source向けManifestへ意味のないplaceholder provenanceを
入れることになる。どちらも避ける。

したがって第二実装では、artifact保存や対応構文拡張より先に、次を証明する。

> 同じCanonical Type IRから、現行WasmContract、JSON Schema、型一覧を含む短い実装仕様を生成でき、optional・`null`・明示的`undefined`・closed enumの差を失わない。

これは、L-Langをプログラミング言語間のSemantic Mapping Layerとして扱うための
最小の基盤である。

## 2. 仮説

### H2-A：Frontend固有型をbackend境界から除ける

TypeScript Type Providerが`ts.Type`やAST nodeを外へ漏らさず、version付きの
Canonical Type IRを返せる。Restricted TypeScript importerは、そのIRだけを
Wasm contract生成へ渡せる。

### H2-B：現在扱うnullish差を保持できる

required、optional、nullable、明示的`undefined`、open string、closed string enumを
別々の状態として保持し、hashとprojectionの差として観測できる。

### H2-C：backend移行で既存の実行意味を変えない

第一実装で受理した二つ以上のPredicateについて、旧`TypeSchema`経由と
Canonical Type IR経由で、WasmContract、Wasm bytes、実行結果が一致する。

### H2-D：JSON Schemaの表現限界を隠さない

JSONには`undefined`が存在しない。JSON Schema projectionはこの差をoptionalへ
黙って潰さず、`requires-host-adapter`と診断を返す。標準schemaだけでlosslessと
表現できる場合に限り`lossless`とする。

### H2-E：仕様表示は決定的なprojectionとして成立する

型一覧とPredicate IRから短いMarkdownを生成できる。ただし、その文章は
「既存実装の説明」であり、Intentや業務要求の正しさを証明するものではない。

## 3. 完成時の縦断

```text
TypeScript type
  -> TypeScript Type Provider
  -> Canonical Type IR v1
       ├─-> predicate-i32-v1 WasmContract
       ├─-> JSON Schema projection + mapping status
       └─-> deterministic implementation specification

TypeScript return expression
  -> Predicate IR
  -> typed compatibility validation
  -> existing Wasm Core / emitter
```

Canonical Type IRはWasmContractの別名ではない。意味上の型を保持し、WasmContractは
特定profileのABIへ必要なfield、state、enum encodingを表す。

## 4. Scope

### 実装するもの

- version付きCanonical Type IR v1
- strict parser、resource limit、canonical ordering
- 既存`TypeSchema`からCanonical Type IRへのTypeScript Provider mapping
- mapping結果と分類済みdiagnostic
- Canonical Type IRから現行`WasmContract`への変換
- 旧経路と新経路のcontract・Wasm bytes一致検証
- Canonical Type IRのhash
- JSON Schema Draft 2020-12 projection
- JSONで表現不能な`undefined`のmapping status
- Canonical Type IRとPredicate IRからの短いMarkdown仕様表示
- `hybrid inspect-ts`へのcanonical typeとprojection追加
- 二つ以上のPredicateを使った局所・統合テスト
- H1 example、README、結果文書の更新

### 今回実装しないもの

- number、integer width、float、NaN、signed zero
- array、tuple、map、nested record
- arbitrary string comparison、pattern、format、length refinement
- structured output、複数戻り値
- ZodまたはTypeScript declarationのcode generation
- JSON Schemaからの逆変換
- Rust、OpenAPI、JSON Schema等の追加Type Provider
- imported TypeScript type
- H1の対応expression grammar拡張
- new Wasm ABI、linear memory、string value transport
- Resolution Lock、Build Manifest、Capability Packageの新形式
- artifact保存・配布CLI
- natural-language Requirement Contract生成
- SAAA、Coding Agent、live modelとの接続
- Sourceや仕様Markdownの自動書き換え
- 新規dependency

## 5. Canonical Type IR v1

### 5.1 初期schema

新規候補`src/canonical-type-ir.ts`に、次の型とstrict parserを置く。

```typescript
export type CanonicalPredicateType = {
  version: 1;
  kind: "record";
  fields: CanonicalPredicateField[];
};

export type CanonicalPredicateField = {
  name: string;
  presence: "required" | "optional";
  nullability: "non-null" | "nullable";
  undefinedValue: "forbidden" | "allowed";
  value:
    | { kind: "boolean" }
    | { kind: "open-string"; encoding: "utf-8" }
    | { kind: "closed-string-enum"; values: string[] };
};
```

このschemaは現在のPredicate profileに必要な意味だけを持つ。将来型を予告する
optional fieldを置かず、version 1のunknown keyは拒否する。

### 5.2 不変条件

- top-levelは一つのrecord
- fieldは一件以上、64件以下
- field名は有効なidentifier
- field名は一意でlexicographic order
- closed enumは一件以上、256件以下
- enum valueは一意でlexicographic order
- enum valueとfield名は既存resource limitを超えない
- `open-string`のencodingは初期版では`utf-8`だけ
- unionはIRへ残さず、nullish属性とvalue typeへ分解する
- boolean literal unionの`true | false`は`boolean`へcanonicalizeする
- string literal unionはclosed enumへcanonicalizeする
- number literalやmixed unionは拒否する

parserは既存`parseContract`と同様、unknown field、重複、非canonical orderを
成功扱いにしない。

### 5.3 Hash

```typescript
export function canonicalTypeHash(type: CanonicalPredicateType): string;
```

hashはstrict parserを通した値を`stableJson`でcanonicalizeしてSHA-256を取る。
source path、TypeScript type名、AST text、declaration order、Compiler API内部ID、mtimeは
含めない。optional、nullable、undefined許可、enum、field名の変更はhashへ反映する。

## 6. TypeScript Type Provider

新規候補`src/typescript-type-provider.ts`へ、既存`TypeSchema`を入力とする狭い
adapterを置く。

```typescript
export type TypeMappingDiagnostic = {
  code:
    | "TOP_LEVEL_NOT_RECORD"
    | "UNSUPPORTED_FIELD_TYPE"
    | "NESTED_RECORD"
    | "NUMBER_REQUIRES_PROFILE"
    | "ARRAY_REQUIRES_PROFILE"
    | "MIXED_UNION"
    | "EMPTY_VALUE_SET";
  path: string[];
  message: string;
};

export type CanonicalTypeMapping =
  | {
      status: "lossless";
      provider: "typescript";
      type: CanonicalPredicateType;
      diagnostics: [];
    }
  | {
      status: "unsupported";
      provider: "typescript";
      type: null;
      diagnostics: TypeMappingDiagnostic[];
    };
```

初期版は`lossy`を成功結果として返さない。意味を落とせば現profileに入る型でも、
`unsupported`として止める。

既存`buildTypeSchema`はTypeScript Compiler APIからの抽出層として残す。
Provider adapterがそれをCanonical Type IRへ変換する。H2中に`buildTypeSchema`全体を
書き換えたり、既存semantic scannerの返却型を変更したりしない。

### Mapping規則

| TypeSchema | Canonical Type IR |
| --- | --- |
| object property | record field |
| `optional: false` | `presence: "required"` |
| `optional: true` | `presence: "optional"` |
| `null` union member | `nullability: "nullable"` |
| `undefined` union member | `undefinedValue: "allowed"` |
| boolean / `true \| false` | `value.kind: "boolean"` |
| string | `value.kind: "open-string"` |
| string literal union | `value.kind: "closed-string-enum"` |
| number / number literal | `NUMBER_REQUIRES_PROFILE` |
| array | `ARRAY_REQUIRES_PROFILE` |
| nested object | `NESTED_RECORD` |
| mixed primitive union | `MIXED_UNION` |

`optional`とunion内`undefined`は統合しない。前者はfieldの存在、後者は明示値の
状態として別々に保持する。

## 7. WasmContractへのlowering

`src/wasm-core.ts`に次のentry pointを追加する。

```typescript
export function contractFromCanonicalType(
  type: CanonicalPredicateType,
): WasmContract;
```

変換規則は現行`contractFromType`と一致させる。

| Canonical | Wasm field |
| --- | --- |
| boolean | `kind: "boolean"` |
| open string | `kind: "string"` |
| closed string enum | `kind: "enum"` |
| nullable | `nullable: true` |
| undefined allowed | `undefinable: true` |
| optional | `optional: true` |

Restricted TypeScript importerは、新経路から生成したcontractを`lowerPredicate`へ渡す。
移行中も旧`contractFromType`は削除しない。二つの経路でcontractやWasm bytesが
異なる場合、新経路を正しいものとして黙って採用せず統合テストを失敗させる。

## 8. JSON Schema projection

新規候補`src/canonical-type-json-schema.ts`に、次のprojectionを置く。

```typescript
export type JsonSchemaProjection = {
  version: 1;
  dialect: "https://json-schema.org/draft/2020-12/schema";
  status: "lossless" | "requires-host-adapter";
  schema: Record<string, unknown>;
  diagnostics: Array<{
    code: "EXPLICIT_UNDEFINED_NOT_JSON";
    path: string[];
    message: string;
  }>;
  hash: string;
};
```

projectionはtop-level object、properties、required、nullable、enum、boolean、string、
`additionalProperties: false`、canonical version用`x-l-lang-*` extensionを生成する。

JSONとJSON Schemaには明示的`undefined`がない。Canonical fieldに
`undefinedValue: "allowed"`が一つでもある場合は次を行う。

- `status: "requires-host-adapter"`を返す
- field path付き`EXPLICIT_UNDEFINED_NOT_JSON`を返す
- `undefined`と欠損が同じ意味であるとは記述しない
- extensionにcanonical情報を残す
- 標準JSON Schemaだけでlosslessであると主張しない

projectionはinspection上の成功だが、そのschemaだけを完全な入力契約とは扱わない。
既存dependencyのAjvをテストに利用し、JSON-compatible caseについてschemaと
`encodeInput`の合否を比較する。`undefined` caseはhost adapterが必要な別caseとする。

## 9. 短い実装仕様のprojection

新規候補`src/hybrid-specification.ts`にMarkdown rendererを置く。入力はfunction名、
parameter名、Canonical Type IR、Predicate IR、JSON Schema projectionに限定する。

出力は次を含む。

- `Implementation-derived specification`という明示ラベル
- function名とinput parameter名
- field、value type、required/optional、nullable、undefined許可の表
- 既存`renderInterpretedJudgement`を利用した判定木
- JSON Schema mapping statusとdiagnostic要約
- 要求の正しさを証明しないという固定注記
- renderer versionとcontent hash

自然言語Intent、業務上の目的、要求ID、例外理由を命名から推測しない。Markdownは
別ファイルへ自動保存せず、初期版ではinspection JSON内のprojectionとして返す。

## 10. Importer APIとCLI

### Library API

既存`ImportedTypeScriptPredicate`へ次を追加する。

```typescript
input: {
  parameterName: string;
  typeName: string;
  schema: TypeSchema; // H2では互換用に維持
  canonicalType: CanonicalPredicateType;
  canonicalTypeHash: string;
  mapping: {
    provider: "typescript";
    status: "lossless";
    diagnostics: [];
  };
};
projections: {
  jsonSchema: JsonSchemaProjection;
  specification: {
    version: 1;
    format: "markdown";
    status: "implementation-description";
    content: string;
    hash: string;
  };
};
```

H2では既存`input.schema`を削除しない。`semanticHash`も`profile + contract + body`の
hashとして維持する。Canonical Type IRの識別には`canonicalTypeHash`を使う。

### CLI

既存commandを維持する。

```bash
bun run hybrid inspect-ts <source.ts> --function <export-name>
```

成功JSONへcanonical type、hash、mapping、projectionsを追加する。CLIは引き続き
model・network・Binaryenを読み込まず、source、Lock、artifactを書かない。
`apiCalls: 0`、`writes: 0`を維持する。

JSON Schemaが`requires-host-adapter`でもinspection自体は成功する。そのstatusを
warning textだけにしたり、`lossless`へ書き換えたりしない。

## 11. Error契約

新規候補`CanonicalTypeError`は次のcodeを持つ。

- `INVALID_CANONICAL_TYPE`
- `NON_CANONICAL_ORDER`
- `DUPLICATE_FIELD`
- `UNSUPPORTED_TYPE_MAPPING`
- `MAPPING_LOSS_DETECTED`
- `PROJECTION_FAILED`

TypeScript source位置を持つエラーは既存`TypeScriptImportError`へ変換し、relative path、
line、columnを維持する。canonical parser単体のエラーは`fields[2].value`のような
field pathを返す。絶対path、source全文、Compiler API object、stack、environment値は
通常messageへ含めない。

JSON Schemaの`requires-host-adapter`はerrorではなく明示的なprojection statusである。

## 12. 変更対象

### 新規候補

| ファイル | 責務 |
| --- | --- |
| `src/canonical-type-ir.ts` | Canonical Type IR型、strict parser、hash |
| `src/canonical-type-ir.test.ts` | 不変条件、canonical order、hash |
| `src/typescript-type-provider.ts` | TypeSchemaからCanonical Type IRへのmapping |
| `src/typescript-type-provider.test.ts` | lossless / unsupported mapping |
| `src/canonical-type-json-schema.ts` | JSON Schema projectionとstatus |
| `src/canonical-type-json-schema.test.ts` | Ajv合否、undefined差、決定性 |
| `src/hybrid-specification.ts` | deterministic Markdown renderer |
| `src/hybrid-specification.test.ts` | 型表、判定木、固定注記、snapshot |
| `src/hybrid-canonical.integration.test.ts` | 旧新contract・Wasm・実行結果一致 |
| `docs/HYBRID_COMPILER_SECOND_IMPLEMENTATION_RESULTS.md` | 実測結果と未実施事項 |

### 変更候補

| ファイル | 変更 |
| --- | --- |
| `src/typescript-predicate-importer.ts` | canonical mappingとprojectionを追加 |
| `src/wasm-core.ts` | `contractFromCanonicalType`追加 |
| `src/hybrid-cli.ts` | 追加projectionを成功JSONへ含める |
| `src/hybrid-cli.test.ts` | JSON契約、status、read-only性を確認 |
| `examples/hybrid-order/README.md` | canonical contractとschema statusを説明 |
| `docs/HYBRID_COMPILER_CONCEPT.md` | 実装結果後だけH2の現行対応を更新 |

`ir.ts`、`wasm-contract.ts`、`wasm-emitter.ts`、`wasm-runtime.ts`、既存Lock、Manifest、
Capability Packageのschemaは変更しない。

## 13. 実装順序

### I0：H1 baselineの固定

1. H1変更をreview可能なcommitまたは明示snapshotとして固定する。
2. dirty worktreeにH2変更を混ぜる前に対象fileとhashを記録する。
3. H1 targeted testを再実行する。
4. 二つのexampleのinspection JSON、contract、semantic hash、Wasm hashを保存する。
5. 現在の全品質Gateを再実行する。

```bash
bun test src/typescript-predicate-importer.test.ts \
  src/typescript-predicate-importer.integration.test.ts \
  src/hybrid-cli.test.ts \
  src/wasm-core.test.ts
```

完了条件：H1由来の失敗とH2変更の失敗を区別できる。

### I1：Canonical Type IR parser

1. 第5節の型を実装する。
2. unknown key、重複、非canonical order、limit超過を拒否する。
3. parser後の値だけをhashする。
4. nullish属性とenum変更でhashが変わるテストを置く。

完了条件：TypeScript Compiler APIなしでparse、hashできる。

### I2：TypeScript Provider mapping

1. objectをrecordへ変換する。
2. nullとundefinedをvalue unionから分離する。
3. boolean literal unionとstring literal unionをcanonicalizeする。
4. declaration orderをcanonical orderへする。
5. number、array、nested object、mixed unionを分類して拒否する。
6. importerの位置情報へmapping diagnosticを接続する。

完了条件：H1対応型が`lossless`になり、未対応型が近似されずに止まる。

### I3：Wasm contract経路の切り替え

1. `contractFromCanonicalType`を追加する。
2. importerだけを新経路へ切り替える。
3. 旧新contract object、field order、enum encodingを比較する。
4. 同じPredicate IRから生成したWasm bytesを比較する。

完了条件：H1 fixtureでcontract、semantic hash、Wasm hash、実行結果が変わらない。

### I4：JSON Schema projection

1. Draft 2020-12 object schemaを決定的に生成する。
2. required、nullable、enum、boolean、open stringを投影する。
3. explicit undefinedに`requires-host-adapter`を付ける。
4. extensionとdiagnosticへfield pathを残す。
5. JSON-compatible caseをAjvと`encodeInput`で比較する。
6. 欠損、null、空文字、unknown fieldを独立caseで確認する。

完了条件：表現可能範囲の合否が一致し、表現不能差がstatusで見える。

### I5：仕様表示

1. Canonical field tableをrenderする。
2. 既存judgement rendererで条件木をrenderする。
3. JSON Schema statusとdiagnosticをrenderする。
4. implementation-derivedである固定注記を付ける。
5. path、format、mtimeに依存しないsnapshotを固定する。
6. Intentを推測していないことをnegative testで確認する。

完了条件：同じcanonical typeとIRから同じMarkdownとhashが得られる。

### I6：ImporterとCLI統合

1. importer出力へcanonical type、hash、mapping、projectionを追加する。
2. CLI成功JSONを更新する。
3. API keyを空にした別processで実行する。
4. 実行前後でsourceとtracked artifactが変わらないことを確認する。
5. dependency graphにBinaryen、model client、Lock writerがないことを確認する。

完了条件：一つの結果で型の正本、Wasm契約、JSON projection、実装仕様を比較できる。

### I7：意味一致と差分検出

二つ以上のPredicateについて、H1 expected、元TypeScript、Predicate IR evaluator、
旧TypeSchema由来Wasm、Canonical Type IR由来Wasmを比較する。

さらにrequired/optional、nullable、undefined許可、enum値、open string/closed enum、
field renameのmutationがhashまたはprojection差分として検出されることを確認する。

完了条件：意味を変えない移行では結果とbytesが一致し、型意味の変更はhashへ現れる。

### I8：全検証と結果記録

1. targeted testと全品質Gateを実行する。
2. macOS、Ubuntu、Windows CIを確認する。
3. JSON Schema mapping statusの実測を記録する。
4. H1との差分、未実施事項、失敗を結果文書へ残す。
5. 実測後にだけコンセプトのH2状態を更新する。

完了条件：未実施OSやfailed Gateを成功として記載しない。

## 14. テスト計画

| 境界 | 主なテスト |
| --- | --- |
| parser | unknown key、空field、重複、非canonical order、limit |
| hash | path・format非依存、nullish・enum差で変化 |
| provider | boolean、enum、open string、optional、null、undefined |
| unsupported | number、array、nested record、mixed union |
| backend | 旧新WasmContract一致、Wasm bytes一致 |
| JSON Schema | required、nullable、enum、unknown field、Ajv合否 |
| projection loss | explicit undefinedを`requires-host-adapter`として報告 |
| specification | field table、判定木、固定注記、決定的hash |
| CLI | JSONのみ、API 0、writes 0、credentials不要 |
| regression | H1の元TS・IR・Wasm・expected一致 |

### Failure behavior

- unsupported typeからpartial Canonical Type IRを返さない
- unknown canonical keyを黙って無視しない
- enumをopen stringへ広げて成功させない
- optionalとundefinedを統合しない
- JSON Schemaの限界をwarning文字列だけにせずstatusへ入れる
- mapping diagnosticがあるのに`lossless`を返さない
- backend差分が出た場合にgoldenを無条件更新しない
- specification rendererがIntentや要求を捏造しない
- projection失敗後にSource、Lock、artifactを書かない
- CLIの成功stdoutへwarningや進捗を混ぜない

### 全品質Gate

[品質Gate正本](../QUALITY_GATES.md)に従い、次を実行する。

```bash
bun install --frozen-lockfile
bun audit
bun run format:check
bun run lint
bun run ci:docs
bun run typecheck
bun test
bun run coverage
bun run ci:smoke
bun run ci:protected
git diff --check
```

coverage、test数、実行時間は計画へ固定値として複製せず、同一commitの結果文書または
CI evidenceを正本とする。

## 15. Compatibility方針

- H1の受理・拒否syntax、`sourceHash`、`semanticHash`を変更しない。
- 既存`TypeSchema`と`contractFromType`はH2では削除しない。
- 既存semantic、prompt、wasm、capability CLIの既定動作を変更しない。
- Wasm ABI、export名、compiler/backend version、optionsを変更しない。
- JSON Schemaを既存Manifestへ埋め込まない。
- Markdown specificationは保存される正本にしない。

inspection JSONの追加fieldが外部consumerへ影響する場合は、実装前にconsumerを列挙し、
version bumpまたは別commandが必要か判断する。consumer不明のまま破壊的変更を行わない。

## 16. Non-goals、禁止、要相談

### Non-goals

- Canonical Type IR v1を全言語共通の完成形と主張しない
- JSON SchemaをL-Langの意味の正本にしない
- TypeScript `number`を`i32`へ自動変換しない
- 仕様表示を要求や受け入れ証拠にしない
- H2だけでartifact配布可能と主張しない

### 禁止事項

- `any` castでProviderの型不一致を隠さない
- undefined、null、欠損を一つのoptionへ畳まない
- closed enumを単なるstringとして保存しない
- unsupported mappingを空recordやstringへfallbackしない
- JSON Schema extensionを標準validatorが理解すると仮定しない
- H1 goldenを新出力へ合わせるだけで意味一致を省略しない
- importerから対象moduleを実行しない
- build、inspect、projectionでmodelを暗黙に呼ばない
- 新しいLockやManifestへplaceholder hashを入れない

### 要相談事項

- number widthとoverflow規則
- nested recordとnested property
- arbitrary string value transport
- array、tuple、map
- refinement、pattern、format、length
- alias、recursive type、intersection、brand
- JSON SchemaからCanonical Type IRへの逆変換
- Canonical Type IRの永続artifact化
- public inspection APIのbreaking version change
- Zod code generation
- structured output用のWasm memory ABI

## 17. 中止・見直し条件

次のいずれかが判明した場合、実装をそのまま進めず計画を見直す。

- H1で受理済みの型をCanonical Type IR v1がlosslessに表現できない
- 新経路でWasmContractまたはWasm bytesが変わり、既存経路のbugと証明できない
- `TypeSchema`利用箇所の一括migrationが必要になり、H2の局所変更を超える
- JSON Schema projectionが独自extensionなしでは誤用を避けられない
- CLI field追加に既存外部consumerのbreaking impactがある
- 新規dependencyなしではDraft 2020-12検証が成立しない
- Canonical Type IRとWasmContractが実質同じ構造になり、独立層の価値を示せない

中止時はpartial migrationを残さず、調査結果と選択肢を結果文書へ記録する。

## 18. 完了チェックリスト

- [ ] H1 baselineと対象commitが固定されている
- [ ] Canonical Type IR v1のstrict parserがある
- [ ] fieldとenum orderingがcanonicalである
- [ ] optional、nullable、undefinedが別状態である
- [ ] TypeScript Providerが対応型をlosslessにmappingする
- [ ] unsupported型を分類して拒否する
- [ ] importer backendがCanonical Type IR経由になっている
- [ ] 旧新WasmContractとWasm bytesが一致する
- [ ] JSON Schema projectionにstatusとdiagnosticがある
- [ ] explicit undefinedをlossless JSONと主張しない
- [ ] 短い仕様表示が決定的に生成される
- [ ] 仕様表示がimplementation-derivedと明示される
- [ ] H1の四経路意味一致が維持される
- [ ] CLIがAPI 0、writes 0で動く
- [ ] 新規dependency、ABI、Lock、Manifest変更がない
- [ ] 全品質Gateが成功している
- [ ] macOS、Ubuntu、Windowsの結果が記録されている
- [ ] 結果文書に制限と次の判断材料が残っている

## 19. H2完了後の判断

H2後は、利用実績に基づいて次の一つを選ぶ。

### A：artifact化

imported Predicateの保存・再利用が先なら、Canonical Type hash、Semantic IR hash、
source hash、toolchainを連結する専用Resolution / Build Manifestを設計する。

### B：Zod projection

TypeScript hostでの利用が先なら、Canonical Type IRの共通部分だけからZod codeを
生成する。refine、transform、custom functionの相互変換は対象外とする。

### C：H3 Structured Output

boolean以外の小さなrecord結果が必要なら、新しいoutput contract、Wasm ABI、buffer、
ownershipを独立計画として設計する。

### D：追加Type Provider

JSON Schema、OpenAPI、Rust型等の具体的要求が先なら、H2のmapping statusを使い、
差を潰さずにProviderを追加する。

いずれの場合も型の表現力を先回りして拡張しない。まず現在のrestricted Predicateで
Frontend → Canonical Type IR → projection / backendの境界を固定する。
