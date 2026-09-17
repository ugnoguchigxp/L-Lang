# L-Langの汎用言語化：拡張方針コンセプト

作成日：2026-09-17。状態：**拡張方針の提案。新機能の確定仕様・実装完了を示す文書ではない。**

本書は、L-Langを現在の限定Predicateから、一般的なプログラミング言語で行う処理を広く記述できる言語へ発展させるための方針を定める。機能の範囲と設計原則、段階導入の順序を扱い、具体的な構文・schema・ABI・実装日程は個別仕様へ切り出す。

現行JSONCの正本は[Predicate v1仕様](./LLANG_JSONC_SPEC.md)。入力・出力の現状は[経路ガイド](./guides/language-routes.md)、既存の型・IR・backend構想は[Hybrid Compiler Concept](./HYBRID_COMPILER_CONCEPT.md)を参照する。本書はその方向性を汎用プログラムへ広げる提案であり、既存仕様を遡って変更しない。

G0/G1は[第一弾の実装計画](./GENERAL_PURPOSE_LANGUAGE_PHASE1_IMPLEMENTATION_PLAN.md)に沿って実装され、利用仕様は[Phase 1仕様](./LLANG_MODULE_SPEC.md)にある。G2の範囲・仕様判断・変更単位・検証と完了条件は[第二弾の実装計画](./GENERAL_PURPOSE_LANGUAGE_PHASE2_IMPLEMENTATION_PLAN.md)へ具体化した。第二弾は[実装結果](./GENERAL_PURPOSE_LANGUAGE_PHASE2_IMPLEMENTATION_RESULTS.md)と[Value module仕様](./LLANG_MODULE_VALUE_SPEC.md)を参照する。G3は[第三弾の実装計画](./GENERAL_PURPOSE_LANGUAGE_PHASE3_IMPLEMENTATION_PLAN.md)と[実装結果](./GENERAL_PURPOSE_LANGUAGE_PHASE3_IMPLEMENTATION_RESULTS.md)を参照する。collection本体の直接Wasm生成は未完了で、第四弾の前提作業に含める。

## 2026-09-18の方針更新

今後は人間向け構文や抽象化の網羅を拡張目標にしない。第三弾までの計算機能を直接Wasmへ変換する基盤を仕上げ、[第四弾の実装計画](./GENERAL_PURPOSE_LANGUAGE_PHASE4_IMPLEMENTATION_PLAN.md)でIO、非同期、取消・timeout、失敗と後始末、権限・予算、bytes、追加数値型、制限付き並行処理、streamを完成させる。以下のG4/G5から必要な実行機能を第四弾へ集約し、独自package registryや多態性等のG5全体へ自動的に進む計画とはしない。

## 1. 到達したい姿

L-Langで、複数ファイルからなるプログラムを組み立て、値を計算し、データを加工し、状態を管理し、外部システムとやり取りできるようにする。業務ロジック、データ変換、CLI、サービスの処理、エージェントが実行する能力を、同じ言語基盤で表現できることを目指す。

具体的には、注文データを読み込み、型を検査し、明細を集計し、割引を計算し、在庫APIを呼び、結果を保存する処理を、再利用可能な型・関数・モジュールへ分割して書ける状態である。各工程を個別にテストし、修正が影響する依存先を特定し、成果物を受け側で検証して実行できるようにする。

「概ね網羅する」とは、値、型、関数、制御、データ構造、状態、エラー、入出力、非同期、並行処理、ライブラリの組合せで実用的なプログラムを構成できることを指す。既存のあらゆる言語の構文を取り込むことや、すべてのプログラムの停止・正しさを証明することは目標に含めない。

初期の利用対象はアプリケーションとデータ処理である。OSカーネル、デバイスドライバ、厳密なハードリアルタイム、任意アセンブリを前提とする処理は当面の対象外とする。これらの判断で、将来の数値計算・サービス・UIホストとの接続を閉ざさない。

## 2. 維持する原則

### 2.1 TypeScriptとJSONCを並行して扱う

