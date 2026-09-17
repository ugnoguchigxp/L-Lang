# Hybrid Compiler Third Implementation Plan

## Status

- 作成日：2026-09-17
- 対象ブランチ：`hybrid-compiler`
- 前提：[第二実装結果](./HYBRID_COMPILER_SECOND_IMPLEMENTATION_RESULTS.md)
- 対象段階：H2.5 `Reproducible Imported Predicate Artifact`
- 実装名：`Hybrid Predicate Artifact v1`
- 状態：実装完了
- 結果：[第三実装結果](./HYBRID_COMPILER_THIRD_IMPLEMENTATION_RESULTS.md)

本計画は、H1/H2で静的に取り込めるようになった制限TypeScript Predicateを、
再現可能で改ざん検出可能なartifactとして保存し、別processからread-onlyで検証できる
第三の縦断を定義する。

この段階では型・式・Wasm ABIの対応範囲を広げない。現在の
`predicate-i32-v1`に対して、Source、Canonical Type IR、Predicate IR、projection、
Wasm bytes、toolchainの対応をhashで固定する。

## 1. 次にartifact化を選ぶ理由

H2までに次のread-only経路は成立した。

```text
TypeScript source
  -> Restricted TypeScript Import
  -> Canonical Type IR + Predicate IR
  -> JSON Schema / implementation specification
  -> WasmContract -> Wasm bytes
```

ただし現在の`hybrid inspect-ts`はinspection結果を標準出力へ返すだけであり、次を
保証する保存形式がない。

- どのsource bytesとfunctionを取り込んだか
- どのCanonical Type IRとPredicate IRへ解決したか
- どのcompiler/backendでWasmを生成したか
- schema、仕様表示、Wasmが同じresolutionから生成されたか
- 保存後にsource、IR、projection、Wasmのいずれかが変更されていないか
- networkや元workspaceなしで、保存済み能力を検査・実行できるか

ここでZodやStructured Outputへ進むと、生成物が増える一方で、それらを同じ契約へ
結び付ける保存境界が未定義のままになる。先にartifact境界を固定することで、後続の
projectionやbackendを同じhash chainへ追加できる。

既存`Capability Package`はPrompt Source、Requirement、Semantic Test、Acceptanceを
前提とする。imported TypeScript Predicateにはそれらが存在しないため、placeholderの
Conceptや要求を捏造して既存packageへ合わせない。初期版は専用artifactとして設計し、
将来Requirement Contractが結び付いた時点でCapability Packageへ昇格できるようにする。

## 2. 仮説

### H2.5-A：一つのresolutionで派生成果物を固定できる

Source hash、function名、Canonical Type hash、Semantic hashを含むstrictな
`HybridImportResolution v1`を保存し、JSON Schema、仕様表示、Wasm buildのすべてが
そのresolutionに由来することを再計算で確認できる。

### H2.5-B：build provenanceをPrompt Sourceから分離できる

既存`WasmManifest`のPrompt固有provenanceへ偽の値を入れず、import専用の
`HybridBuildManifest v1`でresolution hash、contract hash、compiler、backend、options、
Wasm hashを保持できる。

### H2.5-C：artifactをofflineで検査・実行できる

保存済みartifactは、元workspace、TypeScript Compiler API、model、networkなしで、
strict parse、全file hash、manifest間のlink、Wasm validation、contract付き実行を
確認できる。

### H2.5-D：再buildで決定性を確認できる

read-only verificationの厳格modeでは、artifact内のsource snapshotを再importし、
同じCanonical Type IR、Predicate IR、projection、Wasm bytesが得られることを確認できる。
通常のportable verificationと、toolchainを必要とするrebuild verificationを混同しない。

### H2.5-E：保存は失敗時に部分公開しない

build中の失敗、入力変更、既存出力、write failureがあっても、完成したartifactとして
観測できる部分directoryやmanifestを残さない。既存artifactは上書きしない。

