# Hybrid Compiler Third Implementation Results

> 分類：本文の日付・基点revision・実行条件に対する結果記録です。過去の数値・未完了事項を現在の全経路へ一般化しません。現在の対応範囲は[ロードマップ](../PROJECT_STATUS_AND_ROADMAP.md)、利用方法は[例の一覧](../examples/README.md)を参照してください。

## Status

- 実装日：2026-09-17
- 対象ブランチ：`hybrid-compiler`
- 計画：[第三実装計画](./HYBRID_COMPILER_THIRD_IMPLEMENTATION_PLAN.md)
- 対象段階：H2.5 `Reproducible Imported Predicate Artifact`
- 実装名：`Hybrid Predicate Artifact v1`
- 状態：実装完了、ローカル品質Gate通過

H1/H2で取り込めるようになった制限TypeScript Predicateを、exact source snapshot、
限定TypeScript profile、Canonical Type IR、Predicate IR、JSON Schema、仕様表示、Wasmと
ともに保存するartifact縦断を実装した。

artifactはPrompt Source向けCapability Packageを流用せず、import専用のResolution、
Build Manifest、Artifact Manifestを持つ。Requirement、Concept、Semantic Test、Acceptanceの
placeholderは生成しない。

## 実装した経路

```text
TypeScript source
  -> workspace設定でRestricted Import
  -> 固定TypeScript profileでisolated Import
  -> Canonical Type / Predicate IR一致
  -> HybridImportResolution v1
  -> JSON Schema / specification / Wasm
  -> HybridBuildManifest v1
  -> HybridArtifactManifest v1
  -> self verification
  -> atomic directory publication

portable verification
  -> bounded read / strict parse / 全file hash
  -> manifest間link / projection再生成
  -> stateless Wasm / ABI / runtime境界

rebuild verification
  -> artifact内source + TypeScript profile
  -> isolated Import / 全projection / Wasm再生成
  -> canonical hashとWasm bytes一致
```

## 主な実装

- [`hybrid-typescript-profile.ts`](../src/hybrid-typescript-profile.ts)：
  pathや外部設定を持たない固定TypeScript profileとstrict parser
- [`hybrid-import-resolution.ts`](../src/hybrid-import-resolution.ts)：
  source、TypeScript profile、Canonical Type、Predicate IR、semantic hashのresolution
- [`hybrid-build-manifest.ts`](../src/hybrid-build-manifest.ts)：
  resolution、contract、toolchain、Wasmを結ぶbuild record
- [`hybrid-artifact.ts`](../src/hybrid-artifact.ts)：
  artifact manifest、bounded reader、portable verifier、runtime loader
- [`hybrid-artifact-builder.ts`](../src/hybrid-artifact-builder.ts)：
  snapshot、isolated比較、self verification、transactional publication
- [`hybrid-artifact-rebuild.ts`](../src/hybrid-artifact-rebuild.ts)：
  toolchain確認と再build検証
- [`hybrid-isolated-import.ts`](../src/hybrid-isolated-import.ts)：
  source dependency拒否と一時workspace内の独立import
- [`hybrid-cli.ts`](../src/hybrid-cli.ts)：
  `build-ts`と`verify-artifact` command
- [`wasm-runtime.ts`](../src/wasm-runtime.ts)：
  import artifactでも使えるcontract最小interfaceとstateful section拒否

## Artifact format

一つのartifact directoryは次を持つ。

| File | 内容 |
| --- | --- |
| `source.ts` | exact UTF-8 source snapshot |
| `typescript.json` | `restricted-predicate-ts-v1` profile |
| `resolution.json` | Canonical Type IR、Predicate IR、各hash |
| `schema.json` | JSON Schema projection全体 |
| `specification.md` | implementation-derived specification |
| `build.json` | contract、toolchain、Wasm provenance |
| `<wasm-hash>.wasm` | `predicate-i32-v1` binary |
| `artifact.json` | 全file role、path、SHA-256 |

各JSONはcanonical key orderで保存する。build時刻、絶対path、PID、temporary path、host名を
含めないため、同じsource bytes、function、toolchainから同じartifact hashを得る。

## TypeScript再現境界

元`tsconfig.json`を保存すると`extends`、plugin、path、workspaceの別fileへ依存する。
そこでartifact buildは次を行う。

1. 通常workspace設定で既存importerを実行する。
2. source snapshotを固定`restricted-predicate-ts-v1` profileで再importする。
3. Canonical Type、Predicate IR、contract、semantic hash、projectionが一致した場合だけ保存する。

初期版はreference directive、import declaration、re-export、dynamic import、module
augmentation、ambient moduleを拒否する。source moduleは検査、build、verifyのどこでも
実行しない。外部型が必要になった場合は、依存source graphをhash付きで保存する新versionが
必要である。

## Verificationの意味

portable verificationはTypeScript Compiler APIやBinaryenを読み込まず、次を確認する。

- artifact directory内のregular non-symlink fileだけを読む
- 全fileのsizeとSHA-256
- Resolution、Build、Artifact Manifestのstrict contract
- source、TypeScript profile、Canonical Type、Semantic IR、contractのlink
- JSON Schemaと仕様表示の決定的な再projection
- Wasm hash、custom contract、import／export、signature
- memory、table、global、start、element、data section不在
- 最小有効入力のboolean実行と不正入力拒否

rebuild verificationは現在のTypeScript、L-Lang compiler、Binaryen versionが保存値と一致する
場合だけ実行し、全projectionとWasm bytesを比較する。portable成功とtoolchain再現成功は
別statusであり、toolchain mismatchをportable失敗へ読み替えない。

どちらもRequirement、Semantic Test、held-out case、業務Acceptanceを実行したことには
ならない。検証結果はartifactを書き換えず、対象artifact hashと実行時刻を返す。

