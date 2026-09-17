# 汎用言語化・第三弾の実装計画：可変長データと再利用

後続：[第三弾実装結果](./GENERAL_PURPOSE_LANGUAGE_PHASE3_IMPLEMENTATION_RESULTS.md)には直接Wasm生成の未完了が記録されている。その補完と外部実行機能は[第四弾計画](./GENERAL_PURPOSE_LANGUAGE_PHASE4_IMPLEMENTATION_PLAN.md)へ引き継ぐ。本書は策定時の計画として残す。

作成日：2026-09-17。状態：**実装前の計画案**。新profile、構文、版番号、配置名は提案であり、利用可能な機能を示さない。

上位方針：[汎用言語化コンセプト](./GENERAL_PURPOSE_LANGUAGE_EXPANSION_CONCEPT.md)。前提：[第二弾の実装結果](./GENERAL_PURPOSE_LANGUAGE_PHASE2_IMPLEMENTATION_RESULTS.md)、[Value module仕様](./LLANG_MODULE_VALUE_SPEC.md)、[第二弾計画](./GENERAL_PURPOSE_LANGUAGE_PHASE2_IMPLEMENTATION_PLAN.md)。

## 1. 第三弾の到達点

**件数が変わる注文一覧を検証し、変換・絞り込み・集計・安定ソートできること**を出口とする。配列だけを追加して終わらず、型パラメータ付きの共通関数、callback、値を捕捉するclosure、局所更新、反復と再帰を同じ言語基盤で使える状態にする。

全TS、全JSONC、混在2方向の4構成からTS／再コンパイル可能なJSONC／Wasmを生成する。旧boolean/value profileの意味と成果物は維持する。IO・非同期・外部権限はG4へ送り、第三弾も呼出し外へ状態を残さない純粋な計算を対象とする。

| 領域 | 第三弾の対象 | 後続へ送るもの |
| --- | --- | --- |
| collection | 型付き可変長List、構築・長さ・取得・値を返す更新、map/filter/fold/stableSort | Map/Set、iterator protocol、stream、疎配列 |
| 制御 | let再束縛、while、for-of、break/continue、直接・相互再帰 | 任意goto、generator、tail-call最適化保証 |
| 再利用 | 明示型引数のgeneric関数・型alias、単相化 | trait/interface制約、型引数推論、higher-kinded type、polymorphic recursion |
| 関数値 | 明示signature、callback、immutable capture、関数を返すclosure | mutable capture、外部関数値、動的コード生成、関数値の等値比較 |
| メモリ | 呼出し内の動的確保、所有・寿命の固定、上限付きarena | 汎用GC、永続heap、共有memory、ユーザーによるfree |
| データ型 | 第二弾の型＋List＋内部関数型 | 再帰データ型、f64/decimal、optional/nullishの一般化 |

再帰関数と再帰データ型は別である。第三弾では有限で非再帰な型を保持し、再帰関数はListやi32を処理する。一般的な言語に向けた全体目標は維持し、上表の延期を恒久的な非対応とはしない。

## 2. 確認した基準と開始時の検証

第二弾結果には、516 pass・0 fail、coverage functions 94.22%／lines 91.73%、4構成の共通hash、portable verify成功が記録されている。これは既存記録の引用であり、本計画策定で全試験を再実行した結果ではない。記録の実行Bunは1.3.14、指定版は1.4.2で、Ubuntu/Windows CIは未確認である。

PR-0で指定版による基準を再採取し、第二弾計画の未チェック欄と結果記録を照合する。過去の証跡は書き換えず、差分や未確認事項を追記する。dirtyな作業ツリーを含むsource/config/schema hashを固定し、HEADだけを実装識別子にしない。