## 3. 完成時の縦断

```text
workspace source.ts
  -> importTypeScriptPredicate
  -> HybridImportResolution v1
       |- source.ts
       |- typescript.json
       |- resolution.json (Canonical Type IR + Predicate IR)
       |- schema.json
       `- specification.md
  -> emitWasm
  -> HybridBuildManifest v1 + <wasm-hash>.wasm
  -> HybridArtifactManifest v1
  -> atomic publication

hybrid verify-artifact
  -> bounded read + strict parse
  -> every file hash
  -> resolution/build/artifact linkage
  -> WebAssembly.validate + contract/runtime check
  -> no source execution, no network, no writes

hybrid verify-artifact --rebuild
  -> artifact source snapshotを再import
  -> IR/projection/Wasmのbyte-level再現性を確認
```

portable verificationは保存内容の完全性と実行可能性を証明する。rebuild verificationは
現在のtoolchainによる再現性を追加で証明する。どちらも業務要求への適合やacceptanceを
証明しない。

## 4. Scope

### 実装するもの

- `HybridImportResolution v1`とstrict parser
- `HybridBuildManifest v1`とstrict parser
- `HybridArtifactManifest v1`とstrict parser
- source、resolution、projection、build、Wasmを結ぶhash chain
- exact source snapshotを含む新規artifact directory
- artifactのbounded read、path containment、symlink拒否
- 新規directoryへのtransactional publication
- portableなread-only artifact verification
- opt-inのrebuild verification
- artifactから既存Wasm runtimeを呼ぶlibrary API
- `hybrid build-ts`、`hybrid verify-artifact` CLI
- 二回build、tamper、race、partial write、offline実行を含むテスト
- example README、結果文書、concept statusの更新

### 今回実装しないもの

- TypeScript型またはexpression grammarの拡張
- number、array、nested record、structured output
- Wasm ABI、linear memory、compiler/backend versionの変更
- Zod、OpenAPI、Rust、JSON Schema input provider
- JSON SchemaからCanonical Type IRへの逆変換
- Requirement Contract、Concept、要求IDの自動生成
- Semantic Test、held-out acceptance、業務上の合否判定
- 既存Prompt Source向けResolution Lock／Capability Packageの形式変更
- imported artifactからCapability Packageへの自動昇格
- registry、remote cache、署名、公開鍵、配備
- source map、debug情報、最適化profile
- 任意の外部moduleを含むTypeScript bundle
- model/API呼び出し
- 新規dependency

## 5. 保存する正本とprojection

artifact内では役割を次のように分ける。

| 資産 | 役割 | 正本性 |
| --- | --- | --- |
| `source.ts` | 取り込んだexact source snapshot | frontend入力 |
| `typescript.json` | 型解釈に使った限定コンパイルprofile | frontend設定 |
| `resolution.json` | Canonical Type IRとPredicate IRの固定結果 | compiler resolution |
| `schema.json` | Canonical Type IRからのJSON Schema | projection |
| `specification.md` | implementation-derivedな説明 | projection |
| `build.json` | contract、toolchain、Wasmの対応 | build record |
| `<hash>.wasm` | 実行成果物 | binary artifact |
| `artifact.json` | 全fileとhashのpackage境界 | package index |

`schema.json`と`specification.md`は第二の意味の正本にしない。verification時には
`resolution.json`から再生成できることを確認する。

## 6. HybridImportResolution v1

新規候補`src/hybrid-import-resolution.ts`に、次の概念を持つversion付きcontractを置く。

```typescript
export type HybridImportResolution = {
  version: 1;
  profile: "predicate-i32-v1";
  source: {
    file: "source.ts";
    functionName: string;
    sourceHash: string;
  };
  typescript: {
    profile: "restricted-predicate-ts-v1";
    version: string;
    optionsHash: string;
  };
  input: {
    parameterName: string;
    typeName: string;
    canonicalType: CanonicalPredicateType;
    canonicalTypeHash: string;
  };
  body: PredicateExpression;
  semanticHash: string;
};
```

### 6.1 保存しない情報

- workspaceの絶対path
- mtime、inode、owner、host名
- TypeScript Compiler API内部ID
- 既存`TypeSchema`
- diagnostics、stack trace
- JSON Schemaや仕様Markdown本体
- model、prompt、架空のConcept／Requirement

`TypeSchema`はTypeScript抽出層の互換情報であり、artifactの言語非依存なresolutionへ
固定しない。

### 6.2 Strict parseと再計算

parserはunknown key、symbol、accessor、継承property、sparse array、上限超過を拒否する。
次をparse時に再計算し、不一致なら失敗する。

- `sourceHash`の形式
- `canonicalTypeHash(canonicalType)`
- `fingerprintFor({ profile, contract, body })`としての`semanticHash`
- Canonical Typeから得るcontractとPredicate IRの互換性

source bytesとの一致はartifact readerが確認する。resolution全体はcanonical JSON bytesを
SHA-256でhashし、buildとartifactから参照する。

### 6.3 TypeScript compile profile

source snapshotだけでは、`strictNullChecks`や`exactOptionalPropertyTypes`による型解釈を
再現できない。一方、元の`tsconfig.json`をそのまま保存すると、`extends`、`paths`、
plugin、絶対path、workspace内の別fileへ依存する。

そのため初期artifactは、新規`HybridTypeScriptProfile v1`へ正規化した設定を
`typescript.json`として保存する。profileはTypeScript versionと、意味・diagnosticに
必要なallowlist済みcompiler optionだけを持ち、unknown optionやpath値を拒否する。
少なくとも次を明示値として固定する。

- `strictNullChecks`
- `exactOptionalPropertyTypes`
- `noUncheckedIndexedAccess`
- `target`
- `module`
- `moduleDetection`
- `useDefineForClassFields`
- `skipLibCheck`

builderはsnapshotをこの独立profileでも再解析し、workspaceの通常import結果と
Canonical Type IR／Predicate IRが一致する場合だけartifact化する。reference directive、
import declaration、dynamic import、module augmentation、ambient moduleを含むsourceは
初期版では拒否する。これによりrebuildはartifact内`source.ts`、`typescript.json`、
同じTypeScript version、標準libだけで閉じる。

将来外部型を取り込む場合は、依存source graphと各byte hashを持つ別versionを設計する。
初期版で不足fileをworkspaceから暗黙に読むfallbackは作らない。

## 7. HybridBuildManifest v1

新規候補`src/hybrid-build-manifest.ts`に、import専用build contractを置く。

```typescript
export type HybridBuildManifest = {
  version: 1;
  profile: "predicate-i32-v1";
  export: "evaluate";
  resolutionHash: string;
  canonicalTypeHash: string;
  semanticHash: string;
  contract: WasmContract;
  contractHash: string;
  compiler: string;
  backend: string;
  options: "mvp-no-optimization";
  wasmHash: string;
  file: string;
};
```

`compiler`は`WASM_COMPILER_VERSION`、`backend`は既存Binaryen versionを記録する。
`file`は`<wasmHash>.wasm`に限定する。contractはCanonical Typeから再生成した値と一致し、
`contractHash`も再計算する。

既存`WasmManifest v1`はPrompt Source provenanceを要求するため変更しない。共通化できる
bounded read、Wasm validation、runtime処理は再利用するが、manifestの意味は混ぜない。

## 8. HybridArtifactManifest v1

新規候補`src/hybrid-artifact.ts`にpackage境界を置く。

```typescript
type HybridArtifactFileRole =
  | "source"
  | "typescriptProfile"
  | "resolution"
  | "jsonSchema"
  | "specification"
  | "build"
  | "wasm";

