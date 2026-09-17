# Hybrid Compiler 第一実装計画

- 作成日：2026-09-16
- ブランチ：`hybrid-compiler`
- 基点：`5e160c7`
- 状態：計画。未実装
- 上位文書：[Hybrid Compiler Concept](./HYBRID_COMPILER_CONCEPT.md)
- 対象：H1 `Restricted TypeScript Predicate Import`

計画作成時の局所baselineは、Bun 1.3.14で`semantic-source`、`wasm-core`、`wasm.integration`の18テストが成功、失敗0件だった。これは実装前の比較点であり、第一実装の完了証拠ではない。

## 1. 実装開始点の決定

最初の実装単位は、**既存のpureなTypeScript Predicateを、TypeScript Compiler APIで読み取り、現在のPredicate IRへ変換し、既存Wasm backendで実行できることを確認する読み取り専用の縦断**とする。

```text
限定されたTypeScript function
  ↓ parse・型検査。ソースは実行しない
TypeSchema + Predicate IR
  ↓ 既存のcontractFromType / lowerPredicate
WasmContract + WasmCore
  ↓ 既存のemitWasm
memory・importなしのWasm
```

初回からCanonical Type IR全体、複数言語、SAAA連携、Lock形式を再設計しない。現在もっとも不確実なのはWasm生成ではなく、**TypeScriptの表現を意味変更なしに既存IRへ取り込める範囲を定義し、対応外を確実に拒否できるか**である。

この縦断を先に選ぶ理由は次のとおり。

- Predicate IRからWasmを生成・実行する経路はすでに存在する
- TypeScript Compiler APIによる型抽出もすでに存在する
- 既存コードをHybrid Compilerへ移行する入口はまだ存在しない
- importerの成功・失敗から、Canonical Type IRに本当に必要な情報を具体化できる
- LLM、provider credential、SAAA、配備環境なしで決定的に検証できる
- 小さな変更でFrontend → IR → Backendの全境界を確認できる

## 2. 今回の完了像

次のようなTypeScriptファイルを入力できる。

```typescript
export type Order = {
  paymentStatus: "paid" | "pending" | "failed";
  inventoryStatus: "reserved" | "unavailable";
  status: "open" | "on-hold" | "cancelled";
  email?: string | null;
};

export function canShip(order: Order): boolean {
  return (
    order.paymentStatus === "paid" &&
    order.inventoryStatus === "reserved" &&
    order.status !== "on-hold" &&
    order.status !== "cancelled" &&
    order.email !== null &&
    order.email !== undefined
  );
}
```

library APIが、ソースを実行せずに次を返す。

```typescript
type ImportedTypeScriptPredicate = {
  version: 1;
  profile: "predicate-i32-v1";
  source: {
    file: string;
    functionName: string;
    sourceHash: string;
  };
  input: {
    parameterName: string;
    typeName: string;
    schema: TypeSchema;
  };
  body: PredicateExpression;
  contract: WasmContract;
  semanticHash: string;
};
```

読み取り専用CLIで結果を確認できる。

```bash
bun run hybrid inspect-ts examples/hybrid-order/can-ship.ts \
  --function canShip
```

CLIはJSONを標準出力へ返す。Source、Lock、生成済みTypeScript、Wasm artifactは書き換えない。Wasm artifactの保存・配布は次の計画へ残し、今回はintegration test内で既存emitterを使ってin-memoryで生成・実行する。

完了時に確認する一続きの経路は次である。

```text
TS function
  ↓
Imported Predicate IR
  ↓
reference evaluator
  ↓
Wasm emitter / ABI adapter
  ↓
independent expected casesと一致
```

## 3. 今回検証する仮説

### H1-A：限定TypeScriptは既存IRへ損失なく変換できる

strict equality、boolean junction、否定、nullish presenceに範囲を絞れば、既存の`all`、`any`、`not`、`equals`、`present`へ対応付けられる。

### H1-B：TypeScript型を既存Wasm contractへ再利用できる

同一ファイル内のnamed record typeを既存`buildTypeSchema`と`contractFromType`へ渡し、boolean、closed enum、string presence、null、undefined、optionalを保持できる。

