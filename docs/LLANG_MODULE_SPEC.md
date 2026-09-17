# L-Lang typed modules Phase 1

`module-bool-v1` は、boolean と必須 boolean field だけを持つ平坦な record、型付き純粋関数、相対 named import を提供する。JSONC source は `language: "l-lang"`, `version: 2`, `kind: "module"`, `profile: "module-bool-v1"` で識別する。公開schemaは `schemas/llang-module-v2.schema.json` にある。

## Source and type rules

- source は `.ts` または `.llang.jsonc`。root内の明示拡張子付き相対importだけを許可する。
- 1 moduleに複数のrecord型と関数を宣言できる。export/privateを区別し、import aliasを必須とする。
- 関数は0〜8引数、boolean戻り値、単一式。entryだけはrecord一引数からbooleanを返すexport関数である。
- 式はliteral、parameter、field、`not`、短絡する`all`/`any`、boolean `equals`、direct `call`。
- module cycle（type-onlyを含む）とcall cycleは別々に拒否する。構造的record型はfield集合の完全一致であり、width subtypingはない。
- TypeScript frontendはnamed import、flat type alias、named function、単一returnだけを読む。sourceを実行せず、tsconfig、ambient declaration、package resolutionを参照しない。

## Snapshot, hashes, and outputs

entryから到達する最大64 moduleを一度読み、raw bytesとpathをsnapshotに固定する。生成後に全source hashを再確認し、差替えは `SOURCE_CONFLICT` として公開を中止する。`sourceSetHash` はpathとraw hash、`programHash` は検査済み論理program、`interfaceHash` はentry signatureを表す。

buildは新しい出力directoryだけを使用し、manifestを最後に配置する。出力は次の三種類である。

- `typescript/program.generated.ts`: 全関数を一つに束ね、入力検査付き `evaluate` を公開する。
- `jsonc/**/*.llang.jsonc`: 全moduleを正規化して再生成する。build中に再読込し、program/interface hash一致を検査する。
- `wasm/program.wasm`: internal functionとdirect callを持つstateless Wasm。外部exportは `evaluate` 一つである。

manifestは `format: "llang-module-build", version: 1`。portable verifyはmanifest、全artifact hash、Wasm ABI、固定suiteを検査し、sourceやcompilerを必要としない。署名や第三者由来コードのsandboxを意味しない。

## CLI

```text
bun run llang module lint <entry> --root <root> --entry <export> --json
bun run llang module build <entry> --root <root> --entry <export> --target typescript|jsonc|wasm|all --out-dir <new-dir>
bun run llang module test <entry> --root <root> --entry <export> --suite <suite.json> --json
bun run llang module verify <module-build.json> --suite <suite.json> --json
```

`module test` はreference evaluator、生成TypeScript、JSONC round-trip、Wasmを同じsuiteで実行する。suite形式は `schemas/llang-module-suite-v1.schema.json`、縦断例は `examples/module-access/` を参照する。終了値は0=成功、1=source診断または期待値不一致、2=引数・I/O・実行障害である。

## Explicit non-goals

再帰、closure、高階関数、数値、配列、nested record、局所変数、代入、反復、例外、IO、package import、暗黙拡張子、re-exportはPhase 1に含めない。Predicate v1のenum/nullish機能は既存経路に残り、module graphへ暗黙変換しない。