TypeScriptは人が関数や制御構造を書きやすい入口、JSONCは構造を明示して人とエージェントが編集できる入口として維持する。JSONCでも関数、型、モジュール、文と式を表現し、単一の判定設定に用途を限定しない。どちらも正式なソース形式として扱う。

入力と出力は別に選べる設計にする。共通言語の対応範囲内では、TypeScript／JSONCの入力から、TypeScript／JSONCのソース成果物とWasm実行成果物を生成できることを目標にする。生成JSONCは検査して再コンパイル可能なプログラムとし、manifestや説明用JSONと区別する。

現在は全組合せを選べる汎用CLIを提供していない。新方針は、既存のSemantic TypeScriptやJSONC直接buildを維持しながら段階的に実現する。任意のTypeScript、JavaScriptの動的挙動、npmパッケージを無条件で取り込む保証はしない。

ソース変換はプログラムの意味を保持する。コメント、整形、変数名、元のファイル分割まで完全に復元することは別の編集支援契約とする。元ソースは保持し、変換出力による上書きは明示的な操作にする。

### 2.2 型と意味を共通化する

同じ型・同じ処理が、入力形式やbackendによって別の結果にならないよう、Canonical Typeと共通の意味表現を中心に据える。構文上受理できても、型・演算・実行環境が対応しなければ、該当箇所で明示的に拒否する。

整数のoverflow、文字列の長さ、欠損、等価比較、評価順序、エラー伝播などを、JavaScriptやWasmの偶然の挙動へ委ねない。各backendは言語仕様に合わせて実装し、必要ならruntimeを同梱する。

### 2.3 コンパイラは決定的に動く

要求からプログラムを作る工程ではエージェントを利用できる。ソースが確定した後のparse、型検査、依存解決、build、実行の途中で、未対応機能をLLMへ自動委譲しない。

同じソース、依存、toolchain、対象profile、optionsから同じ成果物を再生成できることを目標とする。外部時刻、乱数、ネットワーク、並行処理を使うプログラムの実行結果まで、常に同一になるとはしない。

### 2.4 保証をprofileごとに明示する

現行`predicate-i32-v1`は、純粋な限定判定として維持する。一般プログラムの再帰・ループ・状態・入出力を、同じprofileへ追加しない。

将来profileは、受理する型・演算、必要runtime、許可するeffect、資源制限、ABI、再現可能性を定める。profile名は未決であり、純粋な一般計算、状態を持つ処理、ホスト機能を利用する処理などの段階を想定する。共通の言語中核を使い、profileごとに別言語を増やさない。

## 3. 能力の全体像

「現行」は主にJSONC Predicate v1を基準にする。TypeScript DSLや用途別実験の能力を、JSONC一般言語の提供済み機能として数えない。表の拡張欄はすべて提案である。

| 領域 | 現行の基準 | 拡張の到達目標 | 主な未決事項 |
| --- | --- | --- | --- |
| 基本値・数値 | boolean、closed enum、nullish状態。数値演算なし | 整数、浮動小数点、文字列、bytes、unit。正確な金額等の表現 | 初期数値型の集合、decimal／多倍長の導入段階 |
| 型 | 限定入力契約。戻り値boolean | record、tuple、tagged union、Option、Result、関数型、型alias、generics | 型の同一性、型推論の境界、公開型の互換規則 |
| 式・制御 | all/any/not/equals/present | 算術、比較、if、match、局所変数、代入、反復、break/continue/return | 文と式の構文、網羅性検査、評価順序の正式規則 |
| 関数 | 1ファイル1Predicate | 複数関数、型付き引数・戻り値、再帰、高階関数、closure | capture、再帰制限、特殊化方式 |
| module | 言語内importなし | ファイル分割、import/export、名前空間、依存グラフ、複数entry point | 拡張子解決、循環依存、公開interface形式 |
| collection | 一般collectionなし | 可変長配列、list、map、set、iterator、range、構築・探索・集計・ソート | 要素所有、順序、hash、境界外アクセス |
| 状態・抽象化 | 純粋で可変状態なし | 明示的な可変束縛、record更新、状態を隠すmodule、interface／trait相当 | alias、値と参照、methodの表現、動的dispatch |
| memory・資源 | 生成Predicateはlinear memory不要 | 自動的なメモリ管理、動的確保、資源handle、確実な解放 | GC／参照計数／region等の方式、ABI所有権 |
| エラー | 入力不正・検証失敗・runtime障害を区別 | 型付き失敗、伝播、回復、cleanup、panic／trapの区別 | 例外構文の必要性、stack trace形式 |
| 入出力・effect | 標準PredicateにIOなし | file、標準入出力、HTTP、時刻、乱数、環境設定、永続化adapter | 権限委譲、effect推論、各ホストの対応範囲 |
| 非同期・並行 | 言語機能として未提供 | async処理、待合せ、取消、timeout、stream、task、message passing | scheduler、背圧、共有状態、並列実行の段階 |
| 標準library | 経路別runtime・utility | 型付きの数値、文字列、collection、encoding、JSON、日時、testing等 | coreと追加packageの分割、版の固定 |
| interop | 限定TypeScript import、Wasm host | 明示した型・effectでのTS/JS／Wasm／外部API接続 | ABI、データコピー、非同期境界、binding生成 |
| package・tooling | 複数CLI、manifest、既存lock・検証 | package、依存固定、incremental build、formatter、LSP、debugger、文書生成 | registry、信頼・署名、公開手順、source map形式 |

