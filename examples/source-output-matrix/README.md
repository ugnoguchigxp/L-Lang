# TypeScript / JSONC → TypeScript / Wasm

同じ「enabledかつ非suspended」という条件を、二つのソース形式から二つの成果物形式へ変換します。従来のTypeScript補完例とは別に、ビルド・配備・実行までを確認する入口です。

| ソース | TypeScript成果物 | Wasm成果物 |
| --- | --- | --- |
| `predicate.ts` | `typescript-to-typescript/predicate.generated.ts` | `typescript-to-wasm/predicate.wasm` |
| `predicate.llang.jsonc` | `jsonc-to-typescript/predicate.generated.ts` | `jsonc-to-wasm/predicate.wasm` |

## 実行

リポジトリルートから、未作成の出力先を指定します。親の`artifacts`がなければ先に作成してください。Bun 1.4.2、インストール済みの依存を使用します。API認証は不要です。

```sh
mkdir -p artifacts
bun run examples:matrix artifacts/source-output-matrix
bun artifacts/source-output-matrix/jsonc-to-wasm/consumer.js '{"enabled":true,"suspended":false}'
bun artifacts/source-output-matrix/typescript-to-typescript/consumer.js '{"enabled":true,"suspended":true}'
```

順に`{"value":true}`、`{"value":false}`を返します。各`*-to-*`ディレクトリは単体で別の場所へコピーできます。配備先に必要なのはBunと、そのディレクトリにある`consumer.js`・`release.json`・成果物です。コンパイラ・node_modules・元リポジトリは不要です。TypeScript成果物は配備先のBunが読み込みます。

runner自体も成果物を別ディレクトリへコピーし、ビルド作業ディレクトリを削除してから、別プロセスで実行します。4通りすべてに独立した4件の真理値表と3件の不正入力を適用します。成果物のhash不一致は実行前に拒否します。hashは署名ではなく、TypeScript成果物は信頼した発行元のものだけを実行する前提です。

## 比較結果

`comparison.json`には、ソースbytes、変更前の`predicate.before.*`との差分行数、生成物bytes、consumer bytes、parse/build時間、10,000回の実行時間、環境とhashを記録します。要求変更は「enabledのみ」から「enabledかつ非suspended」です。JSONCには契約や説明も含むため、文字数差だけで形式の優劣は決めません。

これは単一のローカル実行であり、統計的な速度評価ではありません。時間にはwarmupや実行順序の影響があります。人の編集時間、実モデルの成功率や費用は測っていません。

## 範囲

標準の限定Predicate IR、既存のTypeScript importerとWasm compilerを再利用しています。TypeScript生成の型はこの例の二つのbooleanに限定しています。汎用TypeScript↔JSONC変換や、全出力形式を選ぶ共通CLIではありません。JSONCそのものの生成・修正は[JSONC例](../jsonc-enabled-user/README.md)、要件変更後の配備・切戻しは[ライフサイクル例](../capability-lifecycle/README.md)を参照してください。
