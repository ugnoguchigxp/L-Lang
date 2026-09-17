# JSONC CLIリファレンス

2026-09-17時点の`src/llang-cli.ts`に対応する操作説明。[JSONC仕様](./LLANG_JSONC_SPEC.md)・[実行例](../examples/jsonc-enabled-user/README.md)・[経路一覧](./guides/language-routes.md)。TypeScriptのCLIは[専用ガイド](./guides/semantic-typescript.md)を参照。

## 共通事項

リポジトリルートで`bun run llang <command> ...`を実行する。以下の`<...>`は実在するファイル・出力先へ置き換える。パスに空白があれば引用する。新規パッケージ・開発run・replayの出力先は存在しないディレクトリを指定し、親ディレクトリを先に用意する。

`llang --help`・`llang help`・各サブコマンドの`--help`はファイルや認証なしで終了0になる。`--version`は未提供。

`develop`以外は以下に示すオプション順を守る。全コマンドの末尾に`--json`を付けるとstdoutを一つのJSONとして扱える。lintの診断は構造化report、helpやformat構文診断の文字列は`{ok,message}`に包む。正常時からJSONを返すコマンドのフィールドは維持する。

共通の例外処理はstdoutへ`{ok:false,error:{code,message}}`を出し、終了2になる。I/OエラーではENOENT等、引数不正ではINVALID_ARGUMENTを返す。以前のstderr文字列を読む自動化はこのJSONへ移行する。ライブラリの`runLlangCli`は従来通り例外を送出し、プロセス境界の`executeLlangCli`が変換する。Bun自身のscript起動表示とCLIのstdoutは区別する。

## コマンド一覧と終了値

| コマンド | stdout | 終了0 | 終了1 | 終了2 |
| --- | --- | --- | --- | --- |
| lint | 既定はtext、`--json`でJSON | 診断errorなし | 構文・型・profile不正、またはwarning昇格 | 引数・読込失敗 |
| format | 正常時JSON、不正構文時text | 整形済み、またはwrite成功 | checkで差分あり、または構文診断error | 引数・I/O・競合エラー |
| build | JSON | Wasmとmanifest作成 | 使用しない | Source不正・引数・I/O等 |
| test | JSON | 全ケース成功、必須要求の未網羅なし | ケース不一致・未網羅 | ケース内実行error、入力検証・build・I/O等の例外 |
| package | JSON | パッケージ作成 | 使用しない | 不正入力、既存出力、I/O等 |
| verify | JSON | report.statusがpass | report.statusがfail | report.statusがerror、または例外 |
| mutation-check | JSON | 下記の失敗条件なし | survived/unknown、未処理提案、必須要求未網羅あり | 不正入力・I/O等の例外 |
| migrate | JSON | 新規変換ファイル作成 | 使用しない | 欠損・不正・stale Lock、既存出力等 |
| develop | JSON | statusがpass | statusがfail | unresolved/stopped/error、または例外 |
| replay-development | JSON | statusがpass | statusがfail | その他status、または例外 |
| module lint | JSON | module閉包・entryの検証成功 | source・型・cycle診断 | 引数・I/O・実行障害 |
| module build | JSON | 新規bundle作成 | source診断 | 既存出力・I/O・SOURCE_CONFLICT |
| module test | JSON | 4実行経路で全case成功 | 期待値不一致 | suite・I/O・実行障害 |
| module verify | JSON | 移動可能Wasm bundleの全case成功 | 期待値不一致 | 改変・ABI・I/O・実行障害 |

正常なbooleanの`false`はCLIエラーとは別。`test`の期待値不一致は終了1、実行障害は終了2なので、reportと終了値を併せて読む。

## module

```sh
bun run llang module lint <entry.ts|entry.llang.jsonc> --root <root> --entry <export> [--profile module-bool-v1|module-value-v1] --json
bun run llang module build <entry.ts|entry.llang.jsonc> --root <root> --entry <export> --target typescript|jsonc|wasm|all --out-dir <new-directory>
bun run llang module test <entry.ts|entry.llang.jsonc> --root <root> --entry <export> --suite <suite.json> --json
bun run llang module verify <module-build.json> --suite <suite.json> --json
```

