# 第四弾実装計画：バイナリ実行と外部接続

作成日：2026-09-18。状態：**機能実装完了、全OS証跡待ち**。PR-0相当の
collection native化、effects runtime、汎用typed effect IR、await/task/stream
state-machine lowering、file/HTTP compiler統合、複数moduleの混在source graphと
4構成×3target matrixを実装した。未push revisionのUbuntu/Windows/Bun 1.4.2
証跡とE01〜E16の集約記録は完了条件として残る。

参照：[拡張方針](./GENERAL_PURPOSE_LANGUAGE_EXPANSION_CONCEPT.md)、[第三弾計画](./GENERAL_PURPOSE_LANGUAGE_PHASE3_IMPLEMENTATION_PLAN.md)、[第三弾結果](./GENERAL_PURPOSE_LANGUAGE_PHASE3_IMPLEMENTATION_RESULTS.md)。

## 1. 目的と今回の合意

**計算をWasmバイナリとして実行し、権限の範囲内でIOを行い、非同期・並行・ストリーム処理を失敗時も制御できる状態**を第四弾の出口とする。

人間向け構文やデザインパターンの網羅を目的にしない。TS／JSONCは生成・検証可能な入力および出力表現として維持する。既存generics/closureの機能追加は凍結し、削除は本計画に含めない。必要な実行機能と、その意味・資源・境界を優先する。

| 合意した領域 | 第四弾で完成させること |
| --- | --- |
| IO／型付きホスト呼出し | ファイル読書き、HTTP、登録済みhost operationの型付き呼出し |
| 非同期 | 待機・再開、複数の待機点、呼出しをまたぐ値の保持 |
| 取消／timeout | scope単位の取消、deadline、遅延応答の排除 |
| 失敗と後始末 | 型付きIO失敗、資源close、部分実行結果の報告 |
| 権限／予算 | 対象path/origin/operation、要求回数、byte、時間、memory等の制限 |
| バイト列 | バイナリ入出力、明示UTF-8変換、chunk処理 |
| 追加数値型 | i64、有限f64、固定小数点decimalと明示変換 |
| 制限付き並行処理 | scopeに属するtask、同時実行上限、join、失敗伝播 |
| ストリーム | pull型読出し、背圧、順序、EOF、取消と途中失敗 |

全領域を完了条件に含める。最初のリリースから全OS/全サービスのadapterを揃える意味ではない。基準adapterはローカルfileとHTTP、第三者DB等は同じhost契約で接続できることを検証する。独自package registry、クラス・継承、trait、共有memory thread、任意native FFI、子プロセス起動は対象外。

## 2. 第三弾の現状と必須の前提

2026-09-18の結果記録と実装を確認した。

- collection emitterは`evaluate`がstatus 5を返すWasm shellを出力している。
- `src/llang-module-collection-runtime.ts`は、その後`evaluateCollectionProgram`で本体をhost評価している。
- このため、third-party hostでWasm本体だけを実行して同じ計算を得る段階には未到達。
- 結果記録の532 passはBun 1.3.14での結果。指定1.4.2との再現確認、Ubuntu/Windows CIは開始時の確認事項として残る。

**第四弾の新runtimeを統合する前に、第三弾の計算本体を直接Wasm命令へlowerする。** List、loop、再帰、単相化、closure dispatch、fault・fuelまで対象とし、参照評価器をproduction runtimeの実行経路から外す。manifestのhashは改変検知であり、実行方式や正しさの証明ではない。

この補完はPR-0A/0Bとして追跡する。計画・schemaの策定は先行できるが、shell方式のまま第四弾を完成とはしない。旧shell成果物をnative形式として黙って読むことも禁止する。native化によるABI/manifestの区別を固定してから新profileを追加する。

## 3. 既存実装との境界と版

| 基点 | 第四弾での扱い |
| --- | --- |
| collection IR/loader/source-emitter | 新scalar、bytes、effect、await、task/stream node。profile別checkerを分ける |
| collection Wasm/runtime | native化後のloweringを利用。待機可能なstate machineは新ABIで導入 |
| collection ABI | 純粋entryの契約を維持し、新descriptorとsession寿命は別版へ |
| collection build/suite | 新manifest、host registry hash、effect/limit、event transcript |
| `src/capability-host.ts` | 現状はpackage inspect/verify/invoke。言語内IO APIとは別であり、旧host v1/v2を変更しない |
| worker、path/atomic file、hash部品 | 適用できる部品を共有。新しい権限検査を既存root検査だけで代用しない |

