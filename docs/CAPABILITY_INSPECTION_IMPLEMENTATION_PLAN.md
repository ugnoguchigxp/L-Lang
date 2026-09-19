# 要求付きWasmパッケージをTypeScriptで事後検査する実装計画

作成日: 2026-09-19。状態: 実装済み（2026-09-19、I1〜I11確認済み）。対象は1回の開発で完了させる機能追加です。

[メインコンセプト](../MAIN_CONCEPT.md)のうち、「何を要求し、どの実行物を作り、どのような判定処理になったかを後から確認する」を実装します。既存のCapability v2パッケージから、要求・契約・成果物の対応情報と、検査用TypeScriptを生成する機能に限定します。

## 今回の到達点

利用者は、既存の`llang package`または`llang develop`で作ったパッケージを指定し、次を確認できます。

- 保存された要求本文、必須・禁止・推奨事項、入力契約。
- その要求と結び付けられたsource、program、Wasm、suiteの識別情報。
- 検査済みsourceから決定的に生成したTypeScriptの判定ロジック。
- 要求とテストケースの対応、および未網羅の要求。
- 整合性の確認済み範囲と、実行・意味一致・安全性について未検証の範囲。

対象は`predicate-i32-v1`のCapability v2だけです。外部I/OのないBoolean判定に限定することで、既存の要求・パッケージ契約を変更せずに、要求から検査用コードまでを一本につなぎます。module/effectsの要求形式や権限設定まで新設する作業は含めません。

## 現状調査と不足

調査は2026-09-19の作業ツリーを対象とした静的確認と、下記の限定テストです。既存の未コミット文書変更を前提にしています。

| 項目 | 現状の根拠 | 今回埋める不足 |
| --- | --- | --- |
| 要求の固定と生成 | `src/llang-development.ts`にrequest/suiteの保存・hash照合・修復・replayがある | 生成ループは追加しない |
| 要求と実行物の関連付け | `src/llang-capability-contracts.ts`の`readLlangCapability`がrequest/source/build/Wasm/testsを読み、hash・契約・IDの対応を検証する | 同じsnapshotを人間向け検査資料に利用するAPIがない |
| パッケージ検証 | `src/llang-capability-verifier.ts`がWorker内でsuiteを実行し、要求網羅と結果を返す | 検査資料の生成と実行検証の違いを明示する。verifierの置換は不要 |
| 既存inspect | `src/capability-package.ts`の`inspectCapability`と`src/capability-cli.ts`が旧Prompt Source系の検査を扱う | `llang`のCapability v2に対応するinspect経路とTS出力がない |
| TypeScript生成 | `src/generator.ts`にPredicateExpressionの描画処理があるが、既存型moduleのimportを前提とする | Capability内の契約から自己完結した検査用型と関数を生成する |
| module/effectsのprojection | `src/llang-module-effects-build.ts`にTS/JSONC/Wasm出力がある | v2要求形式とは別profile。今回統合しない |

変更前の限定確認として、`bun test src/generator.test.ts src/llang-capability.test.ts --timeout 30000`は15 pass、0 failでした。実行Bunは1.3.14、リポジトリ指定は1.4.2です。この結果を指定環境での品質Gate成功とは扱わず、実装時の最終検証は指定版で行います。

## 入出力とCLI

次のコマンドを追加します。以下は実装予定の構文です。

```text
bun run llang inspect <capability.json> --json
bun run llang inspect <capability.json> --out-dir <new-directory> --json
```

`--out-dir`なしではJSONを返すだけで、ファイルを書きません。指定した場合は、新しい出力ディレクトリに次の2ファイルを保存します。

```text
inspection.json
program.inspection.ts
```

JSON結果にはTypeScript本文も含め、ファイル出力の有無で確認できる情報を変えません。出力ディレクトリは元パッケージの外部とし、既存ディレクトリを上書きしません。正常な検査は終了コード0、不正入力・未対応profile・出力失敗は既存CLIに合わせて2とします。0はテスト合格や配備許可を意味しません。

コマンドはLLM、Wasm実行、生成TSのimport/eval、ネットワークを呼び出しません。実行検証は従来の`llang verify`を使い、今回のinspectへ暗黙に組み込みません。生成物に記載する`apiCalls: 0`はこの検査操作の値で、元の生成履歴の呼出回数ではありません。

