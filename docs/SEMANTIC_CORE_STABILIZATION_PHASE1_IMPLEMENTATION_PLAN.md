# Semantic Core安定化・第一段階 実装計画

作成日：2026-09-21。状態：完了。実施結果は[第一段階の結果](./SEMANTIC_CORE_STABILIZATION_PHASE1_RESULTS.md)を参照。対象：[安定化コンセプト](./SEMANTIC_CORE_STABILIZATION_CONCEPT.md)のP0（architecture、意味論、観測条件、version契約）。

## 1. 目的と完了状態

既存のprofileと検証処理を調査し、L-Langの意味論・変換経路・比較条件を、実装と試験へ追跡できる文書として整える。後続のgenerated differential testingが、比較対象や期待結果を推測せずに設計できる状態を第一段階の完了とする。

[MAIN_CONCEPT](../MAIN_CONCEPT.md)を上位の研究方針とし、Semantic Coreをprofile別の意味表現に共通する設計概念として説明する。今回の成果物は既存契約の整理であり、単一IRの導入や言語の1.0リリースを意味しない。

第一段階では、現行契約として記載できる事項を確定し、実装との不一致や未検証事項にはIDを付けて残す。確認できない事項を仕様へ昇格させない。中核的な契約が矛盾している場合、その対象の固定は未完了とし、文書作成の完了と区別する。

## 2. 対象と変更範囲

対象はPredicate、`module-bool-v1`、`module-value-v1`、`module-collection-v1`、`module-effects-v1`と、それらへ至るSemantic TypeScript、Prompt Source、Hybrid、JSONC、restricted TypeScriptの現行経路である。専用exampleやLLVM実験backendは、標準経路と混同しないために位置付けのみ記載する。

作成・変更するのは本節の文書と導線である。compiler、runtime、CLI、schema、artifact、lock、凍結済み証跡、依存関係の変更は含めない。不一致を発見した場合は再現条件と影響を記録し、修正を後続の独立した変更単位へ切り出す。新しい実験的な挙動をv1契約へ採用する判断も後続とする。

P1の生成テスト実装、共通比較runner、SECURITY全体の再構成、README冒頭の改稿、package metadata更新、P2の経路統合判断はこの段階の対象外とする。既存の信頼境界はarchitectureと観測条件の前提として参照する。

## 3. 成果物と正本の分担

以下のパスは新規作成予定であり、現時点の提供済み文書を表さない。

| 成果物 | 予定パス | 内容と正本の分担 |
| --- | --- | --- |
| Architecture | `docs/LLANG_ARCHITECTURE.md` | frontend、checked representation、検証、backend、runtimeの対応と責務。実装への索引 |
| Semantic Core v1契約 | `docs/LLANG_SEMANTIC_CORE_V1.md` | 共通原則とprofile別の提供範囲。個別の詳細規則は既存profile仕様を正本として参照 |
| 観測可能な意味と比較条件 | `docs/LLANG_OBSERVABLE_SEMANTICS.md` | 比較対象、正規化、環境条件、対象外、現在の証拠。未実装の比較は提案として区別 |
| Version対応表 | `docs/LLANG_VERSIONING.md` | source、profile、build、ABI、suite、capability、grant、evidenceの対応とreader互換性 |
| 実施結果・差分台帳 | `docs/SEMANTIC_CORE_STABILIZATION_PHASE1_RESULTS.md` | 対象snapshot、根拠、検証結果、不一致、未確定事項、後続作業 |
| 導線 | `docs/README.md`、コンセプト末尾 | 仕様・計画・結果の状態を明記してリンク |

既存profile仕様への変更は、新文書からの参照に必要な最小限の導線と、根拠が確認された説明上の訂正に限る。矛盾を削除して見かけ上の一致を作らない。MAIN_CONCEPTの研究上の主張や過去の実装結果を、この作業の結果として書き換えない。

## 4. 調査基点と根拠

