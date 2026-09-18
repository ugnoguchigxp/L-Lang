# 汎用言語化・第四弾 実装結果

実施日：2026-09-18。状態：**機能実装完了、全OSの最終証跡待ち**。

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

## 残る完了証跡

- GitHub Actions上のBun 1.4.2／Ubuntu／macOS／Windows同一revision結果。
- E01〜E16をID別に集約した最終証跡表。個別の境界・負例は実装済みテストに
  分散しているため、CI結果と対応付けて記録する。

実装済みruntime APIの仕様は
[`LLANG_MODULE_EFFECTS_SPEC.md`](./LLANG_MODULE_EFFECTS_SPEC.md)を参照する。

## 検証結果

macOS arm64、Bun 1.3.14で次を確認した。計画で指定したBun 1.4.2、Ubuntu、
Windowsの同一revision検証は未実施であり、第四弾の完了証跡には数えない。
CI matrixにはmacOSを追加し、Ubuntu/macOS/WindowsをBun 1.4.2で実行する設定に
したが、この未push revisionのCI結果はまだ存在しない。

- `bun install --frozen-lockfile`: 変更なし
- `bun test --timeout 30000`: 121 files、593 pass、0 fail
- `bun run format:check`: pass
- `bun run lint`: pass（既存warningあり、今回追加分のwarningなし、errorなし）
- `bun run typecheck`: pass
- `bun run ci:docs`: pass
- `bun run ci:protected`: pass
- `bun run ci:smoke`: pass
- `bun run coverage`: 121 files、593 pass、0 fail、coverage threshold pass
- `bun audit`: vulnerability 0
- `git diff --check`: pass

coverage計測で露呈した5ms wall-clock境界のテストは、agent開始前の上限到達と
agent待機中のdeadline到達という二つの正当な結果を、同じ
`DEVELOPMENT_LIMIT`として検査するよう修正した。修正後のcoverage全実行で上記件数と
threshold合格を確認した。

縦断exampleは最終lint修正後にも単独再実行し、2 pass、0 failを確認した。