### H1-C：対応外コードを意味変更なしに拒否できる

関数呼び出し、loop、async、coercive equality、nested property、number、任意string比較等を、近いIRへ推測変換せず明示的に拒否できる。

### H1-D：importerはコード実行なしで成立する

TypeScript moduleを`import()`せず、ASTとTypeCheckerだけで変換できる。元関数との比較実行は、リポジトリが所有するfixtureをテストが静的importする場合に限定する。

## 4. Scope

### 実装するもの

- TypeScript sourceとtsconfigの読み取り
- 指定されたexport functionの一意な選択
- named input typeの抽出
- TypeSchemaの生成
- 制限式からPredicate IRへのdeterministic lowering
- IR parserとWasm profileによる再検証
- source hashとsemantic hash
- 読み取り専用library API
- JSONを返す`hybrid inspect-ts` CLI
- 二つ以上の異なるPredicateによる局所・統合テスト
- 元TypeScript、IR evaluator、Wasm、独立期待値の比較
- 利用例と実装結果文書

### 今回実装しないもの

- 任意のTypeScript / JavaScriptコンパイル
- arrow function、function expression、method、class
- imported type、generic、overload
- local variable、複数statement、複数return
- nested property、optional chaining、computed property
- number、array、tuple、nested record
- 任意文字列比較、正規表現、locale処理
- loop、再帰、function call、closure
- exception、async、Promise、I/O、副作用
- L-Lang Sourceの自動生成・昇格
- Requirement IDや自然言語仕様の推測生成
- Resolution LockやBuild Manifestの新形式
- Wasm artifactの保存・配布
- SAAA、Coding Agent、live modelとの接続
- Canonical Type IR全体の再設計
- 新規dependency

## 5. 先に固定する入力契約

### 5.1 Source境界

- 対象はworkspace root内の`.ts`ファイルとする
- 対象sourceに最も近い`tsconfig.json`を使用する
- TypeScriptのerror diagnosticが一件でもあれば失敗する
- source textは2 MiBを上限とし、`SEMANTIC_LIMITS`へ専用値を追加して検査する
- `resolveContainedFile(..., { rejectSymbolicLinks: true })`を使い、symlinkとworkspace外pathを拒否する
- importerはファイルを一切変更しない

### 5.2 Function境界

初期版で受理するfunctionは次をすべて満たす。

- top-levelのnamed `export function`
- CLI/APIでfunction名を明示指定
- 同名overloadがない
- `async`、generator、genericではない
- parameterは一つ
- parameterはidentifierであり、destructuringではない
- optional、rest、initializer付きparameterではない
- parameter型は同じsource file内のnamed type aliasまたはinterface
- 明示された戻り値型が`boolean`
- bodyは一つの`return` statementだけを持つ
- return expressionが存在する

inferred return type、arrow function、importされたtypeは、初期範囲を意図せず広げないため拒否する。

### 5.3 Type境界

入力型は既存`predicate-i32-v1`と同じ範囲とする。

- top-level data record
- boolean
- string literalからなるclosed enum
- 一般stringは存在状態だけを観測
- `null`、`undefined`、optional

次は拒否する。

- number
- 任意stringの内容比較
- object nesting
- array、tuple、index signature
- getter、method、call signature
- branded/intersection type
- conditional / mapped / template literal type
- class instance

`buildTypeSchema`が表現できてもWasm profileが表現できない型は、`contractFromType`で成功扱いにせず`UNSUPPORTED_TYPE`とする。

## 6. 先に固定する式のlowering規則

受理するexpression grammarを次に限定する。

```text
Expression := Parenthesized
            | Expression && Expression
            | Expression || Expression
            | !Expression
            | Property === Literal
            | Literal === Property
            | Property !== Literal
            | Literal !== Property
            | PresentPattern
            | AbsentPattern

Property   := parameter.identifier
Literal    := boolean | string literal | null
```

対応表は次のとおり。