着手時にcommit、未コミット差分、Bunと主要依存の版を記録する。本計画作成時にはコンセプト文書と文書一覧の変更が存在するため、実施時に改めて状態を確認する。結果には、調査に使ったsourceと実行した試験が同じsnapshotに対応するかを記録する。

| 領域 | 調査の入口 | 主な確認点 |
| --- | --- | --- |
| Predicate・各frontend | [JSONC仕様](./LLANG_JSONC_SPEC.md)、[semantic compiler](../src/semantic-compiler.ts)、[Prompt build](../src/prompt-wasm.ts)、[Hybrid builder](../src/hybrid-artifact-builder.ts)、[JSONC build](../src/llang-build.ts) | 受理範囲、LLM解決の位置、IRとlock、検証後の生成経路 |
| Bool | [仕様](./LLANG_MODULE_SPEC.md)、[loader](../src/llang-module-loader.ts)、[build](../src/llang-module-build.ts)、[suite](../src/llang-module-suite.ts) | TS／JSONCの合流点、関数とmodule、4経路の期待値検査 |
| Value | [仕様](./LLANG_MODULE_VALUE_SPEC.md)、[IR](../src/llang-module-value-ir.ts)、[loader](../src/llang-module-value-loader.ts)、[suite](../src/llang-module-value-suite.ts) | i32境界、Unicode、union、評価順、faultとfuel |
| Collection | [仕様](./LLANG_MODULE_COLLECTION_SPEC.md)、[IR](../src/llang-module-collection-ir.ts)、[suite](../src/llang-module-collection-suite.ts)、[build](../src/llang-module-collection-build.ts) | List、closure、反復、資源、native版と旧shell版の区別 |
| Effects | [仕様](./LLANG_MODULE_EFFECTS_SPEC.md)、[graph](../src/llang-module-effects-graph.ts)、[IR](../src/llang-effects-ir.ts)、[graph suite](../src/llang-module-effects-graph-suite.ts)、[build](../src/llang-module-effects-build.ts) | linear互換形式とtyped graph、TS実行、Wasm replay、task／streamの抽象化の違い |
| 権限・失敗・時間 | [operation契約](../src/llang-effects-contract.ts)、[session](../src/llang-effects-session.ts)、[concurrency](../src/llang-effects-concurrency.ts)、[SECURITY](../SECURITY.md) | effect要求とgrant、共有ledger、deadline、取消、cleanup |
| 版と互換性 | `schemas/`、profile別build／suite reader、[Capability契約](../src/llang-capability-contracts.ts)、[Effects仕様](./LLANG_MODULE_EFFECTS_SPEC.md) | writerの出力版、readerの受理版、未知版拒否、旧版の実行意味 |

根拠は「仕様」「実装のsymbol」「試験名またはcase」「今回の実行結果」に分ける。試験ファイルを見つけたことと、対象の条件で試験を実行して成功したことを別に記録する。リンク切れ検査は、この内容照合の代わりにはならない。

## 5. 作業単位と受け入れ条件

### SC1-01：基点と差分台帳

結果文書にsnapshotと環境、各成果物の状態、未確定事項の表を作る。差分IDは`SCG-001`から採番し、分類、根拠、影響profile、期待契約、現行挙動、再現方法、後続作業、第一段階の完了を妨げるかを記載する。

分類は「説明不足」「証拠不足」「仕様と実装の不一致」「契約の判断が必要」とする。単に資料が見つからない場合は未確認と記録し、未実装と断定しない。

受け入れ条件：後続の各主張と差分が同じ調査基点へ追跡できる。既存の未コミット変更を識別できる。

### SC1-02：Architectureと経路表

各経路について、入力形式、受理profile、parse／resolve、checked representationの型・生成symbol、静的検査、出力target、runtime、portable検証を一行で追える表を作る。frontend合流点と、合流しない経路の理由を記載する。

Verificationは生成前・生成後・実行中・実行後に分ける。source pathやhashの来歴情報と、実行意味へのsyntax依存を区別する。標準compilerとexample内専用compilerを同じ対応欄に載せない。

