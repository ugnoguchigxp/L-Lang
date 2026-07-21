# M1〜M4 実行用実装計画

作成日: 2026-07-21
状態: 実装中（M1完了、M2未着手）
基準コミット: `70e7870 feat: add artifact-level semantic closure`
対象: 自動適用と任意Review、Policy-aware Semantic Closure、Semantic Test拡張、`semantic verify`

## 1. この文書の役割

この文書は、[`RELEASE_0_1_ALPHA_IMPLEMENTATION_PLAN.md`](./RELEASE_0_1_ALPHA_IMPLEMENTATION_PLAN.md)のM1〜M4を、実装者が追加設計なしで着手できる粒度へ具体化する。M5以降のbenchmark、package公開、CI matrixは対象外とする。

実装順、公開型、CLI契約、lock互換性、変更ファイル、テストケース、完了条件をこの文書で固定する。実装中に契約変更が必要になった場合は、コードより先に本書を更新する。

## 2. 調査済みの現在地

現行コードについて、次を前提とする。

- `compileSemanticSource`と`compileStaticJudgmentSource`の`build`は、候補検証後に生成物と`semantic.lock`をすでに自動適用している
- PredicateとStatic Judgmentは、candidate typecheck、project typecheck、full test、rollbackをそれぞれ独立実装している
- `semantic check / diff / approve`はSchema Evolution後のPredicate専用であり、新規PredicateとStatic Judgmentの任意Reviewには使えない
- Schema Evolution candidateは`.semantic/evolution/<id>`へ保存され、IDは`YYYYMMDDHHMMSS-xxxxxxxx`形式である
- `semantic.lock`はversion 1で、Predicateの`entries`とStatic Judgmentの`judgments`を別namespaceに持つ
- `semantic closure`は明示manifest、依存graph、current / stale / unlocked / integrity-errorをAPIなしで検査するが、review policyを持たない
- `semanticTest`は`accept`と`reject`だけを持ち、一時的なBun test moduleへ変換される
- 現在の`semantic test`は実質的にreplay経路へ入り、独立したread-only contract test APIではない
- `src/cli.ts verify`は低レベルPredicate IR生成の検証であり、今回追加する`semantic verify`とは別機能である
- 基準点は`bun run typecheck`成功、全78 test成功である

したがってM1では自動適用そのものを作り直さず、既存経路を共通化し、その適用直前で停止できる任意Reviewを加える。

## 3. 固定する設計判断

### 3.1 既定は自動適用

```text
resolve / lock hit
  → IR・context検証
  → candidate生成
  → candidate typecheck
  → Semantic Test（Predicateのみ）
  → project typecheck
  → 生成物を一時適用
  → full test
  → semantic.lock更新
```

通常の`semantic build <source>`はこの経路を通る。人間承認を要求しない。

### 3.2 Reviewは明示opt-in

```text
semantic build <source> --review
  → 適用直前まで通常buildと同じ検証
  → review candidateを保存
  → tracked生成物とsemantic.lockは変更しない

semantic diff <review-id>
semantic approve <review-id> --reviewer <id>
  → freshnessとcandidateを再検証
  → 通常buildと同じpromotion経路で適用
```

Reviewの有無でvalidatorやtest強度を変えない。違いは検証済みcandidateを直ちに適用するか、明示承認まで保存するかだけとする。

### 3.3 Review設定を増やしすぎない

M1では新しい全体configファイルを導入しない。

- 単発build: CLIの`--review`
- artifact gate: Closure manifest nodeの`review: "auto" | "manual"`
- manifestで未指定の場合: `auto`

manifestの`manual`はClosureの要求を表す。build時にmanifestを暗黙探索しないため、利用者は`semantic build --review`を明示する。

### 3.4 Schema Evolution candidateと分離する

既存の評価・Consensus経路を壊さないため、任意Review candidateは別namespaceにする。

- 保存先: `.semantic/reviews/<review-id>/`
- ID: `review-YYYYMMDDHHMMSS-xxxxxxxx`
- 既存Evolution ID: 既存どおりprefixなし
- `semantic diff / approve`: ID prefixでReviewとEvolutionへdispatch

M1では`semantic-evolution.ts`をReview candidate実装へ統合しない。

### 3.5 lock version 1を維持する

`semantic.lock`のfingerprint計算とnamespaceを変更せず、各entryへoptionalな`promotion`を追加する。既存lockを一括書き換えない。

- 新規build / approveで書くentry: `promotion`必須
- 既存entry: parser上は許可し、`legacy-auto`として表示
- `review: "auto"`: `auto`、`reviewed`、`legacy-auto`を許可
- `review: "manual"`: `reviewed`だけを許可
- replay: 既存entryのpromotionを変更しない

