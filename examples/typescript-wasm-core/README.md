# npm依存のない型付きTypeScript → Wasm

計算と非同期処理を、それぞれ既存のCollection／Effects profileへ変換する例です。
元のTypeScriptをコンパイル時に実行せず、型・処理を検査したIRからWasmを生成します。

## 計算・配列・オブジェクト・関数・反復

[`program.ts`](./program.ts)は、相対importしたinterface、入れ子のオブジェクト、
`number[]`、添字アクセス、`length`、`filter`／`map`、関数呼び出し、`let`、
`for`、`break`／`continue`、`+=`を使用します。npm依存はありません。

リポジトリルートから、未作成の出力先を指定してください。

```sh
mkdir -p artifacts
bun run llang module build program.ts \
  --root examples/typescript-wasm-core --entry evaluate \
  --profile module-collection-v1 --target all \
  --out-dir artifacts/typescript-wasm-core
```

`typescript/program.generated.ts`、正規化したJSONC、`wasm/program.wasm`、
hashと型契約を記録した`module-build.json`を生成します。

追加した配列表記は`T[]`、`Array<T>`、`ReadonlyArray<T>`、`readonly T[]`です。
`for (const value of values)`の要素型は、読み取り済みの型付きソースから推論します。
`reduce`は明示した初期値を必須とし、callbackの引数・戻り値には型を記述します。
`for`の初期化は型付きの`let`／`const`一つ、更新は局所変数の代入・`++`／`--`・
`+=`／`-=`／`*=`／`/=`／`%=`に対応します。`while`も使用できます。

このprofileの`number`は**検査付き32ビット符号付き整数**です。小数は対象外で、
除算はゼロ方向へ切り捨て、overflowとゼロ除算はfaultになります。
添字範囲外も`undefined`ではなくfaultです。配列は永続的なListとして扱い、
要素への代入、`push`、破壊的な`sort`は受け付けません。
関数・局所変数・callbackには明示的な型が必要で、型aliasはrecord／tagged union用です。
詳細は[Collection仕様](../../docs/LLANG_MODULE_COLLECTION_SPEC.md)を参照してください。

## 登録済み操作へのasync／await

[`async.ts`](./async.ts)は、`defineEffects`でmodule名と操作の契約を宣言し、
名前付きの`export async function main(): Promise<string>`から
`await invoke<string>(operationId, version, request)`を呼びます。
操作の応答型とawait先・戻り値の型を検査し、既存の継続状態を持つWasmへ変換します。

```sh
bun run llang module build async.ts \
  --root examples/typescript-wasm-core --entry main \
  --profile module-effects-v1 --target all \
  --out-dir artifacts/typescript-wasm-async
```

この入口は、引数のないentry、逐次await、型付きconst、最後の応答の返却に対応します。
要求はliteralまたは最初のawaitより前に宣言したliteralのconstに限定します。
前の応答から次の要求を組み立てる処理、async内の分岐・反復、任意のPromise処理、
例外、直接の`fetch`／Node API呼び出しは未対応です。
これらを黙って近似せず、コンパイル時に拒否します。
実際のIOは登録済みhost操作が担当し、実行には操作ごとのgrantが必要です。

## 検証

```sh
bun test src/typescript-wasm-core.test.ts src/typescript-async-effects.test.ts
```

計算例は元のTypeScript、参照実行、生成TypeScript、JSONC round-trip、native Wasmを
共通の独立期待値で比較します。非同期例はビルドしたWasmそのものの逐次resume、
生成TypeScript、fixture replay、grant拒否を確認します。

npm・Node標準module・外部ambient declarationの取り込みは対象外です。
計算側の相対importはroot内の明示的な`.ts`／`.llang.jsonc`に限定します。
既存の限定Predicate用`hybrid build-ts`の対応範囲は変更していません。