profileは`module-effects-v1`、JSONC source version 5、build/suite version 5、ABI `llang-effects-session-v1`。build version 4は第三弾native collectionで使用済みのため分離した。版ごとの対応表を正本とし、未知版を推測しない。

TSは`--profile module-effects-v1`で明示選択、JSONC headerと一致させる。同一graphのprofile混在は引き続き拒否。TS/JSONC両入力、TS/JSONC/Wasmの3出力を維持する。旧pure profileの契約、hash、sourceや成果物を遡って変更しない。

## 4. IOは言語側から指示し、ホストが実行する

### 4.1 host operation契約

operationは名前だけではなく、安定ID、版、要求型、応答型、error型、effect、資源種別、取消可否、冪等性の情報を持つ。programは必要なoperationと版・signature hashをmanifestに宣言し、host registryと実行開始時に照合する。

ホストは実際のOS/network操作、認証情報の注入、権限検査を担う。Wasmがhostへ計算IRを渡して解釈させることはしない。host requestは有限の型付きoperationだけであり、任意JS、shell、AST実行を許可しない。

TSのimportは予約module（例`llang:io`）からの静的binding、JSONCは同じoperation IDを指す専用nodeにする。package探索やURLからのコード取得を伴わない。型情報のない外部関数はpureとして扱わない。

### 4.2 初期adapter

| adapter | 必須operation | 境界 |
| --- | --- | --- |
| File | openRead/readChunk/close、openWrite/writeChunk/commit/abort | 書込みは新規作成または明示replace。原子的な確定は同一filesystemの対応範囲で提供 |
| HTTP | request、response metadata、body read/write、cancel/close | GET/HEAD/POST/PUT/PATCH/DELETE。method・origin・header・byte制限を検査 |
| Clock | monotonic timer/deadline、明示wall-clock読出し | deadlineと時刻値を分離。試験では仮想clock |
| Host extension | 登録済みの型付きoperation | mock DB operationを例に、特定DB driverは必須にしない |

HTTPの4xx/5xxは受信したresponseとして返し、DNS/TLS/接続失敗はIO errorとする。redirectは既定で追従せず、許可時も各遷移の権限を再検査する。retryは既定0。書込みやPOSTをtimeout後に自動再送しない。

file writeは一時ファイルに書き、明示commitで確定する。abortは自分の一時物を回収する。HTTPや外部DBの実行済み副作用まで取り消せるとは保証しない。応答喪失などで確定を観測できなければ`outcome:unknown`を返す契約にする。

## 5. effect、権限、予算

### 5.1 静的effectと実行時権限

関数・host宣言にeffect集合を持たせ、calleeから推移的に集約する。実装が宣言を超える場合はcompile時に拒否する。関数値はsignatureにeffect上限を含み、pure callbackを要求する場所へIO callbackを渡せない。高度なeffect polymorphismは追加しない。

effectは「何を要求するか」、grantは「何を許すか」である。manifestが権限を自己付与することはない。実行者が明示したgrantと要求の積集合を開始時・各要求dispatch時に確認する。未宣言operationはartifact fault、許可されない対象はpermission deniedとする。

- file：許可root、操作、replace可否。symlink/junction・path置換raceを考慮したhandle基準の検査を行い、保証できないadapter/OSではその操作を明示拒否する。
- HTTP：scheme、origin、port、method、header、送受信先IP範囲を制限する。接続時の名前解決・redirect・proxy経路を含め検査し、URL文字列だけの許可判定にしない。
- credential：hostに保持し、programの任意header操作と分離。ログやtranscriptへ平文保存しない。
- 権限の変更・取消は次のdispatchにも反映し、待機中operationの取消可能性をadapter契約に従って処理する。

### 5.2 上限の初期案

| 対象 | 既定案 |
| --- | ---: |
| 同時IO / scope内task | 各8 |
| session内task生成数 / host要求数 | 各1,024 |
| 一chunk / queued chunk数 | 64 KiB / streamあたり2 |
| open resource / stream | sessionあたり各32 |
| session送受信累計 | 各64 MiB |
| bytes値 / wire message | 各1 MiB / 2 MiB |
| Wasm memory | initial=max=512 pages（32 MiB） |
| session全体fuel / 1回resumeのquantum | 10,000,000 / 10,000 |
| IO timeout / root deadline / cleanup猶予 | 10秒 / 60秒 / 2秒 |