| 現在確認できる責務 | 第三弾の変更境界 |
| --- | --- |
| `src/llang-module-value-ir.ts`：型展開、checker、call cycle拒否 | 新profileのList・関数型・型引数、関数SCC、局所可変性を分離 |
| `src/llang-module-value-loader.ts`：TS/JSONC読込 | 新構文・型引数・lambda。snapshotと相対import制約は共有 |
| `src/llang-module-value-evaluator.ts`：値・fuel・arena budget | 新IRの実行、反復・call frame・closure・List課金 |
| `src/llang-value-abi.ts`：inline layoutとUTF-8 codec | 新ABIのList descriptorと動的payload検査を追加 |
| `src/llang-module-value-wasm.ts`：WAT生成、Binaryen検証、固定memory | 新loweringでloop・再帰・closure dispatchを生成 |
| `src/llang-module-value-runtime.ts`：新instanceとdecode | 第三弾専用verifier・資源契約をdispatch |
| value build/source-emitter/suite | 新source・manifest・suiteの版、再生成、配布、結果比較 |

第二弾emitterは既に内部arena/globalを用いる。旧計画の配置案を前提に作り直さず、実装されたWAT生成とruntimeを基点にする。コード共有は意味が同じcodec・path・hash部品に限り、旧profileの受理範囲を広げない。

## 3. 新profileと互換契約

仮称`module-collection-v1`を追加する。JSONC source version 4、build manifest version 3、suite version 3、ABI `llang-collection-memory-v1`を提案する。schemaは旧版を上書きせず追加する。

TSは既存`module`コマンドの`--profile module-collection-v1`で選択し、JSONC headerと不一致なら拒否する。一つのmodule graph内でprofileを混在させない。旧moduleを移す場合は明示変更と再buildを要する。source formatはTS/JSONCを対等に扱い、片方にしかない暗黙機能を作らない。

新reader/verifierで版とprofileを厳密にdispatchする。古いreaderへのfallbackや、未知版の推測読込を行わない。既存のsourceSetHash/programHash/interfaceHash/layoutHashの役割を継承するが、新profile・型・意味版・資源契約を新しいhashへ含める。旧hashと証跡は再定義しない。

## 4. Listと局所更新の意味

### 4.1 List<T>

要素型は一様で、第二弾のscalar/record/unionとListを使用できる。第一回の実装ではList内に関数値を格納することを拒否し、関数値は局所変数・引数・戻り値に限定する。Listを含む型も非再帰、型深さ8・展開node4,096の上限を守る。

Listは値意味論とする。`set`、`append`は新しいListを返し、元のListや他のaliasは変わらない。内部共有・copy-on-writeは意味を維持できる将来の最適化であり、初期実装の前提にしない。可変性は`let`の再束縛に限定し、record fieldや配列要素への直接代入は拒否する。

| 操作案 | 意味 |
| --- | --- |
| List literal | 要素を左から一度ずつ評価。空Listにも型注釈が必要 |
| length | i32の要素数。byte数ではない |
| at(list,index) | 0以上length未満のみ有効。それ以外はINDEX_OUT_OF_BOUNDS |
| set(list,index,value) | 同じbounds規則。型一致を要求し、新しいListを返す |
| append(list,value) | 末尾に追加した新しいList。確保前に上限検査 |
| map/filter | 元の順にcallbackを一度ずつ適用。filterは選択順を保持 |
| fold | 明示初期値から左畳込み。空Listは初期値を返す |
| stableSort | comparatorの符号で昇順。同値の元順を保持し、元Listは不変 |

Listの汎用等値演算は導入しない。suiteの期待値比較は順序を含む構造比較であり、言語の等値演算とは別とする。

map/filter/fold/stableSortは`llang:core`の固定signatureとして提供する。通常package探索は行わない。sortは全backendで同じbottom-up stable merge sortを用い、比較順も固定する。callbackが失敗したら最初のfaultで中止する。非推移的なcomparatorでも有限回で終了するが、整列性は保証しない。comparatorの結果を負/0/正で判断し、差の計算によるi32 overflowを推奨例に持ち込まない。

### 4.2 let、loop、制御

