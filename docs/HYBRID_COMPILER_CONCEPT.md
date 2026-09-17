# Hybrid Compiler Concept

## Status

2026-09-16。L-Langの既存実装と、SAAA・Coding Agent・Wasm能力製造に関する検討を統合した将来コンセプト。

最初の縦断として、同一ファイル内のTypeScript型と制限されたpure Predicateを、対象moduleを実行せずにPredicate IRとWasm入力契約へ変換する`Restricted TypeScript Predicate Import`を実装した。続いて、その対応型をCanonical Type IR v1へ正規化し、同じ契約から既存WasmContract、JSON Schema、短い実装仕様を投影するH2を実装した。範囲、検証結果、未実施事項は[第一実装結果](./HYBRID_COMPILER_FIRST_IMPLEMENTATION_RESULTS.md)と[第二実装結果](./HYBRID_COMPILER_SECOND_IMPLEMENTATION_RESULTS.md)を参照する。これらの結果は任意TypeScript対応を意味しない。

第三の縦断として、取り込んだPredicateを再現可能な成果物として保存し、portable検証と
再build検証を行うH2.5を実装した。範囲と検証結果は
[第三実装計画](./HYBRID_COMPILER_THIRD_IMPLEMENTATION_PLAN.md)と
[第三実装結果](./HYBRID_COMPILER_THIRD_IMPLEMENTATION_RESULTS.md)を参照する。これは
Structured Outputや型の対応範囲を広げる実装ではない。

本書は、現在の実装済み範囲と今後の拡張方向を区別しながら、L-Langを「自然言語からコードを生成するコンパイラ」だけではなく、**会話上の要求、プログラミング言語固有の型、実行可能な意味、portableな成果物を結ぶHybrid Compiler**として定義する。

構文、CLI、schemaの確定仕様や実装計画ではない。現在の正本はコードとテストであり、個別の実装範囲は各結果文書を参照する。

## 1. 定義

Hybrid Compilerは、次の複数の入口を、一つの検証可能な意味表現へ収束させる。

- SAAAのような会話エージェントが整理した目的・要求・受け入れ条件
- TypeScriptに存在する型、限定されたpure function、既存テスト
- Coding Agentがプロジェクト文脈へ対応付けたSourceと検証候補
- JSONなどの構造化されたPrompt Source

これらを直接Wasmへ変換するのではなく、言語非依存の契約とIRへ正規化する。

```text
会話上の要求 ───────────────┐
                              │
TypeScript型・限定式 ────────┼─→ Canonical Contract / IR
                              │              │
Prompt Source ───────────────┘              │
                                             ├─→ TypeScript
                                             ├─→ Wasm
                                             ├─→ 仕様表示
                                             ├─→ Test IR
                                             └─→ Host Adapter
```

中心となる定義は次のとおりである。

> Hybrid Compilerは、自然言語の意味とプログラミング言語の型を、検証可能な言語非依存IRへ対応付け、決定的なbackendとadapterを通して実行可能な能力へ変換するSemantic Mapping Layerである。

## 2. 解こうとする問題

同じ業務上の意味でも、プロジェクトや言語によってデータ構造と実装方法は異なる。

```text
Storefront TypeScript:
  order.paymentStatus === "paid"

Warehouse Rust:
  request.payment_captured == true

Legacy record:
  row.payment_code == 2
```

三つの条件式は構造上は異なるが、「支払いが確認済みである」という意味を共有し得る。現在は、その意味、型、入力検証、ドキュメント、テスト、配布形式を環境ごとに別々に保守することが多い。

Hybrid Compilerは、再利用する中心資産を個別の条件式から次へ移す。

- 安定したConcept・Capability ID
- 入出力のCanonical Contract
- 識別子付きの意味要求
- Project固有型へのbinding
- 言語非依存のSemantic IR
- 独立した受け入れ条件と検証記録

これにより、同じ意味を異なる型へ適応し、複数の実行形式へ変換できるようにする。

## 3. 製品仮説

利用者が最初に書くものは、完全なプログラムでも長い仕様書でもない。

```text
注文が出荷可能か判定する。
支払い済みで、在庫を確保できていて、保留・キャンセルされていない注文を対象とする。
```

