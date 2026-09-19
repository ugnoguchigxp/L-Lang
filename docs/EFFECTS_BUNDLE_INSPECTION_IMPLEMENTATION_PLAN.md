# Effects BundleをTypeScriptで事後検査する実装計画

作成日: 2026-09-19。状態: 実装済み（EBI1〜EBI12確認済み）。前段は[要求付きWasmパッケージの事後検査](./CAPABILITY_INSPECTION_IMPLEMENTATION_PLAN.md)です。

## 目的

`module-effects-v1`の移動可能なbuild bundleについて、宣言された外部操作、effect、資源上限、継続状態、TypeScript表現、Wasm成果物の対応を、実行せずに確認できるようにします。

前段のCapability v2 inspectは、外部I/Oのない`predicate-i32-v1`を対象に、要求・契約・判定処理を結び付けました。次段では、すでに実装されているtyped effects graphへ対象を広げます。ただし、effects bundleには自然言語要求、実行時grant、credential、実行transcriptが含まれません。この計画で確認できるのは、bundle内に固定された処理・操作要求・成果物の対応までです。

この順序を選ぶ理由は次のとおりです。

- `module-effects-v1`には、型付きfile/HTTP操作、await、task、stream、資源上限、Wasm継続ABIがすでにある。
- defaultの`--target all` bundleには、同じchecked graphから導出されたJSONC、TypeScript、Wasmがある。
- 同梱JSONCを再検査し、TypeScriptとWasmを再生成してbyte単位で比較すれば、manifestの自己申告だけより強い対応確認になる。
- 実行時grantやtranscriptを扱う前に、静的なbundle検査と実行証跡を分離できる。

## 到達点

利用者は次を実行できます。

```text
bun run llang module inspect <module-build.json> --json
bun run llang module inspect <module-build.json> --out-dir <new-directory> --json
```

対象は、version 5、profile `module-effects-v1`、ABI `llang-effects-session-v1`で、`typescript`、`jsonc`、`wasm`の3 targetをすべて含むbundleです。一部targetだけのbundleは、部分的な成功reportを出さず、再build方法を示して終了コード2で拒否します。

`--out-dir`なしではJSONだけを返します。指定時は、元bundle外部の新しいディレクトリへ次を保存します。

```text
effects-inspection.json
program.inspection.ts
```

`program.inspection.ts`は、検査済みの同梱JSONCから再生成したTypeScriptです。同梱`typescript/program.generated.ts`とのbyte一致を確認してから公開します。JSON結果にも同じTypeScript本文を含め、保存の有無で情報量を変えません。

コマンドはWasmをinstantiate・実行せず、生成TypeScriptをimport/evalせず、adapter、外部API、ネットワーク、credentialを使用しません。成功はbundle内部の整合と決定的な再生成が確認できたことを意味し、実行成功、権限付与、要求充足、安全性、発行者の真正性を意味しません。

## 現状と不足

| 項目 | 現在の実装 | 今回埋める不足 |
| --- | --- | --- |
| bundle reader | `readEffectsModuleBuildManifest`がmanifest、artifact path、bytes、hash、Wasm contractを厳格に検査 | 人間向けの一つの検査reportがない |
| JSONC projection | build時にchecked graphをflattenして同梱する | bundleから再検査して正本との対応を示すAPIがない |
| TypeScript projection | build時に`EffectsHost`を使う自己完結したTypeScriptを生成・型検査する | 同梱TSがJSONC/Wasmと一致することをinspect時に再確認しない |
| Wasm | typed graphから`typed-wire-v1`の継続Wasmを生成し、manifestへcontractとstateを保存する | 同梱JSONCから再生成したWasmとのbyte一致をinspect reportへまとめない |
| operation/effect | operation signature、effect集合、state、resource上限をmanifestが保持する | 外部操作と内部task join、宣言と権限の違いを人間向けに整理しない |
| grant | hostが実行時に独立して与え、bundleへ埋め込まない | 「宣言されたeffect＝許可済み」と誤読しない表示が必要 |
| transcript | linear runtimeにはredacted transcriptがあるが、typed graphのportable bundle inspectとは別責務 | 今回は生成せず、未提供と明示する |

## 実装内容

### 1. Effects bundleの検査snapshot

