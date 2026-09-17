# 汎用言語化・第二弾の実装計画：値・制御・型付き結果

実装後の参照先：[第二弾の実装結果](./GENERAL_PURPOSE_LANGUAGE_PHASE2_IMPLEMENTATION_RESULTS.md)、[確定仕様](./LLANG_MODULE_VALUE_SPEC.md)。本書の計画時判断は履歴として残し、環境差と検証状態は結果記録を参照する。次段階は[第三弾の実装計画](./GENERAL_PURPOSE_LANGUAGE_PHASE3_IMPLEMENTATION_PLAN.md)。

作成日：2026-09-17。状態：**実装済み**。実装されたprofile、構文、ABI、schema版、配置名の正確な契約は[Phase 2仕様](./LLANG_MODULE_VALUE_SPEC.md)、ローカル品質ゲートと環境差は[実装結果](./GENERAL_PURPOSE_LANGUAGE_PHASE2_IMPLEMENTATION_RESULTS.md)を正本とする。

上位方針は[汎用言語化コンセプト](./GENERAL_PURPOSE_LANGUAGE_EXPANSION_CONCEPT.md)、前段は[第一弾計画](./GENERAL_PURPOSE_LANGUAGE_PHASE1_IMPLEMENTATION_PLAN.md)、現行の利用仕様は[Phase 1仕様](./LLANG_MODULE_SPEC.md)を参照する。

## 1. 到達点と範囲

**単一の注文明細を複数moduleで検証・計算し、明細の計算結果または理由付きエラーを返せること**を第二弾の出口とする。同じ処理を全TypeScript、全JSONC、両方向の混在で記述し、TypeScript／再コンパイル可能なJSONC／Wasmで同じ結果を得る。

例は商品コード、単価、数量、会員区分を入力し、検証、金額計算、結果整形を3 moduleに分ける。金額は最小通貨単位の整数とする。件数が可変の注文一覧はG3のcollection・反復へ引き継ぐ。

| 領域 | 第二弾で実装する | 後続へ送る |
| --- | --- | --- |
| 数値 | 符号付き32 bit整数、検査付き四則演算・剰余・比較 | f64、i64公開型、decimal、暗黙変換、bit演算 |
| 文字列 | Unicode文字列、等値、連結、scalar数取得 | index/slice、正規表現、locale比較、数値との変換 |
| 型 | boolean、i32、string、非再帰record、tagged union | generics、再帰型、配列、任意union、null/undefined、optional field |
| 値と戻り値 | record構築、field参照、union構築、全対応型の引数・戻り値 | mutable reference、関数値、複数entry |
| 制御 | immutableな局所束縛、条件分岐、網羅的match、早期return | 代入、loop、再帰、closure、例外構文 |
| 失敗 | unionで表す業務エラー、別枠の算術・資源・入力エラー | 汎用Result<T,E>、try/catch、暗黙伝播記法 |
| Wasm | 固定サイズmemory、呼出し単位のarena、型付き入出力ABI | GC、free、memory.grow、永続状態、WASI、IO |

G2は一般計算の最初の共通範囲を完成させる段階であり、すべての数値型や文字列APIを揃える段階ではない。上表の延期項目は汎用化の全体目標から削除しない。

## 2. 第一弾の実装を前提にする

2026-09-17の作業ツリーで確認した実装を基点とする。変更が多数未コミットのため、HEADだけでは対象を特定できない。実装開始時にsource/config/schemaのhash、dirty状態、toolchainを採取する。

| 確認した現状 | 第二弾の変更責務 |
| --- | --- |
| `src/llang-module-ir.ts`にboolean専用型、式、checker、100,000 stepの上限 | profile別の型・式・意味検査。戻り値型を検査済み関数へ保持 |
| `src/llang-module-loader.ts`にJSONC/TS parserと閉包収集 | 新構文のfrontendを分け、既存snapshot・root制約を共有 |
| `src/llang-module-evaluator.ts`に参照評価と旧WasmContractへの変換 | 値、束縛、分岐、失敗の参照意味。新契約を旧contractへ押し込まない |
| `src/llang-module-source-emitter.ts`にTS/JSONC生成 | 数値helper、値構築、分岐、型付き結果、再生成 |
| `src/llang-module-wasm.ts`にi32関数・直接call、MVP、memoryなし | 新profile専用のlowering/emitter。既存のstateless経路を維持 |
| `src/llang-module-build.ts`にbuild/reader、manifest version 1 | 新manifestのdispatch、入出力型・ABI・資源契約の記録 |
| `src/llang-module-suite.ts`、runtime workerはboolean期待値 | 構造化期待値、エラー種別、新runtimeでのportable verify |
| 3つのmodule schema、`examples/module-access/`、`ci:module-smoke` | 既存を回帰対象にし、新schema・例・smokeを追加 |

