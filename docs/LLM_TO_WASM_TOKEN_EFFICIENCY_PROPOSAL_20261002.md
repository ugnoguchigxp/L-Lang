# プロンプトを正本にしてWasmを作るための調査と提案

2026-10-02。提案書。実装・新しいモデル試行・設定変更は行っていません。既存のコンセプト、仕様、計画を更新する決定ではありません。

## 推奨する方向

**LLMにWasmのバイト列や詳細なJSON ASTを全部書かせるより、要求の解釈と短い実行仕様を一度に返させ、既存の検査・コンパイラで展開する方法を小さく試すことを推奨します。** 実行仕様には、状態と遷移、決定表、既知のデータ処理部品を使います。部品で表せない計算は、同じ応答に含めた制限付きTSの小さな関数で補います。表現できない要求は未解決として返します。

狙う成果は、利用者がコードを正本として保守せずに、成功までのtoken、待ち時間、修正を減らせることです。決定的なコンパイルが何段あるかは、モデルが生成・再解釈する量とは別です。段数が増えてもLLMの出力と修正が減れば目的に合います。逆に「自然文→仕様→IR」の各段でLLMを呼び、同じ内容を再生成すれば目的から遠ざかります。

現在の計測は、L-Langの生成コストが通常TSより低いことを示していません。通常TSは有力な比較対象です。ただし、既存TS試行との差をJSONCだけの効果とすることもできません。まず同じモデル・推論・要求・部品・成功条件で、直接JSONC、制限TS、短い仕様の三経路を比較する必要があります。

JSONCとTSの入口、profileごとの検査済み表現、Binaryen、manifest、検証器、runtimeは残します。新しい入口は実験として追加し、合わなければ取り外せる構成にします。汎用自然言語コンパイラ、新しい統一IR、テトリス専用DSLの開発を出発点にはしません。

## セッションと調査範囲

正規の`list_projects`でL-Langは次の登録情報でした。

| 項目 | 確認結果 |
| --- | --- |
| プロジェクトID | `2cba6f4f-e7b1-48ed-abb8-93cc715d1c57` |
| 登録先 | `/Users/y.noguchi/Code/L-Lang`、local、Git repository |
| このセッション | `01a0fa2b-5681-7861-a681-8463c029391c` |
| 正規`list_threads`のcwd | 登録先と一致 |
| 正規`list_threads`のprojectId | `null` |
| 保存済み`turn_context` | model=`gpt-6.1-sol`、effort=`high` |
| 調査時のHEAD | `7ba0adea047d9134401690d149943f62b6f7f7d0`。未コミットのコード・例も参照 |

したがって、登録L-Langの作業ディレクトリで調査していることは確認できましたが、**アプリ上のprojectId紐付けが設定されているとは確認できません**。ご指定の「Astra reasoning high」に対して、今回のターン記録はSol 6.1 highです。highは一致し、モデルは一致しません。この記録はクライアントの実行設定を示すもので、サーバー内部のモデル実装を独立検証したものではありません。確認元はこのセッションの[保存済み実行記録](/Users/y.noguchi/.codex/sessions/2026/10/02/rollout-2026-10-02T10-12-19-01a0fa2b-5681-7861-a681-8463c029391c.jsonl)です。設定は変更していません。