これらはPR-1で境界vectorとともに固定する案。grantは減額できる。compiler/ABIが保証するhard limitをhostが黙って増額しない。taskごとに予算を複製せず、親sessionの台帳から予約・消費する。fuel、byte、memory、要求数とwall-clock時間を混同しない。

## 6. 非同期とWasmの実行モデル

### 6.1 明示的な待機・再開

Wasm JS Promise連携の暗黙機能には依存せず、compilerがawaitを継続state machineへ変換する。TSはasync関数/awaitの限定構文、JSONCはasync flag/await nodeで表す。非同期recursionも保持すべきframeと論理call-depthに上限を持たせる。

ABI案はmemoryと`start`、`resume`、`cancel`、`dispose`のexport。署名、領域配置、status code、event envelopeのbyte layoutはPR-1で固定する。概念上の返却状態は以下。

- `YIELDED`：host request群を生成し、必要な応答を待つ。
- `RUNNABLE`：quantumを使い切ったが、再開可能。schedulerへ制御を返す。
- `DONE`：型付きentry結果。
- `FAILED` / `CANCELLED`：実行失敗または取消、cleanup状態を伴う。

hostはeventを運び、Wasmが継続・分岐・task状態を計算する。request IDにはsession/task/世代/連番を含め、未知ID、重複応答、古い世代、二重resumeを拒否する。応答payloadはhost側とWasm境界で型・boundsを検証する。startを繰り返して同じIOを再発行しない。

1 sessionにつき一つのinstanceを保持し、完了・取消・cleanup終了まで破棄しない。resumeを同時に呼ばず、schedulerで直列化する。純粋計算の長いloopもquantumでyieldし、取消を観測できるようにする。fuel枯渇はRESOURCE_LIMIT、wall-clock timeoutは別の原因として保持する。

### 6.2 hostとbackendの意味一致

TS生成も同じoperation registry・権限・予算・task規則に従う。任意のfetchやfilesystem APIを生成コードから直接呼ばない。JSONC再生成後もeffectと待機構造を保持する。参照評価器は試験oracleとして使い、配布Wasm runtimeには含めない。

外部応答の順序自体は非決定的である。同じevent列を与えた場合の出力・要求列・失敗・資源課金が一致することを保証対象とし、異なるネットワーク実行が同じhashや結果になるとは主張しない。

## 7. 失敗、取消、後始末

IO失敗は型付きの結果として返し、not-found、permission、connection、timeout、cancelled、invalid-response等のcodeと必要最小限の情報を持たせる。業務error union、回復可能IO error、回復不能runtime faultを区別する。任意例外構文は追加せず、明示結果の分岐とresource scopeを用いる。

取消は協調方式を基本とし、親scopeから子task・保有resourceへ伝播する。deadlineは親から短い方を継承する。取消受付後は新規業務IOをdispatchせず、cleanupだけ許可する。完了と取消が競合した場合、schedulerが記録したevent順で一つの終端状態に確定する。期限以上の時刻では同時到着の完了より期限切れを先に処理する規則を固定する。

resourceはopaqueな世代付きhandleで表し、数値を偽造して利用できない。所有scopeを持ち、明示closeまたはscope終了時に逆取得順でcloseする。handleのList格納・wire出力・所有scopeを越えるcaptureを拒否する。stream/task handleも同様に追跡する。

cleanupには別の有限予算を確保し、主fuel枯渇時もclose/abortを試みる。二重closeはadapter側で冪等に扱う。cleanup失敗は主原因を上書きせず付帯情報に残す。猶予超過時はworkerを停止し、hostが所有する接続・fileを強制回収する。外部の副作用はrollbackされたと表示しない。

## 8. 制限付き並行処理とストリーム

### 8.1 構造化されたtask

scope内でspawnし、joinして終了する。detached taskは認めない。明示した同時実行数を超えるtaskは有限queueへ置き、上限超過はRESOURCE_LIMITとする。実行中task間でmutableな値を共有せず、入力はimmutable値として渡す。host IOは並行に待てるが、同じWasm instanceのresumeは直列である。

