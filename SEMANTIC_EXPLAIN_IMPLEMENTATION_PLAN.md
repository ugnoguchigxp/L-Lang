# Semantic Explain implementation plan

作成日: 2026-07-20

状態: **実装着手可能**

## 目的

現在のSemantic source、`semantic.lock`、生成済みTypeScriptを読み取り、PredicateとStatic Judgmentについて次をAPIなしで説明する。

- どのConceptを使用しているか
- どの入力または型を判断対象にしているか
- どのIRまたはbooleanへ解決されたか
- どのlock entryに由来するか
- 生成物の期待hashと実hashが一致するか
- 現在のsourceに対してstaleな場合、どの入力hashが変化したか

`semantic explain`は新しい意味判断を行わない。source、lock、生成物に存在しない情報を推測で補わない。

## 利用形

```bash
bun run semantic explain examples/active-customer/semantic.ts
bun run semantic explain examples/static-judgment/semantic.ts
```

機械可読出力:

```bash
bun run semantic explain examples/active-customer/semantic.ts --json
```

## Predicate v2 Blockerとの関係

[`benchmarks/schema-evolution-v2/BLOCKER.md`](./benchmarks/schema-evolution-v2/BLOCKER.md)は、Schema Evolution v2のConcept、Oracle、fixture境界に関する局所Blockerである。`semantic explain`は既存情報の読み取りと整合性検査だけを行い、v2 live benchmarkやPredicate Consensusを使用しないため実装を進められる。

維持する制約:

- v2の`benchmark.json`と`freeze.json`を変更しない
- v2 live benchmarkを実行しない
- `semantic explain`の出力をv2 Blockerの解決証拠として扱わない
- explain実行中にlock、生成物、auditを変更しない

## 対象

### Predicate

- local `concept<T>`とshared `defineConcept` / `bindConcept`
- Concept ID、Concept hash、Concept source
- target type名とtype schema
- Predicate名とparameter名
- semantic test hash
- 解決済みPredicate IR
- interpreted judgement tree
- provider、model、response metadata、createdAt
- lock fingerprint
- generated TypeScript path、期待hash、実hash
- source、Concept、Type、Test、Promptのstale理由

### Static Judgment

- shared Concept ID、Concept hash、Concept source
- Static Judgment名
- Static value hash
- 解決済みboolean
- provider、model、response metadata、createdAt
- lock fingerprint
- generated TypeScript path、期待hash、実hash
- Concept、Static value、Promptのstale理由

## 非対象

- LLMやAPIを使った説明文の生成
- raw model responseの再解釈
- モデルのchain-of-thoughtや非公開推論
- Schema Evolution candidateのdiff説明
- `approve`状態の推測
- 人間承認履歴の新規記録
- 複数Semantic nodeのClosure graph
- HTML、IDE、LSP表示
- 自動修復、自動build、自動replay
- explain結果のファイル保存
- `semantic.lock` formatのbreaking change

## 読み取り専用の保証

`semantic explain`から次を呼んではならない。

- Predicate compilerまたはStatic Judgment compilerのbuild/replay transaction
- OpenAI / Azure OpenAI adapter
- resolver
- `writeSemanticLock`
- candidate promotion
- audit directory作成
- test runner

実行前後で次が不変であることをintegration testで確認する。

- `semantic.lock`のSHA-256
- 対象`*.generated.ts`のSHA-256
- `.semantic/`配下のファイル一覧とhash
- v2 `benchmark.json`のSHA-256

## statusモデル

```ts
type SemanticExplanationStatus =
  | "current"
  | "stale"
  | "unlocked"
  | "integrity-error";
```

| Status | 条件 |
| --- | --- |
| `current` | 現在のsemantic inputと一致するlock entryがあり、生成物hashも一致する |
| `stale` | 同じsource / symbolの過去entryはあるが、現在のsemantic input hashと一致しない |
| `unlocked` | 同じsource / symbolに対応するlock entryが存在しない |
| `integrity-error` | current lock entryはあるが、生成物が欠損またはhash不一致 |

`stale`と`unlocked`は観測結果として正常に説明を返す。`integrity-error`も説明データを返すが、text rendererでは明確なエラー表示にする。今回はCI用exit codeや`--strict`を追加しない。

## 共通説明モデル

```ts
type SemanticExplanation = {
  version: 1;
  kind: "predicate" | "static-judgment";
  status: SemanticExplanationStatus;
  source: string;
  symbol: string;
  concept: {
    id: string;
    name: string;
    source: string;
    hash: string;
  };
  input: PredicateExplainInput | StaticJudgmentExplainInput;
  resolution: PredicateExplainResolution | StaticJudgmentExplainResolution | null;
  lock: LockProvenance | null;
  generated: GeneratedIntegrity | null;
  staleReasons: StaleReason[];
  limitations: string[];
};
```

