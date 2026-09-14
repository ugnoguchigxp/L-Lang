# L-Lang — Staged Semantic TypeScript

[English](./README.en.md) · [現在地とロードマップ](./PROJECT_STATUS_AND_ROADMAP.md) · [品質Gate](./QUALITY_GATES.md) · [Post-MVP実装計画](./POST_MVP_IMPLEMENTATION_PLAN.md) · [セキュリティ](./SECURITY.md) · [Contributing](./CONTRIBUTING.md) · [MIT License](./LICENSE)

> **抽象的な意図を、Projectの型・テスト・履歴にフィットする決定的なTypeScriptへ変換する。**
>
> Vibe codingの速度を保ちつつ、LLMの柔軟さをbuild時の検証可能な変換へ閉じ込める。

L-Langは、自然言語で記述したConceptを、Project固有のTypeScript型、Semantic Test、既存の意味履歴へ適応したpureなBoolean PredicateやStaticなboolean定数へ変換する研究用コンパイラ／TypeScript DSLです。細部をすべて命令しなくても、Projectが持つ文脈から実装を具体化できることを中心価値とします。

LLMは自由なコードを生成しません。コンパイル時に制限されたSemantic IRを返し、L-Langが型文脈、Semantic Test、プロジェクト全体のテストで検証した後、通常のTypeScriptへ決定的に変換します。生成コードはruntimeでLLM、L-Lang DSL、API keyを必要としません。

追加の実験経路として、TS DSLを使わずJSONのPrompt Sourceから限定PredicateをWebAssemblyへ生成できます。Sourceの作成・要求ID単位の更新、独立Lockへの意味解決、オフラインのbuild/test/inspectを備えています。[利用手順](./examples/prompt-active-customer/README.md)と[実装結果・制限](./docs/PROMPT_SOURCE_RESULTS.md)を参照してください。

> [!IMPORTANT]
> 現在は研究・検証段階のMVPです。`semantic build`は、制限IR、型文脈、Semantic Test、Project全体の回帰検証に成功すると、生成物と`semantic.lock`を**自動昇格**します。Semantic TDDでもTest Planのtrace、Red Certificate、Mutation検出を機械的に検証します。信頼境界は、Project contextへの適合を検査するGateです。
> Semantic TDDのTest Planも、trace・型・Red検証後にImplementation生成前の自動freezeを行います。

## 1. L-Langが解こうとしている問題

通常のソフトウェアでは、同じ業務上の意味をスキーマごとに別の条件式として実装します。

```text
Storefront: customer.status === "active" && customer.email !== null
Back office: account.enabled === true && account.contactAddress !== null
Legacy:     record.stateCode === 1 && record.deletedAt === null
```

L-Langでは、再利用する中心資産を「個別の条件式」から「意味、目的、制約」へ移します。

```text
Projectが与える文脈
  Concept + 型 + Semantic Test + 既存の履歴
                         │
                         ▼ build時のみ
              LLMによる型への意味対応付け
                         │
                         ▼
                 制限されたPredicate IR
                         │
          ┌──────────────┴──────────────┐
          ▼                             ▼
   型文脈・テストで検証          曖昧ならunresolved
          │
          ▼
   決定的な通常のTypeScript
```

同じConceptを異なる型へbindingすることで、命名や表現が異なる環境ごとのStaticな実装を生成できます。この性質を、このプロジェクトでは**Semantic Polymorphism**と呼びます。

## 2. 対象と非対象

### 適している用途

- 抽象的な要求からProjectに馴染む実装を得るVibe coding
- LLMをコンパイラの一段階として安全に利用する研究
- pureで決定的なBoolean Predicate
- 同じConceptを異なるTypeScriptスキーマへ適応する実験
- スキーマ変更へ抽象的なIntentを再適応する実験
- build時に確定できる自然言語値のboolean Static Judgment
- LLM出力を制限IR、型、テスト、lock、監査ログで囲う検証

### 適していない用途

- 認証・認可
- 金額、請求、会計計算
- 暗号処理
- DB transactionや排他制御
- network、filesystem、secretへの副作用
- runtimeでのLLM判断
- 自由なTypeScriptや任意関数の生成

