# Value Wasm メモリー安全性強化 実装計画

作成日: 2026-09-20。状態: 実装済み。基点 revision: `a116435f2d890fae6ed16100bbdffb4ddd0ce1e2`。結果は[実装結果](./VALUE_WASM_MEMORY_SAFETY_HARDENING_RESULTS.md)に記録する。

## 目的

`module-value-v1` が生成する Wasm の `evaluate` を、通常の host runtime を介さず直接呼び出した場合にも、壊れた ABI 入力を memory load より前に拒否できるようにする。不正入力は既存 ABI が定める status 1へ決定的に分類し、入力範囲外の読み出し、出力範囲外の書き込み、未分類の Wasm trap を起こさない。

今回の変更は `llang-value-memory-v1` の互換性を維持する安全性修正である。型、言語構文、export、status code、manifest version、memory page 数、wire 上限は変更しない。新しい optimizer、ABI v2、一般的な pointer 言語、任意 Wasm の安全性証明は導入しない。

## 次の実装対象とした理由

[Collection メモリー安全性と最適化基盤](./COLLECTION_MEMORY_SAFETY_AND_OPTIMIZATION_IMPLEMENTATION_PLAN.md)では `module-collection-v1` の direct ABI 境界と allocator を強化した。一方、`module-value-v1` は別 emitter と別 ABI 実装を持ち、Collection の修正から自動的な保証を受けない。

現行 `src/llang-module-value-wasm.ts` の文字列入力検査は、長さ、pointer、end、UTF-8 の条件を `i32.or` で結合する。Wasm の `i32.or` は短絡しないため、pointer の包含検査が失敗していても `$utf8_valid` が評価される。計画作成時に既存 `module-order-line` artifactのexportを直接呼び、string pointer=`0xffffffff`、length=`1` を渡すと、status 1ではなく `Out of bounds memory access` の `RuntimeError` が再現した。

Effects adversarial benchmark の次段階には、実装担当から独立した dataset author、別の domain reviewer、外部 timestamp、owner の実行承認が必要である。このリポジトリ内の実装だけで完了できる作業ではない。その外部 Gate を迂回せず、現時点で再現・実装・完了判定が可能な Value ABI の安全性差分を先に閉じる。

## 現在地と確認済みの差分

### 既存の保証

- `evaluate(inputPtr, inputLength, outputPtr, outputCapacity)` は status 0〜5を返す。
- memory は初期・最大とも16 pageで、importなし、exportは `memory` と `evaluate` の二つである。
- input／output wire は各64 KiB、文字列は16 KiB、fuelは100,000に制限される。
- root buffer の最小長、memory containment、input／output overlapを entry prologueで検査する。
- boolean、union tag、string長、UTF-8を型に従って検査する。
- public runtimeは呼出しごとに新しい instanceを生成し、host codecで入力を作り、成功結果だけをdecodeする。
- build manifest、portable suite、artifact verifierがABI、layout hash、Wasm hash、memory、import／exportを検査する。

### 閉じる差分

1. 文字列 payload の範囲検査と `$utf8_valid` 呼出しが短絡されていない。
2. 型別 validator が大きな式として生成され、各 memory load の支配条件を局所的にレビューしにくい。
3. 現行 raw ABI test は一部の不正入力を扱うが、trap、status、書込み範囲、境界値を一つの direct harness で横断確認していない。
4. `$alloc`、`$mem_copy`、`$mem_zero` は生成側の前提に依存し、helper 自身の remaining-capacity 検査を持たない。
5. host runtime、reference evaluator、direct ABI の三経路を同じ corpus で比較する固定試験がない。
6. 意図的に検査を壊した mutant が direct test に検出されることを確認していない。

このprobeはmacOS上のBun 1.3.14による一回の再現で、repository fileを変更しない一時scriptを使った。memory corruptionや他runtimeでの同一挙動までは示さない。PR-0でBun 1.4.2の固定corpusとして再実行し、修正前後のstatus、trap、memory snapshotを記録する。

## 保証境界

### 保証する対象

- 信頼する L-Lang compiler が `module-value-v1` の検証済み IR から生成した Wasm。
- その Wasm の `evaluate` に、壊れた base、length、capacity、boolean、union tag、string descriptor、UTF-8 bytesを渡す direct caller。
- input／output wire、内部 arena、string copyに対する linear memory containment。
- 検証失敗時の status、trap有無、書込み範囲、同じ入力に対する経路間の結果一致。