SAAAは会話から不足事項を確認し、要求を安定ID付きの契約へ整理する。Coding Agentは既存のTypeScript型、テスト、命名、制約へ対応付ける。L-LangはSourceを解析してIRへ解決し、型・テスト・制約を検査する。検証済みのIRから、通常のTypeScriptまたはWasmを決定的に生成する。

目指す利用体験は次である。

```text
意図を短く伝える
  ↓
不足する意味だけ会話で確認する
  ↓
型付きのSource兼仕様を確認する
  ↓
独立した検証を通す
  ↓
portableな能力として保存・利用する
```

自然言語は追加の仕様書作業ではなく、型・実装・検証をまとめて作る入口になる。

## 4. 三者の責務

### 4.1 SAAA・会話エージェント

SAAAは、ユーザーの目的を実装詳細へ早期に潰さず、次を整理する。

- 何を達成したいか
- どの状況で利用するか
- どの状況では利用しないか
- 必須条件、禁止条件、希望条件
- 失敗、判断不能、入力不正の扱い
- 受け入れ条件と非公開シナリオ
- 利用権限、予算、配備方針

SAAAは受け入れ条件と配備判断を所有する。候補が通るように期待値を変更しない。

### 4.2 Coding Agent

Coding Agentは、freezeされた要求をプロジェクトの現実へ対応付ける。

- 既存TypeScript型とschemaの探索
- Concept roleとpropertyのbinding
- L-Lang Source候補の作成
- 実装IRと部品テストの独立製造
- Wasm生成と部品検証
- 対応不能・曖昧・Exact Codeが必要な箇所の報告

Coding Agentは、要求の意味を実装しやすい内容へ暗黙に変更しない。意味変更が必要な場合は、要求ID付きの変更提案としてSAAAへ返す。

### 4.3 L-Lang

L-Langは、エージェント間の文章を信頼して成功扱いにせず、次を機械的に扱う。

- Sourceとschemaの厳格parse
- 型抽出とCanonical Type IRへの正規化
- Semantic IRとTyped Core IRの検証
- Source、型、IR、テスト、成果物のhash対応
- Test IR、TypeScript、Wasm、adapterの決定的生成
- 未対応型、曖昧なbinding、不正ABIの拒否
- Lock、Manifest、検証記録の保存

LLMは意味の候補を提案できるが、物理ABI、メモリ配置、Wasm命令列、成果物の合否を自由文で決定しない。

## 5. Source兼仕様

Hybrid Compilerでは、L-Lang Sourceを単なるコンパイラ入力ではなく、**Executable Specification**として扱う。

Sourceには少なくとも次を保持する。

- Capability IDとversion
- Intent
- 入力と出力の契約
- 安定した要求ID
- 必須・禁止・希望の区分
- Out of scope
- Unresolved条件
- public example
- profileとeffect制約
- 親要求のrevisionとhash

概念上の表現は次のようになる。これは確定したTypeScript構文ではない。

```typescript
type Order = {
  paymentStatus: "paid" | "pending" | "failed";
  inventoryStatus: "reserved" | "unavailable";
  status: "open" | "on-hold" | "cancelled";
};

const ShippableOrder = capability<Order, boolean>({
  id: "order.shippable",
  intent: "注文が出荷可能か判定する。",
  requirements: {
    "payment-confirmed": "支払い済みであること。",
    "inventory-reserved": "在庫が確保されていること。",
    "not-on-hold": "保留中ではないこと。",
    "not-cancelled": "キャンセル済みではないこと。",
  },
  unresolvedWhen: [
    "必要な状態が入力契約から一意に判定できない場合。",
  ],
});
```

仕様書は別のLLM出力として再生成しない。SourceとContract IRから、条件表、schema、例、trace、差分を決定的にrenderする。生成された仕様表示は正本のprojectionであり、第二の正本ではない。

## 6. 一つのファイルではなく、連結された正本

要求から配備までを一ファイルへ詰め込まない。各主体が所有する正本をhashで連結する。