letには型と初期値を必須にし、再束縛先は同じ型とする。shadowingは引き続き拒否する。whileは条件を毎回評価し、for-ofは開始時点のList値を固定する。ループ中に元のletを再束縛しても走査対象は変わらない。

break/continueは最内側のloopだけを対象とし、label付き制御は拒否する。returnは関数を終了する。定義されない変数、loop外break/continue、constへの代入を静的に拒否する。評価順、短絡、算術・Unicode・業務unionの意味は第二弾を継承する。

共通IRにはblock/assignment/loopと明示的なcontrol-flow terminatorを追加する。backendごとに早期returnを独自解釈せず、checkerで全経路の戻り値とscopeを判定する。

## 5. generics、再帰、関数値

### 5.1 明示generics

関数とrecord/union型aliasに型パラメータを許可し、呼出しの型引数は明示必須とする。制約なしTに算術・field参照は許可しない。Tは受渡し、List格納、同じTを要求するcallbackへの引渡しに使える。型制約を要する演算はcallbackへ渡す。

コンパイル時に単相化し、キーは定義Symbol ID＋canonical型引数列とする。同じinstanceは共有する。型引数の個数・未束縛・再帰型を拒否する。再帰中に型引数が増殖するpolymorphic recursionは拒否し、同じ型引数の再帰だけを許可する。

IR/JSONC出力はgeneric宣言を保持し、単相化結果はbackend用の派生IRに分ける。再生成JSONCで特殊化済みの別プログラムに変えない。source programHashとlowered IR hashを分け、単相化順で成果物が変わらないよう安定順を固定する。

### 5.2 再帰

module import cycleは引き続き拒否する。同一module内の直接・相互再帰は許可する。関数call graphのSCCを解析して署名を先に確定し、cycleを無条件拒否する旧checkerは新profileでは使わない。

すべてのcallに論理call-depth検査を入れ、fuelと合わせて停止しない処理を中断する。深さの上限に達する前にhost stack overflowやWasm trapへ落ちない実装にする。参照評価は明示frame、TS生成は必要ならtrampolineを用いる。tail recursionも通常callとして課金し、最適化の有無で受理範囲を変えない。

### 5.3 高階関数とclosure

関数signatureは引数と戻り型を明示し、型の完全一致を要求する。lambdaはlexical scopeを捕捉する。捕捉対象はconstとimmutableな引数のみ。letは現在値をコピーする場合も直接捕捉を拒否し、明示constへ束縛した値を捕捉させる。

捕捉は値として行う。関数がclosureを返しても、生成元frame終了後に捕捉値が有効でなければならない。関数値の外部入力・外部出力、wire serialization、等値比較、自己参照closure、暗黙に`this`を捕捉する構文は拒否する。

closure conversionでは定義IDとenvironmentを作る。初期Wasmは閉じた関数集合からsignature別のtag dispatch関数を生成し、直接callへ分岐する。table/call_indirectを導入せず、未知tagと不一致signatureはartifact faultにする。dispatch数・生成code量に上限を置き、将来tableへ移す場合は別ABI判断とする。

## 6. TS/JSONCの対応とコンパイラ順序

| 機能 | TS source案 | JSONC/共通IR案 |
| --- | --- | --- |
| List型 | `List<T>`を`llang:core`から型import | `{"list": TypeUse}` |
| generics | `function f<T>(x:T):T`、`f<number>(x)` | typeParameters、call.typeArguments |
| 関数型/lambda | 明示したarrow signatureとbody | function type、lambda(parameters,returns,body) |
| 更新 | 型付きlet、識別子への`=`のみ | mutable binding、assign(target,value) |
| loop | while、for-of | while(condition,body)、forEach(binding,value,body) |
| collection操作 | core named import | intrinsic(name,typeArguments,arguments) |

TSのArray prototype、spread、任意method、暗黙型推論を受理しない。ListはJS Arrayと同じ可変性ではないことを明記する。lambdaを含め読込ソースを実行して解析しない。JSONCの正確なkeyと全accept/reject例はPR-1で固定する。

