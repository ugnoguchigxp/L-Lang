# L-Lang Semantic Core・検証境界の安定化コンセプト

作成日：2026-09-21。状態：修正方針。個々の意味論の確定、実装計画、検証完了の宣言は後続で行う。

## 目的と位置付け

[メインコンセプト](../MAIN_CONCEPT.md)が掲げる、要求と実行物の対応、TypeScriptによる事後検査、権限と資源の制限を、現在の実装に沿った契約として整理する。L-Lang v1に向けて、何を処理の意味として保持し、何を検証し、どこから先を実行環境に委ねるかを明確にする。

本書はそのための安定化方針である。研究の目的はMAIN_CONCEPT、提供済みの挙動は各profileの仕様、信頼境界は[SECURITY](../SECURITY.md)、品質基準は[QUALITY_GATES](../QUALITY_GATES.md)を参照する。仕様と実装に差があれば、差の原因と互換性への影響を調べて解決し、現行挙動を無条件に正しい仕様として追認しない。

ここでいうv1は、固定する意味論と検証契約の対象を定めるための呼称である。npmの1.0公開、製品成熟度、研究仮説の実証を意味しない。

## 現在の基盤と課題

Semantic Coreは、処理の意味を検査可能な形で保持する設計上の共通基盤とする。実装では用途別のIRとprofileがこの役割を担っている。既存のprofileを基礎に、共通原則と固有の契約を記述する。

| 対象 | 現在の基盤・根拠 | 整理する点 |
| --- | --- | --- |
| Predicateと各入力経路 | [JSONC仕様](./LLANG_JSONC_SPEC.md)、[経路ガイド](./guides/language-routes.md)、[PromptからのWasm生成](../src/prompt-wasm.ts) | Semantic TypeScript、Prompt Source、Hybrid、JSONCの解決・検証・生成経路と対応範囲 |
| Boolean module | [Module仕様](./LLANG_MODULE_SPEC.md)、[suite実装](../src/llang-module-suite.ts) | module境界、checked program、各出力の対応 |
| Value | [Value仕様](./LLANG_MODULE_VALUE_SPEC.md)、[IR](../src/llang-module-value-ir.ts)、[suite実装](../src/llang-module-value-suite.ts) | boolean、i32、string、record、tagged union、評価順、失敗 |
| Collection | [Collection仕様](./LLANG_MODULE_COLLECTION_SPEC.md)、[IR](../src/llang-module-collection-ir.ts)、[suite実装](../src/llang-module-collection-suite.ts) | List、反復、再帰、generics、closure、資源制限 |
| Effects | [Effects仕様](./LLANG_MODULE_EFFECTS_SPEC.md)、[IR](../src/llang-effects-ir.ts)、[graph suite](../src/llang-module-effects-graph-suite.ts) | 型付き操作、await、task、stream、host権限、取消、実行証跡 |

bool／value／collectionには、reference evaluator、生成TypeScript、JSONCの再読込、Wasmを同じsuiteの期待結果へ照合する処理がある。Effectsにはrequest列と結果のfixture検証、portable Wasm replay、生成TypeScriptの実行テストがある。ただし、この存在だけでは全機能・全失敗条件のcross-target一致を確認したことにならない。

主な不足は、全体の責務を示すarchitecture文書、profileごとの観測対象の対応表、既存検証の網羅範囲、生成programを使う比較方針である。実装計画では、この不足を具体的な根拠と検査条件へ分解する。

## Semantic Coreとして固定する契約

外部向けには、L-Langを「LLMによる生成を想定し、制限された意味表現を検証して、対応する実行成果物と検査用表現を生成する言語・コンパイラ・実行系」と説明する。入力syntax、意味論、artifact、実行権限を別の責務として記述する。

| 層 | 責務 |
| --- | --- |
| Frontends | Promptの意味解決、restricted TypeScript／JSONCのparse・正規化。受理する範囲をprofileごとに定める |
| Semantic Core | profile別の型、計算、評価順、失敗、外部操作の要求を保持する |
| Compiler／Backends | checked representationから対応するTypeScript／JSONC／Wasmを決定的に生成する |
| Runtime／Host | 入出力の検査、operationの実行、grant、資源計上、取消とcleanupを適用する |
| Verification | 型・契約検査、suite、cross-target比較、再生成照合、replay、証跡・署名の検査を各段階で行う |

Verificationは生成前の一工程だけに限定しない。生成artifactの検査、実行時検査、実行後の監査についても、対象と前提を記載する。すべてのfrontendがすべてのprofileや出力に対応するとは扱わない。

意味論の記述には、値の範囲、表現の正規化、式と分岐の評価順、module／関数境界、入力拒否、faultの優先順、資源超過時の動作を含める。EffectsではoperationのID・version、request／response／error型、resource kind、cancellation、idempotency、必要権限を含める。

型と演算の提供範囲はprofile別に示す。Effectsのi64、有限f64、bytes、decimal等を、ValueやCollectionでも利用可能な型として掲載しない。task／streamは計算ノードとruntime機能、result／optional／nullableは専用型・unionによる表現・未対応を区別する。runtime補助関数の存在だけでsource言語から利用可能と判定しない。

