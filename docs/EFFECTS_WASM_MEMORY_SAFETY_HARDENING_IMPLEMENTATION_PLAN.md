# Effects Wasm メモリー安全性強化 実装計画

作成日: 2026-09-20。状態: 実装前。基点revision: `a116435f2d890fae6ed16100bbdffb4ddd0ce1e2`。

作成時のworktreeにはValue Wasm安全性強化の未コミット差分があるが、Effects emitter／runtime自体は基点revisionから未変更である。実装開始時は既存差分を保持し、Effects対象ファイルだけをbaseline artifactと比較する。

## 目的

`module-effects-v1`のimport-free continuation Wasmを、通常の`LinearEffectsRuntime`／`TypedEffectsRuntime`を介さずに`start`／`resume` exportへ直接入力を渡した場合にも、linear memoryの範囲外をload／storeせず、未分類のWasm trapを起こさない実装へ強化する。

不正なdescriptor base、length、capacity、overlap、typed payload rangeは、既存の`SESSION_STATUS.FAILED`と`fault_code`へ決定的に分類する。検査失敗ではcontinuation state、generation、sequence、terminal、accumulator／resultを進めず、正しい再試行が可能な境界を定義する。

今回の変更は既存ABI `llang-effects-session-v1`の安全性修正である。export、status、fault分類、512-page fixed memory、linear wire、`typed-wire-v1`、manifest version 5、portable replayの意味は変更しない。新しいeffect、動的request、Wasm内JSON decoder、shared memory、memory growthは導入しない。

## 次の実装対象とする理由

[Collectionメモリー安全性と最適化基盤](./COLLECTION_MEMORY_SAFETY_AND_OPTIMIZATION_IMPLEMENTATION_PLAN.md)と[Value Wasmメモリー安全性強化](./VALUE_WASM_MEMORY_SAFETY_HARDENING_IMPLEMENTATION_PLAN.md)により、二つのvalue-oriented ABIはraw call境界まで検査済みになった。Effectsは別のemitter、stateful continuation、32 MiB memory、複数wire layoutを持つため、その保証を継承しない。

現行Effects Wasmは`$yield`でcapacityの最小値を確認するが、`out`と`capacity`がlinear memory内にあることをstore前に確認しない。`resume`は`event`と`length`の包含確認前にevent fieldをloadする。Bun 1.4.2で基点artifactのraw exportを呼ぶと、linear／typedの双方で次が`SESSION_STATUS.FAILED`ではなく`Out of bounds memory access`でtrapした。

- `start(0xffffffff, descriptorBytes)`
- validな`start`後の`resume(0xffffffff, eventBytes, validOut, validCapacity)`

typed pathの`$copy`もhelper自身にはrange guardがなく、outputがembedded requestやresult scratchへ重なる場合のmodule-private memory契約が明文化されていない。Effectsは外部副作用のdispatch前後をstateで表すため、単発value ABIよりも「検査失敗でstateを進めない」ことが重要になる。

## 現在地

### 維持する既存保証

- ABIは`llang-effects-session-v1`、exportは`memory`、`start`、`resume`、`cancel`、`dispose`、`fault_code`で、importはない。
- memoryはinitial／maximumとも512 pageで固定される。
- statusは1 `YIELDED`、2 `RUNNABLE`、3 `DONE`、4 `FAILED`、5 `CANCELLED`である。
- linear layoutは16-byte request、16-byte event、4-byte resultを使う。
- typed layoutは32-byte request、24-byte event、12-byte resultを使う。
- typed payloadは最大`MAX_EFFECT_WIRE_BYTES`で、response type tag、generation、sequenceをWasmが検査する。
- public runtimeはrequestとeventに固定された低位addressを使い、typed responseをcanonical codecでencode／decodeする。
- duplicate、unknown、late response、cancel、numeric fault、portable replay、typed task／streamを既存testが検査する。

### 閉じる差分

1. `start`のoutput rangeをstore前に検査していない。
2. `resume`のevent descriptorを包含確認前にloadする。
3. `resume`のoutput rangeがstate更新前に検査されず、失敗時にstateを消費し得る。
4. eventとoutput、typed payloadとoutputのalias規則が未定義である。
5. typed `$copy`がsource／destination全体のrangeをhelper自身で確認しない。
6. typed outputがembedded request data／result scratchへ重なり、後続状態を破壊できる。
7. direct ABIのsuccess flagが0／1以外でも受理される。
8. trap、fault、memory snapshot、continuation再試行を同じraw harnessで比較する固定corpusがない。
9. 検査順序を意図的に壊したmutantをtestが検出する証拠がない。