export type HybridArtifactManifest = {
  version: 1;
  kind: "hybrid-imported-predicate";
  profile: "predicate-i32-v1";
  functionName: string;
  files: Record<HybridArtifactFileRole, {
    path: string;
    hash: string;
  }>;
};
```

file pathはflatなportable filenameだけを許可し、絶対path、`..`、separator、NUL、重複、
manifest自身への参照を拒否する。manifest hashはcanonicalized manifest contentから計算し、
CLI結果では`artifactHash`として返す。

artifact formatは`acceptance: pass`や`verified: true`を永続状態として持たない。
verification結果は対象artifact hashと実行時刻を持つ外部結果であり、artifact本体を書き換えない。

## 9. Artifact builder

新規候補`src/hybrid-artifact-builder.ts`に、次のAPIを置く。

```typescript
export async function buildImportedPredicateArtifact(input: {
  workspaceRoot: string;
  sourcePath: string;
  functionName: string;
  outputDirectory: string;
}): Promise<{
  manifest: string;
  artifactHash: string;
  semanticHash: string;
  wasmHash: string;
  apiCalls: 0;
}>;
```

### 9.1 Build順序

1. sourceをbounded readし、regular file、workspace containment、symlink拒否を確認する。
2. exact bytesとhashをmemory snapshotとして保持する。
3. `importTypeScriptPredicate`でresolution候補を得る。
4. sourceがsnapshotから変化していないことを再確認する。
5. workspace設定を限定TypeScript profileへ正規化し、snapshotを独立に再解析する。
6. 通常importと独立profileのCanonical Type IR／Predicate IR一致を確認する。
7. Canonical Type IR、Predicate IR、JSON Schema、仕様表示をcanonical bytesへ変換する。
8. 既存`emitWasm`でWasmを生成し、validateとhashを確認する。
9. resolution、build、artifact manifestをstrict parserへ通す。
10. 親directory内の一時directoryへすべてexclusive writeする。
11. 一時directoryをread-only verifierで再読込する。
12. sourceが再度変化していないことを確認する。
13. 完成directoryを要求された未存在pathへatomic renameする。

既存のoutput directoryは上書きしない。失敗時は、自分が作った一時directoryだけを削除する。
他processが作成したdirectoryや既存artifactを削除しない。

### 9.2 決定性

次はartifact bytesへ含めない。

- build時刻
- workspace絶対path
- temporary directory名
- process ID
- OS path separator
- machine固有情報

同じsource bytes、function名、compiler/backend versionから、全file hash、manifest、
artifact hash、Wasm bytesが一致することを二つの異なるdirectoryで検証する。

## 10. Verification

`src/hybrid-artifact.ts`に二段階のverification APIを置く。

```typescript
export async function verifyImportedPredicateArtifact(
  manifestPath: string,
  options?: { rebuild?: false },
): Promise<PortableVerificationResult>;

