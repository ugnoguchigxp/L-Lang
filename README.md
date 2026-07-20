# L-Lang — Staged Semantic TypeScript MVP

[English](./README.en.md) | [現在地とロードマップ](./PROJECT_STATUS_AND_ROADMAP.md) | [Contributing](./CONTRIBUTING.md) | [MIT License](./LICENSE)

> **意味を一度書く。環境ごとのStaticなロジックへコンパイルする。**<br>
> LLMの柔軟さをコンパイル時に、TypeScriptの確実さを実行時に。

L-Langは、LLMを実行時のエージェントではなく、**コンパイル時の柔軟な意味判定器**として使うTypeScript DSLです。人間は「何を満たすべきか」というConcept、Goal、Constraintを抽象的に記述し、LLMが対象の型・環境・要件に合わせて制限IRへ具体化します。コンパイラはそのIRを型検査とテストで検証し、通常のStaticなTypeScriptとして固定します。

従来のプログラムが、個別環境に合わせたロジックそのものを実装資産としてきたのに対し、L-Langは**意味と意図を再利用可能な実装資産にする**ことを目指します。同じ抽象的な定義から、プロジェクトごとに異なる型、命名、表現へ適応した決定的ロジックを生成します。実行時の生成コードはLLMやDSLに依存しません。

> Status: 研究・検証段階のMVPです。現在の生成対象はpureなBoolean Predicateに限定されています。生成候補を無条件に本番コードとして扱わないでください。

現在地、原案との対応状況、未実装領域、次の評価手順は[`PROJECT_STATUS_AND_ROADMAP.md`](./PROJECT_STATUS_AND_ROADMAP.md)にまとめています。

## L-Langが目指すもの

```text
従来:
  環境ごとのStaticなロジックを人間が直接実装し、コードを再利用する

L-Lang:
  意味・目的・制約を人間が定義し、
  LLMがコンパイル時に環境へ適応させ、
  検証済みのStaticなTypeScriptとして固定する
```

これは自然言語をそのまま実行する仕組みではありません。LLMの判断はbuild/check時にだけ使用され、制限IR、型検査、Semantic Test、人間承認を通過した決定的コードだけがruntimeへ進みます。

## 必要環境

- Bun 1.3以降
- live実行時のみOpenAI APIまたはAzure OpenAI API key
- fixtureテストとlock replayにはAPI key不要

## クイックスタート

APIを呼ばない完全な統合確認:

```bash
bun install
bun run semantic build examples/active-customer/semantic.ts \
  --fixture examples/active-customer/openai-response.fixture.json
```

実際のOpenAI APIまたはAzure OpenAIを使う場合:

```bash
cp .env.example .env
# .envへ接続情報を設定
bun run semantic build examples/active-customer/semantic.ts
```

同じ入力をAPI呼び出しなしで再現する場合:

```bash
bun run semantic replay examples/active-customer/semantic.ts
```

解釈された判定と、各ケースの入力・期待値・実際の判定を表示する場合:

```bash
bun run semantic:test
# または任意のソースを指定
bun run semantic test examples/active-customer/semantic.ts
```

`bun test`は生成済みの通常のTypeScriptコードを検査します。意味解釈まで確認する場合は`semantic:test`を使用します。

## TypeScript内DSL

`examples/active-customer/semantic.ts`が概念、対象型、生成対象、意味テストの唯一の入力です。

```ts
const ActiveCustomer = concept<Customer>`
  An active customer has status "active", has not been deleted,
  and has a present email address.
`;

export const isActiveCustomer = generatePredicate(ActiveCustomer);

semanticTest(isActiveCustomer, {
  accept: [{ status: "active", deletedAt: null, email: "a@example.com" }],
  reject: [{ status: "active", deletedAt: null, email: null }],
});
```

Compiler APIとTypeCheckerがこのソースから型宣言と閉じた意味グラフを抽出します。LLMへ渡すのは概念と対象型だけで、`semanticTest`の値は渡しません。

## コンパイル手順

1. 1 concept / 1 predicate / 1 semanticTestの閉包を検証
2. lockが一致すればIRを再利用し、不一致ならStructured OutputsでIRを解決
3. IR内のプロパティとリテラルをTypeCheckerの型文脈で検証
4. 一時候補を生成し、型検査と候補専用の意味テストを実行
5. 成功時だけ最終ファイルへ原子的に昇格し、全テストを実行
6. 全テスト失敗時は直前の最終ファイルへロールバック

成功した解決結果は`semantic.lock`へ記録します。各試行の入力、応答、IR、候補、レポートは`.semantic/candidates/`へ保存されます。失敗候補も監査用に残ります。

## 現在の制限

Predicate IRの演算は`all`、`any`、`not`、`equals`、`present`のみです。入力はローカルに宣言したrecord型、3段までのネスト、配列、primitive、literal union、null、undefinedに限定しています。複数concept、任意関数、LSP、自動修復、実行時LLM呼び出しは対象外です。

## 接続設定