## 4. 関数とモジュールを最初の土台にする

関数・モジュールは汎用化の必須要件である。一つの公開関数しか持てない構造では、共通処理を再利用したり、責務ごとに変更範囲を絞ったりすることが難しい。型・関数をmoduleの単位で管理し、公開interfaceと内部実装を分ける。

初期導入では、型付き引数・戻り値を持つ純粋関数、同一module内の呼出し、相対パスによる静的import、明示exportを扱う。module間の依存と関数の呼出しグラフは別に管理する。初期は循環importと再帰を拒否できるが、再帰は一般プログラムprofileの到達目標として残す。再帰を許可した後は、停止保証と実行資源制限を明確に切り替える。

静的な依存宣言を採用し、moduleの読込だけで任意のIOや状態変更が起きる方式を初期仕様に入れない。初期化が必要な状態は明示的な関数で作る。依存解決では探索順、重複名、曖昧な参照、workspace外参照、symlinkの扱いを固定し、環境差で参照先が変わることを防ぐ。

想定する構成は次のようになる。これは将来の配置例であり、現在のCLIでビルドできるサンプルではない。

```text
src/
  domain/
    order.llang.jsonc       # 注文型と検証
    pricing.ts             # 共通言語の範囲で書いた計算関数
  application/
    checkout.llang.jsonc    # 上記moduleをimportする購入処理
  ports/
    inventory.llang.jsonc   # 在庫サービスの型付きinterface
```

TypeScriptとJSONCの相互importは、両frontendが同じ公開型・呼出し規約・effectを表せる範囲で成立させる。moduleを分けても、静的linkで一つのWasmへまとめられるようにする。動的linkや実行時module読込は、その必要性を評価して後から追加する。

## 5. 型・値・演算の意味を先に固める

### 5.1 型とデータ構造

静的型付けを基本とし、公開関数の引数・戻り値・effectを明示する。局所的な型推論で記述量を減らし、情報不足を`any`へ自動変換しない。genericsはcollectionと再利用関数の基盤として扱い、必要な演算を制約で表す。型推論不能時の診断も仕様に含める。

record、tuple、tagged unionで複合データを表す。欠損、明示undefined、nullは現行契約で区別されるため、移行時に一つへ潰さない。新しいOption型等との対応は、変換規則として定める。JSON読み込みは未知の入力として扱い、検査を通過した後に型付き値へ変換する。

オブジェクト指向で担われるカプセル化、多態性、再利用は、module、record、関数、interface／trait相当で表現できるようにする。class構文を必須にはせず、継承・動的dispatchの採用は用途と実装負担から判断する。

### 5.2 数値・文字列・比較

数値は幅と演算規則を持つ型として定義する。整数overflowの既定動作、checked／wrapping演算、除算、型変換、浮動小数点のNaN・Infinity・符号付きゼロ・丸めを仕様化する。TypeScript backendでも、言語で定めた精度と失敗条件を維持する。金額等の正確な計算に浮動小数点を暗黙適用しない。