joinAllは入力task順に結果を返す。各taskが返した業務/IO error値は値として集め、runtime faultは兄弟を取消してcleanup後に失敗を返す。fail-fastが必要な場合は別の明示operationとし、暗黙の規則を増やさない。実行公平性はtask ID順のround-robinとquantumで確保する。CPU thread並列化は含めない。

### 8.2 pull streamと背圧

read要求があるときだけ次chunkを取得するpull方式とする。一streamの未処理readは一つ、queue上限は2 chunks。EOFは空bytesと区別したvariant。書込みは消費完了の応答まで次chunkを送らない。順序を保ち、read/write errorは途中まで処理したbyte数と確定状態を返す。

file/HTTP body双方でstreamを扱い、chunkを変換して書き出す縦断例を必須にする。消費者の早期終了はproducerへ取消を伝播しcloseする。全bodyをListへ蓄積してstreamと呼ばない。UTF-8 decoderはchunk境界をまたぐ最大4 byteの状態を保持し、EOF時の不完全列を明示失敗とする。

### 8.3 待機中の値とmemory回収

第三弾の単調arenaは有限計算には使えるが、stream全体の長さに比例して残り続ける設計は採用しない。session frame、task scope、一時chunkのregionを分け、awaitをまたぐ生存値は保持し、消費済みchunk regionは回収する。

逃げる値は所有する長寿命regionへ明示copy/promoteする。compilerのlivenessと所有handle検査で、閉じたregionへの参照やawait後のdangling pointerを拒否する。固定memory内のfree-list等の再利用方式、alignment・fragmentation上限はPR-1で設計し、PR-4で実証する。無制限GCやユーザーfreeは導入しない。

入力全体より小さいmemoryで、上限内の長いstreamを処理できることを試験する。chunkを保存するユーザー処理はその分のmemoryを消費し、上限で正しく失敗する。host側queueと未完了IOもbudget対象とし、Wasm memoryだけの制限で十分とはしない。

## 9. bytesと追加数値型

### 9.1 bytes

immutableなoctet列。lengthはbyte数、indexは0〜255、範囲外はfault。sliceは半開区間でboundsを厳密に検査し、concatは確保前に上限検査する。UTF-8 encode/decodeは明示intrinsicとし、不正列を黙って置換しない。bytesとstring、List<i32>を暗黙変換しない。

wireではpointer＋byte length、JSONC fixture/診断出力ではtag付きcanonical base64表現を用いる。Listと同じshapeでも型tagで区別する。内部共有を使う場合もregionの寿命を保証する。

### 9.2 数値の意味

| 型 | 定義・演算 | wire/fixture |
| --- | --- | --- |
| i64 | 符号付き64 bit、検査付き整数演算、0除算/overflowはfault | little-endian 8 bytes、JSONはtag付き10進文字列 |
| f64 | IEEE binary64の有限値、明示変換、四則と比較。非有限入力を拒否し、演算で非有限になればNUMERIC_NON_FINITE | 8 bytes。fixtureは有限JSON number。境界oracleはbit列 |
| decimal | `decimal<S>`、Sは0〜18のcompile時scale、係数はsigned i64 | 係数の10進文字列＋scale、wireは係数8 bytes、scaleは型契約 |

f64は−0を0へ正規化し、丸めはnearest/ties-to-even。NaN/Infinity、超越関数、fast-mathは範囲外。underflowとsubnormalの扱いをgolden vectorで固定する。i64をTSのnumberで計算せずBigInt helperへlowerする。

decimalは同scaleの加減比較、明示丸めmodeを伴う乗除・rescaleを提供する。modeはtoward-zeroとhalf-even。暗黙丸めはしない。中間積は128 bit精度を確保し、最終係数でoverflow判定する。Wasmではmultiword演算helperをバイナリに含め、host計算へ委譲しない。通貨や税率の意味はlibrary/利用側が与え、型が自動判断しない。

TS/JSONCのliteral・変換は予約core bindingと専用nodeで対応付ける。i32/numberの既存意味を変更しない。型間の演算は明示変換を要求し、suite比較では数値型・scaleを区別する。numeric helperもfuelと資源予算に含める。

## 10. 成果物、試験、replay

manifestにはentry型、effect要求、host operation signature/版、ABI/layout、資源hard limit、compiler/runtime/helper版、source/IR/artifact hashを記録する。grantとcredentialはビルド成果物に埋め込まず、実行時設定として別管理する。