lock version 2への移行はM1〜M4では行わない。

### 3.6 `unknown`はboolean runtimeへ入れない

現在のPredicate契約は`(value: T) => boolean`である。`unknown`を実行結果へ加えると、Predicate IR、generator、利用側TypeScriptをすべてtri-stateへ変える必要がある。

M3では次を実装する。

- Boundary: accepted / rejectedの境界ケース
- Counterfactual: baseと明示variantの結果変化
- Invariance: 複数表現が同じboolean結果になること

`unknown`はresolverが`unresolved`を返すcompile-time結果として維持し、既存のcompiler / consensus testで検証する。第三の実行値や、実行不能な`unknown`配列を`semanticTest`へ追加しない。resolver-level unknownをユーザーDSLにする作業は、専用Judgment/Test IRの別計画とする。

## 4. 共有データ契約

### 4.1 Promotion provenance

`src/semantic-lock.ts`へ次の型を追加する。

```ts
export type PromotionValidation = {
  candidateTypecheck: "passed";
  projectTypecheck: "passed";
  semanticTest: "passed" | "not-applicable";
  fullTest: "passed";
};

export type PromotionProvenance =
  | {
      mode: "auto";
      promotedAt: string;
      validation: PromotionValidation;
    }
  | {
      mode: "reviewed";
      promotedAt: string;
      candidateId: string;
      reviewer: string;
      validation: PromotionValidation;
    };
```

`SemanticLockEntry`と`StaticJudgmentLockEntry`へ次を追加する。

```ts
promotion?: PromotionProvenance;
```

optionalなのは既存version 1を読むためだけである。新規entryを組み立てる関数では必須引数にする。

parserは次を拒否する。

- unknown `mode`
- 空の`reviewer`または`candidateId`
- reviewedでreviewer / candidateIdが欠落
- autoにreviewer / candidateIdが混入
- canonicalでない`promotedAt`
- `passed` / `not-applicable`以外のvalidation値
- Static Judgmentで`semanticTest: "passed"`

### 4.2 Review candidate

`src/semantic-review.ts`へdiscriminated unionを定義する。

```ts
type ReviewValidation = {
  candidateTypecheck: "passed";
  projectTypecheck: "passed";
  semanticTest: "passed" | "not-applicable";
};

type ReviewCandidateBase = {
  version: 1;
  id: string;
  status: "ready" | "approved";
  source: string;
  output: string;
  symbol: string;
  conceptId: string;
  provider: string;
  model: string;
  fingerprint: string;
  generatedCodeHash: string;
  validation: ReviewValidation;
  createdAt: string;
  approvedAt: string | null;
  reviewer: string | null;
};

type PredicateReviewCandidate = ReviewCandidateBase & {
  kind: "predicate";
  hashes: PredicateSemanticHashes;
  resolvedIr: PredicateExpression;
  baselineFingerprint: string | null;
  response: SemanticLockEntry["response"];
};

type StaticJudgmentReviewCandidate = ReviewCandidateBase & {
  kind: "static-judgment";
  hashes: StaticJudgmentSemanticHashes;
  resolvedValue: boolean;
  baselineFingerprint: string | null;
  response: StaticJudgmentLockEntry["response"];
};
```

candidate directoryには次だけを保存する。

```text
.semantic/reviews/<id>/
  candidate.json
  candidate.ts
  diff.txt
```

raw model responseは既存audit directoryを正とし、Review directoryへ複製しない。`candidate.json`はstrict parserで全field、hash、timestamp、statusとkind別payloadを検証する。

### 4.3 Compiler result

両compilerの結果を次のunionへ変更する。

```ts
type PromotionResult =
  | {
      status: "passed";
      promotionMode: "auto" | "replay";
      // 現行のoutput / fingerprint / hash等
    }
  | {
      status: "review-required";
      promotionMode: "review";
      candidateId: string;
      candidateDirectory: string;
      // source / fingerprint / hash等
    };
```

`SemanticCompileOptions`と`StaticJudgmentCompileOptions`へ次を追加する。

```ts
promotion?: "auto" | "review";
reviewRoot?: string;
```

既定値は`auto`。`mode: "replay"`と`promotion: "review"`の組み合わせは拒否する。

## 5. M1: 自動適用と任意Review

### M1-1. 先に回帰testを固定する

変更前の振る舞いを次のintegration testで明示する。

