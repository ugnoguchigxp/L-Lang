# 汎用言語化・第四弾 実装結果

実施日：2026-09-18。状態：**完了**。

## 完了した範囲

- collection shellをimport-free native Wasmへ置換した。build manifest version
  4 / ABI `llang-collection-native-v1` を旧shell版と分離し、配布runtimeから
  参照評価器依存とexecutable contractを除去した。
- List、loop、再帰、generic call、closure、checked i32、fuel、call-depth、
  nested payload promotionをWasm命令へlowerした。旧shell ABIは専用legacy
  runtimeだけで明示的に扱い、native runtimeでは拒否する。
- immutable bytes、分割UTF-8、checked i64、有限f64、scale 0–18 decimal、
  i128中間値、toward-zero／half-even丸めを実装した。
- version/signature付きhost registry、推移的effect checker、dispatch時grant
  再検査、共有resource ledgerを実装した。
- session/task/generation/sequence request ID、重複・未知・遅延応答拒否、
  deadline優先、取消、redacted transcript、世代付きresource handle、逆順
  cleanupを実装した。
- structured task、join順序、fault時兄弟取消、bounded pull stream、
  temporary/session regionとfree-list再利用を実装した。
- local file adapter、一般HTTP adapter、system/virtual clockを追加した。HTTPは
  許可originに加えて名前解決結果を検査し、public addressは利用可能、private・
  loopback・link-local等は明示CIDR許可が必要で、選択IPを接続へ固定する。
  file temporary pathはdevice/inodeをcommit/abort直前にも確認し、再帰削除を
  行わない。Nodeで排除できない検査後の敵対的path置換raceは制限として残す。
- import-free `start/resume/cancel/dispose` Wasm継続ABI、固定event wire、
  portable build/replay、effects smokeを追加した。
- `module-effects-v1`のJSONCと制限付きTypeScript frontend、CLI
  lint/build/test/verify、TypeScript/JSONC/Wasm出力、version 5 portable manifest
  を追加した。旧線形i32形式を互換入力として維持し、typed graph形式を追加した。
- bytes／i64／有限f64／decimal、record、Listを扱う共通typed effect IRと
  canonical wire codecを追加した。Wasmの`typed-wire-v1`は型tag、payload領域、
  state、generation、sequenceを検査し、複数awaitを型を保ったまま再開する。
- await、task join、bounded pull streamをstate種別としてWasmへlowerした。
  taskは共有ledger下で同時実行しspawn順にjoinする。streamは一つずつpullし、
  chunk数・chunk byte・累積byte上限とproducer closeを適用する。
- source-levelの`file`／`http` nodeを予約済みの型付きoperationへcompileし、
  Wasmに埋め込んだcanonical requestをLocalFileAdapter／HttpAdapterへ接続した。
- 複数module import graphを依存順に検査し、全TS、全JSONC、TS→JSONC、
  JSONC→TSの4構成をTypeScript／JSONC／Wasmの3targetへbuildした。生成TS実行、
  生成JSONC再compile、Wasm実行、manifest verifyをmatrix testで照合した。
- typed suite replayをCLI testへ統合し、operation、version、request、response、
  最終値をcanonical型表現のまま比較する。
- Wasmのrequestをregistry、grant、共有resource ledger、redacted transcript、
  取消可能なhost executorへ接続する統合runtimeを追加した。
- file pull、分割UTF-8、typed NDJSON、最大4並行、decimal、temporary file
  commitを通す縦断exampleを追加した。

実装済みruntime APIの仕様は
[`LLANG_MODULE_EFFECTS_SPEC.md`](./LLANG_MODULE_EFFECTS_SPEC.md)を参照する。

## 最終検証結果

