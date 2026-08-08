# Public Alpha製品化計画

作成日: 2026-07-23

状態: **Gate 1待ち・未着手**

Gate: 2

前提: [Private Pilot実装・評価計画](./PRIVATE_PILOT_IMPLEMENTATION_PLAN.md)合格

## 1. 目的

Private Pilotで価値が確認されたPredicate / Static Judgmentの範囲を、外部開発者がclean installし、CIへ組み込み、障害を診断し、安全にupgradeできる`0.x` packageとして提供する。

Public Alphaの目的は機能を増やすことではない。次の製品契約を作る。

- versioned packageと公開API
- Bun上で安定して動くCLI
- strict configとmachine-readable report
- lock / config migration
- provider障害、rate limit、timeout、budgetの制御
- policy-aware Closureとread-only verification
- Linux / macOSでのinstall / upgrade / smoke test
- support範囲、data boundary、既知制限の公開

## 2. 着手条件

- Core Hardening完了
- Private Pilot合格
- approved false resolution 0
- replay reproducibility 100%
- Pilotの費用と時間が事前基準内
- package化する公開範囲をPredicate / Static Judgmentに限定
- release ownerとsecurity contactを決定

Pilotが技術的に成功しても、価値基準を満たさない場合は着手しない。

## 3. 既存Alpha計画との関係

[`RELEASE_0_1_ALPHA_IMPLEMENTATION_PLAN.md`](./RELEASE_0_1_ALPHA_IMPLEMENTATION_PLAN.md)のうち、次は実装済み前提として本計画へ引き継ぐ。

- Project Fit-aware Semantic Closure
- Semantic Test拡張
- read-only `semantic verify`

残る対象はpackage / CLI配布 / CI matrixである。自動昇格、互換用staging、promotion provenance、M2〜M4は再実装しない。

## 4. Alpha support contract

### 対応

- Runtime: Bun 1.3系
- OS: Linux x64/arm64、macOS arm64/x64
- Language: TypeScript 5.9
- Provider: OpenAI Responses API、Azure OpenAI Responses API
- Source kind: Predicate、Static Judgment
- Package status: `0.x` prerelease

### 非対応

- Node.js単独runtime
- Windows
- browser
- runtime LLM
- arbitrary code generation
- authorization / money / transaction
- 自動Schema Evolution approve
- SLA

対応外環境をbest effortとして暗黙サポートしない。

## 5. Package設計

### 5.1 Package構成

初期案:

```text
@l-lang/core
  exports:
    ./dsl
    ./compiler
    ./reports
    ./config
  bin:
    l-lang
```

単一packageから開始し、provider package分割は依存とrelease cadenceの実測後に判断する。

### 5.2 Public API

公開するもの:

- TypeScript DSL
- compiler options / result
- explain / closure / verify report型
- config型
- stable error型
- provider interface

公開しないもの:

- TypeScript AST node
- internal scanner state
- filesystem helper
- audit directory内部表現
- test-only injection hook
- raw lock mutation API

`src/*`への相対importを公開利用例から排除する。

### 5.3 Package metadata

- package名
- `version`
- `bin`
- `exports`
- `types`
- `files`
- `engines`相当のBun要件
- `license`
- repository
- keywords
- publish dry-run script

`private: true`を解除するのはrelease candidateのpackage smoke test完了後だけとする。

## 6. Config contract

rootに`l-lang.config.json`を置けるようにする。

```ts
type LLangConfig = {
  version: 1;
  semanticLock: string;
  auditRoot: string;
  provider: {
    kind: "openai" | "azure-openai";
    model: string;
    baseUrl?: string;
  };
  promotion: {
    default: "auto" | "review";
  };
  limits: {
    maxApiCalls: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxEstimatedCost?: number;
  };
  verify?: {
    manifest: string;
    requireCleanGit?: boolean;
  };
};
```

規則:

- unknown field拒否
- workspace-relative path
- secretをconfigへ保存しない
- environment variable名をversioned schemaで許可
- CLI overrideの優先順位を文書化
- resolved configを`--print-config --json`でsecretなし表示

## 7. CLI contract

### 7.1 Command

```text
l-lang build
l-lang replay
l-lang test
l-lang check
l-lang diff
l-lang approve
l-lang explain
l-lang closure
l-lang verify
l-lang tdd-plan
l-lang tdd-build
l-lang tdd-test
l-lang tdd-replay
l-lang config validate
l-lang doctor
```