`module-bool-v1`の型付き関数・複数moduleに加え、`--profile module-value-v1`でi32、string、record、tagged union、const、if、match、型付き結果を扱う。lint/build/testのentryはroot相対、verifyのmanifestとsuiteはcwd相対である。testはreference evaluator、生成TypeScript、再生成JSONC、Wasmを同じ固定suiteで比較する。buildは既存出力directoryを上書きせず、source snapshot再検査後にmanifestを最後に公開する。verifyにはWasm targetを含むbundleが必要で、sourceやcompilerを読まない。詳細は[Typed modules Phase 1仕様](./LLANG_MODULE_SPEC.md)、[Phase 2仕様](./LLANG_MODULE_VALUE_SPEC.md)、[Phase 2実行例](../examples/module-order-line/README.md)を参照。

## lint

```sh
bun run llang lint <source.llang.jsonc> [--json] [--warnings-as-errors]
```

構文、schema、型、profile、lowering可能性を検査する。ファイルを書き換えない。JSONは`version/ok/diagnostics/truncated`を持ち、検証済みProgramがある場合は`sourceHash/programHash`も含む。診断に位置・JSON Pointer・hint等を含む。warningのみは通常成功。

## format

```sh
bun run llang format <source.llang.jsonc> --check
bun run llang format <source.llang.jsonc> --write
```

いずれか一つを指定する。コメント・値・順序を維持して整形する。正常な出力は`{changed, written}`。`--check`は非書込、`--write`だけがSourceを書き換える。構文不正や重複キーの推測修復は行わない。Sourceのrealpathに対応する`.llang-write.lock`を排他的に作成し、読込から書込完了まで協調writerを排他する。既存ロックはSOURCE_CONFLICTとして拒否し、正常終了・例外時に解放する。書込前の再読込とatomic renameも使うが、ロックに参加しない外部エディタとの完全排他は保証しない。強制終了で残ったロックは、そのSourceを書いているプロセスがないことを確認してから取り除く。

## build

```sh
bun run llang build <source.llang.jsonc> --out-dir <directory>
```

検証したSourceからWasmと`manifest.json`を作る。出力は`manifest/source/sourceHash/programHash/wasmHash/bytes/apiCalls`。APIは呼ばない。hash名のWasmとmanifestを公開し、同じ出力ディレクトリへ再buildできる。受け入れsuiteは実行しない。

## test

```sh
bun run llang test <source.llang.jsonc> --request <request.json> --suite <tests.json>
```

固定要求・入力契約とSourceを照合し、一時ディレクトリにbuildしたWasmでsuiteを実行する。一時成果物は削除する。出力は`version/coverage/requirements/uncoveredRequirements/results/ok/apiCalls`と追跡hash。

`requestRevision/suiteHash/sourceHash/programHash/artifactHash`は実際に検証・実行したsnapshotから得る。元のSourceをbuild時に読み直さず、取り込んだJSONC原文を一時Sourceとしてコンパイルする。コメントだけの変更はsourceHashに反映し、programHash/artifactHashは変えない。同じ入力の`verify`と5種類のhashが一致する。要求IDのない入力のcoverageは`not-evaluated`で、要求網羅の証明ではない。

## packageとverify

```sh
bun run llang package <source.llang.jsonc> --request <request.json> --suite <tests.json> --metadata <metadata.json> --out-dir <new-directory>
bun run llang verify <new-directory/capability.json>
```

metadataは`id/release/purpose/useWhen/doNotUseWhen`。request・Source・metadataのIDと契約の整合を要求する。パッケージはrequest/source/build/wasm/testsの5 roleを持ち、JSONC原文を保持する。Resolution Lockは含まない。

packageの成功出力は`manifest/packageHash/verification:"not-run"/acceptance:"not-run"/apiCalls:0`。作成だけではテスト合格と表示しない。

