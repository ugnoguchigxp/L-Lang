# Staged Semantic TypeScript Concept

## Status

Discussion draft / MVP concept.

本書は、TypeScriptを基盤として、プログラミング言語と自然言語を同一ソース内に共存させる新しい言語処理系のコンセプトを定義する。

現時点では、独自の汎用プログラミング言語や独自ランタイムを完成させることを目的としない。まずは、TypeScript内に埋め込まれた意味的な定義・判断・生成要求を、LLMによってビルド時に解決し、通常のTypeScriptへ変換できるかを検証するMVPを構築する。

仮称を `Staged Semantic TypeScript` とする。

---

## 1. 背景

従来のプログラミング言語では、プログラマが次の要素を明示的に記述する。

* 変数
* 型
* 関数
* 条件分岐
* ループ
* データ構造
* モジュール
* 依存関係
* エラー処理
* 副作用

この方式は、数値計算、状態管理、トランザクション、認証・認可など、厳密な処理を記述する上で優れている。

一方で、人間にとって自然な概念や意味を、プログラム上の条件として完全に記述しようとすると、大量の条件分岐や個別ルールが必要になる。

例えば、「この対象は猫である」という判断を手続き的に記述する場合、毛、耳、脚、鳴き声、種別、身体的欠損、年齢など、多数の条件を考慮しなければならない。

しかし、人間やLLMは、「猫」という概念を、単純な条件の集合ではなく、意味的なまとまりとして判断できる。

本構想では、LLMの意味理解能力をプログラムの実行時に利用するのではなく、**コンパイル時の意味解析・判断・構造生成に限定して利用する**。

LLMによる判断が完了した後は、通常のTypeScriptへ変換し、実行時にはLLMを呼び出さない。

---

## 2. 中心となる考え方

本構想の基本原則は、次の一文で表現できる。

> 自然言語によって意味・目的・概念・制約を記述し、LLMがそれらをコンパイル時に解釈して、決定的なTypeScriptへ具体化する。

処理全体は次のようになる。

```text
Semantic TypeScript Source
        ↓
構文解析
        ↓
LLMによる意味解釈・Judgment・Elaboration
        ↓
Semantic IR
        ↓
型検査・テスト・制約検証
        ↓
通常のTypeScript
        ↓
JavaScript
        ↓
通常ランタイムで実行
```

LLMは実行エンジンではない。

LLMが担当するのは次の領域である。

* 概念の理解
* 意味的な分類
* 既存コードとの対応付け
* 型や関数の候補生成
* 条件式やマッピングの生成
* テストケースの生成
* 曖昧さや不足情報の検出

通常のTypeScriptとJavaScriptランタイムは次を担当する。

* 数値演算
* 文字列処理
* 配列処理
* ループ
* メモリ上の値管理
* 非同期処理
* I/O
* ネットワーク処理
* DB処理
* 副作用
* 最終的な実行

---

## 3. Soft Specification, Hard Execution

本構想は、次の二層構造を持つ。

```text
Soft Specification
  意味
  概念
  目的
  制約
  判断基準
  期待される性質

        ↓ Compile

Hard Execution
  型
  値
  関数
  条件式
  アルゴリズム
  実行順序
  副作用
```

表面言語では、一定の曖昧さや意味的な柔軟性を許容する。

しかし、最終成果物には曖昧な判断を残さない。

実行時に使用されるプログラムは、通常の決定的なTypeScriptまたはJavaScriptでなければならない。

---

## 4. 言語内の4つの領域

同一ソース内に、異なる意味論を持つ4種類の領域を共存させる。

### 4.1 Exact Code

通常のTypeScriptとして、プログラマが完全に制御する領域。

```typescript
function calculateTotal(
  subtotal: number,
  taxRate: number,
): number {
  return subtotal * (1 + taxRate);
}
```

この領域ではLLMを使用しない。

次の処理は原則としてExact Codeに置く。

