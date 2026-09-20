# Value Wasm メモリー安全性強化 実装結果

実施日: 2026-09-20。対象: `module-value-v1` / `llang-value-memory-v1`。基点revision: `a116435f2d890fae6ed16100bbdffb4ddd0ce1e2`。

## 結果

generated Wasmの入力検査を、memory accessを含む条件まで`i32.or`でまとめる式から、失敗時に即returnする型別staged validatorへ置き換えた。top-levelのbase、length、capacity、memory containment、input／output overlapを確認した後だけrootを読み、string descriptorはpayloadがinput wire内にあることを確認した後だけUTF-8 validatorへ渡す。

基点artifactでは、`module-order-line`のstring pointerへ`0xffffffff`、lengthへ1を置いたdirect callがstatus 1ではなく`Out of bounds memory access`でtrapした。最初のBun 1.3.14 probeに加え、基点revisionを分離worktreeへ戻したBun 1.4.2でも同じtrapを再現した。修正後は同じcaseを含むpointer-before-input、input-end超過、wraparound、16 KiB超過がすべてstatus 1になり、output write前に停止する。

recordはfield順、unionは範囲内tagのselected variantだけを検査する。booleanは0／1だけを受理する。unalignedだがcontainedなbuffer、zero-length pointer、安全なimmutable payload alias、非zero input paddingは新たに拒否せず、ABI v1の受理範囲を維持した。

allocatorは要求bytesとalignment paddingを残容量へ比較してからarenaを更新する。constant constructorとrecord／union constructorはallocation fault後にstoreを続けない。copy／zero helperはsource／destination全体をlinear memoryへ照合し、output stringはaligned sizeが`outputCapacity`へ収まることを確認してからcopyする。最初のfault statusは後続helperで上書きしない。

## direct harnessとmutation

`ValueDirectHarness`はhost runtimeを介さず、raw memoryを配置して`evaluate`の4引数を直接呼ぶ。statusとWasm trap、input／output hash、同一instance再呼出しを区別する。固定corpusはreference evaluator、public Wasm runtime、direct ABIを比較する。

次の七つの退行をtestが検出する。

1. string payload containmentの省略によりUTF-8 readerが範囲外を読む。
2. rootの`inputLength`検査を省く。
3. unsigned base検査をsigned比較へ変える。
4. input／output overlap検査を省く。
5. selected union以外のpayloadも検査する。
6. allocatorのremaining-capacity guardを省く。
7. output stringのcapacity guardを省く。

## artifact互換性

`module-order-line`の基点Wasmは2,003 bytes、SHA-256 `adc4a3f899a69180cd7578dbb15a7f0b4471cf18fe3ff06e2db7dc80baef6440`だった。修正後は2,252 bytes、SHA-256 `c9045e75d135e39f800aafb0b9c87416e351f5b5f7db90143323aa4c92326dd5`である。249 bytes、12.43%の増加はstaged validatorとrange helperによる。性能改善は今回の目的・主張に含めない。

ABI `llang-value-memory-v1`、manifest version 2、16-page fixed memory、64 KiB wire、16 KiB string、fuel 100,000、status 0〜5、export `memory`／`evaluate`、import 0を維持した。既存version-2 portable bundle、移動後verify、timeout分類も回帰試験を通す。

## 実装単位との対応

| 単位 | 実装 |
| --- | --- |
| PR-0 | revision、runtime、Binaryen、ABI、limits、基点artifactとtrap再現をfreeze |
| PR-1 | raw memory、status／trap、hash、再利用を扱うdirect harnessと固定corpus |
| PR-2 | top-levelからUTF-8までのstaged type validator |
| PR-3 | remaining-capacity allocator、fault-aware constructor、bounded copy／zero／output |
| PR-4 | reference／host／direct differentialと七mutation |
| PR-5 | ABI、manifest、portable suite、artifact shapeの回帰 |
| PR-6 | schema付きmatrix、生成Markdown、仕様、SECURITY、Gate、roadmap |

## 計画から具体化した点

計画時は「output capacity外を変更しない」を広く記載していたが、現行ABIではinput／output以外のlinear memoryはmodule-privateで、内部arenaが宣言output直後を使う場合がある。この領域をcaller canaryとして保護する契約は存在しない。

最終保証は、invalid-inputがoutput write前に停止すること、inputを変更しないこと、output writerが`outputCapacity`外へcopyしないこと、内部arenaがinput／outputと重ならないこととした。宣言buffer外の全memory不変は主張しない。この境界は仕様、SECURITY、Matrixで一致させた。

## 受け入れ条件

VMS1〜VMS30の対応は次のとおりである。product Wasmへtest instrumentationやmutant分岐は含めていない。