`.env.example`を`.env`へコピーし、APIキーを設定します。Bunが`.env`を自動的に読み込むため、dotenvパッケージは不要です。

`OPENAI_MODEL`の既定値は`gpt-5.4-mini`です。Azure OpenAIでは、GPT-5.4 miniを指すデプロイ名を設定します。

### Azure OpenAI

Azure OpenAIでも同じ変数名を使用できます。

```dotenv
OPENAI_API_KEY=<Azure OpenAI API key>
OPENAI_MODEL=gpt-5-4-mini # GPT-5.4 miniのAzureデプロイ名
OPENAI_BASE_URL=https://<resource-name>.openai.azure.com
```

`.openai.azure.com`のURLを検出した場合、ハーネスは`/openai/v1/responses`へ接続し、`api-key`ヘッダーを使用します。通常のOpenAI APIでは従来どおりBearer認証を使用します。

旧IR CLIと旧ハーネスも互換確認用に`bun run verify`、`bun run llm:verify`として残しています。

## Semantic Polymorphism

共有Conceptを型から分離し、同じ意味を異なるTypeScriptスキーマへbindingできます。

```ts
// concepts/active-customer.ts
export const ActiveCustomer = defineConcept("customer.active")`
  A customer that is currently permitted to use the service.
  Use only semantic roles unambiguously represented by the supplied type.
`;
```

```ts
const ActiveCustomerRecord = bindConcept<CustomerRecord>(ActiveCustomer);
const ActiveServiceAccount = bindConcept<ServiceAccount>(ActiveCustomer);
```

Compiler APIはimportされた`defineConcept`の宣言をTypeCheckerで解決します。両bindingは同じ`conceptId`と`conceptHash`を持ちますが、型、Predicate IR、生成コードはそれぞれ異なります。

```bash
# fixtureでビルド
bun run semantic build examples/semantic-polymorphism/customer/semantic.ts \
  --fixture examples/semantic-polymorphism/customer/openai-response.fixture.json
bun run semantic build examples/semantic-polymorphism/account/semantic.ts \
  --fixture examples/semantic-polymorphism/account/openai-response.fixture.json

# lockからAPI呼び出しなしで意味とケースを表示
bun run semantic:test:customer-schema
bun run semantic:test:account-schema
```

`examples/semantic-polymorphism/ambiguous`は、型のプロパティを意味的役割へ一意に対応付けられない負例です。この入力は推測でコードを生成せず`unresolved`になります。

## Blind Cross-schema Benchmark

3つの固定Conceptを9つの現実的な型（解決可能6、意図的に曖昧3）へ適用し、各入力をlockなしで3回ずつ、合計27回評価します。

```bash
bun run benchmark:cross-schema
```

モデルへ渡すのは固定Concept、対象型、生成対象だけです。期待Predicate IRは`benchmarks/cross-schema/oracles/`、隠しケースは`benchmarks/cross-schema/cases/`に分離され、API入力には含まれません。各試行の生レスポンス、解釈結果、隠しテスト結果と集計は`.semantic/benchmarks/<run-id>/`へpretty JSONとMarkdownで保存されます。`semantic.lock`は読み書きしません。

人手比較は`benchmarks/cross-schema/manual/manual-times.json`へ実測値を記録した場合だけ計算します。未計測の`null`値を推定値で補完することはありません。この初期ベンチマークはmodel-blindですが、独立した人間による二重盲検ではありません。

## Schema EvolutionとSemantic Diff

承認済みのsemantic sourceで型を変更した後、通常の`build`ではなく`check`を実行すると、生成コードと`semantic.lock`を変更せずに候補を検査できます。

```bash
bun run semantic check examples/customer/semantic.ts
# fixtureで再現する場合
bun run semantic check examples/customer/semantic.ts --fixture response.json
# 単発方式を明示的に使う場合
bun run semantic check examples/customer/semantic.ts --samples 1 --quorum 1
```

`semantic check`は既定で3応答を並列取得し、型付きPredicate IRのsemantic signatureが2票一致した場合だけ候補を採用します。required nullable型における`x === null`と`!present(x)`のような型上の同値表現も同じ票として扱います。2/3に届かない場合は`unresolved`となり、全応答、署名、型付きrewrite、支持票が候補監査ログへ保存されます。

候補は`.semantic/evolution/<candidate-id>/`へ保存されます。`candidate.json`、生成候補、候補専用テスト、生レスポンス、pretty化された`diff.txt`が含まれます。

```bash
bun run semantic diff <candidate-id>
bun run semantic approve <candidate-id>
```

差分分類は次の3種類です。

- `compatible`: IRが同一、または論理構造を保ったプロパティ／値表現の変更
- `breaking`: 論理演算や条件数が変化した、または候補検証に失敗
- `unresolved`: 変更後の型から必要な意味的役割を一意に決定できない

分類はレビュー支援情報であり、自動承認には使いません。`compatible`を含むすべての候補が明示的な`approve`を必要とします。`unresolved`と検証失敗候補は承認できません。

