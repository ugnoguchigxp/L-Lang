# L-Lang

新しい実行例：[TypeScript/JSONC → TypeScript/Wasmの4通り](./examples/source-output-matrix/README.md) · [要件変更・修正・配備・切戻し](./examples/capability-lifecycle/README.md)

[English](./README.en.md) · [ドキュメント一覧](./docs/README.md) · [現在地とロードマップ](./PROJECT_STATUS_AND_ROADMAP.md) · [品質Gate](./QUALITY_GATES.md)

L-Langは、要求や型に基づく判定処理を、制限されたIRとテストで検証し、再現できる成果物へ変換する研究プロジェクトです。**TypeScriptとJSONCの両方を扱います。** 用途に応じて入力形式と出力形式を選びます。

入力言語と出力形式は別の軸です。通常のTypeScriptを生成する経路、実行可能なJSONCを生成・変換する経路、Wasmへコンパイルする経路があります。すべての入力と出力の組合せに対応しているわけではありません。

## 目的から選ぶ

| やりたいこと | 入力 → 出力 | 案内 |
| --- | --- | --- |
| 自然言語のConceptをプロジェクトの型へ適応させる | TypeScript DSL → 通常のTypeScript | [Semantic TypeScriptガイド](./docs/guides/semantic-typescript.md) |
| 明示した判定プログラムを検証・実行する | JSONC → Wasm | [JSONCの最小例](./examples/jsonc-enabled-user/README.md)・[言語仕様](./docs/LLANG_JSONC_SPEC.md)・[CLI](./docs/LLANG_CLI_REFERENCE.md) |
| エージェントからJSONC実装を作る | 固定要求・suite → JSONCを含む候補パッケージ | [入力と出力の対応](./docs/guides/language-routes.md) |
| 解決済みのPrompt SourceをJSONCへ変換する | Prompt Source v1＋Lock → JSONC・要求・suite | [入力と出力の対応](./docs/guides/language-routes.md) |
| 既存TypeScriptの型と限定Predicateを取り込む | TypeScript → Wasm | [Hybridの段階別デモ](./examples/hybrid-wasm-scenarios/README.md) |
| Prompt Sourceから意味解決を行う | Prompt Source JSON → 解決Lock → Wasm | [Prompt Sourceの例](./examples/prompt-active-customer/README.md) |
| 型付きIO・非同期処理をローカルで実行する | TypeScript／JSONC → TypeScript／JSONC／Wasm | [Effects仕様](./docs/LLANG_MODULE_EFFECTS_SPEC.md)・[Module IO例](./examples/module-io-pipeline/README.md) |

JSONCの生成は現行の`develop`・`migrate`で扱います。任意のTypeScriptとJSONCの相互変換や、全コマンド共通の出力形式切替を意味しません。各CLIと生成物の対応は[経路ガイド](./docs/guides/language-routes.md)にまとめています。

## APIを使わずに試す

Bunの指定版は[package.json](./package.json)の`packageManager`を参照してください。現在は1.4.2です。以下はリポジトリのルートで実行します。

```sh
bun install --frozen-lockfile
bun run typecheck
```

TypeScript DSLの保存済みlockと生成物を確認します。

```sh
bun run semantic explain examples/active-customer/semantic.ts --json
bun run semantic verify semantic-closure.json --json
```

JSONCをlintし、固定要求・独立suiteで検証します。

```sh
bun run llang lint examples/jsonc-enabled-user/enabled-user.llang.jsonc --json
bun run llang test examples/jsonc-enabled-user/enabled-user.llang.jsonc --request examples/jsonc-enabled-user/request.json --suite examples/jsonc-enabled-user/tests.json
```

生成を含む手順は[TypeScriptガイド](./docs/guides/semantic-typescript.md)と[JSONCの例](./examples/jsonc-enabled-user/README.md)を参照してください。fixture・保存済みlock・JSONCのlint/build/testはAPI認証なしで実行できます。実モデルによる生成を選ぶ場合は、利用する経路の認証が必要です。

## 保証する範囲

限定されたBoolean Predicateに加え、`module-effects-v1`ではbytes、i64、有限f64、decimal、型付きIO、await、structured task、pull streamをTypeScript／JSONCからWasmへlowerできます。これは制限されたIRと登録済みhost operationによる実行系であり、任意のTypeScript、任意の外部API、汎用package ecosystemを提供するものではありません。

制限IR、型・入力契約、独立テスト、hash、replayで不正な入力や改変を検査します。hashは署名ではなく、テスト合格は自然言語要求の完全な充足を証明しません。部品検証とSAAAによる受け入れ・配備も別工程です。詳しくは[セキュリティ](./SECURITY.md)を参照してください。

実モデル評価・性能計測は経路と条件ごとの結果です。TypeScript経路の評価をJSONC経路の精度証拠へ読み替えず、fixture成功を実モデル評価とは扱いません。[現在地とロードマップ](./PROJECT_STATUS_AND_ROADMAP.md)から各証跡を確認できます。

Phase 4はローカルfile、許可済みHTTP、fixture/replay、loopback統合を対象に実装・検証済みです。SAAAでのsoak／capability評価、実ネットワークのTLS運用試験、長期の性能・memory評価は、利用期間と観測条件を確保してから別証跡として実施します。[Phase 4結果](./docs/GENERAL_PURPOSE_LANGUAGE_PHASE4_IMPLEMENTATION_RESULTS.md)に現在の完了範囲と保留した運用評価を記録しています。

## リポジトリの案内

| フォルダー | 内容 |
| --- | --- |
| `src/` | コンパイラ、CLI、runtime、検証処理とテスト |
| `docs/guides/` | 利用方法と入出力経路の案内 |
| `docs/` | 言語仕様、設計、計画、結果。種類別の入口は[文書一覧](./docs/README.md) |
| `examples/` | 経路ごとの実行例。入口は[例の一覧](./examples/README.md) |
| `benchmarks/`・`pilots/` | 評価入力、freeze、保存済み証跡 |
| `schemas/` | 公開する構造化データのschema |

開発手順は[Contributing](./CONTRIBUTING.md)、検証項目は[品質Gate](./QUALITY_GATES.md)、今回の整理と残る差分の作業計画は[整合計画](./docs/DOCUMENTATION_AND_IMPLEMENTATION_ALIGNMENT_PLAN.md)を参照してください。

## License

[MIT License](./LICENSE)。`package.json`の`private: true`はnpmへの誤公開を防ぐ設定です。