### 保証しない対象

- 任意の第三者 Wasm、改変済み artifact、host が評価中に memory を同時変更する場合。
- threads、shared memory、memory64、memory growth、再入。現行 artifact verifierはこれらを受理しない。
- raw pointer、任意 alias、貸借・所有権を公開する新しい言語機能。
- secret confidentiality、constant-time実行、side-channel耐性。
- `module-collection-v1`、`module-effects-v1`、legacy bool ABIへの保証の一般化。
- 性能向上。安全性修正の費用は測定できるが、速度改善を完了条件にしない。

## 互換性方針

次を維持する。

| 契約 | 維持する値 |
| --- | --- |
| profile | `module-value-v1` |
| ABI | `llang-value-memory-v1` |
| build manifest | version 2 |
| exports | `memory`, `evaluate` |
| imports | 0 |
| memory | initial 16 / maximum 16 pages |
| status | 0 success、1 invalid input、2 arithmetic、3 division、4 resource、5 invalid artifact |
| wire limit | input／output各65,536 bytes |
| string limit | 16,384 UTF-8 bytes |
| fuel | 100,000 |

Wasm は非整列 load を定義しており、現行仕様は pointer alignment を入力要件として明記していない。この計画では unaligned root／string payloadを新たに拒否せず、既存受理範囲を維持する。

length 0の文字列pointer、複数fieldが同じimmutable payloadを参照するalias、root内のbytesを文字列として参照する表現も、現行 ABI が禁止していないため一律に拒否しない。canonical encoderが生成する形と direct ABI が受理する安全な形を区別する。paddingとinactive union payloadは出力時にzero化するが、入力の非zero paddingを新しい互換性条件として拒否しない。

## 実装設計

### 1. staged entry validation

`evaluate` の検査を次の順序に固定する。

1. `inputLength`／`outputCapacity` の最小値と64 KiB上限。
2. input／output baseが既存の最小address 64以上、memory size以下であること。
3. `length <= memorySize - base` の減算形式によるcontainment。
4. containment確認済みのendを使ったinput／output overlap検査。
5. root layout内のscalar、descriptor、tagの型別検査。
6. descriptorのpayload containment。
7. containment確認済みpayloadだけに対するUTF-8検査。
8. 検査完了後だけoutput zero化、arena設定、entry関数実行。

各段階は前段失敗時に即時returnする。memoryに触れる条件を `i32.or` のoperandへ並べない。純粋な整数比較をまとめる場合も、後続にload／callを含まないことをコードレビューとtestで確認する。

### 2. 型別 validator

compile時に型layoutから validatorを生成する。実行時の一般的なreflectionは追加しない。

- `boolean`: slot containment確認後、0または1だけを受理する。
- `i32`: slot containment以外の値制約を持たない。
- `string`: 8-byte descriptorを安全にloadし、16 KiB上限、input wire内包含を順に確認してからUTF-8を走査する。
- `record`: root layoutの包含を一度確認し、field順に再帰検査する。最初の失敗で停止する。
- `union`: tag slotを安全にloadし、範囲内tagだけを選び、選択variantのfieldだけを検査する。

型深度8、layout node 4,096、wire 64 KiBという既存compile／runtime上限を維持する。validatorが外部入力に対して無制限再帰や二次走査を追加しない。

### 3. 範囲検査helper

生成WATに小さなhelperを置く場合、責務を分ける。

- `$range_in_memory(base, length)`: `base <= memoryBytes` と `length <= memoryBytes - base`。
- `$range_in_input(base, length)`: memory containment確認後、`base >= inputBase` と `length <= inputEnd - base`。
- overlap判定: 事前に確認済みendを使い、加算wraparoundへ依存しない。

memoryは現行契約の16 page固定値を使えるが、定数と実memoryの不一致はartifact verifierとinstance確認で拒否する。将来のmemory可変化を今回へ先取りしない。

### 4. UTF-8 validator

UTF-8 validatorはpayload全体がinput wire内にあることをcaller側で確認してからだけ呼ぶ。validator内部でも `remaining >= width` を加算wraparoundなしで確認してからcontinuation byteを読む。