* 金額計算
* 暗号処理
* 認証・認可
* DBトランザクション
* 排他制御
* 外部APIへの副作用
* リソース管理
* 厳密な数値処理
* セキュリティ境界
* 障害回復

### 4.2 Ontology Definition

ドメインに存在する概念、関係、制約、能力を定義する領域。

```typescript
const Cat = concept`
  生物学的なイエネコ。

  年齢、毛の有無、身体的欠損は問わない。

  猫を描いた画像、玩具、ロボット、
  大型の野生ネコ科動物は含まない。
`;
```

より複雑な例は次のようになる。

```typescript
const ActiveCustomer = concept<Customer>`
  現在サービスを利用可能な顧客。

  停止または削除されておらず、
  有効な連絡手段を持つ。
`;
```

Ontology Definitionは、直接実行されるコードではない。

次の処理の入力として利用される。

* Judgment
* 型生成
* Predicate生成
* マッピング生成
* テスト生成
* 状態遷移生成
* 既存コードとの意味的対応付け

### 4.3 Static Judgment

コンパイル時に存在する具体的な対象を、LLMが実際に判断する領域。

```typescript
const mikeDescription = staticValue(`
  三毛模様でニャーと鳴き、
  人間の家で飼育されている小型動物
`);

const mikeIsCat = judgeStatic(
  mikeDescription,
  Cat,
);
```

LLMがコンパイル時に判断した結果は、通常の定数へ変換される。

```typescript
const mikeIsCat = true;
```

最終成果物には、LLM呼び出しやJudgment処理を残さない。

この方式は、通常のコンパイラにおける定数畳み込みを、意味的判断まで拡張するものと捉えられる。

### 4.4 Semantic Generation

自然言語による意味・目的・制約から、再利用可能な型、関数、条件式、テストなどを生成する領域。

```typescript
const isActiveCustomer =
  generatePredicate<[Customer], boolean>`
    現在サービスを利用可能な顧客を判定する。

    停止または削除されている顧客は除外する。
    有効な連絡手段を持たない顧客は除外する。

    pure;
    deterministic;
    no network;
  `;
```

コンパイル後は、通常のTypeScript関数になる。

```typescript
function isActiveCustomer(
  customer: Customer,
): boolean {
  return (
    customer.status === "active" &&
    customer.deletedAt === null &&
    customer.email !== null
  );
}
```

Static JudgmentとSemantic Generationは異なる機能である。

Static Judgmentは、コンパイル時に存在する具体的対象を判断する。

Semantic Generationは、将来の入力にも適用できる再利用可能なプログラム構造を生成する。

---

## 5. 自然言語と形式言語の役割分担

本言語では、自然言語を自由に記述できる。

ただし、自然言語が果たす役割は、外側の形式構文によって厳密に指定する。

```typescript
concept`...`;

judgeStatic(value, concept);

generatePredicate`...`;

generateType`...`;

generateFunction`...`;

semanticTest`...`;
```

自然言語部分だけを見て、コンパイラがその目的を推測してはならない。

次の原則を採用する。

> 自然言語の内容は柔軟にするが、自然言語ブロックの役割は形式構文で固定する。

自然言語は主に次を表現する。

* 何であるか
* 何を達成したいか
* 何を含むか
* 何を含まないか
* 何を守るべきか
* 何が同じ意味か
* どの程度の誤差や保留を許容するか

TypeScriptは主に次を表現する。

* どの値を扱うか
* どの順序で処理するか
* どの関数を呼ぶか
* どの副作用を起こすか
* どの型で接続するか
* どのアルゴリズムを使用するか

---

## 6. コンパイルフェーズ

値や定義が、どの段階で存在するかを区別する。

MVPでは、最低限次の3フェーズを持つ。

### 6.1 Static

コンパイル開始時点ですでに存在する値。

```typescript
const description = staticValue(`
  三毛模様の飼い猫