処理順はsnapshot→宣言/型パラメータ束縛→型検査/scope/制御→generic instance収集→SCC/資源上限→closure conversion→backend loweringとする。診断用source位置はすべての派生IRへ対応付ける。特殊化失敗には元定義・呼出し・型引数、capture失敗には捕捉位置を出す。

## 7. メモリ、ABI、停止条件

### 7.1 呼出し内arenaという寿命モデル

第三弾も一回のevaluateごとに新instanceを用い、結果をhostへコピーした後に全memoryを破棄する。Listのbuffer、record、文字列、closure環境は呼出しarenaに動的確保する。frame終了時に解放しないため、返したclosureや複合値がdangling pointerを持たない。手動freeとGCは不要である。

この方式は解放を呼出し終了へまとめるため、loop内の一時値も累積する。生存値が小さくてもarenaを使い切ればRESOURCE_LIMITとなることを仕様にする。無限に動くサービスのheapとして完成したとは扱わない。map/filter/fold/sortは事前確保したbufferを使い、appendの繰返しによる二乗確保を避ける。

論理確保byte・alignment・fuel課金を共通IR/intrinsicごとに定義し、参照評価・TS・Wasmが同じ地点で上限になるようにする。host GCや物理layout最適化によって論理budgetを変えない。出力のwire上限、内部arena上限、物理memory上限は別々に記録する。

### 7.2 新ABI案

外部signatureは第二弾と同形の`evaluate(inputPtr,inputLength,outputPtr,outputCapacity)->status`、exportはmemory/evaluateだけとする。新ABI版を持たせ、descriptorが似ていることを互換の根拠にしない。

List wire値はpointer＋要素数の8 bytesとし、要素layoutのstrideを契約から得る。空Listはpointer=0/count=0だけをcanonical表現とする。要素領域と再帰的な文字列/List payloadは同じinput/output buffer内に収める。count×stride、offset加算、alignment、重複領域、循環参照、深さ、総要素数を検査する。wireはaliasを保持しない値treeとしてencodeする。関数値はwire型検査で拒否する。

内部Listはwireと区別し、長さ・要素型・buffer領域の整合性をloweringで保証する。新statusとしてINDEX_OUT_OF_BOUNDSを追加し、旧status番号を流用・変更しない。深さ、fuel、arena超過はRESOURCE_LIMIT。trap/timeout/不正descriptorは業務error値として成功させない。

### 7.3 上限案と受理条件

| 対象 | 初期値案 |
| --- | ---: |
| 一つのList | 4,096要素 |
| 一入力/出力のList総要素数 | 各16,384要素 |
| 入力/出力wire | 各256 KiB |
| 一文字列 | 16 KiB UTF-8（第二弾と同じ） |
| 呼出しarena | 4 MiB、確保累計で判定 |
| Wasm memory | initial=max=128 pages（8 MiB）、grow禁止 |
| 論理fuel | 1,000,000 |
| call depth | 64（entryを1と数える） |
| 型引数/closure capture | 各8／16 |
| 単相化関数/closure定義 | Program全体で各1,024／256 |
| 出力Wasm | 4 MiB |

source/module/型展開の既存上限は維持し、意味が変わるものだけ新profileで定義する。新memoryの定数・input・output・arena・予約領域の非重複mapはPR-1で固定し、足りなければbuildを失敗させる。上限をテスト都合で黙って引き上げない。

fuelは式評価、loop条件判定、call、intrinsicの要素処理/比較へ明示課金する。空bodyの無限loopにも課金する。callbackも通常のcallとして深さとfuelを消費する。残高不足では効果を開始せずfaultを返す。worker timeoutは二次的な運用中断とし、deterministicなfault oracleには使わない。

Binaryenは固定版132.0.0を基準とする。新emitterのloop・branch・direct call・memoryを対象にローカルAPIで検証する。今回、Binaryen更新や最適化設定変更を併せない。既存value emitter同様、検証とdisposeを行い、旧stateless verifierを緩めない。性能は計測するが、既存より速いという成功条件は設けない。