検証を二つに分ける。

1. **fixture/replay検証**：仮想時計・host応答・event順を固定し、実IOを行わない。同じ要求列/結果/失敗を比較する。
2. **adapter統合検証**：一時directoryとloopback HTTP serverで実read/write/通信・取消を試す。外部credential不要とする。

replayは記録の再生であり、書込み/送信を再実行しない。transcriptは要求ID、operation、redacted対象、payload hash、event順、結果と確定状態を記録する。秘密を除去した記録だけでは完全再現できない場合は明記し、完全fixtureと監査ログを区別する。

portable verifyは新runtime/adapter契約で実行する。原source、compiler、IR evaluatorなしでWasmを実行できることを別environmentで確認する。TS生成も同じfixture driverを使用するが、共通の誤りを避ける独立oracleを用意する。

## 11. 変更単位と依存順序

第四弾は複数の実装群である。下表のPR単位を一度にまとめず、各出口を満たして進む。ファイル名は責務案であり、実装前に空の層を作ることを要求しない。

| 単位 | 内容 | 依存 | 合格条件 |
| --- | --- | --- | --- |
| PR-0A | 第三弾のnative lowering：List/loop/call/closure、旧版区別 | 基準採取 | host evaluatorなしで純粋suite一致 |
| PR-0B | native配布runtime、指定Bun/OS証跡、旧profile回帰 | 0A | evaluator/compilerを除いた配布試験、未確認差分の記録 |
| PR-1 | effect/host/session ABI/schema、memory所有・数値・budget規則 | 0B（設計は先行可） | accept/reject fixtureとbyte/event golden vector固定 |
| PR-2 | bytes/i64/f64/decimal：IR、両frontend、参照・TS/JSONC/Wasm | 1 | 型・数値・codec境界の四経路一致 |
| PR-3 | host registry、effect checker、manifest要求とgrant照合 | 1 | 未宣言/不一致/権限外の拒否。外部IOなしで試験 |
| PR-4 | session frame、region再利用、handle所有、資源台帳 | 1、2 | await保持・chunk回収・stale handle・memory上限 |
| PR-5 | await state-machine lowering、start/resume、scheduler | 3、4 | 複数待機・quantum・event競合。Wasmが継続を実行 |
| PR-6 | 取消/deadline、scope終了、cleanup/強制回収 | 5 | 遅延応答・二重close・cleanup失敗・部分結果 |
| PR-7 | file/HTTP/clock adapter、credential境界 | 3、6 | 一時file/loopbackでIOと権限・取消・timeout |
| PR-8 | structured task、join、同時実行数・予算共有 | 5、6 | 順序・公平性・親取消・過剰spawnの拒否 |
| PR-9 | stream read/write、背圧、UTF-8境界、region回収 | 4、7、8 | 長いstreamを一定のmemory上限内で処理 |
| PR-10 | build/test/verify/CLI、suite v5、replay、portable kit | 2〜9 | 4source構成×3target、compilerなし配布 |
| PR-11 | 縦断examples、help/仕様、全品質Gate・結果記録 | 10 | 全領域の成功/失敗と対象OSを確認 |

配置は`llang-module-effects-*`（IR/frontend/lowering/build/suite）、`llang-effects-runtime`、`llang-host-operations`、`llang-io-adapters`等を候補とする。既存Capability hostを新規IO runtimeに読み替えない。PR-2/3の独立作業も、共通契約が固定されてから進める。

## 12. 縦断例と必須検証

`examples/module-io-pipeline/`を提案する。入力fileをchunkで読み、UTF-8を境界をまたいでdecodeし、coreの型付きJSON decode結果を分岐して注文を得る。明示型のJSON encode/decodeはbytes/stringと既存型の橋渡しとして最小libraryに含め、schema不一致を型付きerrorにする。HTTPで付加情報を取得し、最大4件並行で処理、decimalで金額計算し、出力をstreamで一時fileへ書いてcommitする。

全TS、全JSONC、混在2方向で用意する。fixture版は通信不要、統合版はloopbackと一時directoryのみ。失敗例では途中取消、HTTP timeout、権限不足、書込み失敗を発生させ、確定済み副作用と未確定処理を区別する。