- Predicate通常buildが生成物とlockを更新する
- Static Judgment通常buildが生成物とlockを更新する
- candidate typecheck / semantic test / project typecheck / full test失敗時に生成物とlockが変わらない
- lock write失敗時に生成物がrollbackされる
- replayはresolverを呼ばない

対象:

- `src/semantic-compiler.integration.test.ts`
- `src/static-judgment-compiler.integration.test.ts`

### M1-2. Promotion transactionを共通化する

新規`src/semantic-promotion.ts`へ、生成物の一時適用、full test、lock書き込み、rollbackを集約する。

```ts
export async function promoteSemanticArtifact(input: {
  outputPath: string;
  generatedCode: string;
  lockPath: string;
  nextLock: SemanticLock;
  workspaceRoot: string;
  runFullTest: () => Promise<void>;
  writeLock?: typeof writeSemanticLock;
}): Promise<void>;
```

処理順を固定する。

1. 現在の生成物をmemoryへ退避
2. 新生成物をtemporary file + renameで配置
3. full test実行
4. `writeSemanticLock`でtemporary file + rename
5. 成功を返す
6. 2〜4でcatch可能な失敗が起きた場合は生成物を復元する

lock write後にはreportやcandidate更新をtransactionへ含めない。lock write成功をcommit pointとし、その後のaudit書き込み失敗はpromotion失敗としてrollbackしない。

M1の保証は「通常のcatch可能なI/O・test失敗に対するrollback」である。プロセス強制終了や電源断を含むcross-file crash recovery journalはM1〜M4の非目標として明記する。

変更対象:

- 追加: `src/semantic-promotion.ts`
- 追加: `src/semantic-promotion.test.ts`
- 修正: `src/semantic-compiler.ts`
- 修正: `src/static-judgment-compiler.ts`
- 修正: `src/semantic-evolution.ts`

`semantic-evolution.ts`も共通promotion関数を使うが、candidate schemaは変更しない。

### M1-3. 新規entryへpromotion provenanceを書く

通常buildでは`mode: "auto"`、Review approveとSchema Evolution approveでは`mode: "reviewed"`を設定する。Schema Evolution approveにもreviewerを渡す。

変更対象:

- `src/semantic-lock.ts`
- `src/semantic-lock.test.ts`
- `src/semantic-explain.ts`
- `src/semantic-explain-renderer.ts`
- `src/semantic-explain.test.ts`
- compiler / evolutionのentry生成箇所

Explainのlock provenanceへ次を追加する。

```ts
promotion: {
  mode: "auto" | "reviewed" | "legacy-auto";
  promotedAt: string;
  candidateId?: string;
  reviewer?: string;
  validation?: PromotionValidation;
}
```

既存entryでは`createdAt`を`promotedAt`として表示し、`mode: "legacy-auto"`と明示する。

### M1-4. Review candidateを作成する

Predicate compilerとStatic Judgment compilerは、全pre-promotion validation成功後に`promotion === "review"`なら次を行う。

1. review IDを採番
2. candidate unionを作成
3. `candidate.json`と`candidate.ts`を書く
4. 現在のlock baselineとの差分を`diff.txt`へ書く
5. audit reportを`status: "review-required"`で完了
6. tracked生成物とlockを変更せずreturn

diff契約:

- Predicate baselineあり: 既存`classifySemanticChange` / `renderSemanticDiff`
- Predicate baselineなし: `NEW PREDICATE`、candidate IR全体を表示
- Static Judgment baselineあり: `before: true|false`、`after: true|false`
- Static Judgment baselineなし: `NEW STATIC JUDGMENT`、candidate valueを表示

追加対象:

- `src/semantic-review.ts`
- `src/semantic-review-renderer.ts`
- `src/semantic-review.test.ts`

### M1-5. Review candidateを承認する

```ts
export async function approveSemanticReview(
  candidateId: string,
  options: {
    reviewer: string;
    workspaceRoot?: string;
    lockPath?: string;
    reviewRoot?: string;
    commandRunner?: SemanticCommandRunner;
  },
): Promise<ReviewApprovalResult>;
```

承認時は保存済みvalidation結果を信用せず、次を再実行する。

1. candidate strict parseとID/path検査
2. reviewerの非空・trim後一致検査
3. source再scan
4. 現在hashとcandidate hashの一致
5. fingerprint、baseline、generated code hashの再計算
6. Predicate context validation
7. candidate typecheck
8. Predicate Semantic Test
9. project typecheck
10. 共通promotion関数による一時適用、full test、lock更新
11. lock commit後にcandidateを`approved`へ更新

candidate status更新だけが失敗した場合、lockのreviewed provenanceを正とし、CLIはpromotion成功とaudit更新警告を分けて表示する。同一fingerprintがreviewed provenance付きで存在する再実行はidempotent successとする。