## 保証境界

### 保証する対象

- 信頼するcompilerが検証済みlinear／typed Effects IRから生成したWasm。
- raw callerが`start`／`resume`へ渡すoutput descriptor、event descriptor、typed payloadのmemory range。
- range検査失敗時のstatus、fault code、trap禁止、caller input／output、continuation stateの非消費。
- public runtime、portable replay、bundle inspection／executionが使う既存layoutとの互換性。
- `start`／`resume`がdirect outputを通じてembedded request data／result scratchへ書き込まず、response payloadとしてmodule-private bytesを受理しない境界。

### 保証しない対象

- 任意の第三者Wasm、改変済みartifact、hostが同期評価中にmemoryを書き換える場合。
- exported memoryを持つhostがmodule-private bytesを直接書き換える行為。ABI関数はaliasを拒否できるが、memory export自体をaccess-control境界にはできない。
- threads、shared memory、memory64、memory growth、reentrant host import。現行artifactはimport-freeでmemory固定である。
- typed response payloadのJSON構文・canonical encodingをWasmだけで証明すること。Wasmはtype tag、size、rangeを検査し、payload意味はhost codecがdecode時に検査する。
- host adapter、grant、外部file／HTTP応答の真実性、exactly-once副作用、remote host integrity。
- secret confidentiality、constant-time性、一般的なcontrol-flow integrity。
- performance改善。追加guardのartifact sizeと局所時間は記録するが、速度向上を完了条件にしない。

## 互換性方針

| 契約 | 維持する値 |
| --- | --- |
| profile | `module-effects-v1` |
| ABI | `llang-effects-session-v1` |
| typed layout | `typed-wire-v1` |
| build manifest | version 5 |
| exports | `memory`, `start`, `resume`, `cancel`, `dispose`, `fault_code` |
| imports | 0 |
| memory | initial 512 / maximum 512 pages |
| status | 1〜5の既存`SESSION_STATUS` |
| linear wire | request 16 / event 16 / output 4 bytes |
| typed wire | request 32 / event 24 / output 12 bytes |
| typed payload | 既存`MAX_EFFECT_WIRE_BYTES` |

Wasmのunaligned load／storeは定義済みで、現行ABIはalignmentをcaller要件にしていない。containedかつ互いに許可されたunaligned bufferは引き続き受理する。base 0も、module-private領域と重ならずrangeがcontainedなら一律には拒否しない。

raw direct callerに対しては、event descriptor、そのtyped payload、output bufferをcaller-owned regionとして扱い、呼出し中は変更しないことを要求する。成功responseから次のrequest／resultを書くresumeでは、event descriptorとoutput、typed payloadとoutputの重なりを拒否する。隣接するrangeとzero-length payloadは重なりではない。`ok=0`はoutputを使用せずterminal failureになる既存挙動を維持する。

typed Wasmのembedded request dataとresult scratchはmodule-privateである。callerのoutputとresponse payloadはこれらへ重ねない。public runtimeがresponseを書き込む`EVENT_PAYLOAD_START`側の領域はcaller inputとして扱い、module-private result scratchとは分離する。この所有規則はABI callの検査であり、hostによるmemory exportへの直接storeを防ぐsandboxではない。

## faultとstate transaction

既存fault番号の意味を拡張せず、次に固定する。

| 条件 | status | fault code | state |
| --- | --- | --- | --- |
| descriptor length／capacity／base／containment／overlap不正 | `FAILED` | 5 | 非消費、`busy=0` |
| typed payload size／range不正 | `FAILED` | 8 | 非消費、`busy=0` |
| response type不一致 | `FAILED` | 7 | 非消費、`busy=0` |
| response `ok=0` | `FAILED` | 6 | 既存どおりterminal failure |
| numeric overflow | `FAILED` | 3 | 既存どおり |

不正な`start`後は、同じinstanceへの正しい`start`を許す。不正な`resume`はpending responseを消費せず、同じgeneration／sequenceの正しいeventで再試行できる。受理した遷移の開始時に前回のretryable boundary faultをclearし、成功後の`fault_code`が古い失敗を示さないようにする。terminal failure、cancel、dispose後の再開拒否は維持する。

