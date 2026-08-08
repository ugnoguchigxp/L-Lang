# Staged Semantic TypeScript Concept

## Status

Executable research MVP concept.

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

中心価値は、生成過程を管理しやすくすることではなく、**抽象的で細部を省いたIntentを、Projectの型・テスト・履歴へ自動的に適合させること**にある。開発者はVibe codingの速度を保ち、Project側の文脈が不足した詳細を補う。成功は、初回適合率、Project全体の回帰通過率、修正に必要な追加指示量、Schema変更への追従率で測る。

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
const Cat = defineConcept("animal.cat")`
Definition:
A domesticated animal that is a biological cat.

Exclusions:
- Mechanical or virtual cat-shaped objects.
- Large wild felids.
`;
```

より複雑な例は次のようになる。

```typescript
const ActiveCustomer = concept<Customer>`
Definition:
A customer that is currently active and contactable.

Requirements:
- status is "active".
- deletedAt is null.
- email is present.

Exclusions:
- Customers whose status is "suspended".
- Customers whose deletedAt is not null.

Out of scope:
- Email address syntax and deliverability.

Leave unresolved when:
- The schema does not expose status, deletion, or email roles unambiguously.
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
const ActiveCustomer = concept<Customer>`
Definition:
A customer that is currently active and contactable.

Requirements:
- status is "active".
- deletedAt is null.
- email is present.

Exclusions:
- Suspended or deleted customers.
`;

const isActiveCustomer = generatePredicate(ActiveCustomer);

semanticTest(isActiveCustomer, {
  accept: [
    { status: "active", deletedAt: null, email: "customer@example.com" },
  ],
  reject: [
    { status: "suspended", deletedAt: null, email: "customer@example.com" },
  ],
});
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

現在のExecutable MVPでは、役割を次の形式構文で固定する。

```typescript
const LocalConcept = concept<Input>`...`;
const SharedConcept = defineConcept("stable.id")`...`;
const BoundConcept = bindConcept<Input>(SharedConcept);

const predicate = generatePredicate(LocalConcept);
semanticTest(predicate, { accept: [...], reject: [...] });

const value = staticValue("...");
const judgment = judgeStatic(value, SharedConcept);
```

`generateType`や`generateFunction`は将来構想のconceptual syntaxであり、現在のMVPでは実行できない。

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
const CatForAnimal = bindConcept<Animal>(Cat);
const isCat = generatePredicate(CatForAnimal);
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
const CatForAnimal = bindConcept<Animal>(Cat);
const isCat = generatePredicate(CatForAnimal);
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
* Project全体の適合Gateが成功している

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

Semantic IRは、OpenAI structured outputへ渡すJSON Schemaと、実装内の厳格なruntime parserによって検証する。さらにTypeScript Compiler APIでsource contextを検査し、生成候補をTypeScript型検査へ通す。

検証済みIRを、決定的なGeneratorがTypeScriptへ変換する。

```text
LLM
  ↓