これらは人間が所有する通常のTypeScript、すなわちExact Codeに残してください。

## 3. 現在の実装範囲

| 領域 | 状態 | 現在の範囲 |
| --- | --- | --- |
| Predicate生成 | 実装済み | Conceptとローカルrecord型からpureなboolean関数を生成 |
| Semantic IR | 実装済み | `all`、`any`、`not`、`equals`、`present` |
| Semantic Test | 実装済み | `accept` / `reject`、boundary、counterfactual、invariance |
| Semantic Polymorphism | 実装済み | 共有Conceptを複数スキーマへbinding |
| Static Judgment | MVP実装済み | literalな文字列値をboolean定数へ固定。blind benchmarkのfreeze・Oracle分離・fixture harnessを実装 |
| Lock / Replay | 実装済み | `semantic.lock`からAPIなしで決定的に再生成 |
| Candidate staging | 互換機能 | 必要な場合だけ`build --review → diff → approve` |
| Schema Evolution | 実装・評価中 | 型付き2/3 consensus、diff、明示approve |
| Explain | 実装済み | lock、入力hash、生成物整合性を読み取り専用で説明 |
| Semantic Closure | Project Fit-aware | 明示manifest、Context・検証provenance、依存状態を一括検査 |
| Semantic Verify | 実装済み | Closure、決定的再生成、Semantic Test、typecheckをread-onlyで統合 |
| Semantic TDD | Predicate POC実装済み | Contract trace、Test IR、Red Certificate、Test Plan自動freeze、Selection Report、read-only検証 |
| 任意コード・副作用生成 | 非対応 | 設計上の非目標 |

詳細な進捗、未証明の仮説、次の評価Gateは[PROJECT_STATUS_AND_ROADMAP.md](./PROJECT_STATUS_AND_ROADMAP.md)を参照してください。

## 4. 必要環境