出力に必要なbytesはstate更新前に求める。linear／typedとも、次がrequestならrequest descriptor size、最後のresponseならresult descriptor sizeを使う。最終結果の小さいcapacityを、次request用の最大descriptor sizeへ不必要に引き上げない。

## 実装設計

### 1. 共通range predicate

両emitterのWATに、加算wraparoundへ依存しない小さなpredicateを置く。

```text
base <= memoryBytes && length <= memoryBytes - base
```

overlapは、contained確認済みのendまたは減算形式を使う。signed比較へ置き換えず、i32 bit patternをunsigned addressとして扱う。range checkのoperandにload、store、loopを含めない。

typed emitterでは次のpredicateも分離する。

- caller rangeとembedded request dataの非重複。
- caller rangeとresult scratchの非重複。
- event descriptor／payloadとoutputの非重複。
- `$copy(source, target, length)`のsource／target whole-range containment。

### 2. `start`のstaged validation

`start`は次の順序で処理する。

1. terminal／busyの既存状態を確認する。
2. 最初のrequest descriptorに必要なcapacityを確認する。
3. 宣言されたoutput range全体のmemory containmentを確認する。
4. typed outputがmodule-private rangeと重ならないことを確認する。
5. 検査成功後だけ`busy`、state、sequence、accumulator／resultを初期化する。
6. `$yield`がdescriptorを書き込む。
7. 全return pathで`busy=0`に戻す。

失敗時にoutputやmodule-private dataを書き換えない。`$yield`にもrange guardを残し、将来の内部caller追加で前提が外れてもtrapしないようにする。

### 3. `resume`のstaged validation

`resume`はmemory loadとstate更新を分離する。

1. terminal／busyを確認する。
2. `length`がexact event sizeであることを確認する。違う場合はeventを読まない。
3. event descriptor全体のmemory containmentを確認する。
4. contained eventからgeneration、sequence、success flag、type tag、payload descriptorをlocalsへ一度だけloadする。
5. success flagが0／1、generation／sequence／type tagが期待値と一致することを確認する。
6. typed payloadのsize、memory containment、module-private非重複を確認する。
7. 次stateに必要なoutput bytes、output range、event／payloadとの非重複、typed module-private非重複を確認する。
8. すべて成功した後だけ`busy=1`とし、accumulator／result copy、state increment、次の`$yield`を行う。
9. すべてのreturn pathで`busy=0`を保証する。

event fieldを複数回loadせずlocalsを使う。検査後のhostによる同時memory変更は保証外だが、通常の同期callerで検査値と使用値が分離しない形にする。

success flagが0の場合は、generation／sequenceとflagの検査後に既存のterminal failureへ遷移し、type tag、payload、outputを要求しない。success flagが1の場合だけ手順5以降のtype／payload／output検査とstate commitを行う。

### 4. typed copyとmodule-private memory

`$copy`はfaultがある場合に即returnし、source／targetのwhole rangeを確認してからloopへ入る。loop内で毎byte同じrangeを再検査しない。sourceとtargetが重なる場合は拒否し、現行のforward-copy結果へ依存しない。

embedded request payloadはbuild時の`[DATA_START, embeddedEnd)`、result scratchは`[RESULT_START, RESULT_START + MAX_EFFECT_WIRE_BYTES)`としてemitterが把握する。direct outputとresponse payloadがこれらへ重なる場合はboundary faultにする。data segment間の既存上限と`EVENT_PAYLOAD_START`の配置を維持する。

payloadをresult scratchへcopyした後、result descriptorを書く前にfaultを再確認する。copy失敗時はstate、result length／typeをcommitしない。

### 5. direct harness

`src/llang-effects-memory-direct-harness.ts`を追加し、linear／typedの両artifactをhost runtimeなしで操作する。

- compile／instantiateとexport shape確認。
- raw memory bytesの配置。
- `start`／`resume`への任意i32引数。
- return status、fault code、Wasm trapの区別。
- event、output、payload、module-private canaryのbefore／after hash。
- request generation／sequence／stateのdecode。
- invalid call後のvalid retry。