`);
```

Static値は、Static Judgmentに使用できる。

### 6.2 Generated

コンパイル中に、LLMや決定的Generatorによって生成される値・型・関数。

```typescript
const isCat = generatePredicate<
  [Animal],
  boolean
>`猫を判定する`;
```

### 6.3 Runtime

プログラム実行時に初めて存在する値。

```typescript
const uploadedFile = await request.file();
```

Runtime値をStatic Judgmentへ渡してはならない。

```typescript
judgeStatic(uploadedFile, Cat);
```

これはコンパイルエラーとする。

```text
SemanticStageError:
  runtime value "uploadedFile" cannot be used
  by static judgment
```

一方、Runtime値を処理する関数を事前生成することは可能である。

```typescript
const isCat =
  generatePredicate<[Animal], boolean>`
    入力された動物が猫であるかを、
    利用可能な構造化データから判定する。
  `;
```

---

## 7. Semantic Closure

本言語では、最終的な実行成果物を生成する前に、すべての意味的処理が解決済みでなければならない。

この状態を `Semantic Closure` と呼ぶ。

```text
Unresolved Semantic Node
        ↓
Judgment / Generation / Verification
        ↓
Resolved Semantic Node
        ↓
TypeScript
```

最終ビルド時には次を保証する。

* 未解決のJudgmentが存在しない
* 未生成の型・関数が存在しない
* LLM呼び出しが実行コードに残っていない
* Semantic IRがすべてTypeScriptへ変換されている
* 型チェックが成功している
* 必須テストが成功している
* 必要な人間承認が完了している

解決できない場合、コンパイラは推測でビルドを継続せず、エラーを返す。

```text
SemanticCompileError:
  ActiveCustomerの定義を一意に解決できません。

Missing context:
  - emailVerifiedAtを必須条件とするか
  - suspendedAtとstatusの優先関係
```

---

## 8. Semantic IR

LLMから直接、自由なTypeScriptを生成させない。

LLMは制限された中間表現である `Semantic IR` を出力する。

例として、判定式は次のようなIRになる。

```json
{
  "kind": "all",
  "conditions": [
    {
      "kind": "equals",
      "target": {
        "kind": "property",
        "object": "customer",
        "property": "status"
      },
      "value": "active"
    },
    {
      "kind": "equals",
      "target": {
        "kind": "property",
        "object": "customer",
        "property": "deletedAt"
      },
      "value": null
    }
  ]
}
```

Semantic IRはZodなどによって検証する。

検証済みIRを、決定的なGeneratorがTypeScriptへ変換する。

```text
LLM
  ↓
Semantic IR
  ↓ Zod Validation
Validated IR
  ↓ Deterministic Generator
TypeScript
```

MVPで許可するIRは限定する。

候補は次のとおり。

* Concept IR
* Judgment IR
* Boolean Predicate IR
* Type Declaration IR
* Mapping IR
* Validation IR
* Test Case IR
* Port Declaration IR

初期段階では、次の生成を禁止する。

* 任意のファイル操作
* 任意のネットワークアクセス
* SQLの直接実行
* シークレット参照
* トランザクション
* ロック
* 動的コード実行
* 任意の非同期副作用

副作用が必要な場合、生成側はPortまたはInterfaceを宣言し、実装はExact Codeへ委譲する。

---

## 9. Semantic ZoneとExact Zone

生成対象と手書き対象の境界を明示する。

```text
Semantic Zone
  Ontology
  Static Judgment
  Generated Type
  Generated Predicate
  Generated Test

        ↓ Typed Contract

Boundary Zone
  Interface
  Port
  Binding
  Approval

        ↓

Exact Zone
  Math
  State
  Effect
  I/O
  Transaction
  Security
```

### 9.1 Semantic Zone

LLMやコンパイラによって、再生成可能な領域。

生成物を人間が直接編集しない。