文字列とbytesを区別する。文字列の有効なUnicode、長さ・添字の単位、slice境界、正規化、大小比較、locale依存処理を定義する。「文字」の一語でbyte、UTF-16、Unicode scalar、書記素を混在させない。localeやtimezoneに依存する処理は入力・設定を明示する。

等価比較は型ごとに定義し、collectionやrecordの構造比較と参照同一性を区別する。map/setで使うhashは等価関係と整合させ、列挙順の保証も明文化する。

### 5.3 制御・状態・評価順序

if、match、短絡演算、反復、再帰、早期returnを扱う。副作用を導入する前に、引数と式の評価順序、短絡の有無、matchの網羅性、変数のscopeと初期化を固定する。

既定では不変な束縛を使い、必要な局所状態を明示して変更できるようにする。変数の再束縛、値の更新、共有参照先の更新を区別する。一般プログラムprofileでは停止しない計算が記述できることを認め、timeoutや実行budgetを停止証明と混同しない。

## 6. memory・失敗・外部資源を一緒に設計する

動的データを導入する時点で、確保と解放、コピーと参照、alias、closure capture、呼出しをまたぐ値の寿命を定める。通常のアプリケーションコードでは手動の解放や生ポインタを要求しない方向とする。GC、参照計数、region等の採用方式は未決であり、言語の値の意味と各backendの実装方式を分けて検討する。

file、socket、transaction等の外部資源には、memory管理とは別の有効期間と終了処理が必要になる。成功・失敗・取消のどの経路でも資源を終了できるscopeまたはcleanup機構を備える。取消が外部処理の取消やrollbackまで保証するかは、adapterごとに明示する。

通常想定される失敗はResult等の型付き値で表現し、伝播と回復を記述できるようにする。入力検証エラー、業務上の拒否、外部IOの失敗、プログラムのpanic、Wasm trap、資源上限超過を区別する。例外構文を提供するかは別途決めるが、黙ってfalseやnullへ変換する既定動作は採用しない。

Wasmとホスト間では、文字列・collectionのメモリ配置、所有権、解放責任、handleの寿命、不正な参照の検査をABIで定める。TypeScript側だけで安全に扱えたことを、Wasm境界の安全性の証明にしない。

## 7. 入出力・非同期・並行処理

外部操作は型付きhost interfaceを介して利用する。関数のeffectに、filesystem、network、clock、random等の要求を表し、依存先を含めて集約できるようにする。プログラムの要求とホストが付与する権限を照合し、必要な権限がなければ実行前に拒否する。

権限は「networkを使える」という名前だけで終わらせず、対象hostやpath、操作範囲を制約できる設計を検討する。effect情報のない外部関数をpureとして扱わない。ネイティブ実行やTS/JSのFFIは強い権限を持つ境界として明示する。

async関数、待合せ、timeout、取消を段階的に導入する。taskの生存期間をscopeと関連付け、処理終了後に未管理の仕事が残ることを避ける。streamとiteratorでは、背圧、終了、部分結果、途中失敗の意味を定義する。

並行処理は非同期処理と分けて考える。まずmessage passingとデータの分離を軸に設計し、共有可変memoryやatomicsは後続段階にする。スレッド数やschedulerが異なっても、順序を保証するAPIと保証しないAPIが区別できるようにする。並行実行の観測結果を、共通IRだけを根拠に決定的と呼ばない。

テストではhost interfaceを差し替え、時計・乱数seed・応答を固定できるようにする。外部操作のreplayは保存した観測を再生する方式を基本とし、送信・課金・更新等を無条件に再実行しない。

## 8. 標準library・interop・配布

言語中核、標準library、host adapterを分ける。数値やcollectionの基本操作は共通library、fileやHTTPはeffect付きinterfaceとadapter、特定サービスのSDKは追加packageとして扱う。すべてを構文や特別なIR命令にしない。

標準libraryの対象には、文字列・bytes・encoding、数値、collection、JSONのparse/serialize、日時、パス、正規表現、testing、loggingを含める。暗号、圧縮、DB、UI、OSプロセス等は、必要に応じたpackage／adapterで利用できる接続点を設ける。対応環境、資源上限、失敗、effectを同じ型と文書形式で説明する。