| ID | 状態 | 根拠 |
| --- | --- | --- |
| VMS1 | 完了 | `freeze.json`がrevision、ABI、Bun、Binaryen、limitsを固定し、direct corpusをstrict schemaで検証する。 |
| VMS2 | 完了 | `ValueDirectHarness.invoke`がraw `evaluate` exportを直接呼ぶ。 |
| VMS3 | 完了 | top-level／string negative corpusがstatus 1とtrapなしを検査する。 |
| VMS4 | 完了 | `input-short-root`とroot-load前のstaged check。 |
| VMS5 | 完了 | memory／input rangeを`limit - base`形式で検査する。 |
| VMS6 | 完了 | complete、partial、one-byte overlapの固定case。 |
| VMS7 | 完了 | descriptor load、payload containment、UTF-8の順を生成する。 |
| VMS8 | 完了 | `0xffffffff` pointer caseとeager-reader mutant。 |
| VMS9 | 完了 | boolean 2、union tag上限、selected payloadの型検査。 |
| VMS10 | 完了 | inactive union payload mutantをselected-variant caseが検出する。 |
| VMS11 | 完了 | nested record／selected union内のstring pointer破損case。 |
| VMS12 | 完了 | ASCII、2／3／4-byte scalarとtruncated、continuation、overlong、surrogate、範囲外scalar。 |
| VMS13 | 完了 | 16 KiB実payloadを受理し、16,385 descriptorを拒否する。 |
| VMS14 | 完了 | invalid-inputでinput／output hashとcanaryが不変であることを検査する。 |
| VMS15 | 完了 | resource fault時のinput不変、output-capacity mutant、arenaとの契約分離。 |
| VMS16 | 完了 | `$alloc`がsizeとpaddingを確認してからarenaを更新し、allocator mutantを検出する。 |
| VMS17 | 完了 | `$mem_copy`／`$mem_zero`のwhole-range guardと`$out_string`のcapacity guard。 |
| VMS18 | 完了 | helperは既存faultで即returnし、既存fuel-first-fault testも維持する。 |
| VMS19 | 完了 | rejected input後に同一instanceでvalid callとdecodeが成功する。 |
| VMS20 | 完了 | 既存four-backend testと固定corpusのreference／host／direct比較。 |
| VMS21 | 完了 | 七mutationを三つのtestで検出する。 |
| VMS22 | 完了 | artifact verifierとfreezeがimport 0、export二つ、固定memoryを確認する。 |
| VMS23 | 完了 | ABI、manifest v2、status、limitsを変更せず既存layout contractを通す。 |
| VMS24 | 完了 | version-2 bundle、relocation、timeoutの既存testを通す。 |
| VMS25 | 完了 | mutantはtest内WAT置換だけで生成物へ到達しない。 |
| VMS26 | 完了 | Ajv schema適合とJSONから生成したMarkdownの完全一致test。 |
| VMS27 | 完了 | fixtureとtestはlocal fileとin-process Wasmだけを使う。 |
| VMS28 | 完了 | Value局所、全体check、coverage、docs、protected、smokeを固定Bunで実行する。 |
| VMS29 | 完了 | `git diff --check`と本書の保証境界を確認する。 |
| VMS30 | 完了 | 実行したmacOSだけを成功として記録し、Ubuntu／Windowsは未実行とする。 |

## 検証結果

macOS 26.6.2（Darwin 25.6.0、arm64）、Bun 1.4.2、TypeScript 5.9.3、Binaryen 132.0.0で実行した。

| 検証 | 結果 |
| --- | --- |
| Value局所test | 29 pass、0 fail、198 assertions |
| `bun run check` | 732 pass、0 fail、15,782 assertions、134 files |
| `bun run coverage` | 732 pass、0 fail、15,798 assertions。全体functions 93.00%／lines 92.51%、`semantic-transaction.ts` functions 98.36%／lines 96.88% |
| format／typecheck／lint | 成功。lintはerror 0、warning 87 |
| `bun run ci:docs` | Markdown linkと24 command／3 versionを含むdocumentation contractが成功 |
| `bun run ci:protected` | protected benchmark inputsの検証が成功 |
| `bun run ci:smoke` | semantic、llang、module、effectsの全smokeが成功。module smokeはValue 4構成／portable 4 caseを含む |
| `bun run value:memory:matrix` | schema適合済みJSONからMarkdownを再生成し、test内の完全一致検査が成功 |
| `git diff --check` | 成功 |

実行したOSとして成功を記録するのはmacOSだけである。Ubuntu／Windowsはこのlocal作業で実行しておらず、成功とは記録しない。

## 保証境界

この結果が示すのは、信頼するcompilerが検証済みValue IRから生成したWasmと、同期的なdirect callerの境界である。任意Wasm、hostによる実行中のmemory変更、threads、shared memory、memory growth、memory64、secret confidentiality、constant-time性、他profileの同等保証は対象外である。