受け入れ条件：各表の経路から実装の入口へ到達できる。PromptやSemantic TypeScriptの意味解決がmodule全機能に対応するような表現がない。TypeScriptの実行成果物と検査用projectionの役割が経路ごとに明確である。

### SC1-03：Profile別意味論

共通原則に加え、型、値域、正規化、演算、評価順、分岐、module、反復・再帰、失敗、資源、外部操作の対応表を作る。各機能を「直接対応」「制限付き」「既存型による表現」「未対応」「未確認」で区別し、制限の説明を付ける。

特に、Predicateのnullishとmoduleのrequired field、Valueのtagged unionと業務上の失敗、Collectionの関数値と外部wire型の制限、Effectsの値型と計算ノードを区別する。numeric補助関数の存在からsource上の演算対応を推測しない。

受け入れ条件：主要機能に既存仕様と実装の根拠がある。現行契約と今後の比較方針が区別されている。競合する根拠にはSCGを付け、未確認機能をv1の保証として記載していない。

### SC1-04：Observable Semanticsと証拠の初期表

比較ケースを、profile、checked program、入力、grant、registry、fixture応答、予算、論理時計、schedule、取消点の組として定義する。pure profileで不要な項目は対象外とする。

正常値、入力拒否、fault、host失敗、取消、timeout、request、task結果、stream、cleanup、資源について、比較単位と正規化、比較対象外を記載する。型付き値を保持し、error messageやstackの完全一致を共通規則にしない。

以下は個別に判定する。

- fuel、arena等がbackend共通の論理量か、実装固有の量か。資源制限による成功／失敗の違いをどう検出するか。
- taskのspawn順、完了順、dispatch順のうち仕様で拘束されるもの。
- streamの値列、chunk境界、EOFと空chunk、取消後の観測。
- Effectsの`task.join`等の内部continuation eventと外部host operationの対応。内部eventをそのまま外部副作用列へ加えない。
- Wasmのraw ABI status、runtimeのfault、予期しないtrap、runner timeoutの区別。

既存試験について、profile・target・観測項目・case・実行条件を記した初期表を作る。状態は「確認済み」「部分確認」「未確認」「対象外」とし、実行結果の有無も併記する。全ケースを新しい形式へ移す作業は後続とする。

受け入れ条件：同じ入力だけでは比較できない条件が明示される。既存試験による確認と、将来実装する比較を区別できる。差を隠す正規化や、両backendが共通evaluatorを呼ぶだけの比較を同値性の独立証拠として扱っていない。

### SC1-05：Versionとhashの対応表

formatごとに、識別field、現在のwriter出力、reader受理範囲、ABI、suite、未知版の扱い、根拠symbolを整理する。JSONC source版をTypeScript sourceの版として扱わない。版の数値が同じでも互換性を推定しない。

Collectionのsource version 4、native build version 4、suite version 3のような非一致や、旧shell版の区別を具体例にする。Effectsのlinear／typed layoutと共通ABI名の関係も確認する。Capability、grant、実行証跡、署名形式はそれぞれ独立して記載する。

hashはsource bytes、source集合、program、interface、lowered representation、artifact、bundle identityの対象を分ける。flatten前後やfrontend間で、どのhashが一致すべきかをprofile別に確認し、すべての`programHash`を同じ意味とみなさない。

受け入れ条件：既存reader／writerと表が一致し、未知版や旧版の扱いを調べられる。新しいfieldの追加、版番号変更、hash再計算を必要としていない。

### SC1-06：整合確認と後続引継ぎ

文書間の用語、対応profile、保証範囲を照合し、文書一覧とコンセプトから導線を追加する。初期証拠表から、後続のテスト補強候補を観測項目単位で抽出する。

受け入れ条件：すべての作業IDに成果物と検証記録がある。次段階の候補には、対象subset、既存runner、足りない観測、独立oracle、環境固定条件、反例の再現条件がある。P1のすべてを着手条件なく一括実装する計画にしない。

## 6. 実施順序

