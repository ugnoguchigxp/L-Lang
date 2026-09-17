# Contributing to L-Lang

Issue、提案、文書修正、実装、検証データの提供を歓迎します。本プロジェクトは実験段階のため、互換性よりも仮説を明確に検証できることを優先する場合があります。

## 開発環境

- Bun 1.4.2
- TypeScript 5.9
- OpenAI APIまたはAzure OpenAIはlive検証時のみ必要

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run ci:docs
```

TypeScriptとJSONCの両経路を保守します。[入力・出力の対応](./docs/guides/language-routes.md)を確認してください。APIを使わないTypeScriptのfixture経路で基本動作を確認できます。

```bash
bun run semantic build examples/active-customer/semantic.ts \
  --fixture examples/active-customer/openai-response.fixture.json
```

JSONCの基本検証もAPIなしで実行できます。

```sh
bun run llang lint examples/jsonc-enabled-user/enabled-user.llang.jsonc --json
bun run llang test examples/jsonc-enabled-user/enabled-user.llang.jsonc --request examples/jsonc-enabled-user/request.json --suite examples/jsonc-enabled-user/tests.json
```

## 変更方針

- LLM出力から自由なTypeScriptを直接実行しないでください。
- 新しい生成機能には、制限されたIR、validator、決定的generator、テストを用意してください。
- 曖昧な入力を推測でresolvedにせず、fail-closedな`unresolved`を維持してください。
- 副作用、認可、金額計算、トランザクション、secretアクセスはExact Codeに残してください。
- 既存の生成済みファイル、`semantic.lock`、人間の変更を無関係な修正で上書きしないでください。

## Benchmarkの完全性

Blind Benchmarkの期待値、hidden cases、freeze hashは評価結果を見た後に変更しないでください。改善後の性能を測る場合は、新しいheld-out benchmark versionを作成します。

- Oracleとhidden casesをモデル入力へ含めない
- Consensusの候補選択にOracleやhidden casesを利用しない
- APIエラーと意味的失敗を区別して記録する
- 成功結果だけでなく、失敗と`unresolved`も保存する
- `draft`のBenchmark入力でlive実行せず、`frozen`な入力hashだけを評価する

## Pull request

Pull requestには次を記載してください。

- 解決する問題または検証する仮説
- 変更した安全境界
- 実行した検証コマンドと結果
- LLM APIを利用した場合はmodel、試行数、費用・tokenへの影響
- Benchmark入力を変更した場合はfreezeとreviewへの影響

最低限、次を成功させてください。

```bash
bun run typecheck
bun test
git diff --check
```

全品質Gateとcoverage閾値は[`QUALITY_GATES.md`](./QUALITY_GATES.md)を参照してください。

## Secretsと生成物

`.env`、API key、`.semantic/`、`artifacts/`、`node_modules/`をコミットしないでください。新しい秘密情報や大きな生成物を扱う場合は、先に`.gitignore`を更新してください。

## License

Contributionは、リポジトリと同じ[MIT License](./LICENSE)で提供されるものとします。


## 文書の配置と更新

利用方法は`docs/guides/`、現行仕様とCLIは`docs/`、過去の状態記録は`docs/records/`、実行例は`examples/`へ置く。設計・計画・結果の既存パスは参照を維持し、[文書一覧](./docs/README.md)で分類する。新規文書は一覧と[全Markdown台帳](./docs/MAINTENANCE_STATUS.md)にも追加する。

言語・出力形式の追加は[経路表](./docs/guides/language-routes.md)へ反映する。TypeScriptとJSONCの併存を前提とし、ある経路の制限をプロジェクト全体の制限として記載しない。結果文書には対象revision・環境・未確認事項を残し、凍結済みbenchmark・Pilot証跡は説明整理のためにも書き換えない。