| 資産 | 所有者 | 表すもの |
| --- | --- | --- |
| Requirement Contract | SAAA | 目的、要求、受け入れ方針 |
| L-Lang Source | Coding Agentが提案、L-Langが検査 | 型付きの実行仕様 |
| Canonical Type IR | L-Lang | 言語固有型を正規化した構造 |
| Semantic IR | L-Lang resolver | 要求を解決した実行意味 |
| Resolution Lock | L-Lang | Source・型・IR・resolverの固定結果 |
| Build Manifest | backend | IR・ABI・toolchain・成果物の対応 |
| Capability Package | 製造処理 | Source、Lock、Wasm、テスト、metadata |
| Acceptance Record | SAAA | 対象hashに対する利用目的上の合否 |

```text
Requirement hash
  ↓
Source hash
  ↓
Type IR hash + Semantic IR hash
  ↓
Resolution Lock
  ↓
Wasm / Manifest / Package hash
  ↓
Acceptance Plan hash + Result
```

LockはSourceの代替ではない。Wasmは意味の正本ではない。受け入れ結果は別hashの候補へ流用しない。

## 7. 複数のFrontend

### 7.1 Intent-first frontend

SAAAが会話からRequirement Draftを作り、未解決質問を減らしてからrevisionをfreezeする。Coding Agentが型とbindingを補い、L-Lang Sourceへ昇格させる。

SAAAが確認するのは、意味に影響する不足に限定する。

- 複数のfieldが同じrole候補になる
- 境界値の扱いが決まらない
- 要求と例が矛盾する
- 必要な情報が入力型に存在しない
- 既存仕様との互換性を壊す
- `must`と`should`の区別が不明

情報不足を推測で埋めず、`unresolved`または要求変更提案を返せるようにする。

### 7.2 TypeScript DSL frontend

既存のTypeScript DSLは、型、Concept、binding、Semantic Testを同一sourceで扱うfrontendである。TypeScriptは次を提供する。

- IDE補完と参照検索
- 既存型への接続
- typed example
- module境界
- Exact Codeとの組み合わせ
- Git上の差分とreview

TypeScript固有のASTをCanonical IRへ漏らさない。TypeScriptは有力なauthoring frontendであり、内部意味モデルそのものではない。

### 7.3 Prompt Source frontend

Prompt Sourceは、TypeScript DSLを必要とせず、自然言語要求、明示契約、例、profileを構造化データとして扱う。Agentによる局所更新と、要求ID・revisionによる競合検出に適する。

### 7.4 Restricted TypeScript import frontend

既存コードから移行するため、限定されたpure TypeScript関数をSemantic IRへloweringするfrontendを将来追加できる。

```typescript
function canShip(order: Order): boolean {
  return (
    order.paymentStatus === "paid" &&
    order.inventoryStatus === "reserved" &&
    order.status !== "on-hold" &&
    order.status !== "cancelled"
  );
}
```

対象は次に制限する。

- pureで決定的
- 単一または明示契約された入力
- 対応済みのproperty accessとoperatorのみ
- 外部mutable stateを参照しない
- I/O、async、exception、reflectionを使用しない
- 対応範囲内で停止が保証される

未対応構文は意味を推測せず`UNSUPPORTED_SYNTAX`として拒否する。

コードから生成した自然言語仕様は、既存実装の説明案であり、本来あるべき要求の証明ではない。SAAAまたはユーザーがIntentと照合してからSourceへ昇格させる。

## 8. Type ProviderとCanonical Type IR

各言語の型は直接Wasm ABIへ変換しない。Type ProviderがCanonical Type IRへ正規化する。

```text
TypeScript Type Provider ─┐
Rust Type Provider       ├─→ Canonical Type IR
OpenAPI Provider         ┤
JSON Schema Provider ────┘
```

Canonical Type IRは、少なくとも次を区別する。

- boolean、整数幅、浮動小数点
- closed enumとopen string
- record、array、tuple
- required、optional、undefined
- nullable
- 文字列のencodingと長さ制約
- property名とsemantic role
- 将来のownership、lifetime、effect情報

言語ごとの差を根拠なく潰さない。

- TypeScriptの`number`を自動的に`i32`へしない
- `null`、`undefined`、field欠損を同じoptionへしない
- enumと任意文字列を同一視しない
- JavaScriptのcoercionをWasm側へ暗黙移植しない
- 変換不能なrefinementを検証済みとして扱わない