## 実装内容

### 1. Capability v2の検査API

`src/llang-capability-inspection.ts`を追加し、`readLlangCapability`の返すsnapshotだけから検査結果を組み立てます。独自のpackage parserや新しいpackage形式は作りません。

出力はversion付きの派生reportとし、少なくとも次を含めます。

| 情報 | 内容 |
| --- | --- |
| 識別 | report format/version、profile、packageHash、既存metadata |
| 要求 | request本文、requirements、requestRevision |
| 契約 | 入力fields、boolean出力、既存manifestのpermissions |
| 対応 | sourceHash、programHash、artifactHash、suiteHash、buildのcompiler/backend/options |
| 要求網羅 | 既存`requirementCoverage`の結果。ケースへの対応であって要求の意味の網羅とは表示しない |
| TypeScript | projection version、本文、本文bytesのSHA-256、元source/programのhash |
| 検査範囲 | `integrity: checked`、`verification: not-run`、`acceptance: not-run`、`semanticEquivalence: not-checked`、`apiCalls: 0` |

既存packageのhashとrequestRevision等の意味を変更せず使います。projectionHashはUTF-8本文のbytes hashと定義します。生成日時・絶対パス・乱数を決定的なreport本文に含めません。

パッケージを読み終えた後にファイルを個別に読み直して本文を生成しません。公開直前に既存readerで再確認し、元snapshotとのpackageHash不一致や読取エラーを検出したら出力しません。ただしこれは読み取ったsnapshotの検査であり、敵対的な環境で将来のファイル不変を保証する機能とはしません。

hashで内部整合を確認できても、package全体とhashを一緒に置き換えた攻撃者の真正性は判定できません。既知の正しいpackageHashとの外部照合が必要であることを説明します。manifestの自己申告だけでsourceとバイナリの意味一致を証明したとは表示しません。

### 2. 検査用TypeScriptの生成

`src/llang-predicate-projection.ts`を追加します。入力は上記snapshotの`checked.program`に限定し、要求本文からLLMで説明コードを生成しません。

- `contract.fields`から自己完結した`Input`型を生成する。boolean、enum、string、optional、nullable、undefinableを区別する。
- 固定名の`evaluate(input: Input): boolean`と、all/any/not/equals/presentの判定式を生成する。
- 既存`src/generator.ts`の式描画を小さな関数として共有する。既存`generatePredicate`の出力は維持し、外部型module依存のwrapperを流用しない。
- property描画は、契約上許可される名前と欠損fieldの意味を保つ。`constructor`等の名前で継承プロパティを誤読しないよう、自身のdata propertyを参照する。既存generatorへこの挙動を無条件で適用しない。
- 利用者の文字列はliteralとしてescapeする。要求本文やdescriptionを実行コード、識別子、無加工のコメントに挿入しない。
- 検査用TypeScriptの冒頭には固定文で「契約を満たす入力に対する判定ロジック」と記す。入力検査は既存runtimeの責務であり、不正入力時の`INVALID_INPUT`までこの関数が再現するとはしない。
- runtimeの入力検査規則はreportの契約と制約説明から参照できるようにする。新たな入力validatorを複製しない。

生成コードはパッケージの新しい正本にはしません。手修正して元パッケージへ戻す経路、TSからWasmへの新しいcompile経路、署名、任意コードの逆コンパイルは追加しません。

### 3. CLIと出力処理

`src/llang-cli.ts`へinspectの分岐・help・引数検証を追加します。既存の`--json`処理とエラー形式に合わせ、未知・重複・値欠損の引数を拒否します。

ファイル保存は新規ディレクトリのみ許可し、realpathを用いて元パッケージ内やsymlink経由の出力を拒否します。TSを保存し、そのhashを含む`inspection.json`を最後に公開します。失敗時は今回作成した未完了ファイルだけを削除し、元パッケージと既存の利用者ファイルを変更しません。既存atomic write・排他作成の慣例を利用します。

## 検証と受け入れ条件

TypeScriptの実行は開発テスト内だけで行います。実際の検査コマンドが対象コードを実行しないこととは分けて検証します。