外部ライブラリは型付きbindingを介して利用する。任意JavaScriptをコンパイル対象へ混ぜて対応範囲を広く見せず、L-Lang内で検証できる部分と外部実装へ依存する部分を区別する。生成TypeScriptが特定runtimeへ依存する場合は、その版も成果物に含める。

packageでは公開interface、言語・profile・ABIの対応範囲、依存先の版と整合性を管理する。外部依存を導入する段階で依存解決Lockを設け、既存のResolution Lockやtoolchain用`bun.lock`とは役割を分ける。決定的buildが必要な経路では任意のinstall scriptを暗黙実行しない。registryや署名方式は未決とする。

LSP、補完、定義参照、rename、source map、stack trace、debugger接続も開発基盤に含める。JSONCで構造化されたプログラムを書けても、診断が元の関数やソース位置へ戻らなければ、一般プログラムの保守は難しい。

## 9. コンパイラと成果物の構成

想定する処理の流れは以下である。各箱の名称は概念上のもので、現在のファイル配置や公開APIを指定しない。

```text
TypeScript frontend ─┐
                      ├─ 名前解決・型検査・effect検査
JSONC frontend ──────┘              │
                         共通Program / Module / Function表現
                                    │
                         検証・特殊化・最適化・lowering
                                    │
                 ┌──────────────────┼──────────────────┐
          TypeScript出力       JSONCプログラム出力     Wasm出力
          ＋必要runtime        （再コンパイル可能）    ＋ABI / host契約
```

一つの平坦なIRへ構文、型、所有権、機械表現をすべて押し込まず、ソースに近い表現、検証可能な共通表現、backend向け表現を段階化する。各変換が保持する意味と必要な前提を定める。

manifestにはentry point、公開interface、参照した全ソースのhash、依存グラフ、package Lock、toolchain/options、profile、ABI、effect、成果物hashを記録する。単一ファイルのsourceHashを、複数module全体の変更検出に流用しない。

最適化では評価順序、overflow、例外、外部操作を変えないことを確認する。未使用コードの削除もeffectを考慮する。増分buildは依存関係と設定に基づき無効化し、cacheを検証の省略根拠にしない。

## 10. 互換性と現行仕様の仕上げ

現行Predicate v1を引き続き読み取り・検証・ビルドできるようにする。新しいmodule構造や型体系への移行は明示的な変換として提供し、ソースや契約を無断で書き換えない。

言語仕様、profile、公開schema、package形式、runtime ABIは異なる版の軸として管理する。受け側は必要な機能と版の組合せを照合し、未対応を推測で補完しない。互換性は少なくともソース互換、公開API互換、意味互換、バイナリ互換に分けて説明する。

汎用化へ進む前に、現行仕様の次の細部を整理する。2026-09-17の確認では、説明文の絵文字2,049個をschemaが受理しlintが拒否する長さの差、条件65件の上限超過をLLP001ではなくLLS001とする診断分類、式の未知fieldをキーではなく親bodyへ位置付ける診断差を確認した。これらは新機能ではなく適合性の修正として扱う。

入力検査の順序・対象、余分なfield、欠損とundefined、各種長さの単位、辞書順、canonical hashの正確な定義も、実装参照だけに頼らず仕様と適合テストで固定する。新機能でも同じ曖昧さを持ち込まない。

## 11. 段階導入と出口条件

以下は推奨順序であり、工数見積りではない。各段階でTypeScript／JSONCの対応範囲と各backendの対応表を公開する。未対応機能を使ったbuildは明示的に失敗させ、別backendへの自動切替で隠さない。

