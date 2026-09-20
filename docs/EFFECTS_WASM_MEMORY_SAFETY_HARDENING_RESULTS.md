# Effects Wasm メモリー安全性強化 実装結果

実施日: 2026-09-20〜21。対象は `module-effects-v1` の import-free linear／typed continuation Wasm である。実装基点は `2669c7bef6f870c3404f9704db569f4131e3d171`、比較用baselineは `a116435f2d890fae6ed16100bbdffb4ddd0ce1e2` とした。

## 結果

raw `start`／`resume`へ不正なdescriptorを渡しても、検査対象の境界違反はWasm trapを起こさず、既存の `SESSION_STATUS.FAILED` とfault 5／7／8へ分類されるようになった。検査はmemory load、store、copy、continuation commitより前に完了する。不正なstart後は同じinstanceでstartを再試行でき、不正なresume後は同じgeneration／sequenceのeventを再送できる。受理した再試行では以前のboundary faultを消去する。

linear／typed emitterには、unsigned subtraction形式のrange predicateとhalf-open rangeのoverlap predicateを追加した。typed emitterはembedded request dataとresult scratchをmodule-private rangeとして扱い、callerのoutputとsuccess payloadが重なる呼出しを拒否する。typed `$copy` はsource／target全体のcontainmentと相互overlapをloop前に確認する。

`ok=0` は既存どおりterminal fault 6で終了し、type、payload、outputを要求しない。numeric fault、cancel、disposeのterminal意味も維持した。成功eventではsuccess flagを0／1に限定し、generation、sequence、typed response typeの既存検査を維持した。

## ABIとartifact

profile `module-effects-v1`、ABI `llang-effects-session-v1`、typed layout `typed-wire-v1`、manifest version 5、status 1〜5、既存export、import 0、initial／maximum 512-page memoryを変更していない。linear wireはrequest 16 bytes、event 16 bytes、result 4 bytes、typed wireはrequest 32 bytes、event 24 bytes、result 12 bytesのままである。

代表artifactの差分は次のとおり。追加したguardによりbytesとhashは変わるが、ABIの変更ではない。

| artifact | baseline | hardened | 差分 |
| --- | ---: | ---: | ---: |
| linear | 504 bytes / `06e067c6a2412ea38a7b6092ef6e8c24f606215e6e02392b7af50c6cd905ee0e` | 760 bytes / `1721b9e0cfd227e54f81c2247ceb0c043831cb3d43d8e44655d518a4dc35c3e4` | +256 bytes / +50.79% |
| typed | 686 bytes / `191dd751e313dc454424546dd5202aca6798ac6ded2ab9af85ac2118ecba7e73` | 1126 bytes / `57130a0f23383558ddcf3d034779c71a7bdc8490ffdfc10ee7217fe84b4dd259` | +440 bytes / +64.14% |

baselineではlinear／typedそれぞれの `start(0xffffffff, ...)` とvalid start後の `resume(0xffffffff, ...)` の4 probeが `Out of bounds memory access` でtrapした。hardened artifactでは4件ともtrapせずstatus 4、fault 5になった。固定値と環境は [`freeze.json`](../benchmarks/effects-memory-v1/freeze.json) に保存した。

## テストと証跡

製品runtimeを介さずraw exportとlinear memoryを操作する `EffectsMemoryDirectHarness` を追加した。returnとtrap、status、fault、監視rangeの前後hash、request generation／sequenceを取得できる。固定corpusは [`direct-corpus.json`](../benchmarks/effects-memory-v1/direct-corpus.json)、保証表の正本は [`memory-safety-matrix.json`](../benchmarks/effects-memory-v1/memory-safety-matrix.json) で、両方をstrict JSON Schemaで検査する。[Memory Safety Matrix](./EFFECTS_WASM_MEMORY_SAFETY_MATRIX.md) はJSONから決定的に生成し、testで完全一致を確認する。

検査を意図的に壊した9 mutantをtest内のWAT置換だけで作り、次を個別に検出した。

1. start output containmentの欠落
2. event containmentの欠落
3. unsigned比較からsigned比較への変更
4. event／output overlap検査の欠落
5. typed payload containmentの欠落
6. typed `$copy` whole-range guardの欠落
7. module-private overlap検査の欠落
8. validation前のstate commit
9. success flag 0／1検査の欠落

製品artifactにはtest用branchやinstrumentationを追加していない。public runtime、portable replay、direct ABIの正常sequenceと結果も同じtestで比較した。

検証環境はmacOS arm64、Bun 1.4.2、Binaryen 132.0.0、TypeScript 5.9.3である。

| 検証 | 結果 |
| --- | --- |
| Effects局所test | 23 pass、0 fail、163 assertions |
| portable build／graph | 13 pass、0 fail、64 assertions |
| inspection／execution evidence | 36 pass、0 fail、130 assertions |
| audit／attestation／trust | 23 pass、0 fail、133 assertions |
| Effects smoke | 成功 |
| 全体check | 745 pass、0 fail、15,928 assertions |
| coverage | 745 pass、0 fail、15,927 assertions。全体 functions 92.95%、lines 92.52%。`semantic-transaction.ts` functions 98.36%、lines 96.88%。threshold成功 |
| format／lint／typecheck | 成功。lintはerror 0、既存warning 87 |
| docs／protected／smoke／`git diff --check` | 成功 |

portable Effects回帰ではversion-5 build、manifest parse、inspect、verify、replay、execute、audit、署名、assured trust chainを確認した。

## 受け入れ条件

| ID | 根拠 | 結果 |
| --- | --- | --- |
| EMS1〜EMS2 | freeze、direct harness | 完了 |
| EMS3〜EMS8 | start／resumeのstaged range・overlap・success flag検査、direct negative cases | 完了 |
| EMS9〜EMS15 | generation／sequence／type、typed payload、module-private range、guard付きcopy | 完了 |
| EMS16〜EMS21 | commit前validation、invalid call後の同一instance retry、fault clear、全return pathのbusy解放 | 完了 |
| EMS22〜EMS25 | terminal回帰、unaligned／adjacent／exact-end／zero・maximum payload、最終result capacity、differential test | 完了 |
| EMS26〜EMS28 | 9 mutation test、ABI freeze、test-only mutation | 完了 |
| EMS29〜EMS31 | portable回帰、strict schema・生成文書一致、全品質Gate | 完了 |
| EMS32 | 本文の保証外範囲と未実行OS | 完了 |

## 保証外

Wasmはtyped payloadのtype tag、size、rangeを検査するが、JSON構文やcanonical encodingの意味検証はhost codecが担当する。hostが同期呼出し中にexported memoryを書き換える場合、任意または改変済みWasm、host adapter／grant／外部file・HTTP応答、exactly-once副作用、remote host integrityは今回の保証に含めない。

exported memoryはhostの直接storeを防ぐaccess-control境界ではない。threads、shared memory、memory64、memory growth、reentrant host importも対象外である。長期performance／memory評価とSAAA配備は実施していない。OS検証はmacOS arm64だけで、UbuntuとWindowsは未実行である。