harnessは製品runtimeへ組み込まない。期待値は固定corpus、既存ABI定数、独立したrange計算から作り、生成WATのhelperをoracleとして再利用しない。

## 固定corpus

### positive／compatibility

- linear／typedの通常start、複数resume、done、cancel、dispose。
- request／event／outputのunalignedだがcontainedなbase。
- memory末尾へちょうど収まるdescriptor。
- eventとoutput、payloadとoutputが隣接する非overlap境界。
- typed zero-length payloadと`MAX_EFFECT_WIRE_BYTES`ちょうど。
- 最終resumeでresult descriptor分だけのcapacity。
- invalid start／resume後の同一instance retry。
- public runtime、portable replay、raw direct ABIのrequest sequence／result一致。

### negative

- base `0xffffffff`、memory末尾超過、length／capacity wraparound相当値。
- descriptorより1 byte短いcapacity／length。
- eventとoutputの完全、部分、1-byte overlap。
- typed payloadがevent前、memory外、end wraparound、上限超過。
- typed payloadとoutputのoverlap。
- output／payloadがembedded request dataまたはresult scratchへ重なるcase。
- success flag 2、generation／sequence／type tag不一致。
- output不正とevent不正が同時にあるcase。
- retryable boundary fault後に同じsequenceのvalid eventを渡すcase。

各negative caseは期待status、fault code、trap禁止、変更可能なglobal／memory範囲を持つ。単に例外になれば合格とはせず、raw Wasm trapと`FAILED`を区別する。

## mutation sensitivity

最低限、次のmutantを固定caseで検出する。

1. `start` output containmentを省く。
2. event containmentより前にevent fieldをloadする。
3. unsigned base比較をsigned比較へ変える。
4. event／output overlap checkを省く。
5. typed payload containment checkを省く。
6. typed `$copy`のsource／target guardを省く。
7. module-private rangeとのoverlap checkを省く。
8. validation完了前にbusy／state／sequenceをcommitする。
9. success flag 0／1 checkを省く。

mutantはtest内のWAT置換またはtest-only fixtureに限定し、製品artifactやmanifestへoptionを追加しない。各mutantを殺すcase IDをmatrixへ記録する。

## 成果物

- `benchmarks/effects-memory-v1/freeze.json`: revision、Bun、Binaryen、ABI、layout、limits、基点artifact、trap再現。
- `benchmarks/effects-memory-v1/direct-corpus.json`: linear／typedのraw vectorと期待status／fault／state分類。
- `benchmarks/effects-memory-v1/memory-safety-matrix.json`: 保証層、state transaction、positive／negative vector、制限。
- `schemas/effects-memory-direct-corpus-v1.schema.json`: direct corpusのstrict schema。
- `schemas/effects-memory-safety-matrix-v1.schema.json`: matrixのstrict schema。
- `docs/EFFECTS_WASM_MEMORY_SAFETY_MATRIX.md`: matrix JSONから決定的に生成する表。
- `docs/EFFECTS_WASM_MEMORY_SAFETY_HARDENING_RESULTS.md`: 実装結果、baseline再現、artifact差分、受け入れ条件、未保証範囲。
- direct harness、WAT range helper、state transaction test、mutation test。

生成MarkdownはJSONと手作業で二重管理しない。freezeとcorpusは結果を見て期待statusを緩めず、変更する場合はversionを上げて理由を記録する。

## 実装単位

### PR-0: baselineと契約freeze

- 基点revision、Bun 1.4.2、Binaryen 132.0.0、512-page memory、ABI、linear／typed layoutを固定する。
- representative artifactを固定する。基点値はlinear 504 bytes／SHA-256 `06e067c6a2412ea38a7b6092ef6e8c24f606215e6e02392b7af50c6cd905ee0e`、typed 686 bytes／SHA-256 `191dd751e313dc454424546dd5202aca6798ac6ded2ab9af85ac2118ecba7e73`である。
- 四つの`0xffffffff` raw probeを同じruntimeで再現し、status／trap／memory／retry状態を記録する。
- corpus／matrix schema、case ID、fault分類を固定する。

出口: linear／typedの修正前挙動と期待契約を同じvectorで比較できる。

### PR-1: direct harnessとboundary corpus

- linear／typed共通のdirect harnessを追加する。
- status、fault、trap、memory hash、request sequence、retryを取得する。
- valid public runtime／portable replayの結果とraw callを比較する。