| TypeScript | Predicate IR | 条件 |
| --- | --- | --- |
| `a && b` | `all(a, b)` | 両辺が対応式 |
| `a \|\| b` | `any(a, b)` | 両辺が対応式 |
| `!a` | `not(a)` | operandが対応式 |
| `p === literal` | `equals(p, literal)` | strict equalityのみ |
| `literal === p` | `equals(p, literal)` | propertyを左へcanonicalize |
| `p !== literal` | `not(equals(...))` | strict inequalityのみ |
| `literal !== p` | `not(equals(...))` | propertyを左へcanonicalize |
| `p !== null && p !== undefined` | `present(p)` | 同じproperty。順序逆も許可 |
| `p === null \|\| p === undefined` | `not(present(p))` | 同じproperty。順序逆も許可 |

`undefined`は一般LiteralとしてIRへ入れない。上記のpresence / absence pattern全体としてだけ認識する。

次は明示的に拒否する。

- `==`、`!=`
- truthy / falsy coercion
- `Boolean(x)`等のcall
- property単体によるboolean省略記法
- `in`、`instanceof`、`typeof`
- ternary、nullish coalescing
- arithmetic、bitwise operation
- optional chaining
- object/array literal
- template literal
- parameter以外をrootとするproperty access
- `parameter.field.subfield`

初期版は短いが機械的に説明できる変換表を優先する。便利な省略記法は、必要性と意味保持を個別に検証してから追加する。

## 7. APIとエラー契約

### 7.1 Library API

新規候補`src/typescript-predicate-importer.ts`に次のAPIを置く。

```typescript
export async function importTypeScriptPredicate(input: {
  workspaceRoot: string;
  sourcePath: string;
  functionName: string;
}): Promise<ImportedTypeScriptPredicate>;
```

処理順序は固定する。

1. workspace containmentと入力サイズを検査する
2. tsconfigを読み、ProgramとTypeCheckerを作る
3. TypeScript error diagnosticsを拒否する
4. 対象functionとsignatureを検査する
5. input typeからTypeSchemaを作る
6. return expressionをPredicate IRへloweringする
7. `parsePredicateExpression`でnode数・深さ・未知keyを再検査する
8. `contractFromType`と`lowerPredicate`で現行Wasm profileへの適合を検査する
9. source hash、semantic hash、inspection結果を返す

`semanticHash`は絶対path、format、mtimeを含めず、canonicalな`profile + contract + body`から計算する。`sourceHash`はsource textそのものから計算し、format変更を検出する。既存`fingerprintFor` / `stableJson` / `sha256`を再利用する。

### 7.2 Error

新規`TypeScriptImportError`は、少なくとも次のcodeを持つ。

- `SOURCE_OUTSIDE_WORKSPACE`
- `SOURCE_TOO_LARGE`
- `TSCONFIG_NOT_FOUND`
- `TYPESCRIPT_DIAGNOSTIC`
- `FUNCTION_NOT_FOUND`
- `AMBIGUOUS_FUNCTION`
- `UNSUPPORTED_SIGNATURE`
- `UNSUPPORTED_SYNTAX`
- `UNSUPPORTED_TYPE`
- `INVALID_IR`

messageにはsource位置を`relative/path.ts:line:column`形式で含める。絶対path、source全文、stack traceを通常のJSON出力へ含めない。

Wasm側の`WasmError`をそのまま外部契約に流さず、import段階のcodeへ分類する。元errorは開発時のcauseとして保持してよい。

### 7.3 CLI

新規候補`src/hybrid-cli.ts`とpackage scriptを追加する。

```json
{
  "scripts": {
    "hybrid": "bun run src/hybrid-cli.ts"
  }
}
```

初期commandは一つだけとする。

```bash
bun run hybrid inspect-ts <source.ts> --function <export-name>
```

成功時はinspection JSONをstdoutへ一件出力する。

```json
{
  "version": 1,
  "profile": "predicate-i32-v1",
  "source": {
    "file": "examples/hybrid-order/can-ship.ts",
    "functionName": "canShip",
    "sourceHash": "..."
  },
  "input": {
    "parameterName": "order",
    "typeName": "Order",
    "schema": {}
  },
  "body": {},
  "contract": {},
  "semanticHash": "...",
  "apiCalls": 0,
  "writes": 0
}
```