第一弾計画は実装済みと記載され、機能の完了欄はチェック済み。一方、最終revisionの全品質Gateと対象CIの証跡欄は未チェックである。本計画ではその状態を合格と読み替えない。PR-0で既存ログとの照合または再実行を行い、未確認事項を記録する。今回は全テストの再評価ではなく、実装構造を確認した計画策定である。

## 3. profileと互換性

新profileの仮称を`module-value-v1`とする。旧`module-bool-v1`、Predicate v1、既存Capability経路は継続する。新しい値を扱うために旧readerやstateless verifierの制約を緩めない。

| 軸 | 第二弾の提案 | 旧形式の扱い |
| --- | --- | --- |
| JSONC source | `language:"l-lang", version:3, kind:"module", profile:"module-value-v1"` | version 2のschemaは固定 |
| TypeScript source | `module`コマンドの`--profile module-value-v1`で明示選択 | 省略時の旧挙動を維持 |
| module graph | 同一profileのみ。JSONC headerと選択profileの不一致は診断 | 旧moduleの暗黙取り込みなし |
| build manifest | `llang-module-build` version 2 | version 1 readerと分離 |
| suite | `llang-module-suite` version 2 | boolean専用version 1を維持 |
| runtime ABI | `llang-value-memory-v1` | `evaluate`のみの旧ABIを維持 |

既存のboolean moduleを新profileに移す場合も明示変更と再buildを要求する。自動migrationは本範囲に含めない。中間段階では未実装targetを明示拒否し、TSへの自動切替でWasm対応を装わない。第二弾完了時は対象機能すべてを3形式に揃える。

## 4. 数値と文字列の意味を先に固定する

### 4.1 i32

値域は−2,147,483,648〜2,147,483,647。JSONCの型名は`i32`、TS sourceの`number`はこのprofile内ではi32を意味する。任意TypeScriptのnumberと同じ意味ではないことを仕様・診断・生成物の説明へ明記する。小数literal、NaN、Infinity、範囲外入力を拒否し、入力の−0は0に正規化する。

- `+ - *`と単項minusは数学的結果が値域外なら`ARITHMETIC_OVERFLOW`。wrapしない。
- 除算はゼロ方向へ切り捨て。0除算は`DIVISION_BY_ZERO`、最小値÷−1はoverflow。
- 剰余は切捨て除算に対応する符号を持ち、最小値%−1は0。剰余の0除算も拒否。
- 同じ型同士の`=== !== < <= > >=`を許可し、boolean/stringとの暗黙変換を拒否。
- 定数式も実行時と同じ意味。未選択branch内の0除算を先行評価して失敗させない。

TS生成ではJSの通常の乗算に結果検査を足すだけでは不十分なので、正確な中間計算を行うhelperを使う。参照評価はBigInt等で独立に実装し、Wasmはi64の中間演算と範囲検査を使う案とする。公開i64型の導入とは区別する。算術失敗は実行結果のfaultであり、業務unionの値に暗黙変換しない。回復したい業務処理は演算前に条件を検査して明示したerror variantを返す。

### 4.2 string

Unicode scalar列を値とし、Wasmでは妥当なUTF-8で表す。lone surrogateと不正UTF-8を拒否する。正規化は行わず、合成済み文字と結合文字列は異なる値として扱う。等値はscalar列の完全一致、lengthはscalar数、連結は左から右の順序を保つ。空文字、NUL、絵文字を許可する。

TSでは`.length`を受理せず、専用intrinsicの`scalarLength(text)`と`concat(left,right)`を使う。intrinsicは仮想組込みmodule `llang:core`のnamed importとして解決する案とする。これはコンパイラが所有する固定signatureであり、ネットワークやpackage探索をしない。通常の相対import規則に対する例外はこの完全一致名だけとし、shadowing・関数値化を拒否する。JSONCは同じintrinsic名を持つ専用式nodeへ対応付ける。