`src/llang-effects-bundle-inspection.ts`を追加します。独自のmanifest parserは作らず、最初に`readEffectsModuleBuildManifest`を使って全artifactを検査済みbytesとして取得します。

検査開始時に次を要求します。

- `format: llang-module-build`
- `version: 5`
- `profile: module-effects-v1`
- `abi: llang-effects-session-v1`
- targetsが`typescript`、`jsonc`、`wasm`の3件
- typed Wasm contractが`typed-wire-v1`
- JSONCとTypeScriptがstrict UTF-8

bundle identityは、検査済みmanifestのcanonical objectと、manifestに記録された全artifact hashから`fingerprintFor`で導出します。絶対path、読取時刻、乱数、出力先は含めません。これは署名ではなく、同じ検査対象を識別する派生hashです。

検査結果の構築後、公開直前に既存readerでbundle全体を再読し、bundle identityが同一であることを確認します。変更、削除、symlink化、reader errorがあればreportを公開しません。敵対的な環境で将来の不変性を保証するものではありません。

### 2. 同梱JSONCからの決定的な再構築

`src/llang-module-effects-graph.ts`の既存parse/check処理を、検査済みbytesから単一のflattened graphを構築できる小さなin-memory APIとして共有します。ファイルを再読する専用loaderや、検査用の別parserは作りません。

再構築は次の順序で行います。

1. artifact map内の`jsonc/program.llang.jsonc`をparseする。
2. importが空で、entry/module、operation定義、result type、nodeが有効なflattened graphであることを検査する。
3. interfaceHashをmanifestと比較する。
4. 既存emitterからTypeScriptを再生成し、同梱TS bytesおよびartifact hashと比較する。
5. `emitTypedEffectsWasm`でWasmを再生成し、Wasm bytes、wasmHash、loweredHash、contract、state一覧を比較する。
6. 再生成TSを固定compiler optionsで型検査する。

Binaryenは固定済み`132.0.0`と現行emitterを使います。最適化passや設定は追加せず、ABI、features、memory、imports、exportsを変更しません。`module.validate()`や`WebAssembly.validate()`だけを意味一致の証拠にはせず、現行emitterによる決定的なbyte再生成を比較します。Binaryen moduleは例外時にもdisposeします。

元graphの`programHash`はsource inventoryを含むため、複数sourceをflattenしたJSONCを再読した際の`programHash`とは一致しません。これを失敗条件にしません。元の追跡値としてmanifestの`programHash`を保持し、再構築の一致判定には、source配置に依存しない`interfaceHash`、`loweredHash`、TypeScript bytes、Wasm bytes、contract/stateを使います。この前提は実装前の代表fixtureで確認します。

元の複数source本文はbundleに含まれず、manifestにはpathとhashだけが残ります。そのため、source inventoryは表示しますが、元sourceを再構築・再検査済みとは表示しません。flattened JSONCから同じ成果物を再導出できた範囲だけを`checked-by-regeneration`とします。

### 3. TypeScript inspection projection

graph向けの既存TypeScript emitterを`src/llang-module-effects-build.ts`のprivate実装から、副作用のない共有関数へ分離します。build出力はbyte単位で維持します。

projectionには次を残します。

- literalなtyped effects definition
- await、task、streamのnode順序
- operation IDとversion
- request payload
- `EffectsHost.invoke`境界
- entryの戻り値

projectionは「bundleに記録された処理」を示しますが、host adapterの実装、credential注入、DNS検査、atomic file commit、grant、deadline、resource ledgerの全挙動を複製しません。これらはreportのruntime boundaryに列挙します。

要求文や外部データをコメント・識別子・式として追加しません。同梱JSONC中の値は既存のliteral emitterでescapeします。inspect本体はprojectionをimportまたは実行しません。

### 4. report契約

reportはversion付きとし、少なくとも次を含めます。