export async function verifyImportedPredicateArtifact(
  manifestPath: string,
  options: { rebuild: true },
): Promise<RebuildVerificationResult>;
```

### 10.1 Portable verification

- manifestと全fileをsize上限内で読む
- regular fileだけを許可し、symlinkを拒否する
- 全file hashを照合する
- resolution、build、artifact manifestをstrict parseする
- source bytes hashとresolutionの`sourceHash`を照合する
- TypeScript profile hashとresolutionの`optionsHash`を照合する
- resolution hashとbuildの`resolutionHash`を照合する
- Canonical Type hash、Semantic hash、contract hashを再計算する
- Canonical Type IRからJSON Schemaと仕様表示を再生成し、保存bytesと比較する
- Wasm hash、`WebAssembly.validate`、export、memory/table/global/start不在を確認する
- contract adapterで最小の有効／無効入力を用いたruntime境界を確認する
- network、model、workspace source、write処理を呼ばない

最小runtime checkは業務結果を期待しない。Wasmがmanifestのcontractでinstantiateでき、
不正inputをadapterが拒否し、有効inputでbooleanを返すことだけを確認する。

### 10.2 Rebuild verification

portable verification成功後に、artifact内`source.ts`と`typescript.json`を一時workspaceへ
展開して再importする。
再import時にもsource moduleは実行しない。次をbyte-levelまたはcanonical hashで比較する。

- Canonical Type IR
- Predicate IR
- semantic hash
- JSON Schema
- specification Markdown
- WasmContract
- Wasm bytes
- compiler/backend/options

現在のtoolchain versionがmanifestと違う場合は、mismatchを成功扱いにせず、
`TOOLCHAIN_MISMATCH`としてrebuild不能を報告する。portable verificationの成功とは
別statusにする。

## 11. CLI

既存`hybrid inspect-ts`を維持し、次を追加する。

```bash
bun run hybrid build-ts examples/hybrid-order/can-ship.ts \
  --function canShip \
  --out artifacts/hybrid/can-ship