承認時にはsource hash、型、テスト、Concept、基準lock、候補コードhashを再検証し、候補型検査と意味テストを再実行します。その後に生成コードを一時昇格し、全テストが成功した場合だけ新しいlock entryを原子的に保存します。失敗時は生成コードを直前の状態へ戻します。

## Blind Schema Evolution Benchmark

Schema Evolutionの実LLM性能は、3 Concept × 6種類の型変更 × 3反復、合計54試行の読み取り専用ベンチマークで評価します。

```bash
bun run benchmark:schema-evolution
```

入力は`benchmarks/schema-evolution/`にあり、Concept、baseline、変更後スキーマ、期待IR、隠しケースを`freeze.json`のSHA-256で固定します。期待IRと隠しケースはAPIへ送信しません。ランナーは`semantic.lock`を利用せず、生成済みコードも変更しません。実行前後の`semantic.lock`と全`*.generated.ts`を比較し、1件でも変化すれば評価を失敗させます。

実API実行には独立した人間による入力レビューが必要です。`benchmarks/schema-evolution/REVIEW.md`に従い、レビュー後に`freeze.json`の`status`、`humanReviewed`、`reviewer`、`reviewedAt`だけを記録します。draft状態ではAPI resolverを呼ぶ前に停止します。

各試行のモデル入力、生レスポンス、candidate IR、semantic diff、隠しテスト、診断は`.semantic/benchmarks/schema-evolution/<run-id>/`へpretty JSONで保存され、全体集計はJSONとMarkdownで出力されます。APIエラーは試行失敗として残し、成功するまでの暗黙retryは行いません。

## Type-aware Consensus Replay

保存済みのSchema Evolution試行は、追加API呼び出しなしで型付き同値判定と2/3 consensusを再評価できます。

```bash
bun run consensus:replay .semantic/benchmarks/schema-evolution/<run-id>/report.json
```

同値判定は`all`／`any`の順序などを正規化し、requiredな`string | null`型では`x === null`と`!present(x)`を同値と扱います。optionalまたは`undefined`を含む型では両者を同値化しません。

候補選択に使うのはcontext validationと型付きsemantic signatureだけです。隠しケースと期待IRは選択後の採点にのみ利用され、consensusへ漏洩しません。2/3の同値候補がなければ結果を確定しません。派生レポートは`.semantic/benchmarks/schema-evolution-consensus/`へ保存し、元の実測レポートは変更しません。

## Blind Schema Evolution v2

v2はv1で使用したConceptと型を再利用しないheld-out評価です。Actionable Ticket、Payable Invoice、Deployable Release、Enrollable Courseの4 Conceptに対し、6種類の変更を各1件、合計24ケース・72応答で評価します。ネスト、配列、union、nullable、optionalも含みます。

入力、期待条件、hidden case用のpositive/negative値は`benchmarks/schema-evolution-v2/benchmark.json`へ集約し、そのSHA-256を`freeze.json`で固定します。実行時に一時TypeScriptソースへ展開しますが、モデルにはConceptと対象型だけを送り、conditionやfixture値は送りません。

現在のv2はdraftであり、評価設計上の局所Blockerにより人間承認とlive実行を保留しています。`benchmarks/schema-evolution-v2/BLOCKER.md`に問題、影響範囲、禁止事項、再開条件を記録しています。Blockerが解消するまで`freeze.json`を承認状態へ変更せず、live benchmarkを実行しないでください。

```bash
bun run benchmark:schema-evolution:v2
```

3応答はケース単位で並列実行されます。レポートには単発1票目の成功率と型付き2/3 consensusの成功率・成立率・誤解決率、トークン、待ち時間、workspace mutation、凍結元manifestのSHA-256が同時に記録されます。合格基準はconsensus正解率95%以上、成立率90%以上、誤解決0、workspace mutation 0です。

## セキュリティとデータ

- API keyは`.env`または環境変数で管理し、Gitへコミットしないでください。
- ConceptとTypeScript型宣言は、設定したLLM providerへ送信されます。
- `semanticTest`の値、Benchmark Oracle、hidden casesは通常のモデル入力へ送りません。
- `.semantic/`には生のモデル応答と監査情報が保存されるため、外部公開前に内容を確認してください。
- LLM出力は、IR検証、型検査、テスト、人間承認を通過するまで信頼済みコードではありません。

詳細は[`SECURITY.md`](./SECURITY.md)を参照してください。

## Contributing

Issue、実験結果、文書改善、実装へのContributionを歓迎します。凍結済みBenchmarkを変更する場合は、先に[`CONTRIBUTING.md`](./CONTRIBUTING.md)のBenchmark完全性ルールを確認してください。

## License

このプロジェクトは[MIT License](./LICENSE)で公開されます。ライセンス表示と免責条項を維持する限り、利用、複製、変更、配布、サブライセンス、販売を含めて自由に使用できます。

`package.json`の`private: true`はnpmへの誤公開を防ぐための設定であり、MIT Licenseによるソースコード利用を制限するものではありません。