| 段階 | 主な導入範囲 | 完了を判断する例・条件 |
| --- | --- | --- |
| G0：現行v1の確定 | 仕様適合、文字数・診断・入力・hashの定義 | schema／lintの境界試験と既存回帰が一致 |
| G1：複数moduleの基盤 | 型付き純粋関数、呼出し、import/export、名前解決、entry point、依存追跡 | 3 moduleを両ソース形式で構成し、型不一致・循環依存を拒否。共通範囲でTS／JSONC／Wasmを生成・再検証 |
| G2：値と一般計算 | 数値、文字列、record／union、局所変数、if／match、型付き失敗 | 注文明細の計算と検証を表現し、境界値・Unicode・エラーをbackend間で照合 |
| G3：動的データと再利用 | memory/runtime ABI、generics、collection、反復、再帰、高階関数、closure、局所更新 | 件数が変わるデータの変換・集計・ソートを実装。資源上限と停止しない処理の中断を検証 |
| G4：外部と接続する処理 | effect、権限、file/HTTP等、async、取消、cleanup、標準library | 読込→変換→外部呼出→保存を実行。権限不足・timeout・部分失敗・資源解放を検証 |
| G5：大きなプログラムと運用 | package／依存Lock、interface、多態性、stream／task、並行処理、interop、開発支援 | 複数packageのサービスまたはCLIを別環境へ配布し、依存更新、診断、取消、切戻しを確認 |

文字列や複合値のWasm表現にはmemoryが必要になるため、G2で最小ABIを設計し、G3で動的確保と寿命管理を確定する。G2の時点でbackendの意味を合わせられない機能は、そのbackendで未対応として公開する。

各段階は一つの変更で導入せず、型・演算・ABI・診断・適合テストを揃えた単位へ分割する。数値型の意味やmemory所有権が未決なら、それに依存する機能の公開仕様化を進めない。型推論、generics、closure、非同期、並行処理を一度に導入しない。

## 12. 検証方針と「概ね網羅」の判断

仕様の例と境界値を、frontendとbackendから独立した適合テストへする。両ソース形式を同じ共通表現へ対応付け、reference実行、生成TypeScript、Wasmで値・失敗・effectの観測が一致することを確認する。JSONC出力は再読込・再コンパイルして意味を照合する。

数値境界、Unicode、空collection、ネスト、alias、再帰、取消、資源解放、module変更を重点対象とする。property-based test、fuzzing、差分試験を使い、生成器同士の一致だけを正解の根拠にしない。非同期・並行処理では、許可される順序や取消後の状態を検査し、単一の実行順に固定して合格させない。

大きな機能領域ごとに、最低一つの実用規模の縦断例を持つ。

- 複数module・共通型・再利用関数を使う業務ロジック。
- 可変長データを読み、検査・変換・集計して出力するCLI。
- 外部APIと永続化を使い、失敗から回復できるサービス処理。
- 複数taskとstreamを扱い、取消時に資源を解放する処理。
- 外部ライブラリを型付き境界で利用し、別環境へ配布するプログラム。

これらがソースの一部を任意TS/JSへ丸投げする特別扱いなしに構成でき、検査・テスト・配布・診断まで通ることを「概ね網羅」の判断材料にする。外部APIやlibraryの利用自体は通常のinteropとして認め、その境界と依存を明示する。

## 13. 次に仕様として決めること

最初の設計作業では、Program／Module／Function／Typeの共通モデル、名前解決、公開interface、呼出しと戻り値、entry point、依存追跡、既存Predicateの取り込みを決める。その後に型・数値・memory・effectを順に具体化する。

特に、次は実装開始前に個別の判断記録を残す。

| 判断 | 決める内容 |
| --- | --- |
| 共通言語の境界 | 取り込むTypeScriptの構文・型と、JSONCで対応する構造 |
| 型の意味 | nominal／structuralの使い分け、union、generics制約、推論、公開API互換 |
| 値とABI | 数値集合、文字列の単位、record／collection配置、所有権とmemory管理 |
| 実行モデル | 再帰・反復、失敗、状態、資源budget、effect、asyncと取消 |
| 標準環境 | 必須runtime、core library、host adapter、対象環境ごとの差 |
| 依存と版 | module解決、package Lock、profile／schema／ABIの版付けと移行 |

拡張の基準は、一般的な処理を組み立てられることと、その意味を検証・説明できることの両立に置く。関数・モジュールを土台に用途を広げ、対応している範囲を、ソース・型・成果物・実行時の四つの境界で一貫させる。