出口: 基点の四trapを再現し、正常sequenceは既存runtimeと一致する。

### PR-2: linear continuation境界

- linear `$yield`、`start`、`resume`へstaged range／overlap validationを追加する。
- success flagを0／1へ限定する。
- invalid callでaccumulator、step、sequenceを消費せずretry可能にする。

出口: linear negative corpusがtrapせず既存faultへ分類され、valid replay hashが変わらない。

### PR-3: typed descriptor／payload境界

- typed eventをcontained確認後にlocalsへloadする。
- payload size／range、output range、alias、module-private overlapをstate更新前に検査する。
- type tag、generation、sequence、success flagをstagedに検査する。

出口: typed descriptor／payload negative corpusがtrapせず、正しいretryと既存task／streamを維持する。

### PR-4: copy helperとstate transaction

- `$copy`へwhole-range／overlap guardを追加する。
- copy、result metadata、state increment、yieldをcommit順に並べる。
- fault pathの`busy=0`とfirst-fault保持を全return pathで検査する。

出口: copy／output失敗がpartial state commitやinstance poisoningを起こさない。

### PR-5: differentialとmutation

- linear／typedのpublic runtime、portable replay、direct ABIを固定corpusで比較する。
- 九つのmutantを対応caseが検出する。
- adjacent、unaligned、exact-end、maximum payloadの互換caseを追加する。

出口: validatorと同じ実装だけをoracleにせず、検査欠落と順序退行を検出できる。

### PR-6: portable artifact回帰

- build、manifest parse、inspect、verify、replay、execute、audit、signed／assured chainを回帰確認する。
- export、import、memory、layout、status、fault、operation sequence、bundle identityの意味を維持する。
- artifact bytes変更は記録するが、ABI変更とは扱わない。

出口: memory safety修正がversion-5 portable Effects chainを破っていない。

### PR-7: matrix、文書、品質Gate

- Effects仕様、SECURITY、QUALITY_GATES、CLI reference、roadmap、docs indexを更新する。
- schema付きmatrixからMarkdownを生成するscriptと一致testを追加する。
- 結果文書へVMSとは別のEMS受け入れID、環境、件数、coverage、artifact hash、未実行OSを記録する。

出口: 実装、test、仕様、運用文書が同じmemory／state保証を述べ、全品質Gateが成功する。

## 受け入れ条件

| ID | 完了条件 |
| --- | --- |
| EMS1 | freezeがrevision、Bun 1.4.2、Binaryen 132.0.0、ABI、layout、memory、artifact hashを固定する。 |
| EMS2 | direct harnessがhost runtimeを介さずraw `start`／`resume`を呼ぶ。 |
| EMS3 | linear／typedのinvalid output baseがtrapせず`FAILED`／fault 5になる。 |
| EMS4 | invalid event base／lengthをevent load前に拒否する。 |
| EMS5 | containmentが加算wraparoundやsigned比較へ依存しない。 |
| EMS6 | declared output range全体がmemory内にあることをstore前に確認する。 |
| EMS7 | success responseのevent descriptorとoutputの完全・部分・1-byte overlapを拒否する。 |
| EMS8 | success flagは0／1だけを受理する。 |
| EMS9 | generation、sequence、type tagの既存検査を維持する。 |
| EMS10 | typed payload sizeをload／copy前に検査する。 |
| EMS11 | typed payload rangeを減算形式で検査し、wraparoundを拒否する。 |
| EMS12 | typed success payloadとoutputのoverlapを拒否する。 |
| EMS13 | `start`／`resume`がoutput rangeを通じてembedded request dataを書き換えない。 |
| EMS14 | `resume`がresult scratchをresponse inputまたはoutputとして受理しない。 |
| EMS15 | `$copy`がsource／target whole rangeをloop前に確認する。 |
| EMS16 | invalid startでstate、sequence、accumulator／result、terminalを変更しない。 |
| EMS17 | invalid resumeでpending stateとsequenceを消費しない。 |
| EMS18 | invalid start後のvalid startが同一instanceで成功する。 |
| EMS19 | invalid resume後の同じsequenceによるvalid retryが成功する。 |
| EMS20 | 全return pathで`busy=0`となり、boundary failureでinstanceがpoisonされない。 |
| EMS21 | accepted retry後にstale boundary faultが残らない。 |
| EMS22 | `ok=0`、numeric fault、cancel、disposeのterminal意味を維持する。 |
| EMS23 | unaligned、adjacent、exact-end、zero-length payloadの安全な既存入力を受理する。 |
| EMS24 | 最終resumeは既存result descriptor分のcapacityで成功する。 |
| EMS25 | public runtime、portable replay、direct ABIのvalid sequence／resultが一致する。 |
| EMS26 | 九つのmutantがそれぞれ指定caseで検出される。 |
| EMS27 | export、import、memory、ABI、layout、manifest version、statusを変更しない。 |
| EMS28 | product Wasmへtest instrumentationやmutant branchを含めない。 |
| EMS29 | version-5 build／inspect／verify／execute／audit／attestation回帰が成功する。 |
| EMS30 | corpus／matrix JSONがstrict schemaに適合し、生成Markdownと一致する。 |
| EMS31 | 局所test、Effects smoke、全体check、coverage、docs、protected、`git diff --check`が成功する。 |
| EMS32 | 結果文書がWasm内payload意味検証、host同時変更、外部副作用、未実行OSを保証外として明記する。 |