次を明示的に検査する。

- ASCII、2／3／4-byte scalarの最小・最大境界。
- truncated sequence、孤立continuation、overlong encoding。
- surrogate range、`U+10FFFF`超過。
- 16 KiBちょうどと16 KiB超過。
- memory末尾とinput末尾に接するpayload。

### 5. allocatorとmemory helper

`$alloc` はheap更新前に、alignment paddingと要求sizeを残容量へ順番に比較する。失敗時にarenaを更新しない。内部生成コードの矛盾でのみ起こる範囲違反は status 5 `INVALID_ARTIFACT`、既存の正当な資源枯渇は status 4 `RESOURCE_LIMIT` とし、最初のfaultを後続helperで上書きしない。

`$mem_copy` と `$mem_zero` は、呼出し前にsource／destinationの範囲が確認されている構造を保つ。共通helperに実行時guardを追加する場合は、output capacity不足を status 4、生成artifactの内部範囲違反を status 5へ分ける。1 byteずつのloop内で毎回同じ全体範囲を再検査しない。

`$out_string` は `length <= outEnd - cursor` を確認してからcopyする。alignmentでcursorを進める場合も、実際に書くbytesと次の開始位置を別に検査し、capacity外をzero化またはcopyしない。

### 6. faultと書込み規則

- entry validationの失敗はstatus 1で返し、input、output、両buffer外canaryを変更しない。
- arithmetic／division／resource faultは既存statusを維持する。
- status 0以外の結果をhost runtimeがdecodeしない既存動作を維持する。
- evaluation開始後のfaultではoutput wire内がzero化済みまたは部分構築済みでもよい。内部arenaはinput／outputと重ならないmodule-private memoryを使うため、宣言buffer外の全bytes不変はABI契約にしない。
- public runtimeはfresh instance per callを維持する。direct harnessでは同一instance上のinvalid-input後にvalid callが既存どおり成功することも確認する。

## direct ABI harness

`src/llang-module-value-direct-harness.ts` を追加し、hostの `encodeValueToMemory` と `instantiateValueModule(...).evaluate` を通さず、次を制御できるようにする。

- generated Wasmのcompile／instantiate。
- raw memory bytesの配置。
- `evaluate` 4引数の直接指定。
- statusまたはtrapの記録。
- 呼出し前後のinput、output、canary snapshot。
- 成功時だけの独立decode。
- 同一instance再呼出し。

harnessは製品runtimeではなくtest支援である。安全性のoracleを生成validatorと共有しない。期待値は固定corpus、host codec、reference evaluator、明示的なstatus規則から作る。

## test corpus

### positive／boundary corpus

- boolean、i32最小・最大、空文字列、ASCII、2／3／4-byte Unicode。
- nested record、各union variant、同じpayloadを参照する安全なalias。
- root／payloadがinput末尾に一致するケース。
- output rootだけで足りる値、output capacity末尾まで使う文字列。
- unalignedだがmemory内にあるbase／payload。
- direct ABI、public runtime、reference evaluatorの同値比較。

### negative corpus

- baseが0、memory末尾超過、`0xffffffff`、length／capacityのunderflow相当値。
- root layoutより短い `inputLength` と `outputCapacity`。
- input／outputの完全、部分、1-byte境界overlap。
- boolean 2、範囲外union tag。
- string pointerがinput前、input後、memory外、end wraparoundになるdescriptor。
- string length 16,385、invalid UTF-8全分類、末尾でtruncatedしたmulti-byte sequence。
- nested record／selected union内の壊れたstring descriptor。
- output不足、arena枯渇、copy境界。

各negative caseは期待status、trap禁止、変更可能範囲を持つ。単に「例外になった」ことを合格にせず、raw Wasm trapとstatus 1／4／5を区別する。

## mutation sensitivity

testが実装と同じ誤りを見逃さないよう、少なくとも次の意図的変異を検出する。

1. payload containmentより前にUTF-8 validatorを呼ぶ。
2. `inputLength` をroot検査で無視する。
3. unsigned containmentをsigned比較へ置き換える。
4. input／output overlap検査を省く。
5. selected union以外のpayloadも読む。
6. allocatorをheap更新後検査へ戻す。
7. output copyのcapacity検査を省く。

