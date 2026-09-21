# 実行例の一覧

[プロジェクト概要](../README.md) · [入力と出力の対応](../docs/guides/language-routes.md)

フォルダーは既存のコマンド・fixture・lockから参照されるため、名前と配置を維持し、用途別に案内します。

| 入力・用途 | 例 | 出力・確認内容 |
| --- | --- | --- |
| 入出力4通りの比較・配備 | [source-output-matrix](./source-output-matrix/README.md) | TypeScript/JSONC → TypeScript/Wasm、移動後実行、共通oracle、計測 |
| 型付き複数module | [module-access](./module-access/README.md) | 全TS・全JSONC・混在 → TypeScript/JSONC/Wasm、portable verify |
| 要件変更から配備・切戻し | [capability-lifecycle](./capability-lifecycle/README.md) | 固定suite、失敗→修正→replay→配備→rollback |
| TypeScript DSL | [active-customer](./active-customer/)、[利用ガイド](../docs/guides/semantic-typescript.md) | 通常のTypeScript、lock、Semantic Test |
| TypeScriptのスキーマ適応 | [semantic-polymorphism](./semantic-polymorphism/)、[order-fulfillment](./order-fulfillment/README.md) | 同じConceptを複数の型へ具体化 |
| TypeScript Static Judgment | [static-judgment](./static-judgment/) | boolean定数 |
| JSONC | [jsonc-enabled-user](./jsonc-enabled-user/README.md) | lint、Wasm、独立suite、Capability v2 |
| Semantic TypeScriptからWasm | [wasm-active-customer](./wasm-active-customer/README.md) | lockからWasmを生成し実行 |
| 既存TypeScriptの取り込み | [hybrid-order](./hybrid-order/README.md)、[段階別デモ](./hybrid-wasm-scenarios/README.md) | 型・PredicateからWasm |
| Prompt Source JSON | [prompt-active-customer](./prompt-active-customer/README.md) | 意味解決LockとWasm |
| Prompt Sourceの部品検証 | [capability-access](./capability-access/README.md) | パッケージ作成・検証 |
| Prompt Sourceのテスト・実装製造 | [capability-development](./capability-development/README.md) | 独立テスト、最大1回修正、replay |
| Host接続 | [saaa-host](./saaa-host/README.md) | 単発Wasm実行キット |
| LLVM checked sum比較 | [llvm-sum-i32](./llvm-sum-i32/README.md) | TS/JSONCから同一kernel planを抽出し、direct/LLVM Wasm/Nativeを比較 |
| 用途別ソート実験 | [wasm-json-sort](./wasm-json-sort/README.md) | 実験用JSONCからTS/Wasmを生成・比較。標準Predicate profileとは別 |
| 用途別UIデモ | [saaa-world-clock](./saaa-world-clock/README.md) | 専用ABIとtimezone adapter。一般Predicate言語の拡張ではない |

コマンドは各READMEに特記がなければリポジトリのルートで実行します。JSONC出力を作る`llang develop`・`llang migrate`の位置付けは経路ガイドを参照してください。