Semantic IR
  ↓ JSON Schema + strict runtime validation
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
  Verification Gate

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
const ActiveCustomer = defineConcept("customer.active")`
Definition:
A customer that can currently use the service.

Requirements:
- The customer is enabled.
- A verified contact method is present.

Exclusions:
- Suspended or deleted customers.

Leave unresolved when:
- The project schema cannot be mapped to these roles unambiguously.
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

## 11. Semantic TestとSemantic TDD

テストを補助機能ではなく、意味を確定するための第一級要素とする。

### 11.1 Example Test

現在のExecutable MVPは、生成対象のPredicateに対する非空の`accept` / `reject`に加え、名前付きboundary、counterfactual、invarianceを提供する。

```typescript
semanticTest(isCat, {
  accept: [
    { species: "felis_catus", description: "A domesticated calico cat." },
  ],
  reject: [
    { species: "panthera_tigris", description: "A tiger." },
    { species: "robot", description: "A cat-shaped robot." },
  ],
});
```

### 11.2 Boundary Test

概念の境界を検査する。

```typescript
semanticTest(isCat, {
  accept: [{ species: "felis_catus", domesticated: true }],
  reject: [{ species: "robot", domesticated: false }],
  boundary: [
    {
      name: "feral-domestic-cat",
      input: { species: "felis_catus", domesticated: false },
      expected: "accepted",
    },
  ],
});
```

### 11.3 Counterfactual Test

入力の一部分だけを変更し、判断がどのように変化すべきかを検査する。

```typescript
semanticTest(isCat, {
  accept: [{ species: "felis_catus", mechanical: false }],
  reject: [{ species: "robot", mechanical: true }],
  counterfactual: [{
    name: "biological-to-mechanical",
    base: {
      input: { species: "felis_catus", mechanical: false },
      expected: "accepted",
    },
    variants: [{
      name: "robot",
      input: { species: "robot", mechanical: true },
      expected: "rejected",
    }],
  }],
});
```

### 11.4 Invariance Test

意味が同じなら表現が変わっても結果が変化しないことを検査する。

```typescript
semanticTest(isCat, {
  accept: [{ species: "felis_catus", description: "calico cat" }],
  reject: [{ species: "robot", description: "cat-shaped toy" }],
  invariance: [{
    name: "description-language",
    expected: "accepted",
    inputs: [
      { species: "felis_catus", description: "三毛猫" },
      { species: "felis_catus", description: "calico cat" },
    ],
  }],
});
```

### 11.5 Semantic Mutation Test

ここから11.6までは将来構想であり、現在のsource DSLが直接提供するAPIではない。

Concept、Constraint、Goalを意図的に変更し、テストが意味の欠陥を検出できるか確認する。

### 11.6 Model Migration Test

使用モデルを変更した際、過去のJudgmentがどの程度変化したかを比較する。

### 11.7 Semantic TDD

L-Langでは、人間が大量の具体的なテストコードを書く代わりに、振る舞い、境界、禁止事項、変化に対する関係を意味契約として先に定義する。

L-Langは意味契約からテストと実装を別々に具体化し、先に固定されたテスト義務を満たす実装候補だけを採用する。この開発方式を`Semantic TDD`と呼ぶ。

```text
Semantic Contract
        ↓
契約条項の正規化
        ↓
Test Obligation IR
        ↓ Red検証 / 自動Freeze
Implementation IR候補
        ↓
型 / Effect / Test / Mutation検査
        ↓
採用候補
        ↓
semantic.lock
```

Semantic TDDの正本は生成されたテストコードではない。次を資産として扱う。

* 人間が定義した意味契約
* 契約条項から導出されたTest Obligation IR
* Test IRの生成根拠と契約条項へのtrace
* 検証済みImplementation IR
* Red検証、型検査、Effect検査、Test、Mutationの結果
* それらを固定するLockfile

#### 11.7.1 緩いTDD

通常のTDDでは、人間が実装前に具体的なテストコードを書く。

L-Langでは、人間が先に固定するのはテストコードではなく、次のようなテストの意味である。

```text
何を必ず満たすか
何を受理するか
何を拒否するか
何を判断不能とするか
何が変化しても結果が変わらないか
どの変化によって結果が変わるべきか
どの副作用を許可しないか
```

具体的なfixture、property、counterfactual、invariance、実行可能なテストコードはコンパイラが展開する。この意味で、Semantic TDDはテスト記述量を減らした「緩いTDD」である。

ただし、合否条件を緩くするものではない。Hardな意味義務、型、Effect、安全境界はすべて満たさなければならない。

#### 11.7.2 Test IRとImplementation IRの分離

同じ生成結果の中で実装とテストを作ると、同じ誤解を共有した自己確認になる。

Semantic TDDでは、意味契約から少なくとも二つの独立した生成経路を持つ。

```text
                    ┌─→ Test Synthesizer ─→ Test Obligation IR
Semantic Contract ─┤
                    └─→ Implementation Synthesizer ─→ Implementation IR
