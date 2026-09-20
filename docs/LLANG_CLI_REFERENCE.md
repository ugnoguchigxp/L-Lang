# JSONC CLIリファレンス

2026-09-20時点の`src/llang-cli.ts`に対応する操作説明。[JSONC仕様](./LLANG_JSONC_SPEC.md)・[実行例](../examples/jsonc-enabled-user/README.md)・[経路一覧](./guides/language-routes.md)。TypeScriptのCLIは[専用ガイド](./guides/semantic-typescript.md)を参照。

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
| inspect | JSON | 整合する検査report生成 | 使用しない | 改変・未対応profile・出力先・I/O等 |
| mutation-check | JSON | 下記の失敗条件なし | survived/unknown、未処理提案、必須要求未網羅あり | 不正入力・I/O等の例外 |
| migrate | JSON | 新規変換ファイル作成 | 使用しない | 欠損・不正・stale Lock、既存出力等 |
| develop | JSON | statusがpass | statusがfail | unresolved/stopped/error、または例外 |
| replay-development | JSON | statusがpass | statusがfail | その他status、または例外 |
| module lint | JSON | module閉包・entryの検証成功 | source・型・cycle診断 | 引数・I/O・実行障害 |
| module build | JSON | 新規bundle作成 | source診断 | 既存出力・I/O・SOURCE_CONFLICT |
| module test | JSON | 4実行経路で全case成功 | 期待値不一致 | suite・I/O・実行障害 |
| module verify | JSON | 移動可能Wasm bundleの全case成功 | 期待値不一致 | 改変・ABI・I/O・実行障害 |
| module inspect | JSON | Effects bundleの再構築検査成功 | 使用しない | target不足・改変・出力先・I/O等 |
| module execute | JSON | 実行完了と証跡report公開 | failed/cancelled/incompleteの有効な証跡 | preflight・grant・出力・証跡I/O等 |
| module audit-execution | JSON | passedまたはreview-required | 機械的不一致を示すfailed report | 不正入力・未対応version・出力・I/O等 |
| module recover-execution | JSON | 使用しない | crash後のincomplete report公開 | live owner・改変・既存report・I/O等 |
| module attestation-keygen | JSON | Ed25519鍵pairを新規作成 | 使用しない | 既存出力・権限・I/O等 |
| module approve-requirements | JSON | 要求承認署名を新規作成 | 使用しない | bundle・要求・鍵・出力不正 |
| module attest-audit | JSON | 監査者署名付きpackageを新規作成 | 使用しない | role・署名・監査・出力不正 |
| module verify-attestation | JSON | 全chainと現行policyがtrusted | policy判定がrejected | 改変・role・policy・I/O等 |
| module explain-attestation | JSON | 検証済みpackageから決定的summaryを新規作成 | packageのtrust判定がrejected | 改変・role・policy・出力・I/O等 |

正常なbooleanの`false`はCLIエラーとは別。`test`の期待値不一致は終了1、実行障害は終了2なので、reportと終了値を併せて読む。

## module

```sh
bun run llang module lint <entry.ts|entry.llang.jsonc> --root <root> --entry <export> [--profile module-bool-v1|module-value-v1|module-collection-v1|module-effects-v1] --json
bun run llang module build <entry.ts|entry.llang.jsonc> --root <root> --entry <export> --target typescript|jsonc|wasm|all --out-dir <new-directory> [--profile module-bool-v1|module-value-v1|module-collection-v1|module-effects-v1]
bun run llang module test <entry.ts|entry.llang.jsonc> --root <root> --entry <export> --suite <suite.json> [--profile module-bool-v1|module-value-v1|module-collection-v1|module-effects-v1] --json
bun run llang module verify <module-build.json> --suite <suite.json> --json
bun run llang module inspect <module-build.json> [--out-dir <new-directory>] --json
bun run llang module attestation-keygen <new-key-directory>
bun run llang module approve-requirements <module-build.json> --requirements <effects-requirements.json> --signing-key <private-key.pem> --out <approval.json>
bun run llang module execute <module-build.json> --grant <effects-grant.json> --out-dir <new-evidence-directory> [--requirements <effects-requirements.json>] [--approval <approval.json> --trust-policy <policy.json> --host-signing-key <private-key.pem>] [--credential-env <mapping.json>] --json
bun run llang module audit-execution <module-build.json> --requirements <effects-requirements.json> --evidence <evidence-directory> [--trust-policy <policy.json>] [--require-attestation] [--out-dir <new-audit-directory>] --json
bun run llang module recover-execution <evidence-directory> [--trust-policy <policy.json> --host-signing-key <private-key.pem>] --json
bun run llang module attest-audit <module-build.json> --requirements <effects-requirements.json> --audit <audit-directory> --trust-policy <policy.json> --signing-key <private-key.pem> --out-dir <new-package-directory>
bun run llang module verify-attestation <module-build.json> --requirements <effects-requirements.json> --package <package-directory> --trust-policy <policy.json>
```