変更したい場合は、Ontology、Constraint、Test、Bindingを変更して再生成する。

### 9.2 Exact Zone

人間が所有する通常のTypeScript。

生成処理によって上書きしない。

### 9.3 Boundary Zone

Semantic ZoneとExact Zoneを、型付き契約で接続する。

```typescript
export interface RefundPort {
  execute(
    request: RefundRequest,
  ): Promise<RefundResult>;
}
```

実装はExact Zoneに置く。

```typescript
export const refundPort: RefundPort =
  stripeRefundAdapter;
```

---

## 10. Semantic Polymorphism

本構想では、同じ実装を再利用するのではなく、同じ意味を異なるプロジェクトへ具体化する。

例えば、次のConceptを定義する。

```typescript
const ActiveCustomer = concept`
  現在サービスを利用でき、
  停止または削除されておらず、
  有効な連絡手段を持つ顧客。
`;
```

プロジェクトAでは次へ変換される。

```typescript
customer.status === "active" &&
customer.deletedAt === null &&
customer.email !== null
```

プロジェクトBでは次へ変換される。

```typescript
account.enabled === true &&
account.suspendedAt === null &&
account.contacts.some(
  (contact) => contact.verified,
)
```

同じConceptが、異なる型、スキーマ、命名、アーキテクチャへ適応する。

この性質を `Semantic Polymorphism` と呼ぶ。

従来の再利用は、同じコードを異なる値や型へ適用する。

Semantic Polymorphismは、同じ意図や世界理解から、環境ごとに異なるコードを生成する。

---

## 11. Semantic Test

テストを補助機能ではなく、意味を確定するための第一級要素とする。

### 11.1 Example Test

```typescript
semanticTest(Cat, {
  accept: [
    "一般的な飼い猫",
    "毛のない猫",
    "脚を一本失った猫",
  ],

  reject: [
    "猫型ロボット",
    "猫のぬいぐるみ",
    "虎",
  ],

  unknown: [
    "遠くに写った小型動物",
  ],
});
```

### 11.2 Boundary Test

概念の境界を検査する。

```typescript
semanticBoundaryTest(Cat, [
  {
    input: "野生化したイエネコ",
    expected: "accepted",
  },
  {
    input: "ヨーロッパヤマネコ",
    expected: "rejected",
  },
  {
    input: "イエネコとヤマネコの交雑種",
    expected: "unknown",
  },
]);
```

### 11.3 Counterfactual Test

入力の一部分だけを変更し、判断がどのように変化すべきかを検査する。

```typescript
semanticCounterfactualTest({
  base: "三毛模様の生きた飼い猫",

  mutations: [
    {
      replace: "生きた飼い猫",
      with: "電池で動く猫型玩具",
      expected: "rejected",
    },
  ],
});
```

### 11.4 Invariance Test

意味が同じなら表現が変わっても結果が変化しないことを検査する。

```typescript
semanticInvariantTest(Cat, {
  inputs: [
    "一般家庭で飼われる三毛猫",
    "家庭で飼育されている三色のイエネコ",
    "a domesticated calico cat",
  ],
});
```

### 11.5 Semantic Mutation Test

Concept、Constraint、Goalを意図的に変更し、テストが意味の欠陥を検出できるか確認する。

### 11.6 Model Migration Test

使用モデルを変更した際、過去のJudgmentがどの程度変化したかを比較する。

---

## 12. Semantic Lockfile

LLMの判断結果と生成結果を再現可能にするため、`semantic.lock` を導入する。

```json
{
  "version": 1,
  "judgments": {
    "sha256:example": {
      "conceptId": "animal.cat",
      "conceptHash": "sha256:...",
      "inputHash": "sha256:...",
      "contextHash": "sha256:...",
      "model": "example-model",
      "result": "accepted",
      "resolvedIrHash": "sha256:...",
      "approved": true
    }
  }
}
```