| 区分 | 内容 |
| --- | --- |
| 識別 | format/version、profile、ABI、entry、bundleIdentityHash |
| source追跡 | sourceSetHash、source path/hash inventory、元source本文は未同梱であること |
| 意味識別 | programHash、loweredHash、interfaceHash、resultType |
| 外部操作 | operation ID/version/signatureHash/effect、effect集合 |
| 継続状態 | state index、await/task/stream、対応operation。task joinは内部同期でありhost grantではないこと |
| 資源 | manifestのmemoryPages、wireBytes、chunkBytes、hostRequests、tasks、fuel |
| 成果物 | JSONC/TS/Wasmのpath、bytes、hash、Wasm contract、toolchain |
| 再構築 | JSONC parse/check、interface、TS byte、TS typecheck、Wasm byte、contract/stateの各結果 |
| TypeScript | projection version、本文、UTF-8 bytes hash、同梱artifact hash |
| 実行境界 | execution:`not-run`、runtimeGrant:`not-provided`、transcript:`not-provided`、credentials:`not-accessed`、apiCalls:0 |
| 制約 | integrity/authenticity/semantic scope、元source未検査、host runtime未検査 |

`declaredEffects`、`requiredOperations`、`runtimeGrant`を別fieldにします。manifestのoperation要求は権限ではありません。file root、HTTP origin/method/header、wall clock許可などを推測しません。

artifactの再生成一致は、固定された現行compiler/emitterが同梱JSONCから同じbytesを作ったことを表します。任意の別compilerとの一般的な意味等価性、自然言語要求との一致、外部hostの正しさ、発行者の真正性は表しません。

### 5. CLIと安全な出力

`src/llang-cli.ts`の`module`分岐へ`inspect`を追加します。許可するoptionは`--out-dir`だけです。共通の`--json`処理を維持し、未知、重複、値欠損、余分な位置引数を終了コード2で拒否します。

保存処理は前段のCapability inspectionと同じ安全条件を満たします。

- 出力先は存在しない新規directoryだけ。
- realpathでbundle内部への出力を拒否。
- symlink出力親を拒否。
- directoryのdevice/inode identityを公開中に確認。
- `program.inspection.ts`を先に排他的に作成。
- TS hashを含む`effects-inspection.json`を最後に排他的に公開。
- 失敗時は、自分が作成しidentityが変わっていないdirectoryだけを削除。
- 置換されたdirectoryや既存利用者ファイルを削除しない。

前段と完全に同じ処理になる部分は、小さな内部helperへ抽出してよいものとします。ただし、既存Capability inspectのreport契約や出力名を変更せず、一般化のための大規模リファクタは行いません。

## 検証と受け入れ条件

| ID | 検証 | 合格条件 |
| --- | --- | --- |
| EBI1 | `module-io-pipeline`相当を`--target all`でbuildしてinspect | operation/effect/resource/state/hashとTS本文がreader・manifest・artifactに一致 |
| EBI2 | bundleを別directoryへ移動 | JSON、TS、bundleIdentityHash、projectionHashが一致 |
| EBI3 | manifest、JSONC、TS、Wasmを個別改変 | readerまたは再構築比較が拒否し、成功出力を残さない |
| EBI4 | TS本文とmanifest hashを協調改変 | JSONCからのTS再生成との不一致を検出 |
| EBI5 | JSONC、TS、各hashを協調改変してWasmを残す | Wasm再生成との不一致を検出。全成果物を整合する別bundleへ交換した場合はidentity変更として扱い、真正性とはしない |
| EBI6 | await、task、streamを含むtyped graph | stateとoperation対応を保持し、内部task joinを外部権限と表示しない |
| EBI7 | file/HTTP/clock/host操作 | 宣言effectとruntime grantを分離し、path/origin権限を捏造しない |
| EBI8 | hostile-looking文字列、引用符、改行、`__proto__`を含むpayload | JSON/TS literalとして保持し、コメントや実行式へ昇格しない |
| EBI9 | inspectの実行境界 | WebAssembly instantiate、Worker、fetch、file/HTTP adapter、生成TS importを一度も呼ばない |
| EBI10 | target不足、旧version、別profile、linear compatibility bundle | 部分成功せず終了2。既存`module verify`の対応範囲は変更しない |
| EBI11 | bundle・出力の差し替え、symlink、既存出力、書込失敗 | 成功扱いせず、bundleと所有していない出力を変更・削除しない |
| EBI12 | CLI誤用と既存module/Capability inspect回帰 | JSON error、終了値、helpが契約どおり。既存コマンドの出力が変わらない |

EBI4/EBI5はhashだけでは検出できない協調改変に対し、再生成比較が実際に機能することを確認します。一方、JSONC、TS、Wasm、manifestをすべて別の内部整合するbundleへ交換した攻撃は、外部の信頼hashや署名なしには真正性を判定できません。この限界をテスト名とreportから隠しません。

