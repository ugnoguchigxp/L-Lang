# 汎用言語化・第三弾 実装結果

実施日：2026-09-18。対象 profile：`module-collection-v1`。

## 実装した範囲

- source version 4、build manifest version 3、suite version 3、ABI
  `llang-collection-memory-v1` を旧版と分離して追加した。
- 型付き `List<T>`、値を返す `set`/`append`、`map`/`filter`/`fold`、
  bottom-up stable merge sort を共通 IR と参照評価器へ実装した。
- `let` 再束縛、`while`、snapshot `for-of`、`break`/`continue`、直接・
  相互再帰、論理 call-depth/fuel を実装した。
- 明示型引数の generic 関数・型 alias、安定した単相化 key、
  polymorphic recursion 拒否を追加した。
- 明示 signature の lambda、callback、immutable capture、返却 closure、
  関数 wire/List 格納拒否を追加した。
- TypeScript/JSONC reader、再生成 JSONC、自己完結 TypeScript emitter、
  build/test/verify/CLI dispatch を追加した。
- List descriptor codec は canonical empty、alignment、bounds、payload
  overlap、nested List/string、総要素数を検査する。
- レビュー後の hardening として、plain data object／未知 field／lone
  surrogate／不正な書込領域を ABI 境界で拒否し、wire 上限判定を実 ABI
  encoding と一致させた。
- manifest と suite の exact-key、件数、path、target/artifact 対応、期待値
  wire 型を検証し、公開 JSON Schema にも同じ制約を反映した。
- TypeScript frontend の `llang:core` import を明示必須にし、生成コードの
  match fallthrough、arena 事前確保、Unicode／wire-size 検査を修正した。
- `examples/module-order-batch/` と module smoke に全TS、全JSONC、混在
  2方向を追加した。4構成は同じ `programHash` になる。

## 固定した上限

| 項目 | 値 |
| --- | ---: |
| List要素数 | 4,096 |
| 入出力List総要素数 | 16,384 |
| 入出力wire | 各256 KiB |
| 文字列 | 16 KiB UTF-8 |
| 呼出しarena | 4 MiB |
| memory | initial=max=128 pages |
| fuel | 1,000,000 |
| call depth | 64 |
| 型引数 / capture | 8 / 16 |
| 単相化instance / closure定義 | 1,024 / 256 |

## 検証

開始時の Bun は指定 1.4.2 ではなく 1.3.14 だった。同環境で変更前の
module/value 局所試験は 20 pass / 0 fail。collection の targeted test、
4 frontend 構成、全 target build、source/compiler を削除した portable
verify を追加した。

最終確認では全体 535 pass / 0 fail、coverage は functions / lines ともに
既存の90%閾値を維持した。`format:check`、`lint`（error 0）、
`typecheck`、`ci:docs`、`ci:protected`、`ci:smoke`、`bun audit`、
`git diff --check` も成功した。Ubuntu/Windows CI はこのローカル実行では
未確認である。

## 実装上の注記

Wasm artifact は import-free の固定 ABI shell と、hash で認証した lowered
executable contract を組み合わせる。現段階の collection runtime は codec
通過後に Wasm の `evaluate` export と status を検証し、この sealed
contract を host 側の決定的 evaluator で実行する。
したがって、直接 Wasm 命令へ lower する旧 value emitter と実装方式が
異なる。外部から見た ABI、portable verify、資源・fault oracle は固定した
が、collection 本体の native Wasm lowering は未完了である。

## 第四弾開始時のnative補完（2026-09-18）

上記の未完了事項は第四弾 PR-0A/0B 相当で補完した。新しい build manifest
version 4 / ABI `llang-collection-native-v1` は旧shell版と明確に区別される。
配布runtimeから参照評価器のimportとsealed executable contractを除去し、
List、loop、再帰、単相化call、closure、fault、fuelをWasm内で実行する。
portable verifyはsource/compiler/evaluatorなしでnative artifactを実行する。
旧version 3 artifactをnativeとして推測して読むことはない。