入力、Concept、Contextが変化していない場合、再ビルドではLLMを再実行せず、Lockfileの結果を使用できる。

Lockfileは次の用途を持つ。

* 再現可能ビルド
* インクリメンタルビルド
* LLM利用料金削減
* モデル変更時の差分検出
* Judgment監査
* 人間承認記録
* Semantic Regression Test

---

## 13. Explainability

生成されたTypeScriptだけを出力するのではなく、なぜそのコードになったのかを追跡可能にする。

```text
Generated condition:
  customer.status === "active"

Derived from:
  Concept: ActiveCustomer
  Constraint: 停止されていない
  Schema candidate: Customer.status
  Judgment: J-1842
```

CLIには最低限、次の機能を持たせる。

```bash
semantic build
semantic check
semantic explain ActiveCustomer
semantic diff
semantic replay
```

`semantic diff` は、通常のコード差分ではなく、意味の変更を表示する。

```text
ActiveCustomer changed

Added constraint:
  有効な連絡手段を持つ

Generated changes:
  email !== null

Affected:
  2 predicates
  1 generated type
  14 tests
  92 locked judgments
```

---

## 14. MVPのスコープ

MVPでは、新しい汎用言語を完成させない。

有効なTypeScript内に、Tagged Templateと関数呼び出しによってSemantic構文を埋め込む。

### MVP対象

* `concept`
* `staticValue`
* `judgeStatic`
* `generatePredicate`
* `semanticTest`
* Semantic IR
* Zod Validation
* TypeScript Generator
* `semantic.lock`
* `semantic build`
* `semantic explain`
* `semantic diff`
* TypeScript型チェック
* Bunによるテスト実行

### MVP非対象

* 独自VM
* 独自GC
* 独自ランタイム
* 完全な独自文法
* 任意の関数自動生成
* 非同期副作用の自動生成
* DB処理の自動生成
* 分散処理
* 並行処理
* 自動トランザクション設計
* 専用LLMの学習
* Pythonバックエンド
* TypeScript以外へのコード生成
* Runtime LLM Judgment

---

## 15. MVP構文例

```typescript
import {
  concept,
  generatePredicate,
  judgeStatic,
  semanticTest,
  staticValue,
} from "@semantic-ts/core";

type Animal = {
  species?: string;
  taxonomyId?: number;
  description: string;
};

const Cat = concept<Animal>`
  生物学的なイエネコ。

  年齢、毛の有無、身体的欠損は問わない。

  猫を描いた画像、玩具、ロボット、
  虎やライオンなどの大型ネコ科動物は含まない。
`;

const mike = staticValue(`
  三毛模様でニャーと鳴き、
  人間の家で飼育されている小型動物
`);

export const mikeIsCat =
  judgeStatic(mike, Cat);

export const isCat =
  generatePredicate<[Animal], boolean>`
    Animalの構造化情報から、
    生物学的なイエネコであるかを判定する。

    pure;
    deterministic;
    no network;
    no mutation;
  `;

semanticTest(Cat, {
  accept: [
    "一般的な飼い猫",
    "スフィンクス",
    "脚を失った猫",
  ],

  reject: [
    "虎",
    "猫型ロボット",
    "猫のぬいぐるみ",
  ],

  unknown: [
    "遠くに見える小型の四足動物",
  ],
});
```

想定される生成結果は次のようになる。

```typescript
type Animal = {
  species?: string;
  taxonomyId?: number;
  description: string;
};

export const mikeIsCat = true;

export function isCat(
  animal: Animal,
): boolean {
  return (
    animal.taxonomyId === 9685 ||
    animal.species === "felis_catus"
  );
}
```

---

## 16. 推奨パッケージ構成