失敗時はstderrへcodeと短いmessageを出し、非0で終了する。CLIはmodel、network、Lock、Binaryenを読み込まない。Wasm互換性は`contractFromType`と`lowerPredicate`までで確認し、実バイナリ生成はintegration testへ分離する。

## 8. 変更対象

### 新規候補

| ファイル | 責務 |
| --- | --- |
| `src/typescript-source-loader.ts` | tsconfig、Program、SourceFile、TypeCheckerの読み取り専用生成 |
| `src/typescript-predicate-importer.ts` | signature検査、式lowering、hash、結果型 |
| `src/typescript-predicate-importer.test.ts` | grammar、型、診断、決定性の局所テスト |
| `src/typescript-predicate-importer.integration.test.ts` | 元TS・IR・Wasm・期待値の比較 |
| `src/hybrid-cli.ts` | `inspect-ts`のstrict CLI |
| `src/hybrid-cli.test.ts` | 引数、JSON、終了code、書込みなしの確認 |
| `examples/hybrid-order/can-ship.ts` | 対応範囲を示す入力例 |
| `examples/hybrid-order/README.md` | 実行方法、対応構文、非対応範囲 |
| `docs/HYBRID_COMPILER_FIRST_IMPLEMENTATION_RESULTS.md` | 実装後の結果、差分、未実施事項 |

### 変更候補

| ファイル | 変更 |
| --- | --- |
| `src/semantic-source.ts` | Program読込処理を共通loaderへ委譲。既存挙動は変えない |
| `src/semantic-limits.ts` | TypeScript source用の2 MiB上限を追加 |
| `package.json` | `hybrid` scriptを追加。dependencyは増やさない |
| `docs/HYBRID_COMPILER_CONCEPT.md` | 実装結果が出た後だけstatusと参照を更新 |

`context-validator.ts`、`ir.ts`、`wasm-core.ts`、`wasm-emitter.ts`の表現力は今回広げない。既存APIの不足が実装中に判明した場合、まずadapterまたは狭い引数型への切り出しで対応し、全体refactorを行わない。

## 9. 実装順序

### I0：Baselineとfixtureの固定

1. Bun、TypeScript、Binaryen版、対象commit、作業ツリー状態を記録する。
2. 既存のsemantic sourceとWasm局所テストを実行する。
3. `canShip`と、論理構造・型が異なる第二Predicateのfixtureを用意する。
4. 各fixtureの期待結果を実装出力から作らず、独立したcase tableとして固定する。
5. 対応・非対応syntax matrixをテスト名として先に列挙する。

Targeted baseline：

```bash
bun test src/semantic-source.test.ts \
  src/wasm-core.test.ts \
  src/wasm.integration.test.ts
```

完了条件：既存失敗と今回の変更による失敗を区別でき、期待caseを後から実装結果へ合わせて変更しない状態になっている。

### I1：TypeScript source loaderの分離

1. `semantic-source.ts`のtsconfig探索、Program生成、diagnostic収集を小さなread-only helperへ抽出する。
2. `scanSemanticSource`の返却値、診断文、許可範囲を維持する。
3. workspace containmentとsize limitをimporter利用時だけ強制するか、既存scannerにも適用するかを実装前にテストで固定する。既存挙動を無言で狭めない。
4. Windows pathとLF/CRLFで診断位置・relative pathが安定することを確認する。

完了条件：既存semantic source全テストが変更前と同じ結果で通り、loaderを単独で利用できる。

### I2：Function signatureとType Provider

1. 指定名のtop-level export functionを一意に選ぶ。
2. 第5.2節のsignatureを順に検査する。
3. parameterのTypeNodeからTypeScript Typeを取得する。
4. 既存`findTypeDeclaration`と`buildTypeSchema`を再利用する。
5. `contractFromType`でWasm profile外の型を拒否する。
6. source位置付きの分類済みerrorを返す。

完了条件：type aliasとinterfaceの正常例が通り、imported type、number、nested object、generic、overload、arrow functionがそれぞれ意図したcodeで失敗する。

### I3：Expression lowering