mutantは製品artifactへ混ぜない。小さなWAT fixtureまたは明示的なtest-only emitter optionとして隔離し、各mutantを殺すcase IDを表に残す。

## 成果物

- `benchmarks/value-memory-v1/freeze.json`: 対象revision、ABI、memory、上限、Bun、Binaryenを固定。
- `benchmarks/value-memory-v1/direct-corpus.json`: direct ABIの固定vectorと期待分類。
- `schemas/value-direct-corpus-v1.schema.json`: direct corpusのstrict schema。
- `benchmarks/value-memory-v1/memory-safety-matrix.json`: 保証層、条件、positive／negative vector、制限。
- `schemas/value-memory-safety-matrix-v1.schema.json`: matrixのstrict schema。
- `docs/VALUE_WASM_MEMORY_SAFETY_MATRIX.md`: JSONから決定的に生成する人間向け表。
- `docs/VALUE_WASM_MEMORY_SAFETY_HARDENING_RESULTS.md`: 実装結果、再現、受け入れ条件、未保証範囲。
- direct harness、型別validator、memory helper、局所test、mutation test。

生成Markdownは手作業でJSONと二重管理せず、generatorと一致testを置く。freezeは結果に合わせて閾値や期待statusを書き換えない。

## 実装単位

### PR-0: baselineと再現固定

- 基点revision、Bun 1.4.2、Binaryen 132、ABI、limitsをfreezeする。
- 現行artifact hash、export／import、Wasm bytes、主要suite結果を記録する。
- eager UTF-8 caseをBun 1.4.2のraw callで再現し、計画作成時のBun 1.3.14 probeとの差を含めてtrapかstatusかを記録する。
- matrix schema、corpus schema、case IDを固定する。

出口: 実装前の挙動と期待する修正後契約を、同じcaseで比較できる。

### PR-1: direct harnessと境界corpus

- direct harnessを追加する。
- positive／negative vectorを読み、status、trap、snapshot、canaryを検査する。
- public runtimeやhost codecをoracleにしないraw caseを含める。

出口: 現行validatorの欠陥を少なくとも一つ再現し、正常caseは既存結果と一致する。

### PR-2: staged type validator

- `invalidInput` の巨大なboolean式を段階的なvalidatorへ置換する。
- string containment後だけUTF-8を呼ぶ。
- recordはfield順、unionはselected variantだけを検査する。
- invalid inputは書込み前にstatus 1でreturnする。

出口: 全negative inputがtrapせず期待statusになり、valid corpusの意味が変わらない。

### PR-3: allocator、copy、output境界

- allocatorをremaining-capacity形式へ変更する。
- UTF-8 continuation、copy、zero、out stringのload／store前条件を明示する。
- 最初のfault分類とcanary不変を検査する。

出口: 内部helperの全load／storeが検査済み範囲に支配され、output writerがcapacity外へcopyしない。module-private arenaの変更は別に扱う。

### PR-4: differentialとmutation

- reference evaluator、generated TypeScript、public Wasm runtime、direct ABIをpositive corpusで比較する。
- 七つのmutantを対応caseが検出することを確認する。
- nested type、境界UTF-8、同一instance再呼出しを追加する。

出口: validator実装を自己oracleにせず、検査の欠落と順序退行を検出できる。

### PR-5: portable artifact回帰

- build、manifest parse、artifact verify、version-2 suite、移動後verifyを実行する。
- 既存 `module-order-line` のTypeScript／JSONC／Wasm出力を比較する。
- export、ABI、layout hash、resource contractが不変であることを確認する。

出口: 安全性修正がportable artifact契約を破っていない。

### PR-6: 文書、matrix、品質Gate

- Value仕様、CLI reference、SECURITY、QUALITY_GATES、roadmap、docs indexを更新する。
- machine-readable matrixからMarkdownを生成する。
- 結果文書に実行環境、件数、artifact hash、未実行OS、保証境界を記録する。

出口: 実装、test、仕様、現在地が同じ保証を述べ、全品質Gateが通る。

## 受け入れ条件