| ID | 検証 | 合格条件 |
| --- | --- | --- |
| I1 | 既存JSONC例をpackage化してinspect | 要求・契約・全hashが既存reader結果と一致し、TSから判定条件が読める |
| I2 | 同じpackageを別ディレクトリへ移し再検査 | JSON/TS本文とprojectionHashが一致する |
| I3 | source、request、Wasm、suite、buildを個別改変 | 既存readerの拒否を伝播し、成功reportや出力を残さない |
| I4 | package読取・出力中の差し替え、symlink、不正profile | 成功扱いせず、元データや既存出力を破壊しない |
| I5 | 生成TSを型検査し、契約に適合する入力で実行 | 参照IR評価と実Wasmのboolean結果に一致する |
| I6 | all/any/notの入れ子、enum、null、undefined、欠損、特殊field名 | 各境界の意味を保つ。手書き期待値も持ち、同じ実装を期待値として複製しない |
| I7 | TSの判定を一箇所反転する故障注入 | I5の照合で不一致を検出し、元projectionHashとの差も検出する |
| I8 | 要求にひも付かないcase、未網羅要求 | 元の網羅情報を保持し、要求充足済み・安全と表示しない |
| I9 | 命令文・コメント終端・引用符を含む要求や説明 | JSONデータとして保持し、生成コードへ命令・式として混入しない |
| I10 | inspectの実行境界 | 外部API、Wasm実行、生成TSのimport/evalを使わず、元packageを変更しない |
| I11 | 書込失敗、既存出力、package内出力、CLI誤用 | 終了コード2。既存データ不変、未完成出力の後始末を確認 |

I5/I6は契約に適合する入力の比較です。不正入力の拒否は既存runtimeテストで維持し、検査用TSが同じ入力検査をするという試験に拡張しません。I9は描画処理の安全性であり、LLMへのprompt injection耐性を測る試験とは扱いません。

実装時の主な変更先は次のとおりです。

- 新規: `src/llang-capability-inspection.ts`、`src/llang-predicate-projection.ts`と各テスト。
- 更新: `src/generator.ts`と既存テスト、`src/llang-cli.ts`とCLIテスト。
- 操作例・CI: `examples/jsonc-enabled-user/README.md`、`docs/LLANG_CLI_REFERENCE.md`、`src/llang-smoke.ts`。
- コンパイラ、Wasm ABI、Capability v2 manifest、既存verifyの判定、凍結済みbenchmarkには変更しない。

対象テストに続き、指定Bun版で`bun run check`、`bun run ci:docs`、`bun run ci:protected`、`bun run ci:smoke`を実行します。coverageと3 OS試験は既存CIに従い、ローカル結果とCI未実行を区別して報告します。新しいlive workflowやbenchmark frameworkは作りません。

## 一回の開発としての進め方

1. 変更前の関連テストを指定Bun版で確認し、projectionの有効入力境界を固定する。
2. 式描画の共有と検査用TS生成を実装し、型検査・IR/Wasmとの照合を通す。
3. snapshotから検査reportを生成し、CLIと排他的な保存処理を接続する。
4. 改変・故障注入・出力失敗の検証、既存例とsmokeの更新、品質Gateを完了する。

一つのAPI、一つのCLIサブコマンド、二つの派生成果物で完結させます。新規依存の追加や既存package形式の変更が必要になった場合は、その作業を別計画へ切り出し、今回の範囲を拡大しません。戻す場合はinspectと派生成果物の生成経路だけを取り除ける構成にします。

## この開発後も残るもの

この機能により、要求付きパッケージと検査用TypeScriptを対応付けられます。ただし、次は未達のまま明記します。

- 自然言語要求とプログラムの意味が正しいことの独立評価。
- 任意のバイナリとCoreの意味一致、コンパイラの一般的な正しさの証明。
- module/effectsにおける要求・権限方針・実行transcriptの一体的な検査。
- 信頼するプロンプトと外部データの分離、および攻撃に対する実験。
- 人間の理解度・調査時間、通常のTypeScript方式との比較。

完了報告ではI1〜I11の結果、生成した検査資料の例、実行した環境とコマンド、残る制約を示します。「コンセプト全体の実装完了」「安全性を証明」「論文の証拠が揃った」とは報告しません。