### M1-6. CLIを接続する

公開CLIを次で固定する。

```bash
semantic build <source.ts> [--fixture <response.json>]
semantic build <source.ts> --review [--fixture <response.json>]
semantic diff <candidate-id>
semantic approve <candidate-id> --reviewer <non-empty-id>
```

- `build --review`: Predicate / Static Judgment両対応
- `diff review-*`: `semantic-review.ts`へdispatch
- `diff <legacy-evolution-id>`: 既存Evolutionへdispatch
- `approve review-*`: `approveSemanticReview`
- `approve <legacy-evolution-id>`: reviewerを渡して既存Evolution approve
- `--review`はbuild以外で拒否
- `--reviewer`はapprove以外で拒否
- fixtureを使ってもreview semanticsは同一

変更対象:

- `src/semantic-cli.ts`
- `src/semantic-explain.integration.test.ts`
- 新規`src/semantic-review.integration.test.ts`
- `README.md`

### M1完了条件

- 既存の通常build / replayが後方互換で成功する
- Predicate / Static Judgmentの`build --review`がtracked生成物とlockを変更しない
- `diff → approve`後に初めて生成物とlockが更新される
- stale、tampered、wrong-kind、invalid timestamp、missing reviewerを拒否する
- auto / reviewed / legacy-autoがExplainで区別される
- full testまたはlock write失敗で生成物とlockが元のまま
- ReviewとEvolution candidate IDが衝突せず、既存Evolution testがすべて成功する

## 6. M2: Policy-aware Semantic Closure

### M2-1. Manifest schema

nodeへoptionalな`review`を追加する。

```ts
export type SemanticReviewPolicy = "auto" | "manual";

export type SemanticClosureManifestNode = {
  id: string;
  source: string;
  dependsOn: string[];
  review: SemanticReviewPolicy;
};
```

JSONでは省略可能で、parser結果では必ず`auto`へ正規化する。unknown value、大小文字違い、unknown fieldは拒否する。rootの`semantic-closure.json`は省略状態のままでも同じ4/4 closedを維持する。

### M2-2. Node status

Closure固有statusをExplain statusから分離する。

```ts
export type SemanticClosureNodeStatus =
  | "current"
  | "stale"
  | "unlocked"
  | "integrity-error"
  | "review-required"
  | "dependency-open";
```

各nodeは診断元を失わないよう次を持つ。

```ts
type SemanticClosureNode = {
  // 既存field
  status: SemanticClosureNodeStatus;
  semanticStatus: SemanticExplanationStatus;
  review: {
    policy: "auto" | "manual";
    promotionMode: "auto" | "reviewed" | "legacy-auto" | null;
    satisfied: boolean;
  };
  openDependencies: string[];
};
```

### M2-3. 判定順序

status優先順位を固定する。

1. Explainが`integrity-error`なら`integrity-error`
2. Explainが`stale`なら`stale`
3. Explainが`unlocked`なら`unlocked`
4. policyがmanualでpromotion modeがreviewedでなければ`review-required`
5. dependencyのいずれかがcurrentでなければ`dependency-open`
6. それ以外は`current`

graphは依存先からtopological orderで評価する。`dependency-open`の`openDependencies`には直接依存のうちcurrentでないIDだけをsortして入れる。blockerはnodeごとに一件とし、messageに直接依存IDを含める。

`unresolved`履歴と`test-failed`statusはM2へ追加しない。unresolved buildはlockを作らないため最終Closureでは`unlocked`となり、test failureもpromotionされない。詳細な失敗理由はaudit report、実行時のtest結果はM4 reportを正とする。

### M2-4. Report schema

rootの`approval: "unknown"`を削除し、次へ置き換える。

```ts
review: {
  auto: number;
  manual: number;
  satisfied: number;
  required: number;
};
```

summaryへ`reviewRequired`と`dependencyOpen`を追加する。limitationsから「Human approval is unknown」を削除し、legacy-autoが存在する場合だけ動的なlimitationを追加する。

### M2-5. 変更対象

- `src/semantic-closure.ts`
- `src/semantic-closure-renderer.ts`
- `src/semantic-closure.test.ts`
- `src/semantic-closure.integration.test.ts`
- `examples/semantic-closure/manual-review.json`（open fixture）
- `README.md`
- `PROJECT_STATUS_AND_ROADMAP.md`

### M2 test matrix