bun run hybrid verify-artifact \
  artifacts/hybrid/can-ship/artifact.json

bun run hybrid verify-artifact \
  artifacts/hybrid/can-ship/artifact.json \
  --rebuild
```

成功時はstdoutへ一つのJSON、失敗時はstderrへboundedな一つのdiagnosticを返す。
portable verificationは`writes: 0`、全commandは`apiCalls: 0`を返す。

引数はcommandごとの厳格parserで処理し、重複option、unknown option、余分なposition、
欠損値、workspace外source、workspace外outputを拒否する。`inspect-ts`の既存JSON契約と
exit codeを変更しない。

## 12. Error model

artifact層の公開errorは少なくとも次へ分類する。

```typescript
type HybridArtifactErrorCode =
  | "INVALID_ARGUMENT"
  | "OUTPUT_EXISTS"
  | "INVALID_ARTIFACT"
  | "ARTIFACT_MISMATCH"
  | "SOURCE_CHANGED"
  | "TOOLCHAIN_MISMATCH"
  | "REBUILD_MISMATCH"
  | "PUBLICATION_FAILED";
```

TypeScript import段階の既存`TypeScriptImportError`は保持する。公開messageは共通resource
limit内に収め、絶対path、source全文、stack、credentialを含めない。元errorは`cause`に
保持してよいがCLI JSONへ出さない。

## 13. Resource limitsとsecurity boundary

- 既存`SEMANTIC_LIMITS.typescriptSourceBytes`と`WASM_LIMITS.bytes`を再利用する
- manifestごとにunknown keyを拒否する
- file数は固定roleの7件だけにする
- file pathはflat nameに限定する
- `lstat`、`realpath`、contained path検査でsymlink escapeを拒否する
- sizeをread前後の両方で検査する
- JSON parse前にbyte上限を検査する
- getterやprototypeを信用せず、strict parserはdata propertyだけを読む
- source moduleをimport、require、evalしない
- Wasmはmemory、table、global、start、importを持たない既存profileに限定する
- verificationはartifact directory外を読まない
- buildは指定された新規outputと自分のtemporary directory以外を書き換えない

署名がないため、artifactの作成者や信頼主体は証明しない。初期版が証明するのは、
manifestが参照する内容の自己整合性と、現在のtoolchainでの再現性だけである。

## 14. 実装単位

### Unit 1：Resolution contract

- `src/hybrid-import-resolution.ts`
- `src/hybrid-import-resolution.test.ts`
- `src/hybrid-typescript-profile.ts`
- `src/hybrid-typescript-profile.test.ts`

strict parse、hash再計算、Canonical Type／Predicate互換性、unknown field、tamper、resource
limit、限定compiler option、外部source依存の拒否を固定する。

### Unit 2：Buildとartifact manifest

- `src/hybrid-build-manifest.ts`
- `src/hybrid-artifact.ts`
- 対応するunit test

file role、path、hash、toolchain、contract、resolution linkを固定する。

### Unit 3：Transactional builder

- `src/hybrid-artifact-builder.ts`
- `src/hybrid-artifact-builder.test.ts`

snapshot、emit、exclusive write、self-verification、atomic publication、cleanupを実装する。

### Unit 4：Portable verifierとruntime

- `src/hybrid-artifact.ts`
- `src/hybrid-artifact.integration.test.ts`

元workspaceなしのread／verify／execute、tamper matrix、offline性を確認する。

### Unit 5：Rebuild verifier

- `src/hybrid-artifact-rebuild.ts`
- `src/hybrid-artifact-rebuild.test.ts`

source snapshotからの再importと全projection／Wasm再現性を確認する。

### Unit 6：CLIと文書

- `src/hybrid-cli.ts`
- `src/hybrid-cli.test.ts`
- `examples/hybrid-order/README.md`
- `docs/HYBRID_COMPILER_CONCEPT.md`
- `docs/HYBRID_COMPILER_THIRD_IMPLEMENTATION_RESULTS.md`

既存command互換性、JSON出力、exit code、write countを固定し、実測結果を記録する。

## 15. Test strategy

### 15.1 Parser／hash unit test

- valid resolution/build/artifactをparseできる
- unknown、missing、wrong version、wrong profileを拒否する
- accessor、symbol、prototype、sparse arrayを実行せず拒否する
- hash一文字変更を検出する
- Canonical Type、Predicate IR、contractの不一致を検出する
- path traversal、絶対path、separator、重複pathを拒否する

### 15.2 Determinism test

同じsourceを異なるworkspace pathとoutput pathで二回buildし、次が一致することを確認する。

- resolution bytes／hash
- JSON Schema bytes／hash
- specification bytes／hash
- build manifest bytes／hash
- Wasm bytes／hash
- artifact manifest bytes／hash
- artifact hash

sourceのformatだけを変えた場合、source hashとartifact hashは変わるが、Canonical Type hash、
Semantic hash、Wasm hashは維持される既存H1/H2の性質も確認する。

### 15.3 Tamper matrix

次の各fileを独立に一箇所変更し、portable verificationが必ず失敗することを確認する。

- source
- TypeScript profile
- resolution
- JSON Schema
- specification
- build manifest
- Wasm
- artifact manifest内の各hash／path

hashだけを追随させた複合tamperについても、resolution/build間の再計算で失敗するcaseを
含める。

### 15.4 Publication／race test

- 既存outputを上書きしない
- sourceがimport中に変化したら公開しない
- write、linkまたはrename failureで完成manifestを残さない
- concurrent buildは一方だけ成功する
- cleanupは自分のtemporary directoryだけに限定する
- symlinked source／output parent／artifact fileを拒否する

### 15.5 Portable integration test

`canShip`と`needsManualReview`をartifact化し、元workspaceとは別のtemporary directoryで
次を確認する。

- portable verification成功
- contract adapterからtrue／falseの独立case tableを実行
- invalid input拒否
- TypeScript source moduleが実行されない
- API 0、network 0、writes 0

### 15.6 Rebuild integration test

- 二つのfixtureで全hashとWasm bytesが一致する
- compiler/backend mismatchを分類して拒否する
- source snapshotのunsupported変更を成功扱いにしない
- import／reference directiveを持つsourceをartifact化しない
- rebuild用temporary workspaceを成功／失敗の双方でcleanupする

### 15.7 Regression test

- H1の元TypeScript／Predicate IR／Wasm意味一致
- H2のCanonical Type／JSON Schema／仕様projection
- `hybrid inspect-ts`の出力
- 既存Prompt Source向けWasm artifactとCapability Package
- 全既存suite

## 16. Acceptance criteria

- [x] 同じ入力を異なるdirectoryでbuildして同じartifact hashになる
- [x] source、Canonical Type、Predicate IR、contract、Wasmのhash chainが閉じている
- [x] 型解釈に必要な限定TypeScript profileが保存され、外部sourceへ依存しない
- [x] Prompt Source固有provenanceや架空のRequirementを保存していない
- [x] portable verificationが元workspace、TypeScript compiler、networkなしで成功する
- [x] rebuild verificationが全projectionとWasm bytesの再現性を確認する
- [x] 全fileの単独tamperと主要な複合tamperを検出する
- [x] artifactから既存runtime adapterでboolean Predicateを実行できる
- [x] source moduleを一度も実行しない
- [x] build失敗時に完成artifactまたは既存artifactを損なわない
- [x] 既存`inspect-ts`、Wasm ABI、Prompt Capability Packageを変更しない
- [x] 新規dependencyを追加しない
- [x] public diagnosticがboundedかつpath／source非漏えいである
- [x] 全品質Gateが成功する
- [x] macOS、Ubuntu、Windowsの結果を結果文書へ記録する

## 17. Quality gates

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

実装中は新規unit／integration testとH1/H2回帰testを先に実行し、最後に全suiteを
実行する。失敗した場合は、対象testで再現、局所修正、対象test再実行、全Gate再実行の
順とする。失敗を無視した結果文書は作らない。

## 18. 実装順序

1. 現在のH1/H2 hashと全Gateをbaselineとして記録する。
2. 限定TypeScript profile、Resolution contract、parserをtest-firstで実装する。
3. Build／artifact manifestとlinkage parserを実装する。
4. in-memoryでartifact構成物を生成し、決定性testを通す。
5. transactional builderとpublication failure testを実装する。
6. portable verifier、tamper matrix、runtime testを実装する。
7. rebuild verifierとtoolchain mismatch testを実装する。
8. CLIを追加し、既存`inspect-ts`互換testを通す。
9. 二つのH1 fixtureでend-to-end artifactを検証する。
10. 全品質Gateと3 OS CIを実行する。
11. 実測hash、test件数、制限、計画との差分を結果文書へ記録する。

## 19. Stop conditions

次が判明した場合は、その場で表現力を広げず計画を見直す。

- exact source snapshotだけでは同一file型依存を再現できない
- current importerが暗黙にworkspaceの別fileへ依存している
- allowlist済みTypeScript optionだけではH1/H2の型解釈を再現できない
- portable verifierがTypeScript Compiler APIやBinaryenを必須にしてしまう
- existing Wasm runtimeがimported artifact用contractを安全に読めない
- atomic directory publicationが対応OSで同じ安全性を持たない
- manifest共通化に既存Prompt artifactのbreaking changeが必要になる
- projection再生成が保存済みtoolchain versionへ依存し、portable検証不能になる
- artifactにRequirement／Acceptanceの意味を持たせないと利用者が誤認する

最後のcaseでは、artifact名とCLI表示を変更し、`acceptance: not-run`相当の制限を
より明示する。技術的完全性を業務上の正しさとして表示しない。

## 20. 完了後の次の判断

H2.5完了後は、保存済みartifactの実利用から次の一つを選ぶ。

### A：Zod projection

TypeScript host integrationが主要用途なら、Canonical Type IRのlosslessな共通範囲から
Zod codeとadapterを生成し、同じartifact hash chainへ追加する。

### B：H3 Structured Output

boolean以外の結果が必要なら、小さなrecord output、linear memory、buffer ownership、
error modelを独立profileとして設計する。

### C：Requirement Contractとのlink

SAAA／Coding Agent連携が優先なら、Requirement revision/hashとartifact hashを結ぶ
外部approval recordを設計する。artifact自体へ自然言語の正しさを埋め込まない。

### D：Additional Provider

JSON Schema、OpenAPI、Rust型などの入力要求が得られた場合、同じCanonical Type IRと
artifact contractへ接続するProviderを追加する。

いずれの場合も、利用例なしに型表現力やABIを先回りして拡張しない。
