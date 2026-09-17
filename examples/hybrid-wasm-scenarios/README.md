# Progressive Hybrid TypeScript → Wasm demos

このディレクトリは、制限されたTypeScript PredicateをCanonical Type IRと
Predicate IRへ変換し、再現可能なWasm artifactとして実行する例を、難易度順に
並べたデモです。LLM、API key、対象TypeScript moduleの実行は必要ありません。

## まず全シナリオを実行する

```bash
bun run hybrid:demo
```

runnerは各シナリオについて次を実行します。

1. TypeScriptの型と関数を静的にimportする。
2. source、Canonical Type IR、Predicate IR、JSON Schema、仕様、Wasmを含むartifactを作る。
3. hash chainとWasm境界をportable verifyする。
4. 現在のtoolchainで再生成し、Wasm bytesまで一致することをrebuild verifyする。
5. Wasm runtimeでcase tableを評価する。
6. 一時artifactを削除する。

成功時は、artifact／semantic／Wasm hashと全caseの結果をJSONで表示します。
一つだけ実行する場合はscenario IDを渡します。

```bash
bun run hybrid:demo 03-nullable
bun run hybrid:demo 06-business-rule
```

## 難易度

| Level | Scenario | 主題 | Case数 |
| ---: | --- | --- | ---: |
| 1 | `01-boolean` | 必須booleanとstrict equality | 2 |
| 2 | `02-enum` | closed string unionとOR | 4 |
| 3 | `03-nullable` | 欠損、`undefined`、`null`、存在する文字列 | 5 |
| 4 | `04-safe-default` | optional booleanとstrict inequality | 4 |
| 5 | `05-composite` | booleanとenumによるAND／OR／NOT | 4 |
| 6 | `06-business-rule` | 支払い、在庫、保留、キャンセルを組み合わせた出荷判定 | 6 |
| 7 | `07-unicode` | Unicode enumとoptional nullable enum | 5 |

Level 3では空文字列も「存在する値」です。Level 4では`blocked`が欠損、
`undefined`、`false`の場合を許可し、明示的な`true`だけを拒否します。
このようなJavaScript／TypeScriptの値状態の差を、Wasm adapterまで保持できるかを
case tableで確認しています。

## artifactを残して調べる

runnerはデモ後に一時artifactを削除します。生成物を残して中身を見る場合は、
通常のHybrid CLIを直接使います。出力先は存在しないディレクトリを指定してください。

```bash
bun run hybrid inspect-ts \
  examples/hybrid-wasm-scenarios/06-business-rule/can-ship-order.ts \
  --function canShipOrder

bun run hybrid build-ts \
  examples/hybrid-wasm-scenarios/06-business-rule/can-ship-order.ts \
  --function canShipOrder \
  --out artifacts/hybrid-demos/can-ship-order

bun run hybrid verify-artifact \
  artifacts/hybrid-demos/can-ship-order/artifact.json

bun run hybrid verify-artifact \
  artifacts/hybrid-demos/can-ship-order/artifact.json \
  --rebuild
```

artifactには次が含まれます。

- `source.ts`: exact source snapshot
- `typescript.json`: 固定TypeScript profile
- `resolution.json`: Canonical Type IRとPredicate IR
- `schema.json`: JSON Schema projection
- `specification.md`: 実装から生成した短い仕様表示
- `build.json`: compiler、ABI、hashの対応
- `<wasm-hash>.wasm`: importやmemoryを持たないWasm predicate
- `artifact.json`: 全ファイルを結ぶmanifest

## 回帰テスト

```bash
bun run hybrid:demo:test
```

テストは7シナリオ・30ケースについて、build、portable verify、rebuild verify、
Wasm実行を確認します。個々のhash値を固定せず、hash形式と再現性の検証結果を
確認するため、意図したcompiler更新を不必要に妨げません。

## 現在の境界

このデモは`predicate-i32-v1`でlosslessに扱える範囲に限定しています。
flat record、boolean、closed string enum、文字列の存在状態、`null`、`undefined`、
`&&`、`||`、`!`、strict equality／inequalityを扱います。

number、array、nested record、任意文字列値の比較、関数呼び出し、local variable、
computed property、optional chain、loop、async、importされた入力型は対象外です。
対応外の入力を近似してWasm化せず、明示的なerrorとして拒否します。