## 主な変更先

- 新規: `src/llang-effects-bundle-inspection.ts`
- 新規: `src/llang-effects-bundle-inspection.test.ts`
- 更新: `src/llang-module-effects-graph.ts`（in-memoryの単一flattened graph検査API）
- 更新: `src/llang-module-effects-build.ts`または小さなemitter module（graph projectionの共有）
- 更新: `src/llang-cli.ts`、`src/llang-cli.test.ts`
- 更新: `src/llang-effects-smoke.ts`
- 更新: `docs/LLANG_CLI_REFERENCE.md`、`docs/LLANG_MODULE_EFFECTS_SPEC.md`
- 更新: `examples/module-io-pipeline/README.md`

既存manifest version、Wasm ABI、operation signature、resource limits、adapter、grant contract、suite形式、凍結済みbenchmarkは変更しません。新規依存も追加しません。

## 実施順序

1. 現行`--target all` bundleのJSONC/TS/Wasm bytes、hash、toolchain、関連テストを基準として固定する。
2. flattened JSONCをartifact bytesだけから検査できるin-memory APIを抽出し、既存file loaderと同じ結果になることを確認する。
3. graph TypeScript emitterを共有し、既存build出力のbyte不変テストを通す。
4. JSONCからTS/Wasmを再生成して全対応を比較するinspection APIとreportを実装する。
5. 排他的な保存処理とCLIを接続し、改変・競合・非実行境界を検証する。
6. 文書、example、smokeを更新し、指定Bun版で品質Gateを実行する。

## 品質Gate

局所検証は少なくとも次を含めます。

```sh
bun test src/llang-effects-bundle-inspection.test.ts src/llang-module-effects-build.test.ts src/llang-module-effects-graph.test.ts src/llang-module-effects-cli.test.ts --timeout 30000
bun run ci:docs
git diff --check
```

最終検証は指定Bun 1.4.2で行います。

```sh
bunx bun@1.4.2 run check
bunx bun@1.4.2 run ci:docs
bunx bun@1.4.2 run ci:protected
bunx bun@1.4.2 run ci:smoke
```

coverageとUbuntu/macOS/Windowsは既存CIに従います。ローカル成功、coverage、各OS CIを区別して報告します。Binaryen `132.0.0`、TypeScript `5.9.3`、compiler `0.1.0-dev.1`を実際のmanifest・lockfileと再照合し、測定していない性能・memory改善を主張しません。

## 対象外と後続計画

今回の対象外は次のとおりです。

- 自然言語要求をeffects graphへ新たに結び付けるCapability形式。
- 実行時grant、credential、file root、HTTP originをbundleへ埋め込むこと。
- 実adapterを使ったfile/HTTP実行。
- typed graphの実行transcript形式と永続化。
- transcriptとbundle、grant、resultの署名・attestation。
- 任意Wasmの逆コンパイル、第三者compilerとの一般的な等価性証明。
- 人間参加者による理解度・調査時間の評価。
- 新しい最適化pass、ABI、manifest version、operation schema。

この実装後の次候補は、hostが実際に与えたgrantとredacted transcriptを、bundle identityおよび実行結果へ結び付ける[Effects実行証跡](./EFFECTS_EXECUTION_EVIDENCE_IMPLEMENTATION_PLAN.md)計画です。その段階では、typed runtimeでのtranscript取得、credential非記録、失敗・取消・cleanup・unknown outcome、署名主体と保存期間を先に設計します。静的inspectの成功を実行証跡の代用にはしません。

## 完了報告で示すもの

- EBI1〜EBI12の結果。
- 生成した`effects-inspection.json`と`program.inspection.ts`の例。
- JSONC、TypeScript、Wasm、contract/stateの再生成一致結果。
- inspectが実行・grant付与・外部I/Oを行っていない証拠。
- Bun、TypeScript、Binaryen、OS、実行コマンド。
- coverage・3 OS CIの実施状況。
- 元source未同梱、runtime grant/transcript未提供、真正性未証明という制約。

「effects実行の安全性を証明した」「要求と外部操作が正しい」「実際の権限と操作履歴を確認した」とは報告しません。