verifyは自己完結したパッケージを読み、各file hashと契約・成果物の対応を照合してWorkerでsuiteを実行する。reportは`status/results/requirements/coverage/diagnostics`等と、`requestRevision/suiteHash/sourceHash/programHash/artifactHash`を持つ。`acceptance`は`not-run`のままで、外部SAAAの受け入れ・配備は実行しない。

パッケージ全体を移動して再検証できる。`capability verify`はv1向けなのでv2には`llang verify`を使う。`capability:host`はv1/v2を判別してinspect/verify/invokeできる。`capability:host-kit <new-directory> --jsonc`はv2の自己完結したキットを作る。

## mutation-check

```sh
bun run llang mutation-check <source.llang.jsonc> --request <request.json> --suite <tests.json>
```

限定IRの条件削除・否定・比較値変更などの変異を作り、既存suiteの検出力を調べる。現行v2はIR evaluatorで比較し、各変異をWasmへbuildする経路ではない。元ファイルは変更しない。

`mutations[].status`は`killed/equivalent/survived/unknown`。reportには`score/proposed/omittedProposals/invalidProposals/duplicates`と要求網羅情報がある。同値変異はscoreの分母から除外し、無効入力ケースを意味変異の検出根拠にしない。検査した変異の検出は自然言語要求の正しさの証明ではない。Prompt Source v1のmutation-checkとは出力・終了値が異なる。

## migrate

```sh
bun run llang migrate <source.prompt.json> --out <new-source.llang.jsonc>
```

Sourceと隣接する`<source.prompt.json>.lock.json`が有効な場合に限り、モデルを呼ばず変換する。出力先の拡張子は`.llang.jsonc`。

- `<new-source.llang.jsonc>`：実行Program。
- `<new-source.llang.jsonc>.request.json`：固定要求の変換結果。
- `<new-source.llang.jsonc>.tests.json`：元の例から引き継ぐsuite。

既存ファイルは上書きしない。元の例に要求IDの対応がないため、移行直後に必須要求のcoverageが不足することがある。warningsを読み、元要求と例の関係を確認する。期待値を自動で作り直さない。

## develop

```sh
bun run llang develop <request.json> --suite <tests.json> --metadata <metadata.json> --fixtures <responses.fixture.json> --out-dir <new-directory>
```

既存の固定suiteから、初回実装と最大1回の修正を行う。テストは同コマンドで生成しない。fixtureはv2の`{version:2,responses:[{stage,reply},...]}`で最大2応答。stageは`implementation`、次が`repair`。実行できる例と応答fixtureは[JSONC例](../examples/jsonc-enabled-user/README.md)にある。

liveの場合は`--fixtures`を`--agent codex-sdk`へ置き換える。fixtureとagentの併用は禁止。CLI実装上のモデル指定は`gpt-5.6-terra`、SDK adapterのreasoningは`medium`。利用可否や認証は実行環境に依存し、別モデルへ自動置換しない。

| オプション | CLIの既定値 |
| --- | ---: |
| --max-output-tokens | 4096 |
| --max-total-tokens | 100000 |
| --max-wall-ms | 120000 |

maxCallsはCLIでは2固定。`--model`や`--max-calls`はこのCLIのオプションではない。token・時間制限は停止制御であり厳密な課金額上限ではない。新規runへ固定request/tests/metadata、呼出記録、試行、`run.json`を保存する。`complete`は処理終了を意味し、合否は`status`で判断する。

## replay-development

```sh
bun run llang replay-development <saved-run-directory> --out-dir <new-directory>
```

保存した入力・応答・hashを検査し、APIなしで再実行する。`run.json`ファイルではなくrunディレクトリを渡す。元run・新規出力を同じ場所にせず、結果のstatusを確認する。改変・途中run等の拒否条件は開発protocolの検査に従う。

## 関連する実行例

[TypeScript/JSONC × TypeScript/Wasm](../examples/source-output-matrix/README.md)と[修正・配備・切戻し](../examples/capability-lifecycle/README.md)を参照。実装と検証結果は[改善記録](./IMPROVEMENTS_RESULTS_20260917.md)へ集約する。