`module-bool-v1`の型付き関数・複数moduleに加え、`module-value-v1`はi32、string、record、tagged union等、`module-collection-v1`はList・loop・closure等を扱う。`module-effects-v1`は互換用の線形i32形式と、bytes／i64／f64／decimal、await／task／stream、file／HTTP専用nodeを持つtyped graph形式を扱う。graphはTS/JSONCを相互にimportでき、全TS・全JSONC・混在2方向からTypeScript/JSONC/Wasmを生成する。version 5 suiteは旧i32 replayに加え、`mode: "typed"`でoperation、version、canonical request/responseと最終値をreplayする。lint/build/testのentryはroot相対、verifyのmanifestとsuiteはcwd相対である。pure profileのtestはreference evaluator、生成TypeScript、再生成JSONC、Wasmを同じ固定suiteで比較する。buildは既存出力directoryを上書きせず、manifestを最後に公開する。詳細は[Typed modules Phase 1仕様](./LLANG_MODULE_SPEC.md)、[Phase 2仕様](./LLANG_MODULE_VALUE_SPEC.md)、[Collection仕様](./LLANG_MODULE_COLLECTION_SPEC.md)、[Effects仕様](./LLANG_MODULE_EFFECTS_SPEC.md)を参照。

`module inspect`はversion 5のtyped `module-effects-v1` bundleに限定し、`--target all`で同梱されたflattened JSONCを検査してTypeScriptとWasmを再生成する。interface、operation、TypeScript/Wasm bytes、Wasm contract/stateがmanifestと一致した場合だけ成功する。`--out-dir`指定時はbundle外部の新規directoryへ`program.inspection.ts`と`effects-inspection.json`を保存する。元source本文はbundleにないため再検査せず、Wasm・生成TS・adapterを実行しない。manifestのeffect要求はruntime grantではなく、credential、実行transcript、真正性、要求充足、安全性を確認したとは表示しない。

`module execute`は同じ静的検査をpreflightとして実行し、検査したbundle内の`wasm/program.wasm`そのものを実行する。grantはformat `llang-effects-grant` version 1で、bundle identity、operation、file logical root、HTTP origin/method/header/network、wall clock、deadline、既定値以下のresource limitを固定する。出力先はbundleとfile adapter rootの外側にある新規directoryでなければならない。

外部operationより先に`execution-intent.json`とrequest eventを耐久化し、`effects-transcript.jsonl`にはpayload本文、HTTP path/query、credential値、実file root、完全なerrorを保存しない。完了時は`effects-execution.json`を最後に公開する。`--credential-env`のmappingはformat `llang-effects-credential-env` version 1の`origins -> header名 -> 環境変数名`であり、値と環境変数名は証跡へ記録しない。reportの`attestation`は`not-signed`、保存責任は`caller-managed`である。

`--requirements`を指定すると、format `llang-effects-requirements` version 1の要求契約をbundle identityへ固定し、実grantが契約のoperation、file、HTTP、wall clock、deadline、resource上限を超えないことをdispatch前に検査する。この経路は要求IDと契約hashを持つversion 2 intent/reportを作る。未指定時はversion 1証跡を維持する。要求本文は実行証跡へ複製しない。