mappingには次の状態を記録する。

- `lossless`
- `lossy`
- `unsupported`
- `requires-host-adapter`
- `requires-exact-code`

lossy mappingは自動昇格せず、失われる情報と影響する要求IDを示す。

## 9. Semantic Contract、Semantic IR、Typed Core IR

三つの層を分離する。

### Semantic Contract

人間が確認する意味の契約。Intent、要求、除外、未解決条件、型、例、effect制約を保持する。

### Semantic IR

要求をProject固有の型へ解決した言語非依存表現。例えば`equals`、`present`、`all`、`any`、`not`を保持する。

### Typed Core IR

backendが実行表現へloweringする直前の型付き操作。物理ABIやWasm命令列とは分離する。

```text
Semantic Contract
  ↓ binding / resolution
Semantic IR
  ↓ type・effect検証
Typed Core IR
  ↓ ABI lowering
Wasm Core
  ↓ deterministic emission
Wasm
```

LLMが担当できるのは、Contractの構造化、binding候補、合法なSemantic IR候補、曖昧さの検出までである。Typed Core IR以降は決定的なcompilerが所有する。

## 10. BackendとHost Adapter

### Backend

Backendは、検証済みIRから実行成果物を生成する。

- TypeScript backend
- Wasm backend
- 将来のRust、SQL、policy engine等の限定backend

言語間を直接変換しない。

```text
TypeScript → Rust
TypeScript → Wasm
Rust → TypeScript
```

という組み合わせごとの変換ではなく、次へ統一する。

```text
各Frontend → Canonical IR → 各Backend
```

### Host Adapter

Host Adapterは、ホスト言語の値とWasm ABIの間を変換する。

- 入力schemaのruntime検証
- enumのtag化
- 欠損、null、undefinedの状態表現
- 文字列・arrayを導入する場合のmemory、encoding、ownership
- outputとerrorの復元
- Manifest、export、artifact hashの照合

業務上の判定をadapter側で先に計算しない。adapterは表現変換を担当し、意味実行はWasmへ残す。

## 11. 「プログラミング言語のORM」という比喩

製品上の説明として、Hybrid Compilerは「実行可能な意味に対するORM」と捉えられる。

| ORM | Hybrid Compiler |
| --- | --- |
| Entity model | Canonical Type IR |
| Column mapping | field・semantic role binding |
| Query model | Semantic IR / Typed Core IR |
| SQL dialect | TypeScript・Wasm等のbackend |
| DB adapter | Host Adapter |
| Migration | Schema Evolution / Semantic Diff |
| ORM metadata | Source / Lock / Manifest |
| Validation | 型・Semantic Test・artifact検証 |

ただし、ORMと同一ではない。

- ORMは主にデータ構造と永続化を写像する
- Hybrid Compilerはデータ構造に加えて処理の意味を写像する
- mappingは常に双方向・可逆とは限らない
- 言語ごとに数値、欠損、文字列、例外、所有権の意味が異なる
- 副作用、権限、失敗回復は型変換だけでは表せない

したがって、技術的な名称は`Semantic Mapping Layer`または`Executable Contract Mapper`とし、ORMは利用者へ価値を説明する比喩として扱う。

## 12. 検証モデル

正しさを一つの「検証済み」でまとめない。

| 検証対象 | 主な確認方法 | 保証しないこと |
| --- | --- | --- |
| 要求の妥当性 | SAAAの会話、ユーザー確認 | ユーザーの意図を完全に形式化したこと |
| Contractの構造 | schema、型、stable ID、revision | 自然言語の意味が正しいこと |
| binding | 型検査、role候補、曖昧性検出 | 命名だけで業務意味が確定すること |
| Semantic IR | strict parser、型・effect検証 | 要求の誤解がないこと |
| Test IR | clause trace、Red、Mutation | 有限テストで全入力を証明すること |
| lowering | reference evaluator、差分試験、有限領域全列挙 | 未対応型への一般化 |
| Wasm | validation、ABI、import/export、hash | host全体の安全性と可用性 |
| 利用目的 | SAAAの独立受け入れ | 別の目的や別versionへの流用 |