重要な制約:

- Concept specification全文とStatic value本文は既定出力へ含めない
- hashとsource pathから元sourceを追跡できるようにする
- Predicate IRとbooleanはlockに保存された値だけを表示する
- lockに人間承認情報がないため、`approved`とは表示しない
- response metadataが`null`ならfixture、replay、手動承認などを推測しない

## text出力

Predicate例:

```text
semantic explain
status: current
kind: predicate
source: examples/active-customer/semantic.ts
predicate: isActiveCustomer(customer: Customer)
concept: local:ActiveCustomer
lock: <fingerprint>
provider/model: fixture:.../gpt-5.4-mini
generated: examples/active-customer/is-active-customer.generated.ts
generated integrity: verified

resolution:
  ALL
    customer.status EQUALS "active"
    customer.deletedAt EQUALS null
    customer.email IS PRESENT (not null/undefined)
```

Static Judgment例:

```text
semantic explain
status: current
kind: static-judgment
source: examples/static-judgment/semantic.ts
judgment: mikeIsCat
concept: animal.cat
static value hash: <sha256>
result: true
lock: <fingerprint>
provider/model: fixture:.../gpt-5.4-mini
generated: examples/static-judgment/mike-is-cat.generated.ts
generated integrity: verified
```

stale時:

```text
status: stale
stale reasons:
  - conceptHash changed
  - testHash changed
```

## JSON出力

`--json`は`SemanticExplanation`をpretty JSONとしてstdoutへ出力する。

- text renderer固有の装飾を含めない
- `undefined`を使用しない
- statusにかかわらず同じschemaを維持する
- filesystem absolute pathを出力せず、workspace-relative pathへ正規化する
- token usage以外のraw responseを含めない

## hash計算の共通化

現在、PredicateとStatic Judgmentのfingerprint材料は各compiler内のprivate関数で計算している。explain側で同じロジックを複製すると、compilerとexplainが異なるstale判定を行う危険がある。

`src/semantic-fingerprint.ts`を新設し、次を一か所へ集約する。

- `sha256`
- stable JSON serialization
- Predicateの`conceptHash / sourceHash / typeHash / testHash / promptHash`
- Static Judgmentの`conceptHash / valueHash / promptHash`
- workspace-relative source pathの正規化
- generated output path規則

既存compilerをこのhelperへ移行する際、現在のlockとgenerated hashが変わらないことを最優先の回帰条件とする。

実装前ベースライン:

- Predicate generated SHA-256: `b8bb73c0f5c4c474a78e0a703a9f39340923cef2b02db51195d8f4d0235dc57e`
- Static Judgment generated SHA-256: `0bfeae824fa34edcea530ac01533f5773133302bf9819452e573217a18a98bab`
- 全ローカル回帰: `60 pass / 0 fail`

## stale判定

### Predicate

exact replay matchがない場合、`semantic.lock.entries`から同じ`source`と`predicate`を持つ最新entryを探す。

比較項目:

- `conceptHash`
- `sourceHash`
- `typeHash`
- `testHash`
- `promptHash`

### Static Judgment

exact replay matchがない場合、`semantic.lock.judgments`から同じ`source`と`judgment`を持つ最新entryを探す。

比較項目:

- `conceptHash`
- `valueHash`
- `promptHash`

過去entryが複数ある場合は`createdAt`の降順で最新を比較対象にする。providerとmodelの違いはstale理由にしない。

## generated integrity

current entryがある場合だけ、決定的な出力pathを解決して実ファイルを読む。

```ts
type GeneratedIntegrity = {
  path: string;
  expectedHash: string;
  actualHash: string | null;
  state: "verified" | "missing" | "mismatch";
};
```

- file欠損は`missing`
- SHA-256不一致は`mismatch`
- 一致時だけ`verified`
- stale entryの生成物をcurrent生成物として検証しない
- integrity検査のために再生成しない

## 変更予定ファイル

### 新規

| File | 責務 |
| --- | --- |
| `src/semantic-fingerprint.ts` | compilerとexplainで共有するhash・path計算 |
| `src/semantic-explain.ts` | read-only explanation model構築、status、stale、integrity判定 |
| `src/semantic-explain-renderer.ts` | Predicate / Static Judgmentのtext出力 |
| `src/semantic-fingerprint.test.ts` | 既存lock fingerprint材料との互換性 |
| `src/semantic-explain.test.ts` | current / stale / unlocked / integrity-error |
| `src/semantic-explain.integration.test.ts` | 実exampleのread-only CLI検証 |

### 変更