### 7.2 共通option

- `--config <path>`
- `--json`
- `--quiet`
- `--no-color`
- `--offline`

command固有optionはstrict schemaで検証する。unknown / duplicate / conflictはI/Oとnetwork前に拒否する。

Semantic TDDのPredicate POCコマンドは実装済みである。Public Alphaでは命名、JSON出力、共通`--offline`、exit code、package binary、config統合をこのCLI contractへ揃える。Test PlanをImplementation生成前にfreezeする条件、自動/staged freeze provenance、`tdd-test`のAPI 0・mutation 0は維持する。

### 7.3 Exit code

| Code | 意味 |
| ---: | --- |
| 0 | command成功、open blockerなし |
| 1 | commandまたは環境error |
| 2 | 検査完了、open / unresolved / test failureあり |
| 3 | usage / config error |
| 4 | workspace busy / transaction recovery required |
| 5 | provider / network / budget error |

既存script互換のため、旧`semantic`入口は1 Alpha minorの間aliasとして残す。

### 7.4 JSON protocol

すべてのJSON outputは次を持つ。

```ts
type CommandEnvelope<T> = {
  schemaVersion: 1;
  command: string;
  status: "ok" | "open" | "error";
  durationMs: number;
  result: T | null;
  errors: SemanticError[];
};
```

stdoutにはJSONだけを出し、progress / warningはstderrへ出す。JSON schemaをpackageへ同梱する。

## 8. Provider reliability

### 8.1 Provider interface

```ts
interface SemanticProvider {
  resolvePredicate(input: PredicateRequest): Promise<ProviderResponse>;
  resolveStaticJudgment(input: StaticJudgmentRequest): Promise<ProviderResponse>;
  describe(): ProviderMetadata;
}
```

compilerはOpenAI接続詳細を参照しない。

### 8.2 Error分類

- authentication
- permission
- rate-limit
- timeout
- transport
- provider-5xx
- refusal
- incomplete
- schema-invalid
- budget-exceeded
- cancelled

response bodyをそのままerrorへ含めず、安全な上限とredactionを適用する。

### 8.3 Retry

retry対象:

- 429
- transient transport
- 明示的にretryableな5xx

retryしない:

- 400 / schema error
- 401 / 403
- refusal
- budget exceeded
- context validation failure

exponential backoff、jitter、最大試行数、総deadlineをconfigで制限する。各retryをtoken / cost reportへ含める。

### 8.4 Budget

network call前に次を確認する。

- command単位API call数
- samples
- input byte / estimated token
- max output token
- run単位estimated cost

budget超過はprovider call 0で失敗する。料金情報が不明なmodelではcost上限を「未評価」とし、明示許可なしに推測価格を使わない。

## 9. Semantic Test拡張

この項目は実装済みである。Public Alphaでは公開contractと互換性を固定する。

Alpha対象:

- 名前付きaccept / reject
- boundary
- counterfactual
- invariance
- read-only `semantic test`
- versioned test report

非対象:

- runtime third value
- modelに期待値を渡すtest generation
- arbitrary test code
- mutation testをユーザーDSLへ公開

完了条件:

- test変更でlock / candidateがstale
- 各case ID、期待、実結果、durationをJSON出力
- 0 caseをCore Hardeningどおり拒否
- `semantic test`がAPI / lock write / generated writeを行わない

## 10. Project Fit-aware ClosureとVerify

### 10.1 Closure

- verified Project Contextとpromotion時の機械検証provenanceを必須化済み
- provenance不足を`verification-required`としてfail-closed
- dependency openを推移的に伝播
- provenance不正をintegrity error
- 人間Reviewの有無は合格条件にしない

### 10.2 Verify

```bash
l-lang verify [manifest] [--json]
```

検査:

- config / lock schema
- source / Concept / Type / Test / Prompt hash
- generated hash
- promotion provenance
- Project Context provenance
- dependency Closure
- read-only Semantic Test
- project typecheck

保証:

- API call 0
- tracked mutation 0
- audit mutation 0
- openはexit 2
- config / I/O errorはexit 1または3

CIでは`verify`を標準entry pointとする。

## 11. Lockとmigration

### 11.1 Policy

- readerはcurrentと直前1 versionを読む
- writerはcurrent versionだけを書く
- migrationは明示commandまたはbuild前previewを必要とする
- migration前にbackupとhashを作成
- failure時に元bytesへ戻す
- provider/model変更だけで既存entryをstaleにしない現行方針を維持