- [Bun](https://bun.sh/) 1.3.14
- TypeScript 5.9（`bun install`で導入）
- live解決時のみOpenAI APIまたはAzure OpenAI API key

fixture、lock replay、`semantic explain`、`semantic closure`、`semantic verify`にはAPI keyは不要です。

## 5. APIを使わないクイックスタート

```bash
git clone <repository-url>
cd L-Lang
bun install

bun run typecheck
bun test
```

保存済みのOpenAI応答fixtureを使って、Predicateをbuildします。

```bash
bun run semantic build examples/active-customer/semantic.ts \
  --fixture examples/active-customer/openai-response.fixture.json
```

このコマンドは通常の`build`と同じ自動昇格経路を使い、検証成功後に次を確定します。

- `examples/active-customer/is-active-customer.generated.ts`
- `semantic.lock`
- `.semantic/candidates/<run-id>/`の監査記録

lock済みの意味と生成物整合性を、APIなし・読み取り専用で確認できます。

```bash
bun run semantic explain examples/active-customer/semantic.ts
bun run semantic:closure
bun run semantic:verify
```

## 6. 30秒で分かるTypeScript DSL

Semantic sourceには、対象型、Concept、生成対象、Semantic Testを置きます。

```ts
import {
  concept,
  generatePredicate,
  semanticTest,
} from "../../src/dsl";

type Customer = {
  status: "active" | "suspended";
  deletedAt: string | null;
  email: string | null;
};

const ActiveCustomer = concept<Customer>`
Definition:
An active customer is permitted to use the service.

Requirements:
- status is "active".
- deletedAt is null.
- email is present.

Exclusions:
- Suspended or deleted customers.

Out of scope:
- Email deliverability.

Leave unresolved when:
- Status, deletion, or email roles cannot be mapped unambiguously.
`;

export const isActiveCustomer = generatePredicate(ActiveCustomer);

semanticTest(isActiveCustomer, {
  accept: [
    { status: "active", deletedAt: null, email: "a@example.com" },
  ],
  reject: [
    { status: "suspended", deletedAt: null, email: "a@example.com" },
    { status: "active", deletedAt: null, email: null },
  ],
});
```

LLMへ送るのは、Concept specification、対象のTypeScript型宣言、生成対象のメタデータだけです。`semanticTest`の値はモデルへ送らず、解決後の独立した検証に使用します。

生成物は通常のTypeScriptです。

```ts
// Generated by staged-semantic-typescript-mvp. Do not edit.
import type { Customer } from "./semantic";

export function isActiveCustomer(customer: Customer): boolean {
  return (
    customer.status === "active" &&
    customer.deletedAt === null &&
    (customer.email !== null && customer.email !== undefined)
  );
}
```

## 7. Concept specification

Concept本文は名前付きセクションで記述します。

| セクション | 必須 | 意味 |
| --- | --- | --- |
| `Definition` | 常に必須 | Conceptの中心的な定義 |
| `Requirements` | Predicateではどちらか必須 | 成立に必要な条件 |
| `Exclusions` | Predicateではどちらか必須 | 明示的に除外する条件 |
| `Out of scope` | 任意 | このConceptが判断しないこと |
| `Leave unresolved when` | 任意 | 推測せず停止すべき曖昧さ |

存在するセクションは表の順序を守り、リスト項目は1行の`- item`形式で記述します。次はLLMやfixture resolverを呼ぶ前にコンパイルエラーになります。

- `Definition`の欠落
- 未知、重複、空、順序違反のセクション
- 未分割の自由文
- 旧TOML形式
- template substitution
- Predicateで`Requirements`と`Exclusions`が両方ないConcept

Static Judgmentは、単純な分類に限り`Definition`だけのConceptも使用できます。

## 8. 共有ConceptとSemantic Polymorphism

型に依存しないConceptを一度定義します。

```ts
// concepts/active-customer.ts
import { defineConcept } from "../src/dsl";

export const ActiveCustomer = defineConcept("customer.active")`
Definition:
A customer that is currently permitted to use the service.

Requirements:
- The account is enabled.
- A usable contact method is present.

Exclusions:
- Suspended or deleted accounts.

Leave unresolved when:
- A required semantic role cannot be mapped uniquely.
`;
```

各スキーマ側でbindingします。

```ts
const ActiveServiceAccount =
  bindConcept<ServiceAccount>(ActiveCustomer);

export const isActiveServiceAccount =
  generatePredicate(ActiveServiceAccount);
```

実行可能な例:

```bash
bun run semantic:test:customer-schema
bun run semantic:test:account-schema
bun run semantic:fulfillment:test
```

関連するソースは[`examples/semantic-polymorphism/`](./examples/semantic-polymorphism/)と[`examples/order-fulfillment/`](./examples/order-fulfillment/)にあります。

## 9. 自動適応とPromotion

通常経路は、Project contextへ適応した候補を機械検証し、そのまま確定します。

| 経路 | 用途 | 生成物とlockの更新 |
| --- | --- | --- |
| `semantic build` | 既定のVibe coding経路 | 機械検証成功後に自動昇格 |
| `semantic build --review` | 互換用のcandidate staging | build時は候補保存のみ。`approve`時に昇格 |
| `semantic replay` | lock済み結果の再現 | 検証後に生成物を確定 |
| `semantic check` | Schema変更への再適応 | consensus済みcandidateを作成 |
| `semantic approve` | staged candidateの明示適用 | 再検証後に昇格 |

### 既定の自動昇格

```bash
bun run semantic build <semantic-source.ts>
```

lock missではLLMを1回呼び、候補が次の全検証を通ると、生成物と`semantic.lock`を自動更新します。

1. IRの厳格parse
2. TypeScript型文脈でのproperty pathとliteral検証
3. 決定的コード生成
4. candidate専用typecheck
5. candidate専用Semantic Test
6. プロジェクト全体typecheck
7. プロジェクト全体テスト
8. lock書き込み

失敗した場合は昇格せず、既存の生成物とlockを復元します。

### 互換用のcandidate staging

```bash
bun run semantic build <semantic-source.ts> --review
bun run semantic diff <review-id>
bun run semantic approve <review-id> --reviewer <id>
```

`--review`は既存ワークフローとの互換性のために残すstaging機能です。検証済みcandidateとdiffを`.semantic/reviews/`へ保存し、明示適用までtracked生成物と`semantic.lock`を変更しません。L-Langの中心経路と価値提案は、通常の`semantic build`による自動適応です。

### Semantic TDD（Predicate POC）

Semantic TDDは、Contractと型だけからTest Planを独立生成し、trace・型・実装前Red検証後に`semantic-test.lock`へ自動freezeしてからImplementationを生成します。

```bash
# Test Planを機械検証・自動freezeしてからImplementationを生成
bun run semantic tdd-build examples/active-customer/semantic.ts \
  --test-fixture examples/active-customer/semantic-test-response.fixture.json \
  --fixture examples/active-customer/openai-response.fixture.json

# API・書き込みなしで整合性を検証、またはlockから再実行
bun run semantic tdd-test examples/active-customer/semantic.ts
bun run semantic tdd-replay examples/active-customer/semantic.ts
```

`tdd-build`はTest SynthesizerへImplementation IR、生成TypeScript、候補ごとの結果を渡しません。自動freezeは全Hard clause traceと実装前Redを必須とします。`tdd-plan → diff → approve`は既存ワークフロー向けの互換用stagingです。`tdd-test`はContract、両lock、生成物hash、Red Certificate、Selection Reportを読み取り専用で照合します。

## 10. CLIリファレンス

| コマンド | API | 主な動作 |
| --- | --- | --- |
| `semantic build <source>` | lock miss時のみ | PredicateまたはStatic Judgmentをbuildし、既定で自動昇格 |
| `semantic build <source> --review` | lock miss時のみ | 検証済みreview candidateを保存 |
| `semantic replay <source>` | 呼ばない | 一致するlock entryから再生成・再検証 |
| `semantic test <source>` | 呼ばない | lock済みPredicateの解釈とSemantic Testを実行 |
| `semantic check <source>` | 変更時に呼ぶ | Schema Evolution candidateを2/3 consensusで作成 |
| `semantic diff <candidate-id>` | 呼ばない | review/evolution candidateを表示 |
| `semantic approve <candidate-id> --reviewer <id>` | 呼ばない | candidateを再検証して昇格 |
| `semantic explain <source>` | 呼ばない | source、lock、生成物を読み取り専用で説明 |
| `semantic closure <manifest>` | 呼ばない | Context・検証provenanceを含む複数artifactを読み取り専用で検査 |
| `semantic verify <manifest>` | 呼ばない | Closure、決定的再生成、Semantic Test、typecheckを一括検証 |
| `semantic tdd-plan <source>` | fixture時は0、live時は1 | staged freeze用の実装非参照Test Plan candidateを保存 |
| `semantic tdd-build <source>` | 各lock miss時のみ | Test Planを先に機械検証・freezeし、Predicate候補を検証・昇格 |
| `semantic tdd-test <source>` | 呼ばない | Test Plan、Implementation、生成物、証明artifactを読み取り専用検証 |
| `semantic tdd-replay <source>` | 呼ばない | 両lockからSemantic TDD transactionを再実行 |

### Fixture

`build`と`check`は、保存済みResponses API応答を使用できます。

```bash
bun run semantic build <source> --fixture <response.json>
bun run semantic check <source> --fixture <response.json>
```

Fixture利用時はAPI callとして数えません。

### Consensus

`semantic check`の既定値は3 samples / quorum 2です。応答は並列取得され、型付きSemantic signatureが2票揃った場合だけ候補を確定します。

```bash
# 既定の2/3 consensus
bun run semantic check <source>

# 旧来の単発方式
bun run semantic check <source> --samples 1 --quorum 1
```

## 11. Static Judgment

build時に存在するliteralな自然言語値をConceptに照らして判断し、通常のboolean定数へ固定できます。

```ts
import { judgeStatic, staticValue } from "../../src/dsl";
import { Cat } from "./cat";

const mike = staticValue(`
  A small domesticated calico animal that meows.
`);

export const mikeIsCat = judgeStatic(mike, Cat);
```

生成物:

```ts
// Generated by the semantic compiler. Do not edit.
export const mikeIsCat = true as const;
```

APIなしのfixture buildとlock replay:

```bash
bun run semantic:judgment:fixture
bun run semantic:judgment:replay
```

blind benchmark基盤は、model input、Oracle、3回分のfixtureを別ファイルとして扱い、manifestを含む全入力のfreeze hashが一致する場合だけread-only評価を実行します。manifestの`profile`は`fixture`または`held-out`で、`held-out`は正確に48 caseを要求します。

```bash
bun run benchmark:static-judgment:fixture -- <manifest> --json
```

Oracleとexpected理由はmodel requestへ含めません。fixture runnerのreportはprofileに関係なく`evidenceEligible: false`です。fixture成功はharnessの検証であり、model精度の証拠ではありません。現在は1 sourceにつき1つの`staticValue`と`judgeStatic`、boolean結果だけを扱います。runtime変数、関数戻り値、template substitutionはresolver実行前に拒否します。48 caseの独立dataset作成とlive判断精度評価は未完了です。

## 12. ExplainとClosure

### Semantic Explain

```bash
bun run semantic explain examples/active-customer/semantic.ts
bun run semantic explain examples/static-judgment/semantic.ts
bun run semantic explain examples/active-customer/semantic.ts --json
```

`explain`はsource、`semantic.lock`、生成済みTypeScriptだけを読みます。API、resolver、build、lock更新、audit作成は行いません。

| status | 意味 |
| --- | --- |
| `current` | 現在の入力、lock、生成物hashが一致 |
| `stale` | 同じsource/symbolの履歴はあるがSemantic入力が変化 |
| `unlocked` | 対応するlock entryがない |
| `integrity-error` | currentなlock entryに対し生成物が欠損またはhash不一致 |

現行の`explain`にはCI用`--strict`やstatus別exit codeはありません。

### Semantic Closure

```bash
bun run semantic:closure
bun run semantic closure semantic-closure.json --json
```

manifestへ明示した複数のPredicate / Static Judgmentを検査し、Project Fit-aware graphを作ります。

- 全nodeが`current`: `closed`、exit code 0
- `stale`、`unlocked`、`integrity-error`、`verification-required`、`dependency-open`を含む: `open`、exit code 2
- manifest、source、lock、graphが不正: exit code 1

Closureはリポジトリ全体を自動探索しません。nodeとdependency edgeはmanifestへの明示が必要で、現行reportはdomain correctnessそのものを判定しません。

### Semantic Verify

```bash
bun run semantic:verify
bun run semantic verify semantic-closure.json --json
```

Closure、lockからの決定的再生成、各PredicateのSemantic Test、Project typecheckをAPIなし・永続書き込みなしで一括検証します。text / JSON reportには具体的なremediationを含みます。検証失敗はexit code 2、manifestやI/Oなどのoperational errorはexit code 1です。

## 13. OpenAI / Azure OpenAI接続

`.env.example`をコピーします。Bunが`.env`を自動的に読み込むため、dotenvパッケージは不要です。

```bash
cp .env.example .env
```

OpenAI:

```dotenv
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.4-mini
OPENAI_BASE_URL=https://api.openai.com/v1
```

Azure OpenAI:

```dotenv
OPENAI_API_KEY=<Azure OpenAI API key>
OPENAI_MODEL=gpt-5-4-mini
OPENAI_BASE_URL=https://<resource-name>.openai.azure.com
```

`OPENAI_MODEL`の既定値は`gpt-5.4-mini`です。AzureではモデルIDではなくdeployment名を設定します。`.openai.azure.com`を検出すると`/openai/v1/responses`へ正規化し、`api-key`headerを使用します。通常のOpenAI APIではBearer認証を使用します。

リクエストはResponses APIのStructured Outputsを使用し、`store: false`を指定します。

## 14. 安全境界とデータ

### モデルへ送るもの

- Concept IDとConcept specification
- 対象のTypeScript型宣言
- 生成するsymbol、parameter、typeの名前

### 通常のモデル入力へ送らないもの

- `semanticTest`の値
- Benchmark Oracle
- hidden cases
- リポジトリ全体
- API key

### ローカルへ保存するもの

- モデル応答とmetadata
- 解決されたIRまたはboolean
- candidate codeと検証report
- input/output hash
- promotion provenance

監査情報は`.semantic/`へ保存され、Git管理対象外です。ただし、外部共有前には内容を確認してください。Conceptと型宣言自体に機密情報を含めないでください。

自動昇格が信頼するのは、制限IR、型文脈検証、candidate test、全回帰、crash-consistent transactionという機械的なGateです。promotionはworkspace lockで直列化され、previous/next byteとjournalから中断後にrollbackまたはcommit検証を行います。これはProject contextへの適合を強めますが、業務上の意味が常に正しいことまで保証するものではありません。

詳細は[SECURITY.md](./SECURITY.md)を参照してください。

## 15. 再現性と監査

`semantic.lock`はPredicateとStatic Judgmentを別namespaceで保存し、次の情報を保持します。

- source、Concept、type、test、promptのhash
- 解決済みPredicate IRまたはboolean
- provider/modelとtoken metadata
- 生成コードのSHA-256
- 作成日時
- promotion provenance（`reviewed`は互換用staging由来の旧名称）

現在のSemantic入力と一致するentryがあれば、`replay`はproviderやmodelへ接続せず、同じ生成コードhashを再現します。

監査directory:

| directory | 内容 |
| --- | --- |
| `.semantic/candidates/` | Predicate buildの試行 |
| `.semantic/judgments/` | Static Judgmentの試行 |
| `.semantic/reviews/` | 互換用staging candidate |
| `.semantic/evolution/` | Schema Evolution candidate |
| `.semantic/benchmarks/` | Benchmark reportと応答 |
| `.semantic/transactions/` | promotionのprevious/next snapshotと状態journal |

CLI errorは`SEMANTIC_*`のstable code、stage、message、remediationを持ちます。`--json`対応commandのerrorはversion 1のJSONとして同じcodeを返します。認証情報らしき値はmessageからredactされます。

## 16. 例とBenchmark

### 実行可能な例

| 例 | 内容 |
| --- | --- |
| [`examples/active-customer/`](./examples/active-customer/) | 基本的なPredicate build/replay/test |
| [`examples/semantic-polymorphism/`](./examples/semantic-polymorphism/) | 共有Conceptを2つのスキーマへbinding |
| [`examples/order-fulfillment/`](./examples/order-fulfillment/) | 1 Conceptを3つの業務表現へ具体化 |
| [`examples/static-judgment/`](./examples/static-judgment/) | literalな自然言語値のboolean定数化 |
| [`semantic-closure.json`](./semantic-closure.json) | 複数artifactのClosure manifest |

### 現在までの評価

2026-07-25時点のローカル検証:

- TypeScript typecheck成功
- sample Semantic Closure: 4/4 nodeがProject Fit verified
- `semantic verify`: 4/4決定的再生成、3/3 Predicate Semantic Test、typecheck成功

保存済み研究結果:

| 評価 | 結果 | 留保 |
| --- | --- | --- |
| Blind Cross-schema | 27/27試行成功、false resolution 0 | 限定された3 Concept / 9 schema |
| 旧Schema Evolution評価 | 50/54試行成功、false resolution 0 | 単発応答には揺れが残る |
| 旧応答のConsensus replay | 18/18ケース成功 | 同じ応答を使った事後評価でheld-outではない |
| Schema Evolution | 未実行 | 評価設計Blockerの解消と新しいfrozen input待ち |

現在の評価設計には、`present`と「usable」の境界、optional nullableの意味、旧評価からの独立性に未解決事項があります。現在の入力を変更して成功証拠として再利用せず、再開条件を満たしてから新しいheld-out評価を行います。詳細は[`benchmarks/schema-evolution/BLOCKER.md`](./benchmarks/schema-evolution/BLOCKER.md)を参照してください。

## 17. 現在の制限

- 1 Predicate sourceにつき、1 Concept / 1 generated Predicate / 1 `semanticTest`
- 1 Static Judgment sourceにつき、1 `staticValue` / 1 `judgeStatic`
- `semantic explain`は1 source / 1 symbol
- Predicate IRは`all`、`any`、`not`、`equals`、`present`だけ
- Predicate IRは最大256 node / depth 32 / 1条件配列64件 / property path 8 segment
- fixtureとAPI JSONは2 MiB、`semantic.lock`は16 MiB、diagnosticsは32件・各2,000文字まで
- collection全体の`some`、`every`、長さ比較は非対応
- 入力型はローカルrecord、primitive、literal union、array、`null`、`undefined`、最大3段のnestに限定
- Semantic Testのproperty generator / shrinkerは未実装
- Closureは明示manifestのみで、import graph自動探索は未実装
- import graph自動解析、自動修復は未実装
- Static Judgmentのlive精度は未評価
- Schema Evolutionの独立held-out評価とmeasured developer Pilotは未完了
- LSP、独自構文、独自runtime、他言語backendは未実装
- npm packageとして公開していない
- promotion中の生成物をL-Lang以外のprocessが読む場合のmulti-file atomicityは保証しない
- workspace lock競合は待機せず`SEMANTIC_WORKSPACE_BUSY`でfail-fastする

## 18. リポジトリ構成

```text
src/
  dsl.ts                         TypeScript内のcompile-time form
  semantic-source.ts             Predicate source scanner
  static-judgment-source.ts      Static Judgment source scanner
  ir.ts                          制限Predicate IR
  context-validator.ts           TypeScript型文脈でのIR検証
  generator.ts                   決定的Predicate generator
  semantic-compiler.ts           Predicate compiler transaction
  static-judgment-compiler.ts    Static Judgment compiler transaction
  static-judgment-benchmark.ts   blind benchmarkのread-only実行と集計
  static-judgment-benchmark-parser.ts  manifest / freeze / Oracleのstrict parser
  semantic-pipeline.ts           compiler共通run / audit / command基盤
  semantic-transaction.ts        workspace lock / journal / recovery
  semantic-limits.ts             IR / 外部入力のresource budget
  semantic-error.ts              stable error codeとsafe diagnostics
  semantic-review.ts             互換用staging workflow
  semantic-evolution.ts          Schema Evolution workflow
  semantic-explain.ts            読み取り専用説明
  semantic-closure.ts            artifact-level Closure
  semantic-test-runner.ts        拡張Semantic Testのread-only実行
  semantic-verify.ts             Project単位の統合read-only検証

concepts/                        共有Concept
examples/                        実行可能なfixtureと生成物
benchmarks/                      凍結済み評価入力、Oracle、結果
semantic.lock                   再現可能な解決結果
```

## 19. 開発

```bash
bun install
bun run check
bun run coverage
bun run ci:docs
bun run ci:smoke
bun run ci:protected
git diff --check
```

固定ツールバージョン、coverage閾値、CI OS matrix、最新値の記録方法は[`QUALITY_GATES.md`](./QUALITY_GATES.md)を正とします。テスト件数とcoverage実測値は各CI runで生成し、READMEへ変動値を複製しません。

変更時は次の原則を維持してください。

- LLM出力から自由なTypeScriptを直接実行しない
- 新しい生成対象には専用IR、validator、deterministic generator、testを用意する
- 曖昧な入力を推測でresolvedにしない
- Oracleとhidden caseをモデル入力やconsensus選択へ使わない
- 凍結済みBenchmarkを結果に合わせて調整しない
- Exact CodeとSemantic Codeの境界を崩さない

詳細は[CONTRIBUTING.md](./CONTRIBUTING.md)を参照してください。

## 20. License

L-Langは[MIT License](./LICENSE)で公開されています。ライセンス表示と免責条項を維持する限り、利用、複製、変更、配布、サブライセンス、販売を含めて自由に使用できます。

`package.json`の`private: true`はnpmへの誤公開を防ぐための設定であり、MIT Licenseによるソースコード利用を制限するものではありません。