例は用途別に分ける。

- `public example`: Sourceの意味説明と最低限の整合性確認
- `component test`: Coding Agentが製造する境界、性質、反例
- `held-out acceptance`: SAAAが候補へ事前公開しない利用シナリオ

提案に使った例を独立検証の証拠として再利用しない。

## 13. 変更とSchema Evolution

変更はSource全体の再生成ではなく、安定した要求IDとbinding IDに対するpatchとして扱う。

```text
「保留中も除外する」
  ↓
requirements.not-on-hold の追加または更新
  ↓
Contract diff
  ↓
Type binding diff
  ↓
Semantic IR diff
  ↓
Test obligation diff
  ↓
Wasm / Manifest / Packageの新hash
```

変更時には次を区別する。

- wordingのみで意味が同じ
- Project固有propertyのmapping変更
- 入力schemaのcompatible change
- 意味条件のbreaking change
- ABIのbreaking change
- 既存profileで表現不能

要求、型、IR、テスト、成果物のどれが変わったかを個別に表示する。

## 14. 現在の実装との対応

現在の`wasm-compiler`系実装とH1・H2は、Hybrid Compilerの最初の縦断に相当する。

| 概念 | 現在の対応 |
| --- | --- |
| TypeScript frontend | TypeScript DSLとCompiler APIによる型抽出 |
| TypeScript import frontend | 同一fileの限定pure boolean functionをPredicate IRへ静的lowering |
| Canonical Type IR | flat recordのboolean、open string、closed enum、optional、nullable、明示的undefined |
| Contract projection | Canonical Type IRからWasmContractとDraft 2020-12 JSON Schemaを生成 |
| Specification projection | Canonical Type IRとPredicate IRからimplementation-derived Markdownを生成 |
| Structured frontend | Prompt Source |
| Semantic Contract | Concept structure、type schema、要求条項 |
| Semantic IR | Predicate IR |
| Resolution Lock | `semantic.lock`とPrompt Source専用Lock |
| Typed/Wasm Core | memoryなしのboolean・enum・presence lowering |
| TypeScript backend | 決定的なPredicate generator |
| Wasm backend | Binaryenによるdirect emitter |
| Host Adapter | contract検証、ABI encoding、Wasm invoke |
| Capability Package | Source、Lock、Wasm、suite、reportの同梱 |
| Coding Agent | テストと実装の分離製造、限定修正 |
| SAAA接続 | inspect / verify / invoke用host kit。受け入れ・配備全体は未完了 |

現行Wasm profileは、flat record、boolean、closed enum、stringの存在状態、`all`、`any`、`not`、`equals`、`present`、boolean outputに限定される。H2のJSON Schema projectionは明示的`undefined`を表現できない場合に`requires-host-adapter`を返し、losslessとは主張しない。nested path、数値、任意文字列比較、array、memory、外部import、任意TypeScript関数は一般対応していない。

## 15. 最初の追加PoC

Hybrid Compilerとしての最初の追加PoCは、**Restricted TypeScript Predicate Import**としてH1で実装した。H2では、その型境界をCanonical Type IRへ切り出し、WasmContract、JSON Schema、実装仕様へのprojectionを追加した。以下はPoCを選定した時点の入力と完了条件である。

### 入力

- named TypeScript record type
- その型を一つ受け取るpure boolean function
- 対応済みoperatorだけを使った式
- 独立した期待例

### 処理

1. TypeScript Compiler APIで型と関数ASTを読む。
2. 対応構文を既存Predicate IRへloweringする。
3. property pathとliteralを型検査する。
4. IRから仕様表示とL-Lang Source案を生成する。
5. 既存Wasm backendでartifactを生成する。
6. 元TypeScript、reference evaluator、Wasmを同じ入力で比較する。
7. 有限領域は全列挙し、変換不能な構文は明示拒否する。

### 完了条件

- 特定のfield名や期待値をimporterへ埋め込まず、複数Predicateを同じ経路で変換できる
- 元TypeScript、IR、Wasmの結果が対応範囲で一致する
- short-circuit、null、undefined、optional、enumの差を保持する
- unsupported syntaxを意味変更なしに拒否する
- Source、IR、Wasm、Manifestのhash対応を説明できる
- 生成仕様が既存実装の説明案であることを明示し、要求の正本へ自動昇格しない