```

Test Synthesizerは次を参照できる。

* Goal、Concept、Requirements、Exclusions
* 型定義と有効な入力領域
* Projectに蓄積された正例、反例、境界
* 過去の不具合と検証済みTest Pattern

Test Synthesizerへ生成済みImplementation IRや生成コードを見せない。

Implementation Synthesizerは次を参照できる。

* Goal、Concept、Requirements、Exclusions
* 型定義
* Effect制約
* 必要な場合に限り、公開すると決めたTest Obligationの一部

Implementation Synthesizerへ、holdout Test、Mutationの生存情報、Oracle実装を見せない。

生成経路の分離だけでは、自然言語の同じ曖昧さを両者が誤解する可能性は消えない。そのため、Test IRは機械検証可能で、各義務が元の契約条項を追跡でき、実装前RedとMutation検出によって有効性を証明できなければならない。

#### 11.7.3 Test Obligation IR

Test Obligation IRは、実行可能なテストコードより前に存在する、言語非依存の検証契約である。

概念例:

```yaml
version: 1
contract: customer.active
obligations:
  - id: reject-deleted
    source: exclusions[1]
    kind: property
    when:
      deletedAt: present
    expect: rejected

  - id: status-transition
    source: requirements[1]
    kind: counterfactual
    change:
      status:
        from: active
        to: suspended
    expect:
      from: accepted
      to: rejected

  - id: display-name-invariant
    source: invariants[1]
    kind: invariance
    change:
      property: displayName
    expect: unchanged
```

すべてのHardな契約条項は、1件以上のTest Obligationに対応しなければならない。対応のないHard条項がある場合、テスト計画は未完了としてfail-closedにする。

Test IRからTypeScriptとBun向けテストコードを決定的に生成する。LLMが自由なテストコードを直接生成して実行してはならない。

#### 11.7.4 Redの証明

テストが実装より先に存在しても、どの実装でも通る空虚なテストでは意味がない。

Test Planを固定する前に、少なくとも次の既知不正実装を検出できるか確認する。

* 常に`true`を返すPredicate
* 常に`false`を返すPredicate
* 条件を一つ削除したPredicate IR
* `equals`の期待値を反転したPredicate IR
* `all`と`any`を交換したPredicate IR

要求に関係する既知不正実装をTest Planが検出した結果を`Red Certificate`として保存する。

すべてのMutationを必ず検出できるとは限らない。型や契約上同値なMutation、到達不能なMutationは除外理由を記録し、単純にMutation scoreの分母へ含めない。

#### 11.7.5 Hard GateとSoft Quality

L-Langの80点思想は、既知の要求への違反を許容する意味ではない。

```yaml
quality:
  hard:
    normative_obligations: pass
    typecheck: pass
    forbidden_effects: zero
    security_tests: pass

  soft:
    obligation_coverage: 0.80
    boundary_coverage: 0.75
    mutation_score: 0.70
    implementation_stability: 0.80