文字列の上限は1値あたりUTF-8 16 KiB、入出力の各wire payloadは64 KiBとする案。scalar数とbyte数を混同しない。連結の長さを確保前に検査する。サイズ超過は`RESOURCE_LIMIT`であり、切詰めや文字置換はしない。

## 5. 型・値・制御の共通モデル

recordは必須fieldだけ、最大64 fields、構造的一致とし、field順は型の意味に影響しない。fieldにscalar、record、unionを許可するが、型参照graphをDAGに限定し最大深さ8とする。構築時は不足・余分・重複fieldを拒否する。値はimmutableで、aliasを介した更新はない。

unionは`tag`を判別fieldとする名前付きtagged union。tagはASCII識別子、最大128文字、variant数2〜16、同名tag禁止。各variantはtagと名前付きpayload fieldsを持つ。任意型の集合や型推論による自動union化は導入しない。業務結果は例えば`{tag:"ok", total:number, label:string} | {tag:"error", code:string}`という具体型で定義する。genericなResultは不要である。

引数は従来どおり最大8、entryはrecord一引数。戻り値はboolean／i32／string／record／unionのいずれか。型注釈を関数・引数・局所束縛に必須とし、広い型推論は後続へ送る。

| 構文・IR | 規則 |
| --- | --- |
| local binding | 一度だけ初期化するconst。字句scope、宣言前参照・同一関数内shadowingを拒否 |
| block | 束縛列と終端式を持つ。関数の全経路で値を返す |
| if | 条件はboolean。両branchの結果型が完全一致。選択branchだけ評価 |
| match | unionのtagを網羅。重複・未知・欠落caseを拒否。case内だけpayloadを参照可能 |
| call | 引数は左から右へ一度ずつ評価。失敗時に後続引数を評価しない |
| record構築 | 初期化式はソース順に評価し、結果の保存layoutはfield名順。評価順をsortで変えない |
| field | param以外にlocal、call結果、構築値からの参照も許可 |

TSではconstとreturn、if/else、三項式、tagに対するswitchを受理する。switchは全caseがreturnで終了し、fallthrough、break、defaultを認めず、明示caseで網羅する。ifによる一般的なunion narrowingは第二弾に含めず、payloadの絞り込みはswitchに限定する。throw/try、代入、loop、関数値、spread、getter、任意method呼出しは拒否する。

JSONCでは`block(bindings,result)`、`if(condition,then,else)`、`match(value,cases)`、`record(type,fields)`、`variant(type,tag,fields)`、`local(name)`、`binary(op,left,right)`、`intrinsic(name,arguments)`等を追加する案。fieldsは評価順を保持する名前と式の配列とする。数値literalは型を明示する。正確なkey・operator一覧・schemaはPR-1で対になるTS/JSONC fixtureとともに固定する。

検査済みIRには各式の型、局所Symbol ID、解決済みcallee、return型を保持する。古い`ModuleExpression`を全profileで無条件に拡張する設計を避ける。frontendが同じ型付きIRへ落とし、checker・参照評価をbackendから独立させる。

## 6. 最小memory ABIと実行寿命

既存Wasmはstateless検査を受けるが、新profileでは内部memoryを必要とする。**言語としての純粋性**と**実装内部の一時memory使用**を区別する。新verifierとruntimeを追加し、旧`assertStatelessWasmBinary`は変更しない。

### 6.1 外部契約案

- Wasmのexportは`memory`と`evaluate`だけ。import、start、table、shared memory、memory64を禁止する。
- memoryはinitial=max=16 pages（1 MiB）、memory.growを禁止。定数data segmentとarena cursor等の内部globalは許可するが、外部exportは禁止。
- `evaluate(inputPtr:i32,inputLength:i32,outputPtr:i32,outputCapacity:i32)->i32`。0は成功、非0は固定されたfault code。業務error variantも正常な戻り値なのでstatusは0。
- 入力・出力・定数領域・scratch arenaを分離する。固定値64を最小有効addressとし、null pointerとは分ける。各領域の整列、重複禁止、境界をruntimeとentry prologueの両方で検査する。
- runtimeは呼出しごとに新しいinstanceを作る。compiled moduleは再利用可。呼出し後に戻り値をhost値へコピーし、instanceを破棄する。外部へ生のpointer/viewを返さない。

