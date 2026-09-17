# Hybrid Compiler First Implementation Results

> 分類：本文の日付・基点revision・実行条件に対する結果記録です。過去の数値・未完了事項を現在の全経路へ一般化しません。現在の対応範囲は[ロードマップ](../PROJECT_STATUS_AND_ROADMAP.md)、利用方法は[例の一覧](../examples/README.md)を参照してください。

## Status

2026-09-16、ブランチ`hybrid-compiler`、開始commit`5e160c7`で、
[第一実装計画](./HYBRID_COMPILER_FIRST_IMPLEMENTATION_PLAN.md)のH1
「Restricted TypeScript Predicate Import」を実装した。

この結果が示すのは、限定されたpure Predicateについて、TypeScriptを実行せずに
型と式を既存Predicate IRへ変換し、既存Wasm backendまで意味を保持できることに
限られる。任意のTypeScriptからWasmへの変換、自然言語要求の自動確定、
artifact配布の完成を示すものではない。

## 実装した縦断

今回の経路は次のとおりである。

```text
same-file TypeScript type + restricted export function
  -> TypeScript AST / TypeChecker
  -> TypeSchema
  -> Predicate IR
  -> WasmContract / Wasm Core validation
  -> inspection JSON
```

主な実装は次である。

- [`typescript-source-loader.ts`](../src/typescript-source-loader.ts)：
  tsconfig探索、Program、SourceFile、TypeChecker、diagnosticの共通read-only loader
- [`typescript-predicate-importer.ts`](../src/typescript-predicate-importer.ts)：
  function選択、signature検査、式lowering、Wasm profile検査、hash生成
- [`hybrid-cli.ts`](../src/hybrid-cli.ts)：
  `hybrid inspect-ts`の読み取り専用CLI
- [`can-ship.ts`](../examples/hybrid-order/can-ship.ts)：
  `canShip`と`needsManualReview`の二つの入力例
- [`examples/hybrid-order/README.md`](../examples/hybrid-order/README.md)：
  実行方法、対応構文、拒否範囲

既存[`semantic-source.ts`](../src/semantic-source.ts)も共通loaderを利用するようにした。
既存scannerの入力境界は変更せず、新しいimporterだけがworkspace containment、
symlink拒否、2 MiB上限、tsconfig diagnosticを追加で強制する。

## 対応範囲

初期版は、次を満たすtop-level functionだけを受理する。

- named `export function`
- 同名宣言が一つ
- 一つのidentifier parameterと、同一ファイル内のnamed input type
- 明示された`boolean`戻り値
- 一つの`return` statement
- `&&`、`||`、`!`
- boolean、string literal、`null`との`===` / `!==`
- `value !== null && value !== undefined`によるpresence
- `value === null || value === undefined`によるabsence
- boolean、closed string enum、string presence、optional、`null`、`undefined`

`undefined`は一般のIR literalへ変換せず、nullish pairとしてだけ扱う。生成したIRは
`parsePredicateExpression`へ、型契約は`contractFromType`へ、組み合わせは
`lowerPredicate`へ通す。途中の一部だけを成功として返さない。

次は拒否する。

- arrow function、method、overload、generic、async、generator
- imported input type、number、array、nested record、任意string内容比較
- 複数statement、local variable、複数return
- loose equality、truthiness省略、call、ternary、computed/nested property、optional chain
- workspace外source、source symlink、2 MiBを超えるsource、TypeScript error diagnostic

## 読み取り専用CLI

実行例は次である。

```bash
bun run hybrid inspect-ts examples/hybrid-order/can-ship.ts --function canShip
```

成功時は、source、入力schema、Predicate IR、WasmContract、source hash、semantic hash、
`apiCalls: 0`、`writes: 0`を一つのJSONとしてstdoutへ返す。失敗時は分類済みcodeと
相対path位置をstderrへ返し、非0で終了する。

CLI経路は対象module、model client、network adapter、Lock、Binaryenを読み込まない。
実際のWasm binary生成は行わず、既存Wasm coreへのlowering成功までを検査する。

## 意味一致の検証

[`typescript-predicate-importer.integration.test.ts`](../src/typescript-predicate-importer.integration.test.ts)
では、リポジトリ所有fixtureだけを静的importし、独立したcase tableに対して次を比較した。