- review省略がautoへ正規化される
- auto + auto promotion = current
- auto + reviewed = current
- auto + legacy = current + limitation
- manual + reviewed = current
- manual + auto / legacy / no promotion = review-required
- dependency先review-requiredが依存元へdependency-openとして伝播する
- stale / unlocked / integrity-errorがreview-requiredより優先される
- cycle / duplicate / unknown dependency / workspace escapeの既存拒否を維持する
- textとJSONのsummary、blocker、exit code 0 / 2 / 1が一致する
- API呼び出し、resolver呼び出し、workspace mutationが0

### M2完了条件

- root manifestは既定autoでclosedを維持する
- manual nodeだけが人間ReviewをClosure条件にする
- dependency-openが推移的に伝播する
- Closure reportからreview policyと実際のpromotion modeを監査できる
- 既存read-only保証とexit code契約を維持する

## 7. M3: Semantic Test拡張

### M3-1. DSL契約

`src/dsl.ts`の`semanticTest`を後方互換で拡張する。

```ts
export type SemanticExpected = "accepted" | "rejected";

export type SemanticTestContract<T> = {
  accept: readonly T[];
  reject: readonly T[];
  boundary?: readonly {
    name: string;
    input: T;
    expected: SemanticExpected;
  }[];
  counterfactual?: readonly {
    name: string;
    base: {
      input: T;
      expected: SemanticExpected;
    };
    variants: readonly {
      name: string;
      input: T;
      expected: SemanticExpected;
    }[];
  }[];
  invariance?: readonly {
    name: string;
    expected: SemanticExpected;
    inputs: readonly T[];
  }[];
};
```

既存の`accept` / `reject`は必須のままにする。新fieldはすべてoptionalなので既存sourceは変更不要。

CounterfactualはAlphaではbaseとvariantの完全な型付き入力を要求する。「一部分だけ変更されたか」の構造差分強制は行わず、nameとreportでレビュー可能にする。任意のpatch適用DSLは導入しない。

### M3-2. Source scanner

`SemanticSource.tests`を次へ拡張する。

```ts
type SemanticTestSources = {
  predicateName: string;
  acceptSource: string;
  rejectSource: string;
  boundarySource: string | null;
  counterfactualSource: string | null;
  invarianceSource: string | null;
};
```

scannerはTypeScript型検査に加えて、AST上で次を検査する。

- 各fieldはarray literal
- caseはobject literal
- `name`と`expected`はliteral
- nameはtrim後に空でない
- expectedは`accepted`または`rejected`
- counterfactual variantsとinvariance inputsは非空
- 同一section内のnameは重複しない
- spread、identifier参照、関数呼び出し、computed property、template substitutionを拒否
- input自体は既存`assertStaticExpression`で静的値に限定する

診断は`semanticTest.boundary[0].expected`のようなsource pathを含める。

変更対象:

- `src/dsl.ts`
- `src/semantic-source.ts`
- `src/semantic-source.test.ts`
- 追加: `src/semantic-test-source.ts`（拡張test AST parserをscanner本体から分離）

### M3-3. Fingerprint

`predicateSemanticHashes`とSchema Evolutionの`prepareInput`で、`testHash`へ次を順序固定で含める。

```ts
{
  accept,
  reject,
  boundary,
  counterfactual,
  invariance,
}
```

未指定fieldは`null`としてhashへ含める。これにより新testの追加・削除・期待値変更は既存lockとReview candidateをstaleにする。fingerprint fixtureは意図したhash変更として更新する。

### M3-4. Test renderer

`renderSemanticTestModule`へ拡張sourceを渡し、すべてのcaseを同じ`registerCase`へflattenする。

case IDは安定した形式にする。

```text
accept[0]
reject[0]
boundary:<name>
counterfactual:<group>:base
counterfactual:<group>:<variant>
invariance:<group>[0]
```

各failureにはcase ID、input、expected boolean、actual booleanをpretty JSONで出す。Invarianceは全入力が明示expectedと一致することを検査し、先頭結果を暗黙oracleにしない。

変更対象:

- `src/judgement-renderer.ts`
- `src/judgement-renderer.test.ts`
- compiler / evolutionのrenderer呼び出し

### M3-5. `semantic test`を独立させる

新規`src/semantic-test-runner.ts`へread-only APIを追加する。

```ts
export async function runSemanticTests(options: {
  sourcePath: string;
  workspaceRoot?: string;
  lockPath?: string;
  commandRunner?: SemanticCommandRunner;
}): Promise<SemanticTestRunResult>;
```

処理:

1. sourceがPredicateであることを確認
2. Explain相当の検査でcurrentとgenerated hash verifiedを要求
3. sourceをscanして全test sourceを取得
4. 最終generated moduleをimportする一時testをsource directoryへ作成
5. `bun test <temporary-test>`を実行
6. `finally`で一時testを削除
7. resolver、OpenAI adapter、lock writerを一切呼ばない

Static Judgmentに対する`semantic test`は`not-applicable`成功ではなく、明示エラー`Static Judgment has no runtime Semantic Test contract`を返す。M4ではStatic Judgmentをskipとして集計する。

CLIの`semantic test <source>`はこのAPIへ接続し、replay aliasではなくする。`semantic replay`の既存動作は維持する。

### M3 examples

`examples/active-customer/semantic.ts`へ各一件以上を追加する。

- boundary: deletedAt直前条件など、accepted / rejectedの境界
- counterfactual: active baseからstatusだけsuspendedへ変えたvariant
- invariance: email文字列の表現が異なる複数active customer

polymorphism exampleは既存accept / rejectのまま残し、optional fieldの後方互換fixtureとして使う。

example変更で`sourceHash`と`testHash`が変わるため、実装後に既存fixtureで通常buildし、新しいauto promotion entryを`semantic.lock`へ追加する。

```bash
bun run semantic build examples/active-customer/semantic.ts \
  --fixture examples/active-customer/openai-response.fixture.json
```

これはM3で意図するtracked lock更新である。生成IRとgenerated code hashが従来と同じであることをdiffで確認し、古いlock entryは履歴として残す。

### M3 test matrix

- 既存accept / rejectだけのsourceが同じようにscan・実行できる
- Boundaryのaccepted / rejected成功・失敗
- Counterfactualのbase / variant成功・失敗
- Invarianceの複数入力成功・失敗
- invalid expected、空name、重複name、空variants / inputs、dynamic expressionをscannerが拒否
- test追加・削除・expected変更でtestHashとfingerprintが変わる
- test変更後にExplain / Closureがstaleになる
- `semantic test`のAPI呼び出し0、lock / generated / audit mutation 0
- 一時testが成功時・失敗時とも残らない

### M3完了条件

- 3種類の拡張testがDSL、scanner、hash、renderer、CLIを一貫して通る
- 既存sourceの変更は不要
- Runtime Predicateはbooleanのまま
- hidden expected値をresolver / model入力へ渡さない
- `semantic test`がread-only、API-freeな独立コマンドになる

## 8. M4: `semantic verify`

### M4-1. 公開CLI

```bash
semantic verify <manifest.json> [--json]
```

M4ではmanifest引数を必須にする。暗黙のファイル探索や新configは導入しない。

### M4-2. APIとreport

新規`src/semantic-verify.ts`へ追加する。

```ts
export type SemanticVerifyCheckStatus = "passed" | "failed" | "skipped";

export type SemanticVerifyReport = {
  version: 1;
  status: "passed" | "failed";
  manifest: string;
  closure: SemanticClosureReport;
  checks: {
    closure: {
      status: "passed" | "failed";
      durationMs: number;
    };
    deterministicGeneration: {
      status: SemanticVerifyCheckStatus;
      total: number;
      passed: number;
      failed: number;
      skipped: number;
      nodes: Array<{
        id: string;
        status: SemanticVerifyCheckStatus;
        diagnostic: string | null;
      }>;
      durationMs: number;
    };
    semanticTests: {
      status: SemanticVerifyCheckStatus;
      total: number;
      passed: number;
      failed: number;
      skipped: number;
      nodes: Array<{
        id: string;
        status: SemanticVerifyCheckStatus;
        diagnostic: string | null;
      }>;
      durationMs: number;
    };
    typecheck: {
      status: "passed" | "failed";
      diagnostic: string | null;
      durationMs: number;
    };
  };
  durationMs: number;
  completedAt: string;
};
```

API:

```ts
export async function verifySemanticArtifact(options: {
  manifestPath: string;
  workspaceRoot?: string;
  lockPath?: string;
  commandRunner?: SemanticVerifyCommandRunner;
}): Promise<SemanticVerifyReport>;
```

`SemanticVerifyCommandRunner`は非zero exitをthrowへ潰さず、検証failureとして集計できる形に固定する。

```ts
export type SemanticVerifyCommandRunner = (
  command: string[],
  cwd: string,
) => Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;
```

### M4-3. 実行順

1. `checkSemanticClosure`
2. current lock entryから各nodeの生成コードをmemory上で決定的再生成し、lock hashと比較
3. manifestの各Predicate nodeへ`runSemanticTests`
4. Static Judgment nodeはsemantic testを`skipped`
5. `bun run typecheck`
6. report集計