このPoCでは、任意TypeScript、複数関数、loop、async、class、I/O、memory profileを追加しない。

## 16. Scope

Hybrid Compilerが扱う範囲は次である。

- pureで決定的な限定能力
- 自然言語要求と型のbinding
- Type Providerによる型の正規化
- Semantic Contract、Semantic IR、Typed Core IR
- 決定的なTypeScript・Wasm backend
- Host AdapterとABI契約
- Test IRと独立検証
- Lock、Manifest、provenance、replay
- schema変更とsemantic diff
- SAAA・Coding Agent間の製造・受け入れ契約

## 17. Non-goals

初期・中期の非目標は次である。

- 任意のTypeScriptまたはJavaScriptを完全にWasm化する
- JavaScript runtime全体をWasmへ持ち込む
- SAAAやCoding Agent自体をWasmへ変換する
- 任意の自然言語を安全に実行可能と保証する
- 全プログラミング言語の型を損失なく統一する
- 認証、暗号、会計、DB transactionを自動生成する
- 副作用のある任意コードを自動配備する
- TypeScriptより高速・省メモリであると事前に仮定する
- 一つの巨大な汎用IR、SSA基盤、ownership systemを先に完成させる

## 18. 禁止事項

- LLMにRaw Wasm、WAT、任意TypeScriptを生成させ、そのまま実行しない
- 未対応型を`any`、JSON文字列、暗黙coercionで迂回しない
- `null`、`undefined`、欠損、空文字を根拠なく統合しない
- lossy mappingを警告なしで自動昇格しない
- Implementation生成結果をTest Oracleとしてコピーしない
- Coding AgentにSAAAの受け入れ結果や有効版を書き換えさせない
- buildやreplayで暗黙にモデルを呼び出さない
- hash一致を発行者の真正性や意味の正しさとして扱わない
- 対応外の副作用や外部権限をWasm sandboxだけで安全とみなさない

## 19. 要相談事項

次の変更は、自動的な実装修正ではなく、新しい契約またはprofileの設計判断として扱う。

- 新しい数値幅、overflow、NaN、符号付きゼロ
- 文字列比較、正規化、locale
- array、map、nested record
- linear memory、buffer ownership、lifetime
- loop、再帰、停止性
- 外部API、filesystem、network、database
- 状態、transaction、retry、idempotency
- 例外とerror model
- lossy conversionを許可する業務条件
- ABIのbreaking change
- 自動配備に必要な権限と隔離方式

## 20. 段階的な拡張

| 段階 | 目的 | 主な証拠 |
| --- | --- | --- |
| H0 現行縦断 | Prompt Source / TS型から限定Predicate Wasm | IR・TS・Wasm一致、再現build、不正入力拒否 |
| H1 TS Import | 限定pure TSを既存IRへ取り込む | 元TSとの意味一致、unsupported拒否 |
| H2 Canonical Type IR | Type Providerとbackendの境界を固定 | TS固有情報の漏れ防止、lossy判定 |
| H2.5 Reproducible Artifact | imported Predicateを保存・検証可能にする | hash chain、改ざん検出、offline検証、再現build |
| H3 Structured Output | boolean以外の小さなrecord結果 | ABI、buffer、ownership、adapter検証 |
| H4 Multi-language Host | Rust等から同じ能力を利用 | 共通test vector、同じ契約の合否一致 |
| H5 Additional Provider | OpenAPI、JSON Schema、Rust型等を入力化 | 差異を潰さずmappingできる証拠 |
| H6 Controlled Effects | 明示host capabilityによる外部操作提案 | 権限拒否、timeout、重複防止、復旧 |

H1、H2、H2.5はmacOS上のローカル品質Gateまで完了している。UbuntuとWindowsの確認、
追加Provider、Structured Outputは未実施である。

各段階は、後段を完成させなくても独立して評価できる。具体的な利用要求がない型・effectを先回りして追加しない。

## 21. 評価指標

Wasm生成の成功数だけを価値指標にしない。

### 意味適合