`--approval`、`--trust-policy`、`--host-signing-key`を三つとも指定するとversion 3署名modeになる。一部だけの指定はdispatch前に拒否する。承認署名、発行時policy、host roleを検証し、承認とpolicyの正確なbytesを証跡へ保持して、Ed25519の`execution-attestation.json`をreport公開後に作る。

`module audit-execution`は要求契約付きversion 2または3証跡を対象に、bundle、要求契約、intent、transcript、reportのidentity/hash chain、grant上限、binding、terminal statusを再検査する。version 3では外部から指定した現行policyだけをtrust rootとし、同梱した発行時policy、承認者・host署名、rotation/revocation、policy ruleも検査する。Wasm、生成TypeScript、adapter、networkは実行しない。署名は自然言語の意味や業務的正しさを証明しない。

`attest-audit`は自己完結した監査directoryを再検査し、全file hashと監査状態を監査者鍵で署名した新規packageを作る。`verify-attestation`はbundleと要求、三つの署名、全hash、role、現行policy ruleをofflineで再検査する。package内のpolicyを現在のtrust rootへ昇格させない。

`module recover-execution`はlive ownerがいない未完了directoryだけを処理し、hash chainを検査してresponseのないrequestを`certainty: "unknown"`とした終了1のreportを作る。operationの再送、Wasmの再開、file commitは行わない。version 3では`recovery-incomplete`を署名し、reportだけが残った場合はreportを変更せず`recovery-after-report`署名だけを補完する。version 1/2の既存report拒否は維持する。

`approve-requirements`と`execute`へ`--trust-boundary <boundary.json>`を加えると、boundaryを要求承認へ固定したexecution version 4を使用する。boundary指定時はrequirements、approval、trust policy、host signing keyをすべて必要とする。version 4は`trust-data-boundary.json`と`static-provenance.json`を証跡・監査・最終packageへ含める。

```sh
bun run llang module explain-attestation <module-build.json> \
  --requirements <effects-requirements.json> \
  --package <attestation-package> \
  --trust-policy <current-policy.json> \
  --out-dir <new-summary-directory> --json
```

`explain-attestation`はfull-chain検証に成功したpackageだけから、`attestation-summary.json`、`attestation-summary.md`、検査済み`program.inspection.ts`を新規directoryへ出力する。LLM、Wasm、projection、adapter、network、credentialを実行せず、外部data本文や秘密値をsummaryへ複製しない。

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

## package、verify、inspect

```sh
bun run llang package <source.llang.jsonc> --request <request.json> --suite <tests.json> --metadata <metadata.json> --out-dir <new-directory>
bun run llang verify <new-directory/capability.json>
bun run llang inspect <new-directory/capability.json> --json
bun run llang inspect <new-directory/capability.json> --out-dir <inspection-directory> --json
```

metadataは`id/release/purpose/useWhen/doNotUseWhen`。request・Source・metadataのIDと契約の整合を要求する。パッケージはrequest/source/build/wasm/testsの5 roleを持ち、JSONC原文を保持する。Resolution Lockは含まない。

packageの成功出力は`manifest/packageHash/verification:"not-run"/acceptance:"not-run"/apiCalls:0`。作成だけではテスト合格と表示しない。

verifyは自己完結したパッケージを読み、各file hashと契約・成果物の対応を照合してWorkerでsuiteを実行する。reportは`status/results/requirements/coverage/diagnostics`等と、`requestRevision/suiteHash/sourceHash/programHash/artifactHash`を持つ。`acceptance`は`not-run`のままで、外部SAAAの受け入れ・配備は実行しない。

inspectは同じreaderで整合性を確認したsnapshotから、要求・契約・成果物hash・要求とcaseの対応・自己完結したTypeScript判定をまとめる。`--out-dir`なしではファイルを書かず、指定時はパッケージ外部の存在しないディレクトリへ`program.inspection.ts`と`inspection.json`を保存する。既存ディレクトリ、パッケージ内、symlinkである出力親は拒否する。生成TSは契約適合入力向けであり、runtimeの入力検査を複製しない。inspectはsuite、Wasm、生成TSを実行せず、意味一致・安全性・配備可否を証明しない。真正性には`packageHash`と外部の信頼値との照合が別途必要である。

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