### 6.2 layoutと所有権

bool/i32/tagはlittle-endian 4 bytes、boolは0/1のみ。stringはpointerとbyte lengthの8 bytes、recordはfield名順のinline layout、unionはtag番号と最大variantのpayload領域とする。tag番号はtag名のASCII順で固定する。型ごとのsize/alignment/offsetを一つのlayout計算器から得る。paddingと未選択payloadは0で初期化する。

入力はhostが型検査してencodeする。返却stringが入力memoryを参照していても、hostへのコピー完了までinstanceを維持する。出力headerと文字列領域はoutput buffer内に収め、scratchへのpointerを外へ残さない。出力は別途型検査・bounds検査・UTF-8検査を通してdecodeし、不正なら`INVALID_ARTIFACT`として失敗させる。

内部関数の複合値戻りはcallerが確保した領域へのout-pointer方式とする。失敗statusを全call siteで伝播し、未初期化出力を使わない。arenaは単調確保し呼出し終了で全破棄する。free、再帰、長期保存は導入しない。pointer+lengthやoffset計算の整数overflowも確保前に検査する。

定数領域と各bufferの正確な配置、header、fault番号、custom section形式はPR-1のABI文書とbyte-level golden vectorで固定する。入出力signatureだけでは十分でないため、manifestにはlayout hash、ABI版、資源上限を含める。これはABI互換性と整合性の検査であり、任意のWasmが生成ソースどおり動く証明ではない。

### 6.3 資源制限とBinaryen

source/module/call depthの既存上限は引き継ぐ。新profileの案は式node上限1関数1,024、depth64、local64、評価step100,000。型展開は深さ8に加えて展開node4,096、固定layout64 KiB以下とし、小さな型DAGによる指数的展開を早期に止める。

資源faultもbackend間で照合できるよう、論理arenaの確保・整列・一時値の課金規則をlayoutと共通IRで固定し、参照評価とTSにも同じbudgetを適用する。host言語のGCやWasmの実配置の差で受理するプログラムを変えない。物理的な確保失敗は別の実行障害とする。

評価stepの課金箇所を共通IRで定義し、参照評価・生成TS・Wasmのすべてに同じfuel検査を入れる。短絡で実行しない式には課金しない。メモリ上限超過やfuel枯渇は`RESOURCE_LIMIT`、workerのwall-clock timeoutは別の実行障害とする。文字列操作はbyte長の上限でも制御する。運用timeoutは既存runnerを基準にPR-1で固定し、機械速度に依存する合否を意味試験へ持ち込まない。

固定依存はBinaryen 132.0.0。ローカル型定義のi64、memory、setMemoryと現行emitterを確認した。新emitterも必要なMVP機能に限定し、validateとdisposeを徹底する。最適化設定・Binaryen更新・性能向上は今回の目的に含めない。最適化を後から加える場合もfuel課金とエラー順を保持する。ソート実験のmemoryを製品ABIとして流用しない。

## 7. backend、hash、成果物、suite

TS生成は通常の型付きコードと意味を揃えるruntime helperから構成する。i32演算、Unicode検査、fuelを生のJS演算へ任せない。生成物単独で型検査・実行できるよう必要な型とhelperを含め、`llang:core`依存を配布先へ残さない。JSONC生成は全module・新profile・式順を保持し、再読込後のprogramHash/interfaceHashとsuite結果を照合する。

新programHashにはprofile、型付きIR、演算意味の版を含める。宣言・型fieldのcanonical順と、評価順を持つ配列を区別する。旧hashは再計算方式を変えない。interfaceHashは入力型と戻り値型、profileを含み、layout/ABIは別hashで管理する。build identityにはtoolchain、ABI、helper版、資源設定を含める。raw source集合、成果物bytes、suiteHash、結果reportも従来どおり別に追跡する。

suite v2のexpectedは次の判別形式を提案する。

```json
{"kind":"value","value":{"tag":"ok","total":600,"label":"商品A"}}
```