決定的再生成はPredicateで`generatePredicate`、Static Judgmentで`generateStaticJudgmentConstant`を直接使う。ファイルは書かず、生成hashがlockと違うnodeを`failed`にする。current lock entryを取得できないnodeは`skipped`にする。

Closureがopenでも、sourceを安全にscanできるnodeのtestとtypecheckは実行し、可能な限り診断を集める。ただしgenerated integrityがverifiedでないnodeのsemantic testは`skipped`とする。

M4の`semantic verify`は`bun test`全体を内部実行しない。verify integration test自身による再帰起動を避け、責務をSemantic Closure、Semantic Test、TypeScript型検査へ限定する。全repository testは外側の`bun test`と将来のM6 CIが担当する。

### M4-4. Read-onlyとprocess出力

- resolver / OpenAI / lock writer / compiler transactionをimportしない
- API keyが環境にあってもnetwork call 0
- temporary semantic testは必ず`finally`で削除
- `.semantic/`へreportを書かない。reportはstdoutだけ
- child process stdout / stderrはcaptureし、JSON modeのstdoutへ混ぜない
- text modeでは失敗checkの短いdiagnosticだけを出す
- secrets、raw prompt、raw responseはreportへ含めない

### M4-5. Exit code

- `0`: Closure closed、決定的再生成、全Predicate Semantic Test、typecheckがすべてpassed
- `2`: 検査は完了したがClosure open、決定的再生成failure、Semantic Test failure、typecheck failureのいずれか
- `1`: manifest parse、I/O、source scan、child process起動など検査自体を完了できないoperational error

`bun test`の非zeroはSemantic Test failureとしてreportへ格納しexit 2とする。command spawn自体の失敗だけをexit 1とする。

### M4-6. 変更対象

- `src/semantic-verify.ts`
- `src/semantic-verify-renderer.ts`
- `src/semantic-verify.test.ts`
- `src/semantic-verify.integration.test.ts`
- `src/semantic-cli.ts`
- `package.json`へ`semantic:verify`
- `README.md`
- `PROJECT_STATUS_AND_ROADMAP.md`

### M4 integration test

root workspaceで次をsnapshotしてからCLIを実行する。

- `semantic.lock`
- 4つのgenerated output
- `.semantic/` tree
- v2 benchmark / freeze hash
- source directoryの一時test候補一覧

ケース:

1. root manifest text: exit 0、4 node closed、決定的再生成4件pass、Predicate 3件test、Static Judgment 1件skip、typecheck pass
2. root manifest JSON: parse可能な単一JSON、exit 0
3. open fixture: exit 2、closure failed、unlocked node test skip
4. manual review fixture: exit 2、review-required
5. generated tamper fixture: exit 2、integrity-error、test skip
6. semantic test failure fixture: exit 2、node diagnosticあり
7. typecheck failure fixture: exit 2、diagnosticあり
8. invalid manifest / unknown option / fixture option: exit 1
9. 前後snapshot一致、API spy 0

### M4完了条件

- 一コマンドでM2 Closure、lockからの決定的再生成、M3 Semantic Test、TypeScript型検査を検証できる
- text / JSON / exit codeが同じ判定を表す
- open statusは推測修復せずfail-closedする
- 実行前後でtracked file、lock、generated output、`.semantic/`が変化しない
- 通常経路でnetwork call 0

## 9. 実装順とコミット単位

次の順序を変更しない。

### Commit 1: Promotion provenanceと共通transaction

- lock optional schema
- shared promotion
- compiler / evolution接続
- auto / legacy Explain
- rollback test

Gate:

```bash
bun run typecheck
bun test src/semantic-lock.test.ts src/semantic-compiler.integration.test.ts src/static-judgment-compiler.integration.test.ts src/semantic-evolution.integration.test.ts src/semantic-explain.test.ts
```

### Commit 2: 任意Review

- Review candidate union / parser / renderer
- build --review
- diff / approve dispatch
- reviewed provenance
- Predicate / Static Judgment integration test

Gate:

```bash
bun run typecheck
bun test src/semantic-review.test.ts src/semantic-review.integration.test.ts src/semantic-evolution.integration.test.ts
```

### Commit 3: Policy-aware Closure

- manifest review policy
- new node status / dependency propagation
- report / renderer
- manual fixture

Gate:

```bash
bun run typecheck
bun test src/semantic-closure.test.ts src/semantic-closure.integration.test.ts
bun run semantic closure semantic-closure.json
```

### Commit 4: Semantic Test拡張

- DSL / scanner / fingerprint
- renderer
- read-only test runner
- examples / CLI

Gate:

```bash
bun run typecheck
bun test src/semantic-source.test.ts src/semantic-fingerprint.test.ts src/judgement-renderer.test.ts src/semantic-test-runner.test.ts
bun run semantic test examples/active-customer/semantic.ts
```

### Commit 5: semantic verify

- verify API / renderer / CLI
- text / JSON / exit code
- read-only integration test
- docs / roadmap

Gate:

```bash
bun run typecheck
bun test src/semantic-verify.test.ts src/semantic-verify.integration.test.ts
bun run semantic verify semantic-closure.json
bun run semantic verify semantic-closure.json --json
```

### Final gate

```bash
git diff --check
bun run typecheck
bun test
bun run semantic replay examples/active-customer/semantic.ts
bun run semantic replay examples/static-judgment/semantic.ts
bun run semantic closure semantic-closure.json
bun run semantic verify semantic-closure.json
```

期待値:

- 全コマンドexit 0
- full testは基準78件以上、fail 0
- replay API call 0、cache hit true
- root Closure closed
- verify passed
- protected artifact hashは意図したlock migration / example変更以外で不変

## 10. ファイル別変更一覧

| ファイル | M | 変更 |
| --- | --- | --- |
| `src/semantic-promotion.ts` | M1 | 共通promotion / rollback |
| `src/semantic-review.ts` | M1 | Review candidate、parse、approve |
| `src/semantic-review-renderer.ts` | M1 | Predicate / Static Judgment diff |
| `src/semantic-lock.ts` | M1 | promotion provenance optional schema |
| `src/semantic-compiler.ts` | M1 | auto / review分岐、共通promotion |
| `src/static-judgment-compiler.ts` | M1 | auto / review分岐、共通promotion |
| `src/semantic-evolution.ts` | M1 | 共通promotion、reviewer provenance |
| `src/semantic-explain.ts` | M1/M2 | promotion modeの公開 |
| `src/semantic-cli.ts` | M1/M3/M4 | review dispatch、test、verify |
| `src/semantic-closure.ts` | M2 | policy、status、dependency propagation |
| `src/semantic-closure-renderer.ts` | M2 | policy-aware text |
| `src/dsl.ts` | M3 | test contract型 |
| `src/semantic-source.ts` | M3 | 拡張test scanner |
| `src/semantic-fingerprint.ts` | M3 | testHash拡張 |
| `src/judgement-renderer.ts` | M3 | 拡張test生成 |
| `src/semantic-test-runner.ts` | M3 | read-only Semantic Test |
| `src/semantic-verify.ts` | M4 | 統合検証API |
| `src/semantic-verify-renderer.ts` | M4 | text renderer |
| `semantic-closure.json` | M2 | 既定autoの互換確認。原則変更不要 |
| `examples/active-customer/semantic.ts` | M3 | 3種類のtest例 |
| `semantic.lock` | M3 | active-customerの新sourceHash / testHash entryをfixture buildで追加 |
| `README.md` / roadmap | M1〜M4 | CLI、保証、進捗同期 |

各新規production fileには同名のunit testを置き、transaction / CLIはintegration testを別に置く。

## 11. 実装中の禁止事項

- Reviewを通常buildの必須条件にしない
- `manual`を高リスク判定などで暗黙強制しない
- Review candidateとSchema Evolution candidateを同じschemaへ統合しない
- lock fingerprintへpromotion metadataを含めない
- replay、test、closure、verifyからresolver / APIを呼ばない
- hidden expected値をmodel promptまたはConsensus選択へ渡さない
- `unknown`をfalseとして扱わない
- Runtime Predicateをtri-stateへ変更しない
- verify内部からrepository全体の`bun test`を再帰実行しない
- M5 benchmark、package公開、CI matrix、import自動探索を混ぜない
- 任意TypeScript生成、side effect生成、auto git commit / push / mergeを追加しない

## 12. Definition of Done

M1〜M4は、次をすべて満たした場合だけ完了とする。

- 通常buildは人間操作なしで自動適用される
- Review利用者だけがcandidate / diff / approveを使える
- autoとmanualの両方で同じ機械検証とrollbackが働く
- lockとExplainからpromotion modeを監査できる
- Closureはnodeごとのreview policyと依存状態を正しく集約する
- Boundary / Counterfactual / Invarianceが型付きtestとして実行される
- `semantic test`と`semantic verify`はread-onlyかつAPI-freeである
- text / JSON / exit code契約がintegration testで固定される
- 全回帰testが成功し、未処理candidate fileやtemporary testが残らない
- README、roadmap、親Alpha計画の記述が実装結果と一致する
