# Binaryen: API と実装

読みどころ: emitter の変更、最適化設定の導入、バージョン更新時。

## まず対象を特定する

- [Predicate emitter](../../../src/wasm-emitter.ts)と[WasmCore](../../../src/wasm-core.ts): 定数・比較・not・all・any。確認時点で `module.optimize()` は呼ばない。
- [Module emitter](../../../src/llang-module-wasm.ts): 関数定義・呼び出しを含む別経路。Predicate の制約だけで判断せず、対象 IR と verifier を読む。確認時点で `module.optimize()` は呼ばない。
- [ソート用 compiler](../../../examples/wasm-json-sort/compiler.ts): 配列・ループ・memory を使う実験用テンプレート。製品 profile の機能ではない。

これらは 2026-09-17 の作業ツリーを確認した案内。実際の変更時には再確認する。

## 必要な API だけ確認する

ローカルで次のように検索し、該当宣言と呼び出し周辺を読む。

```sh
rg -n 'binaryen' package.json bun.lock
rg -n 'optimize\(|runPasses|[gs]etOptimizeLevel|[gs]etShrinkLevel' node_modules/binaryen/index.d.ts
rg -n 'optimize\(|runPasses|setFeatures|emitBinary|validate' src/wasm-emitter.ts src/llang-module-wasm.ts
```

インストール先や lockfile が違う場合は、その環境で解決されたパスを使う。型定義にある `runPasses(string[])` は任意のパス名が有効である保証にはならない。

固定版の参照: [Binaryen version_132](https://github.com/WebAssembly/binaryen/tree/version_132)、[JS API 型定義](https://github.com/WebAssembly/binaryen/blob/version_132/src/js/binaryen.d.ts)、[パス登録](https://github.com/WebAssembly/binaryen/blob/version_132/src/passes/pass.cpp)。必要な識別子だけ検索する。

## 設定を変えるときの原則

- optimize level と shrink level を別々に明示する。`O2` という表示だけで実設定を推測しない。
- JS API の設定はモジュールごとではない。変更前を取得し `finally` で戻す。復元だけでは並行変更の競合を防げないため、設定から最適化・復元までは直列化するか、独立した実行環境に分離する。
- `module.validate()` と `WebAssembly.validate()` は構造検査。意味の同値や速度の改善を証明しない。
- profile の features、imports、状態、exports、契約 custom section を保つ。生成後の verifier でも確認する。
- パス順・設定・ツールバージョンを成果物記録と再実行経路へ反映する。既存 manifest が設定を受け付けるか先に調べる。
- `module.dispose()` は例外時も実行する。

検証は変更した emitter に対応するテスト、型検査、成果物 verify / replay を選ぶ。性能を変更理由にする場合は[測定資料](optimization.md)へ進む。