1. SC1-01で調査基点と台帳を作る。
2. SC1-02とSC1-05で経路・版・hashの対応を確定する。
3. SC1-03でprofile別の意味論を整理する。
4. SC1-04で比較規則と現在の証拠を対応付ける。
5. SC1-06で相互レビュー、検証、後続候補の絞り込みを行う。

各単位は個別にレビューできる差分にする。各文書の記述を確定する前に、その主張を支える実装と試験を読む。不一致がある対象だけを未確定に保ち、依存しない調査と文書化は進める。

## 7. 検証計画

第一段階の実施時には、以下の既存試験を対象主張の確認に使う。ここにコマンドを掲載することは、今回の計画作成時に実行済みであることを意味しない。

```sh
bun test src/llang-module.test.ts src/llang-module-value.test.ts src/llang-module-collection.test.ts --timeout 30000
bun test src/llang-module-effects-loader.test.ts src/llang-module-effects-build.test.ts src/llang-module-effects-graph.test.ts --timeout 30000
bun test src/llang-effects-contract.test.ts src/llang-effects-session.test.ts src/llang-effects-concurrency.test.ts --timeout 30000
bun test src/prompt-source.test.ts src/hybrid-canonical.integration.test.ts src/llang-predicate-projection.test.ts --timeout 30000
```

期待結果は各試験の成功と、引用するcaseが記述対象の条件を実際に検査していることである。試験全体の成功を未検査の意味論へ一般化しない。上記で裏付けられない重要な主張は、該当する既存試験を追加選択するか、証拠不足として台帳へ残す。

失敗時は、環境・既存不具合・記述の誤認を切り分ける。期待値の変更、timeoutの無根拠な引き上げ、skipによって合格へ変えない。実行不能なら理由と影響範囲を記録し、確認済みと表示しない。

文書の最終確認は次を実行する。新規ファイルの末尾空白や参照先も確認する。

```sh
bun run ci:docs
git diff --check
```

文書中の新しい操作例を追加する場合は、認証情報なしで再実行し、期待する成果物・終了値を確認する。既存仕様への参照だけで足りる箇所にはコマンドを複製しない。

本段階は文書変更なので、全体coverageや性能計測を完了条件にはしない。後続でコード・テストを変更する場合は[品質Gate](../QUALITY_GATES.md)の全項目を適用する。現行の基本コマンドは以下であり、実施時には正本を再確認する。

```sh
bun install --frozen-lockfile
bun audit
bun run format:check
bun run lint
bun run ci:docs
bun run typecheck
bun run test
bun run coverage
bun run ci:smoke
bun run ci:protected
git diff --check
```

coverageの全体90%／transaction 95%を維持し、変更領域固有の追加Gateも適用する。依存監査のnetwork照会と、API不要のfixture試験は別に扱う。重い試験とcoverageの同時実行を避け、未実行OSやremote CIの結果を推定しない。

## 8. 完了判定と次段階

- [x] SC1-01〜SC1-06の成果物、根拠、結果が揃っている。
- [x] 各frontendから意味表現・target・runtimeまで実装へ追跡できる。
- [x] profile別の型・計算・失敗・資源契約が整理され、未対応と未確認が区別されている。
- [x] 観測値と実行条件、並行性、内部event、資源、trapの比較規則が明確である。
- [x] source／profile／artifact／ABI／suite等の版とhashの対象がreader／writerに対応する。
- [x] 重要な主張に試験または証拠不足の記録があり、実行結果と静的確認が区別されている。
- [x] 文書検査が成功し、既存コード・artifact・凍結証跡が変更されていない。
- [x] 残るSCGに優先度、影響、後続の検証方法がある。中核契約の未解決項目を残して「v1契約確定」と報告していない。

次段階では、この結果から一つの限定subsetを選び、generated differential testingの実装計画を作る。pure value expression／数値境界を最初の候補とし、共通の期待意味と独立した実行経路が確認できていることを着手条件にする。Effectsの並行・取消・資源比較は、環境モデルと観測規則が決まった項目から扱う。