同じprofileのTS／JSONC入力が共有するchecked representationを確認し、backendが元syntaxに依存する箇所があれば理由と影響を調べる。source pathやhashを由来の記録として保持することと、frontendによって実行意味が変わることは区別する。Prompt Sourceの意味解決も、生成提案を検証済みの表現へ移す境界として説明する。

Predicate等の独立経路は、現役の用途、互換性、実験の位置付けを確認して記載する。別経路であることだけを廃止・統合の理由にしない。

## TS／Wasmの観測可能な意味

cross-target比較では、同じchecked programと入力に加え、実行条件を揃える。Effectsではgrant、operation registry、host応答、資源予算、論理時計、取消の発生点、スケジュール条件を比較ケースに含める。

| 観測対象 | 比較方針 |
| --- | --- |
| 正常結果 | 型に基づいて正規化し比較する。bytes、i64、decimalをJavaScript numberや曖昧な文字列表現へ変換しない |
| 入力拒否・失敗 | invalid input、言語上のfault、host失敗、取消、timeout、実行基盤の障害を分け、安定したcodeと到達状態を比較する |
| 外部操作 | operation ID／version、型付きrequest、許可された対象、dispatchの有無を比較する |
| 操作順序 | 逐次処理では順序を比較する。並行処理では仕様が要求する先行関係と、固定schedule下の順序を区別する |
| Task | 結果の対応と返却順、失敗伝播、取消、終了状態を比較する。完了時刻の偶然の一致は要求しない |
| Stream | 出力列、契約上観測できるchunk境界、空chunkとEOF、早期取消、終了・cleanupを比較する |
| 資源 | 契約に含まれる論理counter、上限判定、超過時の副作用とterminal outcomeを比較する |
| Cleanup | 仕様で要求される解放順、二重closeの扱い、主失敗とcleanup失敗の区別を比較する |

CPU命令数、実時間、GC、物理memory使用量、内部layout、一時変数は共通の同値条件から除外する。ただしABIの公開契約は別の適合試験で検査する。fuelやmemory budgetについては、backend共通の論理量か実装固有の計測値かを先に定義する。資源制限で成功・失敗が変わる場合は、その差を比較対象から黙って捨てない。

タイミングや並行順序に複数の合法な挙動がある場合、固定scheduleでの一致と、許されるtraceの条件を分ける。正規化規則は比較前に定め、見つかった差を消すために後から緩めない。予期しないtrapやrunner timeoutは比較成功へ丸めず、独立した失敗として記録する。

この比較が示すのは、対象program・入力・環境条件で観測した一致である。一般的な意味的同値性、自然言語要求の正しさ、外部serviceの正しさの証明とは区別する。

## 既存検証を拡張する方針

まずprofile、frontend、target、観測項目、正常／失敗条件を軸に検証表を作る。各セルには試験ファイルと対象ケースを対応付け、「確認済み」「部分確認」「未確認」「対象外」を区別する。確認済みでも有限の試験範囲を明記する。

次に、その表の不足を埋める制約付きprogram／input generatorを追加する。pure expressionと数値境界から始め、collection、Effects、task、streamへ広げる。profileで受理する型・構造・深さ・資源制約を生成条件にする。NaN／Infinity等は正常入力のgeneratorから除外し、拒否動作を調べるnegative caseとして別に保持する。

CIではseed、generator版、件数と実行予算を固定する。失敗時にはprogram、入力、実行条件、各targetの観測結果を保存し、生成処理なしで再現できるようにする。可能な範囲で反例を小さくし、原因が分かったケースを固定回帰試験へ追加する。保存先や再現コマンドは実装計画で定める。

比較には実際に生成されたTypeScriptとWasmを使用する。両方が同じreference evaluatorを呼ぶ構造なら独立したbackend比較として数えない。reference evaluatorも誤り得るため、独立した期待値、境界fixture、意図的な誤りを検出するmutationを併用する。

Effectsのfixtureは同じhost応答と論理時計で各targetを実行し、resultだけでなくrequestとterminal outcomeを収集する。取消、timeout、grant拒否、budget超過、cleanup失敗も比較ケースに含める。通常CIは認証情報や実networkを要求せず、外部serviceを用いる運用評価は別条件の証拠として扱う。

生成テストの成功、artifactの再生成一致、portable replayをそれぞれ区別して報告する。これらを組み合わせた実用的な変換検証を強化するが、同じcompilerによるbytes一致だけを独立した意味保存の証明と呼ばない。

## 信頼境界・権限・version

信頼境界はSECURITYの既存保証を基に、次の対象と前提を一つの表へ整理する。

