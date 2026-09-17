# 6項目の改善とexamples拡充

実施日：2026-09-17。基点：`0a40782`と既存の未コミット変更。既存のTypeScript/JSONC経路と凍結された評価入力を維持した。

## 実装内容

| 項目 | 実施内容 | 主な確認先 |
| --- | --- | --- |
| 1. 追跡性・snapshot | 単体testへ5種類のhashを追加。取り込んだJSONC原文をコンパイルし、元パスを再読しない | `src/llang-improvements.test.ts` |
| 2. 品質Gate | Bun 1.4.2、JSONC CLI smoke、CLI一覧・ツール版の文書照合、coverage逐次出力 | `src/llang-smoke.ts`、`src/verify-doc-contracts.ts` |
| 3. CLI | help、JSON例外、終了コード、format協調ロック | [CLIリファレンス](./LLANG_CLI_REFERENCE.md) |
| 4. 形式比較 | TS/JSONC入力×TS/Wasm出力、同一oracle、変更行数・bytes・ビルド/実行時間 | [4通りの例](../examples/source-output-matrix/README.md) |
| 5. 縦断例 | 要件変更→失敗→修正→replay→移動後配備→切戻し。v1/v2共通hostとv2キットも追加 | [ライフサイクル例](../examples/capability-lifecycle/README.md) |
| 6. 内部整理 | case評価、artifact検査、v2 verifier、版別snapshot読込を分離・共有。実行用bundleからcompilerを除外 | `src/llang-case-runner.ts`、`src/llang-artifact.ts`、`src/llang-capability-verifier.ts`、`src/capability-snapshot.ts` |

## 検証環境と記録

macOS arm64、Bun 1.4.2を隔離した場所から使用。通常のBunインストールは変更していない。依存は`bun install --frozen-lockfile`で確認。

全ローカルGateが成功した。ログは`artifacts/improvements-validation-20260917/`に保存（git対象外）。集計は`summary.json`、検証対象の各ファイルhashは`snapshot.json`、開始時と終了時の一致確認は`snapshot-check.json`にある。

| Gate | 結果 |
| --- | --- |
| frozen install / audit | 成功。依存監査109 packages、脆弱性検出なし |
| format / lint / typecheck | 成功、警告なし |
| 全体coverage | 500 pass / 0 fail、100 files、3,751 assertions |
| 全体functions / lines | 94.75% / 92.56%（基準90% / 90%） |
| semantic-transaction functions / lines | 98.36% / 96.88%（基準95% / 95%） |
| ci:smoke | 既存semantic経路＋JSONC CLI 12チェック成功、API呼出0 |
| ci:docs | ローカルリンク、CLI 10コマンド、設定中の3版、JSONC smokeの登録を照合 |
| 文書追加監査 | Markdown 79、現行script参照193、過去記録15の保持、エラー0 |
| ci:protected / diff --check | 成功 |

最終検証のコード・設定の集約SHA-256は`4fc419c56479d7228b68862719745f5c0e3467eb65c2e8b3911f24d27c68887c`。検証前後で一致した。説明文だけの最終結果追記はこのコード・設定hashの対象外。

初回coverageはソース編集中に実行したため、途中の型エラー・モジュール差替えの影響で失敗した。`coverage.log`として残し、最終品質結果には使用しない。最終結果は編集を止めて実行した`coverage-final.log`による。Ubuntu/Windows CIの実行結果は未確認で、ローカル合格とは区別する。

## 同じ要求での生成物比較

Bun 1.4.2 / macOS arm64で4経路すべての真理値表4件、不正入力3件、移動後の別プロセス実行が成功した。TS生成物のhashは両ソースで一致し、Wasm生成物のhashも両ソースで一致した。

| ソース | 出力 | ソースbytes | 成果物bytes | 条件追加時の変更行（追加/削除） |
| --- | --- | ---: | ---: | ---: |
| typescript | typescript | 172 | 278 | 1/1 |
| typescript | wasm | 172 | 146 | 1/1 |
| jsonc | typescript | 963 | 278 | 20/1 |
| jsonc | wasm | 963 | 146 | 20/1 |

JSONCの契約・説明と書式差も含む。人の作業量や優劣をこの表だけで判断しない。時間の生データ、consumerサイズ、環境、hashは`artifacts/improvements-validation-20260917/matrix-final.json`に保存。配備・切戻しでは`true → false → true`を確認し、再検証に失敗した版の有効化を拒否した。

文脈ツール：この実装タスクでは`context_compile` 1回、`compile_eval` 1回。

## 保証範囲

- 四つの生成経路は限定された二つのbooleanによるPredicateの例。汎用の言語間変換ではない。
- 比較時間は単一実行の参考値。実開発者の編集時間、実モデルの品質・費用は未測定。
- 配備はローカルでの移動・再検証・有効版切替。外部サービス公開、複数運用者の同時切替、SAAA受け入れは未実行。
- formatロックは協調writerだけを排他する。任意の外部エディタまで完全排他するとはしない。
- Ubuntu/Windows CIは既存workflowへ新smokeを組み込んだが、このローカル実行からCI成功とは判定しない。