1. Parenthesized expressionを透過する。
2. `&&`、`||`、`!`を再帰的にloweringする。
3. strict equality / inequalityをpropertyとliteralへ分解する。
4. property rootとparameter identityを照合する。
5. presence / absence patternは、一般junctionより先に同じpropertyのpairとして認識する。
6. 生成objectを`parsePredicateExpression`へ通す。
7. `lowerPredicate`まで通し、IRとして合法でもWasm profileで表現不能な比較を拒否する。

完了条件：第6節の対応表をすべて局所テストで確認し、近似変換やAST nodeの取りこぼしがない。

### I4：決定性とinspection API

1. sourceHashとsemanticHashを計算する。
2. absolute path、mtime、object keyの偶然の順序をsemanticHashへ含めない。
3. 同じ内容を別directoryへ置いた場合にsemanticHashが一致することを確認する。
4. formatだけを変えた場合はsourceHashが変わり、意味が同じならsemanticHashは一致することを確認する。
5. field declaration orderの扱いは、既存Wasm contractのcanonical sortに合わせる。

完了条件：同一意味のinspection出力とhashが再現し、意味変更ではsemanticHashが変わる。

### I5：三経路の意味一致

リポジトリが所有するfixtureについてだけ、元TypeScript functionをテストから静的importする。importer自身は対象sourceを実行しない。

各独立caseに対し、次を比較する。

1. 固定したexpected
2. 元TypeScript function
3. `evaluatePredicateExpression`
4. `emitWasm` + `encodeInput`で実行したWasm

対象caseは最低限次を含む。

- すべての条件を満たす
- 各条件を一つずつ破る
- enumの全値
- optional fieldの欠損
- explicit `undefined`
- `null`
- 空文字
- `all`、`any`、`not`
- presence / absence
- strict inequality

有限状態のfixtureは全列挙する。期待値を元TypeScriptまたはIRの結果から自動生成しない。

完了条件：すべてのcaseで四つが一致し、意図的に条件を一つ削ったIRをcase tableが検出する。

### I6：CLIと利用例

1. strictな`inspect-ts`引数parserを実装する。
2. stdoutには成功JSONだけを出す。
3. stderrと終了codeで失敗を区別する。
4. API keyを空にした別processで実行する。
5. 実行前後にworkspaceのtracked file hashが変化しないことを確認する。
6. READMEに対応syntax、拒否syntax、Sourceを実行しないことを記載する。

完了条件：利用例をコピーしてinspection JSONを取得でき、正常・異常ともnetwork 0回、writes 0件である。

### I7：全検証と結果記録

1. 局所テストを実行する。
2. 全品質Gateを実行する。
3. macOSだけの結果を他OS成功と表現せず、CIでUbuntu・Windowsを確認する。
4. 実装結果、計画との差分、未実施事項を結果文書へ記録する。
5. 実測後にのみコンセプトの現行対応表を更新する。

完了条件：未実施Gateと既知の制限を残したまま「完了」としない。fixture成功を任意TypeScript対応や実プロジェクト移行成功の証拠としない。

## 10. テスト計画

### 局所テスト

| 境界 | 主なテスト |
| --- | --- |
| source loader | tsconfig欠落、TS error、workspace外、過大source、relative path |
| function選択 | 未発見、同名overload、非export、arrow、method、async、generic |
| signature | parameter数、destructuring、default、rest、imported type、非boolean戻り値 |
| type | boolean、enum、string presence、optional、null、undefined、number、nested object |
| expression | `&&`、`\|\|`、`!`、strict equality、inequality、parentheses |
| presence | null/undefined pair、順序逆、異なるpropertyのpair拒否、片側だけの拒否 |
| unsupported | call、loop、local、ternary、optional chain、computed path、loose equality |
| determinism | path差、改行差、format差、意味変更、field順 |
| Wasm一致 | expected、元TS、IR evaluator、Wasmの比較 |
| side effect | source非実行、network 0、writes 0、tracked file不変 |

### Failure behavior

- importer失敗時にSource、Lock、artifactを変更しない
- 一つでもTypeScript errorがあれば部分IRを返さない
- 対応外syntaxを無視して残りだけ変換しない
- unknown AST nodeをdefault成功へ流さない
- Wasm profile検証失敗をinspection成功として返さない
- CLIのJSON成功出力へwarning textを混ぜない
- diagnosticsを無制限に出力しない