```

Hard Testは100%合格を要求する。

Soft指標は、生成できた境界の広さ、探索的テストの充実度、Mutation検出力、複数回生成時の安定性を評価する。既知の期待結果に失敗する候補を「80%合格」として自動採用してはならない。

#### 11.7.6 `unknown`と`unresolved`

Semantic TDDでは、次を区別する。

* `unresolved`: コンパイル時にConceptを対象Schemaへ一意に対応付けられない
* `unknown`: 実行時入力に情報が不足し、acceptedまたはrejectedを決定できない

Boolean Predicateは`true`または`false`だけを返すため、実行時の`unknown`を表現しない。実行時に三値判断が必要な場合は、Boolean Predicateへ暗黙に追加せず、`accepted | rejected | unknown`を返す専用Judgment IRを定義する。

Predicate MVPでは、コンパイル時の`unresolved`だけを扱う。

#### 11.7.7 Freeze、選択、Lock

Test PlanはImplementation IR生成前にhashで固定する。

Implementation候補の評価中にTest Planを変更した場合、同じ試行の継続とはみなさず、新しいSemantic Contract revisionとして最初から検証する。

Best-of-Nで複数のImplementation IRを生成する場合、次を守る。

* すべての候補を同じ凍結済みTest Planで評価する
* holdout Testの内容を候補生成へ返さない
* holdout結果を使った反復修正を無制限に行わない
* 合格候補が複数ある場合、IRの単純さ、Effect、安定性を含む決定的な選択規則を使用する
* 合格候補がない場合、Test Planを実装へ合わせて弱めず`unresolved`にする

Lockfileには少なくとも次を記録する。

```text
contractHash
testPlanHash
testCompilerVersion
implementationIr
generatedCodeHash
redCertificate
validationSummary
promotionProvenance
```

#### 11.7.8 Semantic Test Pattern

検証済みのTest Obligation抽象はSemantic Packageとして再利用できる。

```text
Payment
├─ 二重決済防止
├─ Idempotency
├─ 失敗時の再試行
├─ 部分成功
└─ 監査ログ
```

Test Patternは具体的なfixtureを無条件にコピーするものではない。Capability、型、Effect、対象Schemaへbindingし、適用できないroleがある場合は推測せず`unresolved`にする。

#### 11.7.9 導入順序

Semantic TDDは、最初から任意関数生成へ適用しない。

Predicate MVPで次を順に検証する。

1. Test Obligation IRと契約条項trace
2. Exampleからの決定的fixture展開
3. CounterfactualとInvariance
4. Red Certificate
5. Predicate IR Mutation
6. Implementation IRの複数候補生成と選択
7. Property Test用generatorとshrinker
8. Test Planと採用IRのLock

Predicateでテスト生成の妥当性、実装との独立性、false acceptance、Mutation検出力、追加指示量を検証した後だけ、Validation、Mapping、状態遷移などの専用IRへ拡張する。

段階的な実装順、Gate、検証、停止条件は[`SEMANTIC_TDD_IMPLEMENTATION_PLAN.md`](./SEMANTIC_TDD_IMPLEMENTATION_PLAN.md)を正とする。

Predicate POCでは、`tdd-build`がtrace・型・実装前Redを検証したTest PlanをImplementation生成前に自動freezeする。`tdd-plan → diff → approve → tdd-build`は互換用のstaging経路としてのみ残す。`tdd-test`はAPI・書き込みなしの整合性検証、`tdd-replay`は両lockからのtransaction再実行である。Test PlanとRed Certificate、Selection Reportは`semantic-test.lock`へ、Implementation IRと生成物hashは既存`semantic.lock`へ分離して固定する。

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
      "validated": true
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
* 検証・freeze方式の記録
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

すべてのConceptは、tagged template内を名前付きセクションで構造化する。Definitionは常に必須とし、Requirements、Exclusions、Out of scope、Leave unresolved whenは必要な場合だけ記述する。Predicate生成ではRequirementsまたはExclusionsの少なくとも一方を要求し、Static JudgmentではDefinitionだけのConceptも許可する。TypeScriptを型・Binding・Semantic Testの外枠として維持し、未分割の自由文やTOMLは受理せず、LLM呼び出し前にコンパイルエラーとする。

```typescript
const FulfillableOrder = defineConcept("order.fulfillable")`
Definition:
An order eligible for fulfillment intake.

Requirements:
- Payment is confirmed.
- A destination is present.

Exclusions:
- Cancelled orders.

Out of scope:
- Inventory availability.

Leave unresolved when:
- A required semantic role cannot be mapped uniquely.
`;
```

### MVP対象

* `concept`
* `staticValue`
* `judgeStatic`
* `generatePredicate`
* `semanticTest`
* Semantic IR
* JSON Schemaと厳格なruntime parserによるIR Validation
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

ここからは概念説明用の疑似構文ではなく、現在のscanner / compilerが受理するExecutable MVP syntaxを示す。PredicateとStatic Judgmentはsource kindが異なるため、同じSemantic sourceへ置かない。

共有Conceptを`cat.ts`で定義する。

```typescript
import { defineConcept } from "../../src/dsl";

