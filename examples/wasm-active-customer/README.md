# Wasm版active-customer

既存の意味解決済みLockからWasmを作り、Bunから呼び出す例です。プロジェクトルートで実行します。

```bash
bun install --frozen-lockfile
bun run wasm build examples/active-customer/semantic.ts --out-dir artifacts/wasm/active-customer
bun run wasm run artifacts/wasm/active-customer/manifest.json --input examples/wasm-active-customer/input.json
bun run examples/wasm-active-customer/run.ts artifacts/wasm/active-customer/manifest.json
```

JSON入力の結果は`{"result":true}`、利用例の結果は`[true,false,false]`です。空文字のemailはpresent、nullとundefinedはabsentです。

## 有効なLockがない場合

Wasm buildはLLMを呼ばず、`LOCK_MISSING`または`LOCK_STALE`で終了します。このリポジトリのfixtureから準備する場合は、次の既存コマンドを使えます。これはテスト用の解決結果であり、LLMの意味理解を実証する操作ではありません。既存TS生成物とLockを更新するため、fixture検証用checkoutで行ってください。

```bash
bun run semantic build examples/active-customer/semantic.ts --fixture examples/active-customer/openai-response.fixture.json
```

## アプリケーションから使う

```ts
import { loadWasmPredicate } from "../../src/wasm-runtime";

const predicate = await loadWasmPredicate("artifacts/wasm/active-customer/manifest.json");
const accepted = predicate.evaluate({
  status: "active",
  deletedAt: null,
  email: "customer@example.com",
});
```

handleを再利用してください。evaluateごとにinstanceを生成しません。runtimeはBinaryen・TypeScript Compiler API・LLMを読み込みません。現時点では独立したnpm packageではなく、リポジトリ内のBun用APIです。

配布単位は`manifest.json`と、その`file`が示すhash名の`.wasm`です。Sourceは実行先に不要ですが、runtimeのソースとその依存ファイルは必要です。ManifestとWasmに埋め込んだABI契約hashを照合します。これは整合性確認であり、配布者の認証ではありません。本コンパイラで作った信頼済み成果物が対象です。

入力はown data propertyを持つ通常のrecordです。不正な型、余分なproperty、getter、必須property欠落を拒否します。必須のemailには明示的なundefinedを渡せますが、JSONにはundefinedがないためAPIで指定します。生のWasm exportを直接呼んだ場合の不正入力は保証対象外です。

## 制限と互換性

初期profileはトップレベルのboolean・closed enum・nullish状態だけを操作します。string内容の比較、number、配列、nested record、I/O、メモリ操作は対象外です。生成した関数はmemory・GC・RCを必要としませんが、ホストとコンパイラのメモリ確保までなくすものではありません。

旧Lockの整合性を維持するため、ビルドでは既存TS rendererによるhash照合をメモリ内で行います。TSファイルの出力・tsc・TS判定関数の実行は行わず、Wasmの命令はPredicate IRから直接生成します。

## 測定と削除

```bash
bun run src/wasm-benchmark.ts artifacts/wasm/active-customer/manifest.json
```

探索測定はTS版、同じ入力検証を加えたTS版、adapter込みWasmを比較します。環境負荷で変動するため単一結果を速度保証には使いません。

出力はGit管理外の`artifacts/`に保存します。自動キャッシュや自動削除はありません。Manifest更新前の旧hashファイルは残るため、不要になった出力ディレクトリを利用者が削除し、上記buildで再生成できます。

詳細は[コンセプト](../../docs/WASM_COMPILER_CONCEPT.md)と[実装計画](../../docs/WASM_POC_IMPLEMENTATION_PLAN.md)を参照してください。