`{"kind":"invalid-input"}`と`{"kind":"fault","code":"ARITHMETIC_OVERFLOW"}`も許可する。業務errorは`kind:value`内のunionで表す。構造的比較はfield集合と値で判定し、object key順には依存しない。timeout、Wasm trap、decode失敗、artifact改変を業務errorとして合格させない。正常値と失敗理由を四経路（参照評価、TS、再生成JSONC、Wasm）で照合する。

portable verifyは新ABIを持つWasm bundleをcompilerなしで実行する。raw hashだけでは信頼性や意味保存を証明しない。外部TSの自動実行は引き続き行わない。source snapshot再検査、排他的な新規出力先、manifest最後の公開、所有物だけのcleanupは第一弾の契約を継承する。

CLIは既存`module lint/build/test/verify`を拡張し、新profile選択を追加する。終了値0/1/2の区分を維持し、suiteで期待したfaultはpass、期待しない算術faultは試験不一致、timeout等は実行障害として区別する。未対応版やprofileは明示拒否し、旧readerへのfallbackをしない。

## 8. 実装単位と依存

PRは変更の分割単位を示す。ファイル名は責務の配置案であり、計画策定で空ファイルやPRを作成するものではない。

| 単位 | 内容と主な変更箇所 | 依存 | 完了条件 |
| --- | --- | --- | --- |
| PR-0：第一弾基準 | 既存module試験・smoke、品質証跡の照合、hash採取 | なし | 機能基準と未確認CIを区別し、回帰fixtureを固定 |
| PR-1：意味・schema・ABI | 新仕様、source/build/suite schema、数値・Unicode・layout・fault・fuel vector | PR-0 | 両frontendのaccept/reject例とABI codec仕様がレビュー可能 |
| PR-2：値と型検査 | `llang-module-ir.ts`から必要なchecker分離、新value IR、型DAG、return型 | PR-1 | 構造一致、型cycle、展開上限、union網羅性、scope検査 |
| PR-3：参照評価 | value evaluator、算術・文字列・block/if/match・fuel | PR-2 | 独立oracleと境界値・評価順・失敗伝播が一致 |
| PR-4：両frontend | loaderのprofile分岐、TS/JSONC parser、組込みsignature | PR-2、PR-3 | 全TS/全JSONC/混在の型付きIR一致、未対応構文を拒否 |
| PR-5：TS/JSONC生成 | source emitterとhelper、再生成 | PR-4 | typecheck、JSONC hash保持、参照評価との比較 |
| PR-6：codec・runtime | `llang-value-abi.ts`、`llang-value-runtime.ts`相当、新verifier | PR-1、PR-2 | 手書きABI fixtureでencode/decode、範囲・改変・寿命検査 |
| PR-7：Wasm生成 | `llang-module-value-wasm.ts`相当、layout・out-pointer・checked算術・fuel | PR-3、PR-4、PR-6 | 関数、複合戻り値、Unicode、失敗伝播を四経路で照合 |
| PR-8：配布とCLI | build/readerの版分岐、suite v2、worker、CLI/help | PR-5、PR-7 | 全target、portable verify、失敗分類、旧manifest回帰 |
| PR-9：examplesと品質 | `examples/module-order-line/`案、smoke、日英ガイド、結果記録 | PR-8 | 入力構成×target、全Gate、対象OS証跡、文書同期 |

最初の着手はPR-0とPR-1。ABIの未決事項を残したままWasm emitterを作り始めない。PR-5とPR-6は契約が固定されれば独立に進められる。PR-7に入る前に、型付きIRとcodecの試験で失敗原因を切り分けられる状態にする。

## 9. 縦断例と必須試験

`domain/order`に入力・結果型、`pricing/calculate`に金額計算、`application/quote`に検証とentryを置く。入力例は単価200、数量3、商品コード「商品A」、会員false。結果はtotal 600と商品label。数量0は業務error、値域外入力はinvalid-input、計算可能な入力同士の積が範囲外なら算術faultとする。会員割引は整数の切捨て規則を固定し、端数例を必須にする。

全TS、全JSONC、JSONC→TS→JSONC、TS→JSONC→TSを用意し、それぞれ3targetへ生成する。独立に手計算したoracleをfixtureへ固定する。成功例だけでなく次を実装単位ごとに追加する。