実装証跡revision `1e77ea98ac57004f710d26ccd998a0e341e4cb9e`をBun 1.4.2で
検証した。[GitHub Actions run 35316448284](https://github.com/ugnoguchigxp/L-Lang/actions/runs/35316448284)では、Ubuntu／macOS／Windowsのtestとoffline CLI smoke、Ubuntuのaudit、format、lint、文書link、typecheck、coverage、protected input検査がすべて成功した。

- test：121 files、600 pass、0 fail
- coverage：functions 92.96%、lines 92.42%。設定済みthresholdを維持
- `bun audit`：vulnerability 0
- `bun run ci:smoke`：Semantic、JSONC、module、effectsのoffline smoke成功
- 証跡採取時のworktree：commit・push済み、`main`と`origin/main`が同期

## E01〜E16 証跡対応表

各IDは表内の単一ファイルだけで完結するという意味ではない。主要な境界・負例の入口と、全体を同一revisionで実行した上記CIを対応付ける。

| ID | 確認済みの内容 | 主な自動テスト |
| --- | --- | --- |
| E01 | native-only collection、旧shell拒否、portable Wasm | [`llang-module-collection.test.ts`](../src/llang-module-collection.test.ts)、[`llang-effects-build.test.ts`](../src/llang-effects-build.test.ts) |
| E02 | bytes境界、base64、分割UTF-8、EOF不正列 | [`llang-effects-values.test.ts`](../src/llang-effects-values.test.ts)、[`pipeline.test.ts`](../examples/module-io-pipeline/pipeline.test.ts) |
| E03 | i64、有限f64、decimal、丸めとoverflow | [`llang-effects-values.test.ts`](../src/llang-effects-values.test.ts)、[`llang-effects-ir.test.ts`](../src/llang-effects-ir.test.ts) |
| E04 | operation版・signature・型・effect・grant不一致 | [`llang-effects-runtime.test.ts`](../src/llang-effects-runtime.test.ts)、[`llang-module-effects-graph.test.ts`](../src/llang-module-effects-graph.test.ts) |
| E05 | root／symlink境界、HTTP origin・解決IP・redirect拒否 | [`llang-io-file-adapter.test.ts`](../src/llang-io-file-adapter.test.ts)、[`llang-io-http-adapter.test.ts`](../src/llang-io-http-adapter.test.ts) |
| E06 | 複数await、未知・重複・遅延応答、偽造state | [`llang-effects-session.test.ts`](../src/llang-effects-session.test.ts)、[`llang-effects-state-machine.test.ts`](../src/llang-effects-state-machine.test.ts) |
| E07 | 取消、deadline、完了競合、取消後dispatch拒否 | [`llang-effects-session.test.ts`](../src/llang-effects-session.test.ts)、[`llang-effects-runtime.test.ts`](../src/llang-effects-runtime.test.ts) |
| E08 | cleanup逆順、二重close、cleanup失敗の分離 | [`llang-effects-session.test.ts`](../src/llang-effects-session.test.ts)、[`llang-effects-concurrency.test.ts`](../src/llang-effects-concurrency.test.ts) |
| E09 | file commit／abort、HTTP retryなし、未確定結果 | [`llang-io-file-adapter.test.ts`](../src/llang-io-file-adapter.test.ts)、[`llang-io-http-adapter.test.ts`](../src/llang-io-http-adapter.test.ts) |
| E10 | task上限、join順、兄弟取消、共有予算 | [`llang-effects-concurrency.test.ts`](../src/llang-effects-concurrency.test.ts)、[`llang-effects-state-machine.test.ts`](../src/llang-effects-state-machine.test.ts) |
| E11 | pull stream、EOF、背圧、途中失敗 | [`llang-effects-concurrency.test.ts`](../src/llang-effects-concurrency.test.ts)、[`pipeline.test.ts`](../examples/module-io-pipeline/pipeline.test.ts) |
| E12 | region再利用、await生存値、stream累積上限 | [`llang-effects-concurrency.test.ts`](../src/llang-effects-concurrency.test.ts)、[`llang-effects-state-machine.test.ts`](../src/llang-effects-state-machine.test.ts) |
| E13 | fuel、byte、request、memory境界とfault分類 | [`llang-effects-session.test.ts`](../src/llang-effects-session.test.ts)、[`llang-effects-state-machine.test.ts`](../src/llang-effects-state-machine.test.ts) |
| E14 | fixture replay、権限再検査、transcript redaction | [`llang-effects-runtime.test.ts`](../src/llang-effects-runtime.test.ts)、[`llang-effects-build.test.ts`](../src/llang-effects-build.test.ts) |
| E15 | 4 source構成×3 target、再compile、portable verify | [`llang-module-effects-graph.test.ts`](../src/llang-module-effects-graph.test.ts)、[`llang-module-effects-build.test.ts`](../src/llang-module-effects-build.test.ts) |
| E16 | manifest／ABI改変拒否、旧profile・replay回帰 | [`llang-effects-contract.test.ts`](../src/llang-effects-contract.test.ts)、[`llang-module-effects-cli.test.ts`](../src/llang-module-effects-cli.test.ts) |

## 運用後に評価する項目

次はPhase 4の未実装ではなく、代表的な利用期間を必要とする運用証跡として保留する。

- SAAAで実処理を流した後のsoak testとcapability check
- ローカル利用を越えてTLS接続を配備するときの実ネットワーク試験
- workload、入力規模、観測期間を固定した性能・memory回収の長期測定

短時間のcorrectness suiteやloopback成功から、これらの結果を推定しない。現段階の利用範囲はローカル実行と明示grant下のadapterであり、観測結果が得られた時点で本書とは別の運用証跡を追加する。