| ID | 試験 | 必須結果 |
| --- | --- | --- |
| E01 | native-only配布、evaluator import禁止、Wasm単体計算 | shell/host解釈への迂回なし |
| E02 | bytes空/最大/境界、UTF-8分割、不正base64 | 型とbyte境界どおりの結果/拒否 |
| E03 | i64境界、f64丸め/subnormal/非有限、decimal端数・中間積 | 独立BigInt/有理数・bit oracleと一致 |
| E04 | operation版/型/effect不一致、pure callbackへのIO | compile/start/dispatchの適切な段階で拒否 |
| E05 | root外、symlink/junction race、redirect、接続先変更 | 権限を迂回しない。未対応OS操作は明示拒否 |
| E06 | 複数await、未知/重複/遅延応答、二重resume | 一つの継続を一度だけ実行 |
| E07 | 計算中/IO中/完了競合の取消、deadline境界 | 決めたevent順で一つの終端、以後業務IOなし |
| E08 | cleanup逆順、close失敗、猶予超過 | 主原因保持、資源回収、部分結果を正しく報告 |
| E09 | POST応答喪失、file commit境界、retry設定 | unknownを成功/rollbackと誤認せず、暗黙再送なし |
| E10 | task上限±1、join順、fault、兄弟取消、予算共有 | detached仕事なし、公平性と親上限を維持 |
| E11 | 空stream/EOF/遅いconsumer/途中失敗 | 背圧を守り、queueとread数が上限内 |
| E12 | memoryより長いstream、捕捉値/awaitとregion寿命 | chunk回収、dangling pointer・累積漏れなし |
| E13 | 燃料/byte/要求数/memoryの境界、worker停止 | 論理faultとwall-clock障害を区別 |
| E14 | fixture/replay・権限変更・秘密のredaction | replayはIOを再発行せず、ログに秘密なし |
| E15 | 4source構成×3target、JSONC round-trip、portable実行 | hash/意味/host要求列を固定event列で照合 |
| E16 | manifest/ABI/handle改変、旧profile/host/replay | 不正拒否、旧契約・証跡を維持 |

各IDは単一テストではなく境界・負例を含む試験群。event順は複数の許可された順序を列挙し、network偶然性に依存しない。実adapter試験で確認したOS/API能力だけを対応表へ記載する。

## 13. 品質Gateと完了条件

開始時に指定Bun 1.4.2、固定依存、dirty状態を含むsource/config/schema hashを採取する。各PRは担当試験とformat/lint/typecheck。最終revisionで以下を実行する。

```sh
bun install --frozen-lockfile
bun audit
bun run format:check
bun run lint
bun run typecheck
bun run coverage
bun run verify
bun run ci:docs
bun run ci:protected
bun run ci:smoke
git diff --check
```

既存`verify`は旧Predicate生成経路の回帰検査であり、第四弾の検証の代用ではない。新effects smokeを追加し、fixture/replayとloopback/file統合試験を既存smokeへ組み込む。coverage閾値を下げず、同じrevisionのmacOS/Ubuntu/Windows結果・実行環境・件数・hash・ログを記録する。

- [ ] 第三弾の本体がnative Wasmになり、host evaluator不要の配布試験が通った。
- [ ] IO・非同期・取消/timeout・失敗/cleanup・権限/予算を実装した。
- [ ] bytes・i64/f64/decimal・制限付き並行処理・streamが全targetで動く。
- [ ] event/資源/数値/所有・寿命の意味とABI/schemaが固定されている。
- [ ] E01〜E16、fixture/replay、実adapter統合、4構成×3targetが成功した。
- [ ] 第三弾までのpure profile、旧host、既存成果物の契約を維持した。
- [ ] 指定toolchainと対象OSの品質Gateを同一最終revisionで記録した。
- [ ] 利用仕様・対応adapter/OS表・help・examples・制限・結果記録を同期した。

未実行のOS、未対応adapter、host評価へのfallbackを成功として埋めない。失敗したGateは原因に近い試験で修正し、その変更の影響範囲を再検証する。範囲の一部だけ実装した時点は中間到達点として報告し、第四弾完了としない。

第四弾完了後は自動的に旧G5全体へ進まない。package registry・多態性・人間向け開発支援等は実際の要求が生じた場合に別途選定する。今回の全項目を仕上げることを、機能拡張の区切りとする。