| File | 変更 |
| --- | --- |
| `src/semantic-compiler.ts` | private hash/path計算を共通helperへ移行 |
| `src/static-judgment-compiler.ts` | private hash/path計算を共通helperへ移行 |
| `src/semantic-lock.ts` | 同一source / symbolの最新entryを読むread-only helperを追加 |
| `src/semantic-cli.ts` | `explain` commandと`--json`を追加 |
| `src/judgement-renderer.ts` | Predicate tree rendererの再利用可能なexportを追加 |
| `src/semantic-lock.test.ts` | latest entryとnamespace分離のテストを追加 |
| `package.json` | Predicate / Static Judgment explain確認scriptを追加 |
| `README.md` | explain利用方法、status、制限を追加 |
| `PROJECT_STATUS_AND_ROADMAP.md` | Explainabilityの実装状態を更新 |

## 実装フェーズ

### Phase 0: ベースライン固定

実行:

```bash
bun run typecheck
bun test
bun run semantic replay examples/active-customer/semantic.ts
bun run semantic:judgment:replay
```

記録:

- `semantic.lock`のSHA-256
- Predicate / Static Judgment generated hash
- `.semantic/`配下のファイル一覧とhash
- v2 `benchmark.json`のSHA-256

完了条件:

- `60 pass / 0 fail`以上
- PredicateとStatic JudgmentのreplayがAPI calls 0で成功
- v2 freezeがdraftのまま

### Phase 1: fingerprint計算の共通化

作業:

- `semantic-fingerprint.ts`を追加
- Predicate compilerを共通helperへ移行
- Static Judgment compilerを共通helperへ移行
- output path規則を共通化

完了条件:

- 既存Predicate lockでreplay hit
- 既存Static Judgment lockでreplay hit
- 両generated hashがベースラインと一致
- root `semantic.lock`をmigrationしない
- 全回帰成功

### Phase 2: explanation model

作業:

- source kindを既存scannerで判定
- current lock lookup
- latest historical entry lookup
- statusとstale reasonsを構築
- generated integrityを検査
- limitationを明示

テスト:

- current Predicate
- current Static Judgment
- Concept変更
- Predicate type変更
- Predicate semantic test変更
- Static value変更
- Prompt version変更
- lock entryなし
- generated file欠損
- generated file改変
- Predicate entriesとJudgment namespaceの混在

完了条件:

- statusと理由がhash差分だけから決定される
- 欠損情報を推測しない
- explain実行中にwrite APIを呼ばない

### Phase 3: rendererとCLI

作業:

- default text renderer
- `--json` renderer
- `semantic explain <source>`をCLIへ追加
- Predicate interpreted treeを既存rendererから再利用

テスト:

- text出力snapshot
- JSON schema shape
- workspace-relative path
- Static value本文とraw responseが出力されない
- current / stale / unlocked / integrity-errorの表示
- `--fixture`を拒否
- API keyなしで成功

完了条件:

- PredicateとStatic Judgmentを同じcommandで説明できる
- stdout以外を変更しない
- network callが0

### Phase 4: read-only統合検証と文書更新

実行:

```bash
bun run semantic explain examples/active-customer/semantic.ts
bun run semantic explain examples/active-customer/semantic.ts --json
bun run semantic explain examples/static-judgment/semantic.ts
bun run semantic explain examples/static-judgment/semantic.ts --json
bun run typecheck
bun test
```

前後比較:

- `semantic.lock` hash不変
- generated hash不変
- `.semantic/` file set/hash不変
- v2 frozen hash不変

完了条件:

- 両exampleが`current`
- 両generated integrityが`verified`
- API keyを空にしても成功
- 全回帰成功
- READMEとロードマップが実装結果に一致

## 最終完了条件

- PredicateとStatic Judgmentを1つの`semantic explain`で扱える
- Concept、入力、resolution、lock provenance、generated integrityを表示できる
- exact matchがない場合にstale理由またはunlockedを表示できる
- lockの値だけをresolutionとして表示し、新しい意味判断を行わない
- human approvalを記録がない状態で推測しない
- textとJSON出力を提供する
- API、resolver、compiler transactionを呼ばない
- lock、generated、audit、v2 freezeを変更しない
- 既存Predicate / Static Judgment replay hashを維持する
- `bun run typecheck`と全テストが成功する

## 実装後の次候補

`semantic explain`完了後は、PredicateとStatic Judgmentの2種類のSemantic nodeが揃っているため、Semantic Closure graphの最小実装を検討する。

Closureへ進む前に、explainが次の状態を安定して区別できることを確認する。

- resolved/current
- stale
- unlocked
- generated integrity error

このstatusモデルをClosure nodeの基礎として再利用するが、graph実装自体は今回の範囲へ含めない。