- 初回binding成功率
- `unresolved`の適切さ
- 誤ったfield mappingの割合
- held-out acceptance通過率
- schema変更後の意味保持率

### 保守性

- 変更に必要な追加指示量
- 無関係な要求を変更した割合
- 要求ID単位の差分成功率
- 直接コード保守と比較した総作業時間
- 失敗からの復旧時間

### Compiler品質

- frontend、IR、backend間の意味一致
- unsupported入力の拒否率
- 同一Lock・toolchainからのbytes再現性
- artifact、Manifest、ABI不一致の検出率
- mutationとcounterexampleの検出率

### 実行品質

- cold / warmのcompile・instantiate・invoke時間
- adapter込みの単発・batch時間
- artifact size
- hostを含むRSS
- timeout、cancel、資源上限の遵守

## 22. 主なリスク

### 同じ誤解の共有

会話整理、Source生成、実装生成、テスト生成を同じモデルへ依存すると、同じ誤解を複製し得る。役割と入力を分離し、held-out acceptanceを維持する。

### 型の見かけ上の一致

同じ`string`や`number`でも業務意味、単位、範囲は異なる。構造一致だけでsemantic roleを確定しない。

### ABIでの情報損失

存在判定だけに必要なstringをstate tagへ畳むことは、後の文字列比較には使えない。IRが観測する情報からABIを決め、変更をversionとhashへ反映する。

### 抽象化の先行

複数言語、memory、ownership、effectを同時に一般化すると、実利用で必要な保証が不明なまま基盤だけが大きくなる。動く縦断と失敗例からCanonical IRを育てる。

### ORM比喩による過剰期待

ORMのように全表現が自動で往復できる印象を与え得る。mappingのlossless / lossy / unsupportedを公開し、対応profileを能力metadataへ含める。

## 23. 既存文書との関係

- L-Lang全体の言語構想は[Staged Semantic TypeScript Concept](../concept.md)を基礎とする。
- Wasmへの決定的lowering、ABI、Lock、Manifestの詳細は[Wasm Compiler Concept](./WASM_COMPILER_CONCEPT.md)を継承する。
- SAAA、Coding Agent、能力パッケージの責務は[Agent Capability Implementation Concept](./AGENT_CAPABILITY_IMPLEMENTATION_CONCEPT.md)を継承する。
- Prompt Sourceの実装済み範囲と限界は[Prompt Source実装結果](./PROMPT_SOURCE_RESULTS.md)を参照する。
- Wasm縦断の実測は[Wasm PoC実装結果](./WASM_POC_RESULTS.md)を参照する。
- Coding Agentによるテスト・実装製造と限定修正は[Coding Agent検証結果](./CODING_AGENT_VERIFICATION_RESULTS.md)を参照する。
- SAAA接続の準備範囲は[SAAA PoC準備計画](./SAAA_POC_PREPARATION_PLAN.md)を参照する。
- Restricted TypeScript Predicate Importの実装範囲は[第一実装結果](./HYBRID_COMPILER_FIRST_IMPLEMENTATION_RESULTS.md)を参照する。
- Canonical Type IRとprojectionの実装範囲は[第二実装結果](./HYBRID_COMPILER_SECOND_IMPLEMENTATION_RESULTS.md)を参照する。

本書はこれらを置き換えず、**会話、Type Provider、Semantic Mapping、複数backendを一つの製品・言語モデルとして接続する上位コンセプト**を定義する。

## 24. まとめ

Hybrid Compilerの価値は、TypeScriptをWasmへ変換できることだけではない。

```text
会話で得た要求
  ＋
Project固有の型
  ＋
独立した例と受け入れ条件
        ↓
型付きで差分更新可能なSource兼仕様
        ↓
検証済みの言語非依存IR
        ↓
TypeScript / Wasm / Host Adapter
```

この構造により、自然言語の柔軟さ、TypeScriptの開発体験、IRの検証可能性、Wasmのportableな実行境界を組み合わせる。

L-Langは、自然言語を直接実行する言語ではない。プログラミング言語を無制限に相互変換するトランスパイラでもない。

> L-Lang Hybrid Compilerは、意味を一度契約として固定し、それを異なる型・言語・実行環境へ検証可能にmappingするためのExecutable Contract Mapperである。
