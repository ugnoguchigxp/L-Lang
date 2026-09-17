# 汎用言語化・第四弾 実装途中結果

実施日：2026-09-18。状態：**中間到達点（第四弾未完了）**。

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
- local file adapter、loopback限定HTTP adapter、system/virtual clockを追加した。
  Nodeで保証できない敵対的なwrite path置換raceは対応済みと表示せず、仕様へ
  制限を記録した。
- import-free `start/resume/cancel/dispose` Wasm継続ABI、固定event wire、
  portable build/replay、effects smokeを追加した。
- file pull、分割UTF-8、typed NDJSON、最大4並行、decimal、temporary file
  commitを通す縦断exampleを追加した。

## 未完了のため第四弾完了としない範囲

- `module-effects-v1` のTypeScript/JSONC frontend、共通typed effect IR、
  source version 5の公開schema。
- bytes/i64/f64/decimal、await、task、streamを含む汎用programの
  TS/JSONC/Wasm三経路lowering。現在の継続Wasmは固定i32 eventの基盤実装。
- file/HTTP operationをWasm programから型付きrequestとして発行する完全な
  compiler統合、credential付き一般network adapter。
- 4 source構成×3 target、CLI `--profile module-effects-v1`、suite全matrix。
- Ubuntu/Windowsを含むE01〜E16の全vectorと同一revisionの証跡。

これらが残るため、IO・非同期・数値・並行・streamが「全targetで動く」とは
まだ主張しない。実装済みruntime APIの仕様は
[`LLANG_MODULE_EFFECTS_SPEC.md`](./LLANG_MODULE_EFFECTS_SPEC.md)を参照する。

## 検証結果

macOS arm64、Bun 1.3.14で次を確認した。計画で指定したBun 1.4.2、Ubuntu、
Windowsの同一revision検証は未実施であり、第四弾の完了証跡には数えない。

- `bun install --frozen-lockfile`: 変更なし
- `bun test`: 114 files、568 pass、0 fail
- `bun run format:check`: pass
- `bun run lint`: pass（既存を含むwarningあり、errorなし）
- `bun run typecheck`: pass
- `bun run ci:docs`: pass
- `bun run ci:protected`: pass
- `bun run ci:smoke`: pass
- `bun run coverage`: 114 files、568 pass、0 fail、93.38% functions、
  92.10% lines、threshold pass
- `bun run verify`: 568 pass、0 fail、verification completed
- `bun audit`: vulnerability 0
- `git diff --check`: pass

縦断exampleは最終lint修正後にも単独再実行し、2 pass、0 failを確認した。