| ID | 試験 | 受け入れ条件 |
| --- | --- | --- |
| V01 | 最小/最大整数、±1境界、−0、小数、NaN、Infinity | 入力・literal・演算の区分どおりに正規化または拒否 |
| V02 | 大きな積、0除算、最小値÷−1、負数の除算/剰余 | 数学的oracleと全backend一致。JS丸めやWasm trap任せにしない |
| V03 | 絵文字、結合文字、空、NUL、不正surrogate/UTF-8 | scalar数・等値・連結・拒否が一致 |
| V04 | 文字列16 KiB、payload64 KiBの境界±1 | byteとscalarを分離し、確保前に上限判定 |
| V05 | nested record/union、型alias、type-only import | 構造一致、layout/hash、型cycle・指数展開の拒否 |
| V06 | field不足/余分/重複、誤tag、非網羅/重複case | 元のsource位置で診断。backendへ不正IRを渡さない |
| V07 | const scope、前方参照、shadowing、branch型不一致 | 明示的に拒否。全経路returnを検査 |
| V08 | 未選択branchの0除算、call引数順、field初期化順 | 短絡と最初のfaultが四経路で一致 |
| V09 | record/string/union戻り値の直接call、多段呼出し | out-pointer・status伝播、参照寿命、戻り型が正しい |
| V10 | codecのendianness、alignment、padding、tag配置 | golden bytes一致。誤pointer、overflow、重複領域を拒否 |
| V11 | memory不足、fuel限界、timeout、連続・並行呼出し | 資源faultと運用障害を分離。呼出し間の状態漏れなし |
| V12 | 4入力構成×3target、JSONC再読込、別root配置 | 同じ構造のprogramHashと結果、依存閉包保持 |
| V13 | 原source削除、compiler非同梱でのWasm verify | 配布runtimeと固定suiteだけで実行できる |
| V14 | ABI/profile/manifest/suite/bytes改変、旧版reader | 不一致拒否、未知版fallbackなし、旧形式の回帰なし |
| V15 | source差替え、出力競合、途中失敗 | 公開契約保持、所有物以外を削除しない |
| V16 | Predicate、module-bool、Capability、host、replay | 既存公開形式・hash・固定条件のWasm bytesを維持 |

ランダム試験はseedを固定したwell-typed AST生成を補助として使い、共通helper由来の誤りを見逃さないよう算術は独立BigInt oracle、codecは手書きbytes、業務例は手計算を使う。全backendが同じ誤りを持つ可能性を差分試験だけで排除したとしない。

## 10. 品質Gateと終了条件

現行コマンドによる開始時の局所確認：

```sh
bun test src/llang-module.test.ts --timeout 30000
bun run ci:module-smoke
```

各PRはformat/lint/typecheckと担当試験を通す。最終revisionでは指定Bun 1.4.2・固定依存で以下を実行し、実行環境、source/config hash、dirty状態、件数・coverage・ログを記録する。過去の500件という基準を第二弾の結果へ転記しない。

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

新value smokeを`ci:module-smoke`に組み込み、旧boolean smokeも維持する。新script名、CLIオプション、schema版をdocs契約検査へ追加する。全体functions/lines 90%、semantic-transaction 95%の閾値は下げない。Ubuntu/Windows CIとmacOSローカルを分け、実行していない結果を成功と記載しない。

- [ ] 第一弾の品質証跡を確認し、第二弾の基準revision・hashを固定した。
- [ ] 数値、Unicode、型・制御、fault、fuel、ABIの意味と版を仕様化した。
- [ ] 全入力構成・全targetで単一注文明細の成功・業務失敗・実行faultが一致した。
- [ ] V01〜V16の境界・拒否・配布・互換試験が通った。
- [ ] JSONC再生成とcompilerなしのWasm実行が成功した。
- [ ] 旧profileの挙動と成果物を保持した。
- [ ] 同一最終revisionで品質Gate・対象CIを確認し、未実行項目を残していない。
- [ ] 仕様、schema、help、examples、対応表、結果記録を実装と同期した。

次のG3へは、可変長collectionと反復、再帰、generics、closure、局所更新、動的確保と寿命管理を引き継ぐ。f64/decimal等の追加数値型と文字列APIはG2で固定した意味・ABIを基に別の仕様単位で進める。第二弾の固定arenaを、長期稼働する汎用heapの完成として扱わない。