| ID | 完了条件 |
| --- | --- |
| VMS1 | freezeがrevision、ABI、limits、Bun 1.4.2、Binaryen 132を固定する。 |
| VMS2 | direct harnessがhost encode／runtime evaluateを介さずraw exportを呼ぶ。 |
| VMS3 | malformed pointer、length、capacityがraw Wasm trapではなくstatus 1になる。 |
| VMS4 | root layoutより短いinputをroot load前に拒否する。 |
| VMS5 | memory containmentを加算wraparoundに依存せず検査する。 |
| VMS6 | input／outputの完全・部分・境界overlapを拒否する。 |
| VMS7 | string descriptorを安全にloadし、payload containment後だけUTF-8を読む。 |
| VMS8 | invalid pointerとvalid-looking lengthの組合せでもUTF-8 loadへ進まない。 |
| VMS9 | booleanは0／1だけ、unionは範囲内tagだけを受理する。 |
| VMS10 | union validatorはselected variant以外のfieldを読まない。 |
| VMS11 | nested record／unionの壊れたstringを同じ規則で拒否する。 |
| VMS12 | UTF-8のvalid境界とinvalid分類を決定的に検査する。 |
| VMS13 | 16 KiB文字列を受理し、超過を拒否する。 |
| VMS14 | invalid-inputではinput、output、capacity外canaryが不変である。 |
| VMS15 | evaluation faultでもinputを変更せず、output writerはoutput capacity外へcopyしない。module-private arenaの変更は区別する。 |
| VMS16 | allocatorは成功確認後だけarenaを更新する。 |
| VMS17 | copy／zero／out-stringの各書込みに事前の範囲根拠がある。 |
| VMS18 | 最初のfault codeを後続処理が上書きしない。 |
| VMS19 | invalid-input後の同一instance valid callが既存どおり成功する。 |
| VMS20 | reference、generated TypeScript、public Wasm、direct ABIのvalid結果が一致する。 |
| VMS21 | 七つのmutantがそれぞれ指定caseで検出される。 |
| VMS22 | `memory` と `evaluate` 以外のexport、import、start、memory growthを追加しない。 |
| VMS23 | ABI、manifest version、layout hashの意味、status、resource limitsが不変である。 |
| VMS24 | 既存 version-2 suiteとportable verificationが成功する。 |
| VMS25 | product Wasmにtest instrumentationやmutant分岐を含めない。 |
| VMS26 | matrix JSONがschemaに適合し、生成Markdownと一致する。 |
| VMS27 | fixture／testはnetwork、credential、API callを必要としない。 |
| VMS28 | Value局所test、module smoke、全体check、coverage、docs、protectedが成功する。 |
| VMS29 | `git diff --check`が成功し、結果文書が未実証範囲を明記する。 |
| VMS30 | Ubuntu／macOS／Windowsは同一revisionで実行したOSだけを成功として記録する。 |

## 検証計画

### 局所検証

```sh
npx -y bun@1.4.2 test src/llang-module-value.test.ts src/llang-module-value-memory.test.ts --timeout 30000
npx -y bun@1.4.2 run ci:module-smoke
npx -y bun@1.4.2 run value:memory:matrix
```

追加script名は実装時に `package.json` とCLI referenceへ同時反映する。test-only mutantは通常buildから到達不能であることを検査する。

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

結果にはcommand、終了値、test／assertion件数、coverage、Bun／TypeScript／Binaryen、OS／architecture、product Wasm hashとbytesを記録する。ローカル成功から未実行OSの成功を推定しない。

## レビュー観点

- memory load／storeは、その命令へ至る全pathでcontainment確認済みか。
- `i32.or`／`i32.and` のoperandにload、store、loop、helper callが隠れていないか。
- signed／unsigned比較がABIのi32 bit patternに対して正しいか。
- `base + length` を検査より前に計算していないか。
- validator、decoder、test oracleが同じ誤実装を共有していないか。
- failure時のstatusとraw trapを区別しているか。
- safety fixに無関係なABI変更や最適化を混ぜていないか。
- Binaryen moduleを例外時もdisposeし、固定versionのAPIだけを使っているか。
- artifact hash変更を意味契約変更と混同していないか。

## 完了条件

VMS1〜VMS30をすべて満たし、結果文書へ根拠を対応付けた時点で完了とする。欠陥を再現できなかった項目は、推測で修正済みにせず、再現条件と調査結果を記録して採否を決める。

完了は `module-value-v1` の指定された trust boundaryに限る。任意Wasmのmemory safety、他profileの同等保証、一般性能改善、外部研究評価の完了は主張しない。