```text
packages/
  semantic-core/
    concept.ts
    judgment.ts
    generation.ts
    test.ts

  semantic-ir/
    concept-ir.ts
    judgment-ir.ts
    predicate-ir.ts
    test-ir.ts

  semantic-compiler/
    source-scanner.ts
    semantic-resolver.ts
    llm-elaborator.ts
    ir-validator.ts
    dependency-graph.ts

  typescript-generator/
    predicate-generator.ts
    constant-generator.ts
    test-generator.ts

  semantic-lock/
    lock-reader.ts
    lock-writer.ts
    hashing.ts

  semantic-cli/
    build.ts
    check.ts
    explain.ts
    diff.ts
    replay.ts

  llm-adapters/
    interface.ts
    openai-adapter.ts
    local-adapter.ts

examples/
  cat-judgment/
  active-customer/
```

---

## 17. 技術方針

MVPでは次の技術を使用する。

* TypeScript
* Bun
* TypeScript Compiler API
* Zod
* VitestまたはBun Test
* JSONベースSemantic IR
* LLM API Adapter
* SHA-256ベースの入力・Concept・Contextハッシュ

Semantic IR自体はTypeScript固有にしない。

悪い例は次のようなIRである。

```json
{
  "kind": "TypeScriptSyntaxKind227"
}
```

推奨するIRは次のような言語非依存表現である。

```json
{
  "kind": "equals",
  "left": {
    "kind": "property",
    "object": "animal",
    "name": "species"
  },
  "right": {
    "kind": "literal",
    "value": "felis_catus"
  }
}
```

最初のBackendはTypeScriptとするが、将来的にはPython、Java、Rust、SQLなどへの変換可能性を残す。

---

## 18. 成功条件

MVPでは、次の仮説を検証する。

### 仮説1

コンパイル時の意味的判断を、通常の定数として固定できる。

### 仮説2

自然言語によるConceptから、制限されたPredicate IRを生成できる。

### 仮説3

生成されたPredicateを、TypeScriptの型検査とテストによって検証できる。

### 仮説4

同一Conceptと入力に対して、Lockfileを利用すれば完全に再現可能なビルドを実現できる。

### 仮説5

ConceptとSemantic Testを修正する方が、大量の手書きif文を修正するより保守しやすい。

### 仮説6

同一Conceptを、異なるTypeScriptスキーマへ具体化できる。

### 仮説7

生成コード全体を確認するより、Semantic Diffを確認する方がレビュー負荷を下げられる。

---

## 19. 評価指標

MVPでは次の指標を測定する。

| 指標                        | 内容                       |
| ------------------------- | ------------------------ |
| Judgment Accuracy         | 人間の期待結果との一致率             |
| Judgment Stability        | 複数回判断した場合の一致率            |
| Semantic Closure Rate     | 未解決ノードなしでビルドできた割合        |
| Generated Type Safety     | TypeScript型検査成功率         |
| Test Pass Rate            | 生成後のテスト成功率               |
| Semantic Mutation Score   | 意味定義の欠陥を検出できた割合          |
| Code Reduction            | 手書き条件とのコード量比較            |
| Review Time               | 生成コードとSemantic Diffの確認時間 |
| Build Cost                | LLM利用時間と料金               |
| Runtime Overhead          | 通常TypeScriptとの差          |
| Cross-schema Reuse        | 異なるスキーマへの適用成功率           |
| Model Migration Stability | モデル変更時のJudgment維持率       |

---

## 20. リスク

### 20.1 同一LLMによる自己整合した誤り

同じLLMがConceptを解釈し、実装とテストを生成すると、同じ誤解が全工程へ伝播する可能性がある。

対策として次を利用する。

* 人間が定義した正例・反例
* TypeScript型検査
* Property-based Test
* Counterfactual Test
* Semantic Mutation Test
* 別モデルによる比較
* 既存実装とのDifferential Test

### 20.2 意味の揺れ

モデル、プロンプト、Contextの変化によってJudgmentが変化する可能性がある。

対策として次を利用する。

* Semantic Lockfile
* Concept Hash
* Context Hash
* Model ID
* Semantic Regression Test
* 人間承認