## 8. 成果物と検証経路

新manifestにはsource inventory、型signature、source/lowered IR hash、ABI/layout hash、単相化とclosure方式の版、資源上限、toolchain、artifact hashを記録する。interfaceHashはentryのデータ型だけを対象にし、内部closure配置とは分離する。

suite v3は第二弾のvalue/invalid-input/faultという区分を継承し、Listと新fault codeを厳密に受理する。空suite、未知key、case重複、入力・期待値上限違反を拒否する。期待値を生成compilerから作らず、固定oracleを使う。

TS生成は必要なhelperを含め、core importを配布先へ残さない。JSONCはgeneric/lambda/loopを保持して再生成し、再読込後のprogramHashと結果を照合する。portable verifyはcompilerと原sourceなしで実行する。外部から受け取ったTSを暗黙実行しない。source再検査、出力競合、manifest最後の公開、所有物だけのcleanupは既存契約を継承する。

## 9. 実装単位と依存

ファイル名は配置案。既存valueファイルを巨大なprofile条件分岐へ変えず、collection専用の入口と共通部品を分ける。

| 単位 | 内容・主な責務 | 依存 | 出口 |
| --- | --- | --- | --- |
| PR-0 | 第二弾証跡照合、指定Bun・旧profile基準採取 | なし | 再現環境・未確認CI・回帰hashを固定 |
| PR-1 | 新schema/仕様、構文fixture、ABI・資源・課金vector | PR-0 | 対応範囲と未対応を両sourceで判定可能 |
| PR-2 | `llang-module-collection-ir.ts`等、List/関数型、局所制御checker | PR-1 | scope、型、全経路return、List・capture拒否試験 |
| PR-3 | generics単相化、call SCC、closure conversion | PR-2 | 明示型引数、同型再帰、生成上限、安定Symbol ID |
| PR-4 | collection参照evaluator、frame、intrinsic、fuel/arena | PR-3 | 独立oracle・再帰停止・alias/capture意味が一致 |
| PR-5 | TS/JSONC frontend、generic/lambda/loopの位置診断 | PR-2〜4 | 4構成が同じ検査済みIRへ到達 |
| PR-6 | TS/JSONC source emitterとhelper | PR-5 | TS typecheckと実行、JSONC再生成hash保持 |
| PR-7 | collection ABI codec/runtime/verifier | PR-1、PR-2 | 手書きwire vector、bounds・寿命・上限検査 |
| PR-8 | collection Wasm emitter、loop/call/dispatch、論理課金 | PR-3、PR-4、PR-7 | 配列、再帰、返却closure、sortの意味とfault一致 |
| PR-9 | build/suite/worker/CLIの版dispatchとportable配布 | PR-6、PR-8 | 4経路比較、移動後verify、旧版回帰 |
| PR-10 | examples/smoke、文書、全品質Gateと結果記録 | PR-9 | 全構成×全targetと対象CIの証跡 |

最初に実装するのはPR-0/1。PR-7はfrontend完了を待たず固定ABI fixtureで進められる。各段階では未実装機能を明示拒否し、中間のList対応だけを第三弾完了と呼ばない。PRは分割単位であり、この計画作成でPR公開を行う意味ではない。

## 10. 縦断例・必須試験

`examples/module-order-batch/`を提案する。domainに注文/結果型、collectionにgeneric filter/fold、pricingに計算と閾値を捕捉するclosure、applicationにentryを置く。core版とユーザー定義generic版を比較して、組込みだけで例が成立したとしない。

配列の数量と単価から金額を求め、閾値以下を除外し、合計と金額順の一覧を返す。同額では元順を保持する。空入力、1件、重複金額、Unicode商品名、overflow、型付き業務errorを固定する。別fixtureで再帰による合計とloop版を比較し、返されたclosureを作成元関数の終了後に呼ぶ。

