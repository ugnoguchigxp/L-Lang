# Hybrid TypeScript Predicate Import

`can-ship.ts`は、TypeScriptの型と制限された判定式を、Canonical Type IRと
Predicate IRへ整理し、同じ契約からWasm入力契約、JSON Schema、短い実装仕様を
投影する最小例です。

```bash
bun run hybrid inspect-ts examples/hybrid-order/can-ship.ts --function canShip
bun run hybrid inspect-ts examples/hybrid-order/can-ship.ts --function needsManualReview
```

このコマンドは対象moduleを実行せず、TypeScript ASTとTypeCheckerだけを読みます。
ファイル、Lock、Wasm binaryは書き込みません。結果の`apiCalls`と`writes`は常に0です。

成功結果の`input.canonicalType`が型の共通表現です。`input.mapping.status`は
TypeScript型を意味を落とさず変換できたかを示します。`projections.jsonSchema`と
`projections.specification`は、この共通表現と判定IRから機械的に生成されます。

検査結果を再現可能なartifactとして保存する場合は、次を実行します。

```bash
bun run hybrid build-ts examples/hybrid-order/can-ship.ts \
  --function canShip \
  --out artifacts/hybrid/can-ship

bun run hybrid verify-artifact artifacts/hybrid/can-ship/artifact.json
bun run hybrid verify-artifact artifacts/hybrid/can-ship/artifact.json --rebuild
```

portable verificationは、保存済みsource、TypeScript profile、Canonical Type IR、
Predicate IR、JSON Schema、仕様表示、Wasmのhash chainと実行境界をread-onlyで検査します。
`--rebuild`は現在のTypeScript／Wasm toolchainで全projectionとWasm bytesを再生成し、
一致を確認します。

artifact buildは新規directoryだけへ公開し、既存artifactを上書きしません。初期版は
一つのsource snapshotで閉じるため、import、reference directive、module augmentationを
含むsourceをartifact化しません。source module自体はbuild、verifyのどちらでも実行されません。

この例では`cancelled`と`holdReason`が明示的な`undefined`を許します。一方、JSONには
`undefined`がないため、JSON Schema projectionは失敗せず
`status: "requires-host-adapter"`を返します。これは欠損と`undefined`を同一視する
指定ではありません。完全な入力検査にはWasm実行アダプター側の契約も必要です。

初期版が扱う式は、`&&`、`||`、`!`、boolean・string literal・`null`との
strict equality / inequality、および次のnullish判定です。

```typescript
value !== null && value !== undefined
value === null || value === undefined
```

関数は、同じファイルに入力型を持つtop-levelのnamed `export function`で、
引数一つ、明示的な`boolean`戻り値、一つの`return`だけに制限されます。
call、local variable、nested/computed property、optional chain、number、array、
generic、overload、importされた入力型は拒否されます。
入力型がimport由来のalias、base interface、mapped typeを推移的に含む場合や、
call・construct・index signatureを持つ場合も、losslessなrecordとは扱わず拒否します。

生成されるMarkdownは`Implementation-derived specification`です。現在の実装を
確認するための表示であり、業務要求への適合や要求の正しさを証明するものでは
ありません。

artifactのportable／rebuild verificationは技術的な自己整合性と再現性を確認するもので、
業務要求への適合、Semantic Test、acceptanceを実行したことにはなりません。