1. 手書きのexpected
2. 元のTypeScript function
3. `evaluatePredicateExpression`
4. `emitWasm`と`encodeInput`で実行したWasm

対象には、enumの全値、各条件の不成立、optional欠損、明示的`undefined`、`null`、
空文字、`all`、`any`、`not`、presence、absence、strict inequalityを含めた。
また、`canShip`からキャンセル条件を意図的に除いたIRをcase tableが検出することを
確認した。

importerのテストは、対象sourceをimportしない。元関数の実行比較は、上記の
integration testが所有fixtureを静的importする場合に限定している。

## 決定性と境界

- `sourceHash`はsource textをSHA-256でhashするため、format変更で変わる。
- `semanticHash`はcanonicalな`profile + contract + body`だけから作る。
- 絶対path、mtime、sourceのformatは`semanticHash`へ含めない。
- 同じ意味を別path・別formatに置いたテストで`semanticHash`一致を確認した。
- 外部エラーは`TypeScriptImportError`の固定codeへ分類した。
- 通常の公開messageにはworkspaceの絶対pathを含めないことを確認した。
- importerとCLIはSource、Lock、artifactを書き換えない。

hash実装は、CLIがmodel関連moduleを読み込まないよう、既存のcanonical hash処理を
[`stable-hash.ts`](../src/stable-hash.ts)へ分離した。
[`semantic-fingerprint.ts`](../src/semantic-fingerprint.ts)は従来のexportを維持している。

## 実測した品質Gate

環境はmacOS 26.6.2、Bun 1.3.14、TypeScript 5.9.3、Binaryen 132.0.0である。

| Gate | 結果 |
| --- | --- |
| `bun install --frozen-lockfile` | 成功、dependency変更なし |
| `bun audit` | 成功、脆弱性0件 |
| `bun run format:check` | 成功 |
| `bun run lint` | 成功 |
| `bun run ci:docs` | 成功 |
| `bun run typecheck` | 成功 |
| `bun test` | 成功、389 tests / 80 files |
| `bun run coverage` | 成功、functions 95.24%、lines 92.83% |
| `bun run ci:smoke` | 成功 |
| `bun run ci:protected` | 成功 |
| `git diff --check` | 成功 |

coverage初回は、拒否構文マトリクスが計測時に既定5秒を超えてtimeoutした。
テスト内容を弱めず、そのコンパイラAPIテストだけ15秒の上限を明示し、再実行で
389 testsすべてとcoverage閾値が成功した。

UbuntuとWindowsのCIはこのローカル作業では実行していない。そのため、path表現、
symlink、TypeScript diagnostic位置を含む3 OS成功は未確認である。

## 計画との差分

- canonical hash関数を直接`semantic-fingerprint.ts`からimportするとmodel関連moduleも
  読み込むため、依存のない`stable-hash.ts`へ処理を抽出し、既存APIをre-exportした。
- 共通loaderには`includeConfigDiagnostics`を設けた。新importerでは有効にし、
  既存semantic scannerでは従来挙動を保つため無効のままにした。
- `hybrid inspect-ts`はWasm binaryを出力しない。BinaryenをCLI境界へ持ち込まず、
  実バイナリとの一致はintegration testで確認した。

新規dependency、Wasm ABI、Predicate IR、Resolution Lock、Build Manifestは変更していない。

## 未実施と次の判断

未実施事項は次である。

- Ubuntu / Windows CIでの確認
- imported type、arrow function、method、nested property、numberへの対応
- JSON Schema / Zod /短い仕様書の生成
- natural-language Requirement Contractとの結合
- imported PredicateのLock、Manifest、artifact保存
- SAAAやCoding Agentからの自動作成・更新

次の実装は、このrestricted importerを実プロジェクトへ一度適用し、必要な型と構文を
観測してから決める。再利用・配布が先に必要ならprovenance付きartifact化を、
TypeScript以外のfrontendや型差が先に問題になるならCanonical Type IR v1を優先する。

外部project固有の型要求がまだ与えられていないため、型の対応範囲を広げずに
Frontendとbackendの境界を固定する
[第二実装計画](./HYBRID_COMPILER_SECOND_IMPLEMENTATION_PLAN.md)を次の候補とする。