## CLI

```bash
bun run hybrid build-ts examples/hybrid-order/can-ship.ts \
  --function canShip \
  --out artifacts/hybrid/can-ship

bun run hybrid verify-artifact artifacts/hybrid/can-ship/artifact.json
bun run hybrid verify-artifact artifacts/hybrid/can-ship/artifact.json --rebuild
```

`build-ts`は既存outputを上書きしない。portable verificationは`apiCalls: 0`、`writes: 0`、
rebuild verificationは`apiCalls: 0`と`temporaryWrites: true`を返す。rebuild用temporary
workspaceは成功・失敗の双方で削除する。

## 実測hash

| Function | Artifact hash | Semantic hash | Wasm hash |
| --- | --- | --- | --- |
| `canShip` | `467d27707f526f16052a5cafa3bd4406c901fd3b7cdd2375b7ae6e66ea3d5972` | `e92e379d4b51cab9e551b945f74fe381f2e539396ef03dc8aeebcac0403d8e69` | `b9d6849e6d5d91beab447ba6d318c0ee531cdd450b6701b28bef4a6cfbb5c582` |
| `needsManualReview` | `a55792faa7e194678531c67114a15c5fb8b3185c40a14dc48eaa241b69725522` | `d50530d67a204c5ff30f99f7d8261db8a9ec04cc518dc20682fca6f33c8ba6f3` | `31e35f6157e4f5b7255f95a90784fb6fe5525d2af4aced75727d364389dabe4b` |

H1/H2のSemantic hashとWasm hashは変化していない。sourceへ空行だけを追加したcaseでは
artifact hashだけが変化し、Semantic hashとWasm hashは維持された。

## 検証した失敗境界

- source、TypeScript profile、resolution、schema、specification、build、Wasmの単独tamper
- sourceとartifact file hashを同時に変更する複合tamper
- artifact manifestのfunction、path、hash変更
- unknown key、欠損、wrong version／profile、getter、symbol、sparse data
- oversized artifact entry
- symlinked source、artifact file、output parent
- imported type／source dependency、reference directive
- TypeScript／compiler／backend version mismatch
- source変更race
- 同じoutputへのconcurrent publication
- 既存outputへの上書き
- write failure、rename failure、partial publication cleanup
- stateful Wasm section
- source top-levelに`throw`があるmoduleの非実行
- CLIのunknown、duplicate、missing、extra argument

## 品質Gate

環境はmacOS、Bun 1.3.14、TypeScript 5.9.3、Binaryen 132.0.0である。

| Gate | 結果 |
| --- | --- |
| `bun install --frozen-lockfile` | 成功、dependency変更なし |
| `bun audit` | 成功、脆弱性0件 |
| `bun run format:check` | 成功 |
| `bun run lint` | 成功 |
| `bun run ci:docs` | 成功 |
| `bun run typecheck` | 成功 |
| `bun test` | 成功、425 tests / 88 files / 0 failures、2186 assertions |
| `bun run coverage` | 成功、425 tests / 88 files、overall functions 94.90%・lines 92.80%、個別閾値通過 |
| `bun run ci:smoke` | 成功 |
| `bun run ci:protected` | 成功 |
| `git diff --check` | 成功 |

UbuntuとWindowsの実行はローカル環境では行っていない。既存CI matrixの対象だが、
この未commit差分に対するremote CI結果はまだ存在しない。

## 計画との差分

- 計画ではparser、builder、portable verifier、rebuild verifierごとにtest file候補を
  挙げた。実装では共有artifact setupとtamper matrixの重複を避けるため、contract unit
  testとartifact integration testへ集約した。計画した検証項目自体はすべて含む。
- rebuild verificationはread-onlyなartifactに対して一時workspaceを使用するため、
  `writes: 0`とは表示せず`temporaryWrites: true`を返す。portable verificationだけが
  `writes: 0`である。
- portable verifierがBinaryenなしでstateful Wasmを拒否できるよう、Wasm sectionを
  boundedに走査する小さな検査を既存runtimeへ追加した。ABIとemitter versionは変更していない。

## 完了監査

| 計画項目 | 状態 | 証拠 |
| --- | --- | --- |
| Resolution／Build／Artifact contract | 完了 | strict parser、hash再計算test |
| 限定TypeScript profile | 完了 | isolated二重import、toolchain mismatch test |
| hash chain | 完了 | 全file tamper／複合tamper test |
| transactional publication | 完了 | existing、concurrent、write／rename failure test |
| portable verification | 完了 | compiler非依存reader、offline runtime test |
| rebuild verification | 完了 | H1二fixture、projection／Wasm一致test |
| source非実行 | 完了 | top-level throw fixture |
| CLI | 完了 | build、portable、rebuild、invalid arguments test |
| H1/H2互換性 | 完了 |既存Semantic／Wasm hash維持、全suite成功 |
| 文書 | 完了 | concept、example、計画、結果更新 |
| macOS品質Gate | 完了 | 上記コマンド実測 |
| Ubuntu／Windows CI | remote実行待ち | 既存CI matrixでcommit後に確認 |

実装scope内に未実装項目はない。残るremote OS確認は、未commit差分をCIへ送る外部操作であり、
コードまたはローカル検証の実装漏れではない。

## 次の判断

Hybrid Compilerの基礎縦断は、限定TypeScript SourceからCanonical Contract、Predicate IR、
projection、Wasm、再現artifactまで閉じた。次に進む場合は、実利用要求に基づき、Zod
projection、H3 Structured Output、Requirement Contractとの外部link、追加Providerの
いずれかを独立計画として選ぶ。利用例なしに型やABIを拡張しない。