## 検証計画

### 局所検証

```sh
npx -y bun@1.4.2 test src/llang-effects-wasm.test.ts src/llang-effects-state-machine.test.ts src/llang-effects-memory.test.ts --timeout 30000
npx -y bun@1.4.2 run ci:effects-smoke
npx -y bun@1.4.2 run effects:memory:matrix
```

追加script名は`package.json`とCLI referenceへ同時反映する。direct fixtureはnetwork、credential、adapter、real clockを使わない。

### portable Effects回帰

```sh
npx -y bun@1.4.2 test src/llang-effects-build.test.ts src/llang-module-effects-build.test.ts src/llang-module-effects-graph.test.ts --timeout 30000
npx -y bun@1.4.2 test src/llang-effects-bundle-inspection.test.ts src/llang-effects-execution-evidence.test.ts --timeout 30000
npx -y bun@1.4.2 test src/llang-effects-execution-audit.test.ts src/llang-effects-attestation-crypto.test.ts src/llang-effects-trust-policy.test.ts --timeout 30000
```

### 最終Gate

```sh
npx -y bun@1.4.2 run format
npx -y bun@1.4.2 run check
npx -y bun@1.4.2 run coverage
npx -y bun@1.4.2 run ci:docs
npx -y bun@1.4.2 run ci:protected
npx -y bun@1.4.2 run ci:smoke
git diff --check
```

結果にはcommand、終了値、test／assertion件数、coverage、Bun／TypeScript／Binaryen、OS／architecture、linear／typed representative Wasm hashとbytesを記録する。Ubuntu／macOS／Windowsは同一revisionで実行したOSだけを成功として記録する。

## レビュー観点

- すべてのload／storeは、そのpathでrange containment確認に支配されているか。
- `i32.or`／`i32.and`のoperandへload、store、copy callを混ぜていないか。
- event length不正時にevent baseを一切読まないか。
- output不正をstate／sequence incrementより前に検出するか。
- event fieldは検査後に再loadせずlocalsを使用するか。
- unsigned address比較と`memoryBytes - base`がi32 bit patternへ正しいか。
- descriptor、payload、output、module-private rangeの境界接触をoverlapと誤判定しないか。
- `$copy`失敗後にresult length／typeやstateをcommitしないか。
- retryable faultとterminal failureを混同していないか。
- raw direct oracleがemitter validatorの同じ式を共有していないか。
- Binaryen moduleを例外時にもdisposeし、version 132の固定APIだけを使うか。
- artifact hash変更をABI／semantic contract変更と混同していないか。

## 完了条件

EMS1〜EMS32をすべて満たし、結果文書へ実装・test・artifact・文書の根拠を対応付けた時点で完了とする。trapを再現できないcase、fault分類が既存callerと衝突するcase、portable chainで回帰するcaseは推測で完了にせず、条件と判断を結果文書へ残す。

完了は`module-effects-v1`のimport-free linear／typed continuation ABIのmemory／state transaction境界に限る。typed payloadの意味検証、任意Wasm、外部adapterの安全性、live副作用の正当性、長期performance／memory、SAAA配備の完了は主張しない。