| ID | 試験 | 合格条件 |
| --- | --- | --- |
| C01 | 空/1件/最大Listと境界±1、nested List | 順序・型・個数・総byte上限が四経路一致 |
| C02 | 負index、末尾、範囲外、count×stride overflow | bounds faultまたはwire拒否。memory破壊なし |
| C03 | alias後set/append、for-of中の再束縛 | 元値と走査snapshotが不変 |
| C04 | loop 0回、break/continue/return、無限loop | 制御先とfuel切れの地点が一致 |
| C05 | 直接/相互再帰、深さ63/64/65、非停止再帰 | 論理上限で止まりhost stack/trap任せにしない |
| C06 | generics複数型、再利用、型引数欠落、不一致 | 正しい単相化共有、不正型はcompile時拒否 |
| C07 | polymorphic recursion、特殊化爆発、型cycle | 上限前または指定境界で有限に拒否 |
| C08 | immutable capture、返却closure、let捕捉、未知dispatch tag | 寿命維持、不正capture拒否、artifact fault |
| C09 | generic callback・closureのfault/depth/fuel | 通常callと同じ意味・順序で伝播 |
| C10 | map/filter/fold順序、callback回数、stableSort同値 | 固定oracleと一致。非推移comparatorでも停止 |
| C11 | arena累積、文字列/List一時値、空loop | 論理課金が一致し、GCや最適化に依存しない |
| C12 | wireの空descriptor、alignment、重複/cycle、改変 | golden bytes一致。不正入力/出力を確実に拒否 |
| C13 | 4source構成×3target、JSONC再生成、root移動 | 同構造hash・結果一致、compilerなしverify |
| C14 | source差替え、出力競合、途中fault | 不完全成果物を公開せず所有物だけcleanup |
| C15 | profile/ABI/manifest/suite改変、旧reader | 明示拒否、旧版挙動とhash維持 |
| C16 | 旧Predicate/bool/value/Capability/host/replay | 既存品質Gateと固定条件での成果物回帰なし |

小規模データは手計算・独立の参照sortで検証し、seed固定のwell-typed AST生成を補助に使う。四backendで同じhelperを共有するだけでは意味の正しさを証明しない。サイズ別にbuild時間・生成bytes・実行時間・確保量を記録するが、性能改善の主張は比較測定後に限定する。

## 11. 品質Gateと完了条件

開始時は既存moduleとvalueの局所試験・`ci:module-smoke`を指定Bun 1.4.2で実行する。各PRは担当試験、format/lint/typecheckを通し、最後に固定revisionで以下を実施する。

```sh
bun install --frozen-lockfile
bun audit
bun run format:check
bun run lint
bun run typecheck
bun run coverage
bun run ci:docs
bun run ci:protected
bun run ci:smoke
git diff --check
```

collection smokeを既存module smokeへ追加し、旧bool/value例も残す。coverage閾値は現行の全体functions/lines 90%、semantic-transaction 95%を下げない。macOSローカルとUbuntu/Windows CIを区別して記録し、全体試験とcoverageの重複実行を避ける。

- [ ] 第二弾基準を指定toolchainで確認し、未確認CIを解消または明示した。
- [ ] List、反復、局所再束縛、再帰、generics、closureの仕様と両frontendが揃った。
- [ ] 共通IR、単相化、closure conversion、資源課金を固定した。
- [ ] C01〜C16、4構成×3target、再生成・portable検証が通った。
- [ ] 返却closureと複合値の寿命、停止しない計算の中断を確認した。
- [ ] 旧profile・証跡・公開形式を維持した。
- [ ] 同一最終revisionの全品質Gate・対象CI、hash、ログを記録した。
- [ ] 仕様・schema・help・examples・対応表と実装結果を同期した。

未実行の対象CIがある場合、機能実装済みと検証完了を分けて報告し、第三弾全体の完了欄は残す。次のG4はeffect、file/HTTP、権限、async、取消、cleanupを対象とする。IO導入前に、今回の呼出しarenaの寿命を外部処理・待機中の値へどう拡張するかを別途設計する。
