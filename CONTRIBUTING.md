# Contributing to L-Lang

Issue、提案、文書修正、実装、検証データの提供を歓迎します。本プロジェクトは実験段階のため、互換性よりも仮説を明確に検証できることを優先する場合があります。

## 開発環境

- Bun 1.3以降
- TypeScript 5.9
- OpenAI APIまたはAzure OpenAIはlive検証時のみ必要

```bash
bun install
bun run typecheck
bun test
```

APIを使わないfixture経路で基本動作を確認できます。

```bash
bun run semantic build examples/active-customer/semantic.ts \
  --fixture examples/active-customer/openai-response.fixture.json
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
- human review必須のBenchmarkを自動承認しない

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

## Secretsと生成物

`.env`、API key、`.semantic/`、`artifacts/`、`node_modules/`をコミットしないでください。新しい秘密情報や大きな生成物を扱う場合は、先に`.gitignore`を更新してください。

## License

Contributionは、リポジトリと同じ[MIT License](./LICENSE)で提供されるものとします。