| 対象 | 明示する前提・境界 |
| --- | --- |
| Compiler、verifier、依存toolchain | 検査と生成を正しく実施する信頼対象。再生成検査も同じ実装の不具合を共有し得る |
| Runtime、Wasm engine、host adapter、registry | 型・権限・資源・operation実装の責任分担。adapterと登録情報の整合性を前提にする範囲 |
| 要求、trust policy、grant | 独立した主体が選ぶ制御入力。生成物が自分の権限を拡張できない境界 |
| Prompt、生成提案、外部入力・応答 | 由来と用途に応じた検査対象。Promptという形式だけでtrusted／untrustedを決めない |
| Wasm artifactとmemory | 検証済みIRから生成したartifactの保証範囲。exported memoryとhostによる直接変更の制限 |
| OS、credential、remote service | 実行基盤と外部運用に依存する前提。署名やWasmからは保証できない事項 |

Capabilityは、プログラムが宣言する操作要求、独立した方針が認める権限、実行時grantと資源予算の関係として説明する。effect宣言自体は権限を与えない。Capability v1／v2というpackage形式と、Effectsのgrant・registry・ledgerを同じversion系列として扱わない。

hashは照合、suiteは有限の期待動作検査、replayは記録条件での再現、署名は鍵とcommitされたbytesの対応を扱う。これらの保証範囲をREADME・CLI・ガイドで一貫させる。既存の[Effects assurance core v1](./EFFECTS_ASSURANCE_CORE_V1.md)と本書のSemantic Coreは目的が異なるため、名称と適用範囲を説明する。

versionはsource format、semantic profile、build／artifact、ABI、suite、capability／grant schema、attestation／evidenceに分けて対応表を作る。たとえばEffectsのbuild version 5、profile `module-effects-v1`、ABI `llang-effects-session-v1`は別の契約を指す。まず既存fieldの意味と互換性を整理し、新しい`semanticCore` fieldの追加や既存formatの変更は本方針の必須条件にしない。

## 外部向け説明と変更範囲

READMEは、目的、profile別の意味表現、対応する入出力、capability-controlled execution、研究段階であることを冒頭から理解できる構成にする。各機能の詳細と制約はarchitecture／profile表へ誘導し、すべての入力と出力の組合せが使えるような表現を避ける。

package metadataは現在の実態に合わせてdescriptionを見直す。nameは内部参照・lockfile等への影響を確認して判断する。公開、package identityの破壊的変更、version 1.0への更新は別の判断とする。

今回の安定化では新しい単一IRの導入、全frontendの統合、既存経路の削除、backendの置換、全面的なディレクトリ再編成を目的にしない。コード変更は、契約の不一致または検証の空白を解消するものへ限定する。形式証明、任意Wasmの安全な受け入れ、実serviceやhost OSまで含む同値性は対象外とする。

## 実装計画へ進む条件

次の順で、独立してレビューできる変更単位へ分ける。優先度はこの安定化作業内の順序を表し、障害の深刻度を表さない。

| 優先度・作業 | 現状の根拠 | 補う不足 | 確認方法・出口 |
| --- | --- | --- | --- |
| P0：architectureと意味論 | MAIN_CONCEPT、profile仕様、loader／IR／emitter | 全体の責務、型と計算の対応範囲 | 各経路を実装へ対応付け、共通原則とprofile固有契約をレビューできる |
| P0：観測とversionの契約 | 既存suite、manifest、ABI | 比較条件、資源と並行性の扱い、版の関係 | 観測項目の比較規則と既存version表が揃い、未決事項が特定される |
| P1：検証表と生成テスト | profile別suite、固定fixture、memory境界試験 | 未確認条件とprogram生成による比較 | 既存試験を再利用し、再現可能な反例と追加試験で不足を埋める |
| P1：信頼境界と説明 | SECURITY、Effects仕様、README、package metadata | 横断的な境界表と入口の整合 | 根拠へ到達でき、保証の過大表現と対応経路の誤認が解消される |
| P2：独立経路の位置付け | Prompt／Hybrid／Predicate等の実装と利用例 | 継続理由と互換性の説明 | 各経路の用途と維持理由が明確になる。統合候補は別途根拠を示す |

各項目について「現状の根拠・解消する不足・確認方法」が揃った時点で、対象ファイル、受け入れ条件、互換性、試験コマンドを実装計画へ落とし込む。文書とテストで差が見つかった場合は、再現例、期待契約、影響する既存artifactを記録してから修正範囲を決める。

文書だけの変更は`bun run ci:docs`と`git diff --check`で確認する。コード・テストの変更は関連するprofile試験に加え、QUALITY_GATESの必須検査を実行する。coverage閾値、既存fixture、portable verification、replay、mutationの基準を維持する。結果には対象revisionと条件、成功・失敗・未実行を記録する。

安定化の完了は、仕様・実装・試験の対応と、保証できる範囲・残る空白を説明できる状態とする。自然言語要求との一般的な一致、人間による理解の改善、運用環境での効果は、MAIN_CONCEPTに基づく後続の研究評価で確かめる。

P0の具体的な成果物、受け入れ条件、検証手順は[第一段階の実装計画](./SEMANTIC_CORE_STABILIZATION_PHASE1_IMPLEMENTATION_PLAN.md)、確認した範囲と残る空白は[実施結果](./SEMANTIC_CORE_STABILIZATION_PHASE1_RESULTS.md)に記録する。