### 20.3 生成コードの肥大化

自然言語の簡潔さと引き換えに、大量の生成コードが生まれる可能性がある。

生成コードそのものを資産とせず、Ontology、Semantic Test、Binding、Lockfileを資産として扱う。

### 20.4 デバッグの困難さ

問題がConcept、Context、Judgment、IR、Generator、生成コードのどこにあるか分かりにくくなる。

`semantic explain`、`semantic diff`、`semantic replay`をMVPから必須機能とする。

### 20.5 自動生成範囲の拡大

LLMに任意のTypeScriptを生成させると、言語処理系ではなく一般的なコード生成エージェントになる。

MVPでは生成可能なIRを狭く制限する。

---

## 21. 将来構想

MVPで価値が確認された場合、次の機能を段階的に検討する。

### Phase 2

* `generateType`
* `generateMapping`
* `generateValidation`
* Semantic Boundary Coverage
* Model Differential Test
* Project-specific Ontology Mapping

### Phase 3

* `generateFunction`
* 契約ベース関数生成
* 状態機械生成
* Capability / Port生成
* Semantic Polymorphismの本格検証

### Phase 4

* 独自文法
* Language Server
* IDE上のSemantic Diff
* Concept参照・追跡
* Semantic Debugger
* ContextStill連携
* NightWorkersによる検証・修正ループ

### Phase 5

* TypeScript以外のBackend
* ローカルLLM
* Python Semantic Engine
* 専用モデル学習
* Ontology Library
* 共有可能なSemantic Package Registry

---

## 22. NightWorkers・ContextStillとの将来的な接続

本プロジェクトは独立したMVPとして開始する。

ただし将来的には、次の役割分担が考えられる。

### ContextStill

* 汎用Concept
* Relation
* Rule
* Pattern
* Counterexample
* Judgment履歴
* Semantic Test資産
* モデル変更時の知識差分

### NightWorkers

* プロジェクト固有スキーマ解析
* 既存型・関数との意味マッピング
* TypeScript生成
* 型チェック
* テスト
* Review
* Semantic Diff
* 修正ループ
* Human approval

```text
ContextStill
  General Ontology
        ↓
Project Ontology Mapping
        ↓
Staged Semantic TypeScript
        ↓
NightWorkers Verification Loop
        ↓
Deterministic TypeScript
```

MVP段階では、この連携を必須要件としない。

---

## 23. プロジェクトの価値

本構想の価値は、LLMが曖昧なコードを実行することではない。

価値の中心は次にある。

> 従来のコンパイラが扱えなかった意味・概念・常識・目的を、コンパイル時に検証可能なプログラム構造へ変換する。

また、再利用単位をコードから意味へ引き上げる可能性がある。

```text
従来:
  同じ関数を再利用する

本構想:
  同じConcept、Goal、Constraintを再利用し、
  プロジェクトごとに異なるコードへ具体化する
```

最終的には、プログラミングを次の形へ拡張することを目指す。

```text
人間:
  世界の意味
  守るべき制約
  達成すべき目的
  確実に実装したい処理を書く

LLM:
  意味の解釈
  静的な判断
  プログラム構造の候補生成を行う

コンパイラ:
  IR検証
  型検査
  テスト
  Semantic Closureを保証する

ランタイム:
  通常の決定的プログラムを高速に実行する
```

---

## 24. 定義

`Staged Semantic TypeScript`を、次のように定義する。

> TypeScriptによる厳密な計算・制御コードと、自然言語によるConcept・Goal・Constraint・Judgment・Generation Requestを同一ソース内に共存させ、それぞれを異なるコンパイル段階で解決し、LLMを含まない決定的なTypeScriptへ変換する言語処理系。

MVPの中心命題は次のとおりである。

> 自然言語をコードの代わりに実行するのではなく、自然言語をコンパイル時に型・値・条件式・テストへ変換する。