export const Cat = defineConcept("animal.cat")`
Definition:
A domesticated animal that is a biological cat.

Exclusions:
- Mechanical or virtual cat-shaped objects.
- Large wild felids.
`;
```

Predicateは`predicate.ts`で型へbindし、生成対象のPredicateをSemantic Testへ渡す。

```typescript
import {
  bindConcept,
  generatePredicate,
  semanticTest,
} from "../../src/dsl";
import { Cat } from "./cat";

type Animal = {
  species: "felis_catus" | "panthera_tigris" | "robot";
  description: string;
};

const CatForAnimal = bindConcept<Animal>(Cat);
export const isCat = generatePredicate(CatForAnimal);

semanticTest(isCat, {
  accept: [
    { species: "felis_catus", description: "A domesticated calico cat." },
  ],
  reject: [
    { species: "panthera_tigris", description: "A tiger." },
    { species: "robot", description: "A cat-shaped robot." },
  ],
});
```

Static Judgmentは別の`judgment.ts`へ置き、型へbindする前の共有Conceptを直接使用する。

```typescript
import { judgeStatic, staticValue } from "../../src/dsl";
import { Cat } from "./cat";

const mike = staticValue(`
  A small domesticated calico animal that meows.
`);

export const mikeIsCat = judgeStatic(mike, Cat);
```

実際に継続検証しているsourceは、[`examples/active-customer/semantic.ts`](./examples/active-customer/semantic.ts)、[`examples/static-judgment/cat.ts`](./examples/static-judgment/cat.ts)、[`examples/static-judgment/semantic.ts`](./examples/static-judgment/semantic.ts)、[`examples/semantic-polymorphism/`](./examples/semantic-polymorphism/)を正とする。

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
* VitestまたはBun Test
* JSONベースSemantic IR
* OpenAI structured output用JSON Schema
* 厳格なruntime parser
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

抽象的なIntentとProject文脈から、追加指示を抑えながらProjectに適合する実装を生成できる。

### 仮説8

意味契約からTest IRを先に固定し、Implementation IRを分離生成する方が、実装とテストを同じ生成結果から作る方式よりfalse acceptanceを減らせる。

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
| Hard Clause Trace Coverage | Hardな契約条項がTest Obligationへ対応する割合 |
| False Acceptance          | 意味的に誤ったImplementation候補をTest Planが受理した割合 |
| Red Mutation Kill Rate    | Test Planが対象とする既知不正IRを検出した割合 |
| Semantic Mutation Score   | 意味定義の欠陥を検出できた割合          |
| Code Reduction            | 手書き条件とのコード量比較            |
| Intent-to-Fit Time        | 抽象的な指示からProject回帰通過までの総時間 |
| Correction Burden         | 初回適合までに必要な追加指示量と修正回数 |
| Project Regression Pass   | 生成候補がProject全体の回帰を通過した割合 |
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
* Test IRとImplementation IRの分離生成
* 契約条項からTest Obligationへのtrace
* Test Planの先行freeze
* Red Certificate
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
* Project固有のRegression Test
* 複数サンプルのConsensus
* 曖昧時の`unresolved`

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
* Project Context Fit
* Semantic Diff
* 修正ループ
* 自動検証とfreeze

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

`Semantic TDD`を、次のように定義する。

> 開発者が意味契約を与え、コンパイラが実装を参照せずTest Obligation IRを生成・Red検証・自動freezeした後、別経路でImplementation IRを生成し、凍結済みのHard義務をすべて満たす候補だけを採用する生成型TDD。

`Test Obligation IR`を、次のように定義する。

> 実行可能なテストコードより前に存在し、期待する振る舞い、入力変換、結果間の関係、強度、根拠となる契約条項を言語非依存に表現する検証契約。

`Red Certificate`を、次のように定義する。

> Test Planが定数実装や契約条件を欠落・反転させた既知不正IRを検出できることと、検出できないMutationの分類理由を記録した検証artifact。
