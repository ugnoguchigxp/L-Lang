# 入力言語・変換処理・出力形式

[全体案内](../../README.md) · [文書一覧](../README.md) · [実行例](../../examples/README.md)

TypeScriptとJSONCは併存する形式です。どちらかを廃止対象とはしません。出力もTypeScript・JSONC・Wasmを区別し、現在実装された変換を以下に示します。

## 対応している経路

| 経路 | 入力 | 処理・CLI | 主な出力 | LLM |
| --- | --- | --- | --- | --- |
| Semantic TypeScript | Concept・型・Semantic Testを記述したTypeScript DSL | `semantic build` / `replay` | 通常のTypeScript、semantic.lock | live解決時のみ。fixture・lock replayは不要 |
| 制限IRからTS生成 | Predicate IR JSON | `generate` / `verify` | 通常のTypeScript | 不要 |
| JSONC build | `.llang.jsonc` | `llang lint` / `build` | Wasm、Build Manifest v2 | 不要 |
| JSONC実装生成 | 固定request、既存の独立suite、metadata | `llang develop` | JSONCを含む候補パッケージ、試行・検証記録 | fixtureなら不要、live agentなら使用 |
| JSONC変換 | Prompt Source v1と有効なResolution Lock | `llang migrate` | `.llang.jsonc`、request、suite | 不要 |
| Wasm backend | lock済みSemantic TypeScript | `wasm build` | Wasm、manifest | 不要 |
| Hybrid | 既存TypeScriptの型と対応するPredicate | `hybrid` | Wasmと検証用artifact | 不要 |
| Prompt Source | 要求・契約を持つPrompt Source JSON | `prompt resolve` → `build` | 解決Lock、Wasm、manifest | live resolve時のみ |

JSONCを出力する`develop`はエージェントによる実装生成、`migrate`は解決済みIRからの決定的な形式変換です。JSONC→Wasmのコンパイルとは工程が異なります。生成されたJSONCは、その後のlint/build/testへの入力にもなります。

**TypeScript→JSONC、JSONC→TypeScriptという全組合せを一律に選べるCLIは、現時点では提供していません。** TypeScript出力とJSONC出力の併存方針と、個々の変換の実装状況を分けて扱います。

## ファイルの役割

| 種類 | 役割 |
| --- | --- |
| TypeScript DSL・JSONC Program | 作成・編集するプログラム。形式ごとに対応範囲がある |
| 通常の生成TypeScript | TypeScript経路の実行成果物 |
| request・suite | 固定要求と独立した受け入れ条件。JSONC実装の変更と別に管理 |
| IR・Resolution Lock・semantic.lock | 経路ごとの解決内容・履歴。JSONC直接buildはResolution Lock不要 |
| manifest・report | 成果物の構成と検証記録。JSON形式でもJSONCプログラムとは別物 |
| Wasm | 実行バイナリ。入力契約とhostを通して評価する |

## 選び方と検証

既存TypeScriptプロジェクトのConceptと型へ適応させたい場合は[Semantic TypeScript](./semantic-typescript.md)、判定式を明示して編集したい場合は[JSONCの例](../../examples/jsonc-enabled-user/README.md)、既存Predicateを取り込みたい場合は[Hybridの例](../../examples/hybrid-order/README.md)から始めます。

JSONCの`develop`は`--suite`で渡した既存suiteを固定して使います。初回実装と最大1回の修正を行い、同コマンドがテストを自動生成するわけではありません。[テスト製造・修正の例](../../examples/capability-development/README.md)はPrompt Source側の経路なので、引数・成果物をJSONC v2と混同しないでください。

パッケージの作成、部品テスト、外部サービスによる受け入れは別工程です。`package`成功だけで検証済みとはせず、`verify`を実行します。保存済み評価も対象経路ごとに読み、他経路の精度や速度の証拠へ流用しません。

JSONC全10コマンドの引数・出力・終了値は[CLIリファレンス](../LLANG_CLI_REFERENCE.md)にまとめる。host-kitは既定でv1、`--jsonc`でv2を作る。hostは両パッケージを判別する。


## 用途別の実験

[世界時計](../../examples/saaa-world-clock/README.md)は構造化要求から専用ABIのWasmを生成する。[JSON配列ソート](../../examples/wasm-json-sort/README.md)は実験用JSONC profileからTypeScriptとWasmの両方を生成する。どちらもexamples内の専用コンパイラであり、標準`llang` CLIのPredicate profileや、任意のJSONC→TypeScript変換を提供するものではない。

## 入力・出力を揃えて試す

[4通りの配備可能な例](../../examples/source-output-matrix/README.md)ではTypeScript/JSONCを同じPredicateへ変換し、TypeScript/Wasmを生成・移動・実行する。[ライフサイクル例](../../examples/capability-lifecycle/README.md)では要件変更・修正・replay・配備・切戻しを確認できる。