### 全品質Gate

[品質Gate正本](../QUALITY_GATES.md)に従い、実装完了時に次を実行する。

```bash
bun install --frozen-lockfile
bun audit
bun run format:check
bun run lint
bun run ci:docs
bun run typecheck
bun test
bun run coverage
bun run ci:smoke
bun run ci:protected
git diff --check
```

`bun audit`のregistry障害、OS固有CI失敗、timeoutを成功扱いにしない。原因、今回変更との関係、再実行条件を結果文書へ記録する。

## 11. Non-goals、禁止、要相談

### Non-goals

- 第一実装で「TypeScriptからWasmへ一般変換できる」と主張しない
- formatterやrefactoring toolを作らない
- TypeScript sourceから自然言語要求を自動確定しない
- 既存semantic build、prompt、capability CLIの既定動作を変えない
- performance優位を合格条件にしない

### 禁止事項

- 対象TypeScript moduleをimporter内で実行しない
- `transpileModule`の成功だけで型安全とみなさない
- unknown syntaxを`true`、`false`、未検査callへ置換しない
- `any` castでTypeScript Compiler APIの型不一致を隠さない
- loose equalityをstrict equalityとして扱わない
- null、undefined、欠損、空文字を統合しない
- 凍結済みbenchmarkや既存Oracleを今回の結果に合わせて変更しない
- importerのためにWasm IRやABIの対応範囲を同時拡張しない

### 要相談事項

次が必要になった場合は、この計画へ混ぜず、根拠となる入力例と意味を提示して判断する。

- imported typeへの対応
- arrow functionやmethodへの対応
- boolean propertyの省略記法
- nested property
- numberと比較演算
- 任意string比較
- artifact保存と新しいprovenance schema
- Source・Requirement Contractの自動生成
- Canonical Type IRの正式version化
- SAAAへの自動登録・配備

## 12. コミット分割候補

1. `refactor: share read-only TypeScript source loading`
2. `feat: import restricted TypeScript predicates into semantic IR`
3. `test: verify TypeScript IR and Wasm predicate equivalence`
4. `feat: add read-only hybrid compiler inspection CLI`
5. `docs: document the first hybrid compiler vertical slice`

各コミットで対応する局所テストを通す。途中コミットで既存CLIや全体typecheckを壊した状態を前提にしない。

## 13. 完了チェックリスト

- [ ] 対応TypeScript syntaxが表で固定されている
- [ ] Sourceを実行せずに型と式を抽出できる
- [ ] TypeScript error、未対応signature、未対応syntaxを分類して拒否できる
- [ ] TypeSchemaとWasmContractがnullish差を保持する
- [ ] Predicate IRを既存parserとWasm loweringで再検証している
- [ ] 二つ以上の異なるPredicateを同じimporterで扱える
- [ ] expected、元TS、IR evaluator、Wasmが独立caseで一致する
- [ ] 意図的な条件欠落をcase tableが検出する
- [ ] sourceHashとsemanticHashの決定性を確認している
- [ ] CLIがAPI 0回・writes 0件でJSONを返す
- [ ] 失敗時に既存Source、Lock、artifactを変更しない
- [ ] dependencyを追加していない
- [ ] 全品質Gateと3 OS CIの結果を記録している
- [ ] 対応外範囲と次の判断材料を結果文書へ残している

## 14. 完了後の次の判断

第一実装の結果から、次のどちらへ進むかを選ぶ。

### A：artifact化を優先

実プロジェクトでrestricted importの需要が確認できた場合、imported Predicate用のprovenance schema、Resolution、Manifest、保存CLIを設計する。既存Manifestへ意味のないplaceholder hashを入れて流用しない。

### B：Canonical Type IRを優先

TypeScript固有の型差分、別Type Provider、structured outputで現行`TypeSchema`の不足が具体化した場合、Canonical Type IR v1を設計する。利用例のない型を先回りして一般化しない。

SAAA連携、自然言語からのRequirement Contract、Rust等の追加Providerは、この第一縦断の前提条件にしない。Frontend → IR → Wasmの意味保持と拒否境界を確認してから、必要な統合を独立した計画として作る。