### 11.2 Command

```bash
l-lang lock inspect --json
l-lang lock migrate --dry-run
l-lang lock migrate
```

Alphaでlock version bumpが不要なら、無理にbumpしない。ただしfuture fieldのunknown / optional policyを仕様化する。

## 12. Release engineering

### Phase 0: Public surface freeze

- package名
- supported runtime / OS
- exports
- CLI command / exit code
- config schema
- JSON protocol
- lock compatibility

これらをADRまたは本書へ固定してから実装する。

### Phase 1: Package skeleton

- exportsとbin
- build / type declaration
- package contents allowlist
- tarball inspection
- fixture-only smoke project

検証:

```bash
bun run package:build
bun run package:pack
bun run package:smoke
```

### Phase 2: Config / CLI / Provider

- strict config
- public CLI
- structured error
- provider adapter
- retry / timeout / budget
- offline mode

### Phase 3: Test / Closure / Verify

- Semantic Test拡張
- policy-aware Closure
- read-only verify
- CI example

### Phase 4: Security / Documentation

- threat model
- data flow
- redaction test
- vulnerability reporting
- install / quick start
- upgrade / rollback
- troubleshooting
- example repository

### Phase 5: Release candidate

- clean environment smoke
- Linux / macOS
- OpenAI / Azure fixture
- optional limited live canary
- package provenance
- changelog
- known limitations

## 13. Alpha CI matrix

| Job | Linux | macOS | Network |
| --- | --- | --- | --- |
| format / lint / typecheck | yes | yes | no |
| unit / integration test | yes | yes | no |
| package build / smoke | yes | yes | no |
| verify examples | yes | yes | no |
| lock migration fixtures | yes | yes | no |
| provider contract fixtures | yes | yes | no |
| limited live canary | scheduled only | no | yes |

live canaryをPR必須checkにしない。

## 14. Alpha release条件

- Private Pilot合格結果を参照できる
- clean install / build / replay / verify成功
- package外から`src/*`を参照しない
- JSON schemaとexit code test成功
- config unknown field拒否
- provider error matrix成功
- retry / budget上限を超えない
- lock migration rollback test成功
- `verify` API call 0 / mutation 0
- Linux / macOS CI成功
- security / data boundary document完成
- `0.x`で互換性変更があり得ることを明記

## 15. 中止条件

- package化で既存生成hashが無説明に変わる
- migrationが既存lockを破壊する
- CLI JSONへprogress textが混入する
- retryまたはconsensusがbudgetを超える
- source / Concept / secretが想定外のtelemetryへ送信される
- `verify`がnetworkまたはworkspace mutationを行う
- Alpha利用者が再現できない手動setupを要求する

## 16. 最終検証

予定するrelease gate:

```bash
bun install --frozen-lockfile
bun run check
bun run coverage
bun run package:build
bun run package:pack
bun run package:smoke
bun run test:provider-contract
bun run test:lock-migration
bun run test:cli-json
l-lang verify semantic-closure.json --json --offline
git diff --check
```

期待結果:

- format、lint、typecheck、全test成功
- critical-path coverage threshold達成
- package tarballにallowlist外fileなし
- clean smoke projectでbuild / replay / verify成功
- provider contractの全error分類成功
- lock migrationのdry-run / apply / rollback成功
- CLI JSONをschema検証可能
- `verify`のAPI call 0、tracked / audit mutation 0

失敗時:

- release candidateを公開しない
- package、provider、migration、CLI contract、verificationのどのGateかを分類する
- 失敗したGateだけを修正し、全release gateを最初から再実行する
- lockまたはgenerated hashの差分を「snapshot更新」だけで受理しない

## 17. Definition of Done

- `0.x` release candidateをclean environmentで検証
- release条件をすべて満たす
- failed / unresolved / rollback scenarioをdocumentationに含める
- known limitationsをREADMEとpackageへ記載
- Alpha feedback収集方法とsupport窓口を用意
- [Stable Release実装計画](./STABLE_RELEASE_IMPLEMENTATION_PLAN.md)へ進むための運用指標を採取開始

## 18. Alphaで行わないこと

- Stable互換性の保証
- Windows / Node.js support
- repository自動探索による魔法的設定
- runtime LLM
- arbitrary code generation
- Schema Evolution自動approve
- plugin marketplace
- LSP本実装