設定ファイルの既定値だけで現在のモデルを断定せず、ターン記録を優先しました。公式資料にもmodel、reasoningの既定設定と個別overrideがあることが記載されています。[OpenAI公式の設定案内](https://learn.chatgpt.com/guides/best-practices#configure-codex-for-consistency)

AGENTS.mdに従い`initial_instructions`を1回実行しました。`llang-binaryen`、日本語報告の`human-writing`、設定確認のOpenAI Docsを参照しました。初期案内は`context_compile`と評価のDB保存を求めますが、今回の「DB変更不要」を優先し、`context_compile`・`compile_eval`は各0回です。Luna 6 high IRの確認待ち試行は調査・操作の対象にしていません。新しいモデル比較、build/test再実行、commit/push、他チャットへの連絡は行っていません。

## コードから確認した現在の経路

「Semantic IR」は一つの保存形式を指すとは限りません。現在はPredicate、Bool、Value、Collection、Effectsで別の型・制約を持ちます。TSとJSONCが合流するのは対応するprofileの検査済み表現であり、全入力が一つの万能IRに入る構成ではありません。[Semantic Coreの定義](/Users/y.noguchi/Code/L-Lang/docs/LLANG_SEMANTIC_CORE_V1.md)

| 入力経路 | 意味解決・固定 | 検査と出力。対応範囲 |
| --- | --- | --- |
| 直接JSONC Predicate | bodyを入力が明示。Resolution Lockなし、LLMなし | JSONC parser→`checkLlangProgram`→Predicate lowering→Binaryen→Wasm。Boolean/enum/nullish条件。数値計算やゲームではない |
| 固定request/suiteからJSONCを生成する`llang develop` | fixtureまたはlive agent。初回実装＋最大1回修正。既存suiteを固定 | `llang-development-protocol`の現行schemaはPredicate v1。テトリスのCollection全体を、この標準生成コマンドが作るわけではない |
| Prompt Source v1 | intent、要求、未解決条件、契約をresolverがPredicateに解決。Lockで固定 | `resolvePromptSource`は一致Lockならresolver 0回、新規解決はresolver 1回。provider内部のモデルrequest数とは別。独立例はresolver入力から除外し、解決後に検査。buildは0回 |
| Prompt Sourceから`llang migrate` | 有効Lockのbodyを決定的に変換 | JSONC、request、suiteを新規保存。自然文を再解釈する工程ではない |
| Semantic TypeScript DSL | Conceptと型、Semantic TestからPredicateを解決し、`semantic.lock`に保存 | 通常TS生成、型検査・テスト・promotion。fingerprintは要求・型・テスト・prompt/context等に依存。対応Lockなら再解決不要。lock済みPredicateをWasmへ出す別経路もある |
| Semantic TDD / Static Judgment | TDDはTest Planと実装の解決を分ける。Static Judgmentは静的値への判定を解決しLockに固定 | TDDは別のtest lockと検査を持ち、初回呼出しが一つとは限らない。Static JudgmentはBoolean定数生成であり、動的ゲームの一般合成ではない |
| Hybrid / 既存TS Predicate取り込み | 型・関数ASTを静的に取り込み、LLMなし | `typescript-predicate-importer`が限定構文をPredicate IRと契約にする。任意TSをWasm化する経路ではない |
| Moduleの制限付きTS / JSONC | 両frontendが明示済みの処理を読む。LLMなし、意味解決Lockなし | profile別loader→checker→検査済みprogram→TS/JSONC/Wasm。Collectionでは`.ts`と`.llang.jsonc`が`checkCollectionProgram`に合流。混在import可能 |
| examples内の専用経路 | 用途別request/JSONCから決定的に展開 | 世界時計・JSON sort等。世界時計はレビュー済みfixtureで動き、自然文のlive合成実証ではない。標準言語機能に数えない |

経路の根拠は[入口ガイド](/Users/y.noguchi/Code/L-Lang/docs/guides/language-routes.md)、[Prompt Source](/Users/y.noguchi/Code/L-Lang/src/prompt-source.ts)、[意味解決とLock](/Users/y.noguchi/Code/L-Lang/src/prompt-resolution.ts)、[Semantic compiler](/Users/y.noguchi/Code/L-Lang/src/semantic-compiler.ts)、[TDD compiler](/Users/y.noguchi/Code/L-Lang/src/semantic-tdd-compiler.ts)、[JSONC生成protocol](/Users/y.noguchi/Code/L-Lang/src/llang-development-protocol.ts)、[Hybrid importer](/Users/y.noguchi/Code/L-Lang/src/typescript-predicate-importer.ts)です。

### Profile、checker、backend、runtime

| Profile | コードで確認した機能・境界 |
| --- | --- |
| `predicate-i32-v1` | equals/present/not/all/any、1段のproperty、Boolean結果。Wasmは状態やmemoryを持たない |
| `module-bool-v1` | 純粋な型付き関数、flatなBoolean record、module。再帰・局所状態・IOなし |
| `module-value-v1` | i32、文字列、record、tagged union、block/if/match。一般ループ・List・可変束縛なし |
| `module-collection-v1` | List、map/filter/fold/stableSort、generics、closure、再帰、while/forEach、局所更新。外部effectなし |
| `module-effects-v1` | typed operation、await/task/stream、bytes/i64/f64/decimal等、権限・取消・予算。現行checked graphのoperation requestはコンパイル時固定。任意TSのasyncや動的業務計算の無制限な入口ではない |

Collectionの制限TSは型注釈を要求し、`number`をi32として解釈します。Listとintrinsicは`llang:core`から明示importします。任意のJS配列・spread・npm・DOMの振る舞いをそのまま受理しません。JSONCでも「文と式」を全部明示する構文なので、低水準のプログラムであること自体は変わりません。

JSONC parserは未知field・重複key・深さ・サイズを検査します。Collection loaderはroot外参照、symlink、import cycle、ファイル上限を検査し、checkerは型・export・参照・束縛・型展開・式等を検査します。CLIのmodule lintも同じloader/checkerを通ります。現行moduleの診断は最初のthrowで止まる箇所があり、一回のlintで全問題が出るとは限りません。構造上の合格だけでは、ゲーム機能の完成、期待値の独立性、自然文との一致を判定できません。[Collection loader](/Users/y.noguchi/Code/L-Lang/src/llang-module-collection-loader.ts)、[checkerと上限](/Users/y.noguchi/Code/L-Lang/src/llang-module-collection-ir.ts)、[JSONC parser](/Users/y.noguchi/Code/L-Lang/src/llang-jsonc.ts)

標準backendは固定版Binaryen **132.0.0**です。package指定、インストール済みpackage、build manifestで一致しました。PredicateはBinaryen APIでemitし、Collectionは`emitNativeCollectionWat`→`binaryen.parseText`→validate→emitBinaryです。標準Collectionはunoptimized経路で、`module.optimize()`を呼びません。LLVMは`checked-sum-i32`の厳密な形を抽出する実験で、テトリスを任意にLLVMへ送れるbackendではありません。今回の目的ではbackend切替より生成・修正負担を先に測るべきです。[Collection emitter](/Users/y.noguchi/Code/L-Lang/src/llang-module-collection-wasm.ts)、[LLVM抽出制約](/Users/y.noguchi/Code/L-Lang/src/llang-llvm-kernel-ir.ts)

Collection runtimeはimportsなしのWasm、固定128 memory pages、ABI/type/layout/hashを検査します。呼出しごとにfresh instanceを作り、状態を入出力で渡します。fuel 1,000,000、call depth 64、arena 4 MiB、List要素4096、wire 256 KiB等を制限し、境界外・zero除算・overflow・資源超過を区別します。TS projectionにも算術・allocation・fuel等の補助処理があります。これは通常TS実行と同じコスト／意味契約ではありません。[buildとmanifest](/Users/y.noguchi/Code/L-Lang/src/llang-module-collection-build.ts)、[native生成](/Users/y.noguchi/Code/L-Lang/src/llang-module-collection-native.ts)、[runtime](/Users/y.noguchi/Code/L-Lang/src/llang-module-collection-runtime.ts)、[TS projection](/Users/y.noguchi/Code/L-Lang/src/llang-module-collection-source-emitter.ts)

テトリスは親のSDK指示でゲーム・テストJSONCを生成し、共通grid builderから標準Collection compilerを呼ぶ経路です。Prompt Sourceのresolveは使っていません。Wasmが衝突・回転・消去・得点等を担当し、hostが入力、状態transport、描画、timerを担当します。promptはprovenanceにhash保存されていますが、そのhashからゲームの意味を機械検証する仕組みではありません。[共通builder](/Users/y.noguchi/Code/L-Lang/examples/templates/wasm-grid-app/build.ts)、[元の開発記録](/Users/y.noguchi/Code/L-Lang/examples/tetris/DEVELOPMENT_REPORT.md)

## 既存計測が示すこと

以下は保存済みの測定値です。再試験していません。入力と出力の合計をtotalとし、cached inputはinputの内数、reasoning outputはoutputの内数です。親・調整担当のtokensは全試行で未計測です。

| 試行 | 結果 | total tokens | 未cached入力＋出力 | 出力（reasoning内数） | SDK時間 / 外側SDK呼出し |
| --- | --- | ---: | ---: | ---: | --- |
| 元IR Luna 5.6、low 2回→medium 15回 | 成功。元固有の131 checks＋親監査177 checks等。固定36条件との同条件比較ではない | 22,348,273 | 508,401 | 95,519（18,477） | 2369.718秒 / 17 |
| 共通prompt IR Sol 6.1 low | 成功、36/36 | 1,959,325 | 117,661 | 29,170（7,030） | 1024.713秒 / 1 |
| 共通prompt IR Luna 5.6 low | 未完成、10/36 | 1,405,787 | 96,347 | 17,259（2,889） | 391.144秒 / 4 |
| TSのみ Sol 6.0 low | 成功、36/36 | 513,124 | 49,124 | 13,129（982） | 283.179秒 / 2 |
| TSのみ Luna 6.0 high | 成功、36/36 | 2,292,958 | 163,550 | 48,510（24,632） | 1074.714秒 / 2 |

数値の正本は[元usage](/Users/y.noguchi/Code/L-Lang/examples/tetris/token-usage.json)、[IR Sol summary](/Users/y.noguchi/Code/L-Lang/artifacts/tetris-comparison-20261002/sol-low/summary.json)、[IR Luna summary](/Users/y.noguchi/Code/L-Lang/artifacts/tetris-comparison-20261002/luna-low/summary.json)、[TS比較JSON](/tmp/tetris-ts-comparison-20261002/comparison.json)です。IR protocolに元Lunaの「medium 14回」とありますが、元usageと開発記録は17回中low 2回／medium 15回で一致するため、後者を採用しました。

元IR Lunaでは入力22,252,754のうち21,839,872がcachedで、約98.1%です。これは同じ履歴等が繰り返し送られる負担を示しますが、cached tokenと未cached tokenの金額・遅延が同じとは言えません。total、未cached、出力、実時間を併記する必要があります。cachedを除くと元IR Lunaは508,401で、Sol IRとのtotal比約11.4倍が、未cached入力＋出力比では約4.3倍になります。料金は未計算です。

Sol IRとSol TSのtotal比は約3.82倍、出力比は約2.22倍、SDK時間比は約3.62倍です。**これはIR採用の因果効果ではありません。** 世代は6.1対6.0、promptは9177対8409 bytes、読める資料・実行契約・UI再利用・レビュー内容・修正方法が違います。IR側は共通UI、TS側はUIも生成しています。ゲーム成功判定36件は対応していますが、IR固有のABI・fuel・arena条件をTSが満たす比較ではありません。共通形状座標にも一般的なテトロミノとは異なるものがあり、標準SRSの成功証拠ではありません。[IR protocol](/Users/y.noguchi/Code/L-Lang/artifacts/tetris-comparison-20261002/protocol.md)、[TS条件と限界](/tmp/tetris-ts-comparison-20261002/COMPARISON.md)

IR SolのSDK呼出し1回は、モデルとの通信1回を意味しません。保存SDKイベントにはcommand execution 33件、summaryにはvalidation command record 15件中失敗11件、validation snapshot間のIR変更12回が記録されています。外側からのdiagnostic repairが0回でも、そのターン内で生成・検査・修正を繰り返しています。実際のモデルrequest数はこのsummaryでは未取得です。

未完成Lunaの136件という自作テスト数は、ケース番号が範囲内ならtrue、連続検査も固定trueという内容で、ゲーム検証には数えられません。少ないtokensで成功した試行として扱わず、失敗コスト・失敗率へ含めます。Luna 6 high IRの最終未確認試行は、この表にも推論にも含めていません。

## 膨張の原因を分ける

| 要因 | 確認できた根拠 | 判断と未確認事項 |
| --- | --- | --- |
| 表現の冗長性 | Sol IRのgameは81,230 bytes、testsは347,027 bytes。gameにState constructor 12箇所、各13field、計156field指定。literalは657個。元IRのgameにもliteral 811個。TS Solはgame 4,747、tests 9,711 bytes | JSON ASTは演算子・参照・型・無変更fieldを繰り返す。Listゼロ初期化もliteral列で書いている。ファイルbyte数はtoken数ではなく、別実装・ケース数差もあるため圧縮効果を数値断定しない |
| コンテキスト再送 | 元Lunaは17外側ターン、98.1% cached入力。同一threadを継続。Solも1外側ターン内に33 command execution | 完成出力の大きさだけで22Mを説明できない。tool応答、履歴、資料、診断、authoring helperの生成が累積する。各requestの入力内訳と再送tokenの原因別配分は未取得 |
| 静的診断・基盤制約 | Solの失敗にunknown if key、source size超過、type expansion超過4回、root path問題。native emitでunknown bindingも発生 | 公開JSONCのthen/elseと内部IRのwhenTrue/whenFalseを取り違えている。小さな共有fixture・正しいschema・早いpreflightに改善余地。unknown bindingはcheckerとbackendの不整合候補で、生成側だけのミスと断定しない。4回の型上限失敗は変更を伴う試行で、無変更再実行4回という意味ではない |
| 仕様ミス・期待値ミス | 共通protocolは初期promptの==/!=を===/!==へ修正。元のsequence指示は、親が作った全面埋めfixtureの行消去を見落としたと記載。SolにはT-right-one-kickテスト失敗 | LLMの実装だけでなくprompt・親のfixtureも修正原因。仕様変更なしに診断で直せる部分と、利用者に確認すべき解釈変更を区別する。kick失敗の責任分解は今回していない |
| モデル・推論 | 同じIR common promptでSol成功、Luna未完成。Lunaの後半修正はファイル・command変更0 | タスクを継続し本物の検証を書く能力が成功に影響。記法変更だけで未完成を解決できる証拠はない。世代差・推論差・各1試行からモデル一般の優劣は出せない |
| テストと検証 | 元Lunaのtests〜tests-final-fixの7外側フェーズだけで9,804,030 tokens、約43.9%。Solのtest IRがgameの約4.3倍のbytes。元は呼出し内の複数dropでRESOURCE_LIMITに達し、別呼出しのsequence laneを親が追加 | テスト期待値、fixture、dispatch、propertyの全展開も負担。テストを削るのでなく、固定fixture・独立oracle・汎用property runnerを共通化する。phase名による区分で、テストだけの厳密なtoken帰属ではない |

Solの11失敗commandの最初の代表障害は、root外参照1、JSONC field違い1、native binding1、source size1、type expansion4、未作成style/dist1、kick検証1、RESOURCE_LIMIT1でした。一つのcommandが複数検証を含むため、独立した11個のバグやモデル呼出し11回を意味しません。[SDKイベント](/Users/y.noguchi/Code/L-Lang/artifacts/tetris-comparison-20261002/sol-low/generate-desktop-events.jsonl)

元の親指示は途中で共通sequence基盤を追加し、期待値を訂正し、fuel内に収まるケースへ変更しています。[sequence指示](/Users/y.noguchi/Code/L-Lang/examples/tetris/generation/tests-sequence-prompt.txt)、[最終テスト修正指示](/Users/y.noguchi/Code/L-Lang/examples/tetris/generation/tests-final-fix-prompt.txt)。元22Mを純粋なIR表現コストと呼べない理由です。

直接IRの試行でも、一時Python/JavaScriptによるAST構築を許可しており、Solのログには`author.py`の作成・修正が残ります。「最終gameソースがJSONC」は、「LLMがプログラムコードを一切書いていない」とは異なります。その補助コードも生成量・修正コストへ含めるべきです。

## 候補の利益と代償

| 候補 | 減らせる仕事 | 代償・成立条件 | 判断 |
| --- | --- | --- | --- |
| JSONをS式・短縮key・独自記法に変更 | key、括弧、type等の反復出力 | 同じASTのままなら衝突・回転・fixtureの意味判断は残る。新grammarの学習・診断・保守が増え、tokenizer次第で短くならない | 主案にしない。表現だけの効果を見る副実験なら可 |
| 制限TSをLLMの内部出力にする | 式・変数・loop・関数を短く書ける。既存frontendがある | 通常TSの癖で未対応syntaxを出す危険。i32、List、capture制約の診断は残る。利用者にTS保守を求めれば目的から外れる | 最初に比較する低負担案。自然文正本と両立する |
| 自然文→短い構造化実行仕様→決定的展開 | ABI、record全field、型、定型loop、接続、validatorをモデルが毎回書かずに済む | 語彙に対応した展開器が必要。自然文を項目へコピーするだけではアルゴリズムが定まらず、結局もう一度LLMが必要 | 小さな入口を推奨。解釈と仕様は1応答にまとめる |
| 状態／遷移・決定表 | pause/ended、イベントの優先順位、未変更field、guard、更新が見える | collision等の計算内容までは表だけで生まれない。排他条件、重複行、順序、更新前の値、default動作を明示する必要 | 再利用する制御形式として採用候補 |
| 再利用primitive | record patch、repeat/fill、bounded search、filter/fold、安定compaction等を参照一つにできる | 部品の意味・版・失敗・資源挙動を固定し検証する負担。部品がTetris全ロジックなら生成能力を比較したことにならない | 小さな汎用部品から。TS側にも同じ部品を供給 |
| 型付き差分生成 | 正常部分、interface、巨大fixtureの再出力を減らす | 安定ID、依存範囲、base hash、原子的適用、stale拒否が必要。正本との乖離を防ぐ必要 | 修正時に推奨。全文再生成を既定にしない |
| schema／grammar制約 | 未知kind、key、演算子、余分な自由文を抑える | 受理syntaxでも仕様が違う、未実装、常時true等は起きる。巨大ASTの出力量自体は減らない。利用するproviderが保証する機能を別途確認する必要 | 短い仕様に併用。現SDK試行に既に効いていたと仮定しない |
| LLM直接binary / WAT | 人間向けソースを経由しない成果物 | binaryにもinstruction、offset、section、ABIが必要。WATは別の低水準コード。Wasm validateは型・構造検査で、要求との対応は残る。修正位置・意味追跡が難しい | 今回のtoken節減の主案として保留 |
| backendをLLVM等へ変更 | 決定済みプログラムのruntime性能改善候補 | 意味解釈・巨大テスト・再送tokenは直接減らない。現LLVMは狭いsum実験のみ | この課題の初手から除外 |

短縮記法にすると静的エラーや出力tokensが減る可能性はあります。しかし、**モデルに決めさせる情報量を減らす効果**と、**同じ情報を短く印字する効果**を分ける必要があります。後者だけでは、未実装骨組み・誤った回転・同語反復テスト・親の仕様ミスを解消しません。

汎用primitiveの候補は、まず型付きrecord更新とListの反復生成、既存map/filter/fold/stableSortの短い参照です。次に有限候補から条件を満たす最初のものを選ぶ操作、残す行の順序を保った詰め直しなどを検討できます。探索はスケジュール候補やルール選択、compactionはデータ表や座席表にも使えます。こうした別課題での再利用を確認するまで、一般化済みとは呼びません。

record更新の展開は、入力値を一度だけ評価し、更新式を同じ更新前snapshotから評価して、未変更fieldを保存する、と契約化します。既存constructorへの展開はallocation/fuelを消費します。意味やfault順序、資源上限を変える専用命令・最適化は、単なる記法変更に紛れ込ませません。

短い仕様でも、展開後のIRが大きければ式・型展開・arena・fuelの上限に達します。モデルの出力を短くするだけでcompilerの制約は解消しません。部品の関数参照やfixture共有で重複を減らし、展開後の規模をpreflightで検査する必要があります。共有しても現行checkerが型を繰り返し展開する場合など、上限内に収まらない結果は実験の失敗として残します。

## LLMとコンパイラの責任

LLMに残る仕事は、利用者の語をデータ・状態・条件へ結び付け、業務ルールと例外を解釈し、必要な計算手順を選ぶことです。「重ならないように落とす」から衝突判定と探索を選ぶ判断、「同じ点数なら先に来たものを優先する」から安定順序を選ぶ判断は、型検査だけでは決まりません。知らない計算は残余関数として生成するか、質問・非対応として返す必要があります。

コンパイラは、定義済み語彙の型付け・参照解決・展開、状態コピー、evaluation順、ABI/layout、境界・overflow、資源制限、決定的生成を担当します。短い仕様の自然文説明からアルゴリズムを推測して埋めることはしません。「公平に配る」「見やすく」「通常の回転」のような未定義語を受理して既定実装へ隠すと、成功に見えて要求がずれます。

自然文から任意アルゴリズムを正しく合成する一般解は、この提案にはありません。定義済み部品の組合せなら決定的にlowerできますが、新しい探索戦略、細かな幾何、複雑な最適化は情報をどこかで明示する必要があります。それを小さなTS関数で書くなら、その部分はプログラミングです。利用者が書かずに済むことと、内部でコードが不要になることを混同しません。

原文promptと回答済みの補足を利用者の正本にし、解釈、実行仕様、残余関数、IRを派生成果物として保存する案です。要求IDはツールが割り当てて原文範囲と対応させ、LLMによる言い換えだけを正本に昇格させません。Lockには原文hash、回答hash、profile、部品とtoolchainの版/hash、解決仕様、残余関数、検査結果を結び付けます。同じ依存・有効Lockの再buildはLLM 0回を目指します。新しい部品版や型・要求変更は影響部分を再検査し、古いLockを黙って利用しません。これはCollection向けには未実装の提案です。

曖昧さの質問は意味の結果が変わる箇所に絞り、一括で提示します。満たす方法が複数あっても結果契約が同じで既定が明示されていれば、利用者に内部実装選択を求めません。曖昧さを検出するLLMの失敗も独立例とレビューで評価します。

修正は、固定prompt・固定期待値を保ったまま解釈／仕様／残余関数の対象IDだけを変更します。要求そのものを変える必要があれば、利用者の補足として正本へ追加し、仕様修正とは別に記録します。compiler内部の構造的不整合はモデルに回避を繰り返させず、失敗した経路として記録し、基盤修正後の試行と分けます。

## 小例：倉庫内の予約数を管理する

以下は提案形式の説明例であり、現行CLIが受理する新grammarではありません。外部APIや並行在庫更新を含まない、入力状態とイベントから次状態を返す計算を例にします。

利用者の正本promptは、例えば次の文章です。

> 倉庫の在庫を予約する仕組みを作ってください。最初の在庫は20個で、予約はありません。予約を受け付けたら在庫から予約数へ移し、取消では元に戻します。足りない予約は断って、数を変えないでください。受付を停止したら新しい予約だけ止めて、再開もできるようにしてください。在庫と予約は合わせて20個を保ち、画面では結果と現在の数を見せてください。

### 曖昧さの確認

最初のLLM応答は、意味が未確定なら実装せず、「取消が予約数を超えたら拒否か」「0・負数・小数をどう扱うか」をまとめて返します。「新しい予約だけ止める」は取消を止めない指示として使い、重複して確認しません。利用者が「超過は拒否、数量は1〜20の整数のみ」と答えた場合、その補足を原文と一緒に保存します。初回に補足まで指定されていれば質問は不要です。

### モデルに求める短い成果

ループ、全fieldのrecord構築、Wasm ABI、全テストASTは求めません。次の意味を型付きの欄・遷移行として返させます。式はモデル向けの内部表現で、利用者のpromptに書く必要はありません。

| 項目 | 解決仕様 |
| --- | --- |
| 状態と初期値 | 在庫:i32=20、予約:i32=0、受付:Boolean=true |
| 入力 | reserve/releaseの数量、close/openのイベント |
| 数量の契約 | reserve/releaseのみ、整数1〜20。不正は拒否、状態不変 |
| 不変条件 | 在庫≥0、予約≥0、在庫＋予約=20 |
| reserve | 受付中かつ数量≤在庫なら、在庫から数量を引き予約に加え、acceptedを返す。それ以外はrejected、状態不変 |
| release | 数量≤予約なら逆移動してaccepted。受付停止中も可。超過はrejected、状態不変 |
| close/open | 受付fieldだけfalse/trueにする。繰返しも同じ結果 |
| default | 未知イベントと不正状態は拒否。状態不変 |

実際の機械入力では、条件は`and`、比較、field参照、加減算等の定義済み式とし、更新は「変更fieldだけ」の型付きpatchにします。この表の文章をそのままcompilerが自然文解釈する設計ではありません。モデルは必要に応じてguard式を短く明示します。型・event ID・出力statusのenumはschemaで拘束します。この例では残余アルゴリズム関数は不要です。

### 展開と検証

展開器はrecord/イベント型、入力validator、状態validator、更新前snapshot、guard順序、各結果status、無変更fieldの保持を生成し、既存ValueまたはCollectionのsourceへlowerします。物理的な注文APIや排他制御は生成しません。hostには状態transportと表示を任せます。状態不変で拒否するルールを、i32 overflow trapや入力codecの型エラーと同一視しないよう、外側の入力契約と業務上の拒否を分けます。

独立した受入例を先に固定します。reserve(5)後は在庫15・予約5、close後のreserve(1)は拒否、停止中のrelease(2)は在庫17・予約3、release(4)は拒否、再open後はreserveが可能。0・負数・小数・未知イベントの拒否、20を超えない保存則も確認します。数量など、typed ABIへ入れられない不正値はhost境界で拒否し、業務上の失敗は通常結果として返す契約です。

共通runnerは、この固定された入力と期待結果を実行します。展開器の内部ロジックから期待値を自動生成すると同じ誤りを共有するため、独立oracleの代わりにはしません。fixtureの整備・レビューにも費用がかかり、少ないLLM呼出しを実現するための準備コストとして記録します。

例えばLLMがreleaseにも受付guardを付け、独立例「close→release(2)」が失敗したら、診断は該当遷移ID、要求の対応箇所、before、event、expected、actualを返します。修正成果は「releaseのguardを数量≤予約へ変更」という型付き差分とbase hashだけです。原文、他遷移、期待値は保持し、決定的に全体を展開して影響例・共通受入を再検証します。source mapにより生成IRのエラーを遷移IDへ戻します。

質問なし・検証成功ならLLM 1応答、確認が必要なら確認前後で最低2応答、検証修正が必要ならさらに1応答です。一回成功を保証しません。compilerの再実行はLLM呼出しに数えません。

この例は予約に限らず、上限付きカウンタ、受付制御、状態遷移のある業務処理へ広げられます。ただしテトリスの形状・回転・衝突はこの表だけで得られません。そこで有限候補探索などの部品を再利用し、幾何の残余部分は制限TSで明示する、という境界を評価します。単純な例だけで汎用性やtoken節減を実証したことにはしません。

## 最小実験と測定計画

### 既存資産を残す実験

最初の試作は小さな実験用frontendに限定します。状態遷移とrecord patch、Listの反復生成、既存collection操作への短い参照を扱い、既存sourceへ展開して既存checkerを通します。checkerを迂回する新binary入口は作りません。既存moduleの型・ABI・runtime制限は固定します。展開器とsource map、部品のテストは人が決定的に実装する準備作業で、LLM生成コストとは別に測ります。

初めに保存fixtureで展開の意味・上限・再現性を確認します。次に倉庫予約と「条件で抽出し、順序を保って並べ、集計する一覧処理」を使い、状態型とcollection型の両方を試します。最後に元テトリスと同じ仕様全体を比較します。完成テトリスを一つのprimitiveとして供給せず、未知の幾何や新規ルールを残し、別課題でも使える部品かを確認します。ライブラリへ逃がした実装量・準備時間・tokensを開示します。

新しい入口だけに部品を与える比較では、「記法／意味展開」の効果と「解答部品の事前実装」の効果が混ざります。そのため、三つの入口へ同じ型付き部品を与える比較と、部品の有無を変える比較を分けます。

| 比較系 | 目的 |
| --- | --- |
| A：prompt→直接JSONC→既存Wasm | 現行生成との基準 |
| B：prompt→制限TS→同じprofile/checker/Wasm | 既存frontendだけで得られる節減を測る |
| C：prompt→短い仕様＋必要な残余TS→決定的展開→同じWasm | 意味展開をcompilerへ移した追加価値を測る |
| D：prompt→通常TS→JS | 利用者の機能完成・変更コストを測る現実的な基準 |

A/B/Cはbackendとruntimeを固定した比較にできます。DはWasm成果物を出さないため、ゲーム機能・表示の共通成功条件と、Wasm/権限/再現性を含む成果物条件を別に報告します。Wasmが必須ならDは成果物成功に数えませんが、同等機能のコスト比較として残します。通常TS＋固定部品＋型検査・独立テスト・権限制御・ログを備えた強い基準とも比較します。単に素のTSを弱い検証で通す基準にはしません。

### 条件と停止規則

モデルの実IDとreasoningを全経路で固定し、同じSDK/CLI、自然文要求、利用可能資料の予算、共通host/UI、テスト基盤、部品、環境をfreezeします。形式説明だけを経路別付録にし、その入力tokensも計測します。順番は交互または無作為にし、試行ごと新規thread、解答・修正履歴の流用なしとします。生成ソースではなく独立要求から36件等の受入を固定します。明示座標を使う既存テトリスを評価するなら標準形状へ黙って変更しません。

まず各経路5試行を予備比較し、傾向を見ます。これは精密な失敗率推定には足りません。継続判断後は必要な差と検出精度から試行数を定めます。今回、新しい試行は実施していません。

同じtoken・wall time・内部修正の予算を適用し、初回生成、最大1回の診断差分修正、レビュー1回、指摘修正最大1回、最終検証という上限を事前に決めます。モデル内の自発的な再修正も数えます。同一失敗・同一sourceでの検証3連続は進捗なしとして停止します。予算超過、骨組み、テストの偽合格、接続断、基盤不具合は失敗理由として残し、同じ試行を黙って延長・再開して成功へ置換しません。基盤変更後は別条件です。

### 記録する値

| 観点 | 計測 |
| --- | --- |
| 成功 | 固定受入、意味のあるテスト、意図的誤変更の検出、資源上限、runtime fault、review指摘未解消。成功・部分成功・失敗を分ける |
| token | requestごとのinput/cached/uncached/output/reasoning。累計の差分を取り二重加算しない。生成・修正・レビュー・親調整を含め、未取得はnull |
| 呼出し | 外側SDK run数、実モデルrequest数、質問数、診断修正、内部tool往復、source revision数。取得できない指標をSDK run数で代用しない |
| 生成量 | prompt/付録、解釈、短い仕様、残余コード、一時authoring code、IR、テスト、診断のbytesとtoken。固定部品は準備コストとして別記 |
| 時間 | 初回promptから受入までの全経過、SDK、tool検証、deterministic build、レビュー、準備、人の応答待ち。内訳の二重加算を避ける |
| 故障分類 | syntax、型・参照、構造上限、仕様解釈、ゲーム計算、テスト不備、runtime資源、基盤、無変更停止、接続。1事象に複数ラベル可 |
| 正本の保守 | 「受付停止中も取消」「得点ルール変更」等、自然文変更から再受入までのtoken、時間、質問、生成差分、手修正量 |
| 一般化 | 用意した部品の未見組合せ、部品未対応の課題、型境界、曖昧な要求。失敗を含め、適用範囲を明示 |

平均の成功試行コストだけでは失敗の多い方式が安く見えます。失敗試行の消費を含む「全試行のtoken合計÷成功数」、成功率、成功時の中央値・裾、予算打切り数を併記します。成功0なら成功当たりコストは算出不能です。人の確認待ちを隠してLLM時間だけ比較せず、全経過も見ます。部品の準備コストは実際に再利用された件数に対して償却し、件数が少ない場合の損益も残します。

探索実験では、成功率を落とさず、全試行token／成功数が直接JSONCより30%以上低下し、時間と修正回数も悪化しないことを暫定の継続基準として提案します。30%は実測効果や統計的境界ではなく、追加frontendの維持費に見合う改善を求める判断基準です。Bが同程度で安定するなら、まず制限TSを使い、Cの実装範囲を拡張しません。最終採用の成功率許容差や時間上限は予備測定後に明記します。

## 採用、保留、価値が残る条件

推奨は、最初に制限TSを同条件の対照に置き、短い解決仕様＋汎用部品＋必要な残余関数で、LLMが繰り返す仕事を減らす案です。差分生成と位置付き診断を組み合わせ、テストの期待値を固定したまま修正します。promptを正本とする運用は、内部出力がJSONCでもTSでも成立します。モデルの書きやすい形式を排除する理由はありません。

JSONの全面置換、一つの万能IRへの統合、無制限な自然文の決定的コンパイル、テトリス一式を隠したDSL、backend交換によるtoken問題の解決は初手から外します。直接binaryは将来の研究として保留し、構造検証・意味検証・修正・追跡に要る負担まで含めた証拠が揃った時点で扱います。

L-Langの価値が残るのは、同じ機能の生成だけでなく、Wasm実行が必要、許可された処理・資源の境界を機械検査したい、同じ正本から実行物と調査用TSを対応付けたい、共通部品を多数の課題で使い回せる、自然文変更からの再生成が安定する、といった条件です。ただしこれらの利点を通常TS＋適切なhost sandbox・型検査・独立テスト・ログでも実現できる範囲は比較します。Wasm validateやhash一致は自然文の意味一致を証明しません。

通常TSと同じ成功・保守・権限制御条件で、短い仕様が安くならず、部品準備と診断の負担だけが増えるなら、**その用途でL-Langを生成効率のために採用する価値はない**と判断すべきです。Bだけが勝つなら、Semantic Coreを実行・検証の基盤として残し、モデルの内部出力に制限TSを選べばよい。Cが勝つ用途が状態遷移や一覧処理に限られるなら、その範囲の支援機能として提供し、任意ゲーム・任意アルゴリズムへ一般化しません。

なお、[旧Prompt Source v2案](/Users/y.noguchi/Code/L-Lang/docs/PROMPT_SOURCE_V2_DESIGN.md)は「不採用・後継仕様へ置換」と明記されています。本提案は旧Markdown Source計画の復活や既定経路の置換ではありません。今回の目的に照らした新しい比較実験の提案であり、既存JSONC/TS経路と正本を維持したまま、採否を測定で判断します。

## 文書レビュー

自己レビューを1回行い、指摘を修正しました。小例の原文から決まる取消ルールを再質問しない形に直し、resolver呼出しと内部モデルrequestを区別しました。短い仕様でも展開後の上限問題は残ること、独立oracleを準備する費用を省略できないことを補いました。測定の内数・累計、世代差の因果解釈、旧計画の扱い、失敗コスト、同じ部品を使うTS対照、セッション所属・モデルの証拠範囲も確認しました。独立した別モデルのレビュー、修正後の再レビュー循環は行っていません。
