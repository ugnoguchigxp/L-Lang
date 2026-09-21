# 現在の実装状況とロードマップ

更新：2026-09-20。[入出力の対応](./docs/guides/language-routes.md) · [文書一覧](./docs/README.md)

## 実装されている経路

TypeScriptとJSONCは併存する入力・実装形式で、通常のTypeScript、JSONC、Wasmの出力経路がある。全組合せを共通CLIで選べるという意味ではない。

| 経路 | 現在の範囲 | 操作・仕様 |
| --- | --- | --- |
| Semantic TypeScript → TypeScript | Concept、Predicate、Static Judgment、Semantic Test/TDD、lock、replay、Closure/Verify | [TypeScriptガイド](./docs/guides/semantic-typescript.md) |
| JSONC → Wasm | parser、lint、format、直接build、固定request/suite、Capability v2 package/verify | [JSONC仕様](./docs/LLANG_JSONC_SPEC.md)、[CLI](./docs/LLANG_CLI_REFERENCE.md) |
| 固定要求・suite → JSONC候補 | fixtureまたはSDKによる実装と最大1回修正、checkpoint、replay。suiteは既存入力 | [JSONC生成例](./examples/jsonc-enabled-user/README.md) |
| Prompt Source＋Lock → JSONC | 有効Lockの決定的な変換。要求・suiteも出力 | [CLI](./docs/LLANG_CLI_REFERENCE.md) |
| 既存TypeScript → Wasm | 限定Predicateの静的import、Canonical Type IR、schema・仕様投影、artifactとrebuild検証 | [Hybrid例](./examples/hybrid-order/README.md) |
| Prompt Source → Lock → Wasm | 構造化要求の作成・更新・解決、Wasm、Capability v1、独立テスト製造・修正 | [Prompt Source](./examples/prompt-active-customer/README.md)、[製造例](./examples/capability-development/README.md) |
| Wasm host | v1/v2のinspect/verify/invoke、移動可能な単発キット | [host例](./examples/saaa-host/README.md) |
| Effects module | bytes／i64／f64／decimal、型付きfile・HTTP、await、task、streamをTS／JSONCから3targetへbuild | [Effects仕様](./docs/LLANG_MODULE_EFFECTS_SPEC.md)、[IO例](./examples/module-io-pipeline/README.md) |
| 用途別ソート実験 | examples内の専用JSONC profileからTypeScript/Wasmを生成・比較。標準CLIとは別 | [ソート実験](./examples/wasm-json-sort/README.md) |
| 用途別UI | 固定構造化要求から世界時計用WasmとUIを実行 | [世界時計](./examples/saaa-world-clock/README.md) |

通常のPredicateはboolean、closed enum、nullish状態などの限定範囲。TypeScript DSLと各Wasm profileの受理範囲は同一ではない。世界時計の専用ABIを汎用Predicate言語の機能とはしない。

## 残っている実装・検証

[仕様実装整合計画](./docs/DOCUMENTATION_AND_IMPLEMENTATION_ALIGNMENT_PLAN.md)に優先順位と完了条件を集約している。

[Collectionメモリー安全性と最適化基盤 実装計画](./docs/COLLECTION_MEMORY_SAFETY_AND_OPTIMIZATION_IMPLEMENTATION_PLAN.md)を完了した。`module-collection-v1`のdirect Wasm境界検査、safe allocator、RegionMemory管理情報の有界化、製品artifactと分離したallocation／copy計測を実装した。baselineではoutput promotionがcopy量の35.29%を占めたが、ABI v1のoutput所有権を壊さず削除できないため候補を却下した。[実装結果](./docs/COLLECTION_MEMORY_SAFETY_AND_OPTIMIZATION_RESULTS.md)に保証境界と未実証範囲を記録する。

[Value Wasmメモリー安全性強化](./docs/VALUE_WASM_MEMORY_SAFETY_HARDENING_IMPLEMENTATION_PLAN.md)を実装した。`module-value-v1`のdirect callで、string payloadの包含確認より前にUTF-8 validatorが評価されてWasm trapになる問題を、型別staged validatorへ置き換えた。safe allocator／copy、raw ABI differential、七種類のmutation試験を追加し、ABI v1、export、status、resource limitを維持した。[実装結果](./docs/VALUE_WASM_MEMORY_SAFETY_HARDENING_RESULTS.md)に保証境界と内部arenaの所有範囲を記録する。

[Effects Wasmメモリー安全性強化](./docs/EFFECTS_WASM_MEMORY_SAFETY_HARDENING_IMPLEMENTATION_PLAN.md)を実装した。linear／typed continuation ABIのraw `start`／`resume`で、descriptor baseを包含確認前にload／storeしてtrapする境界を閉じ、失敗時にcontinuation stateを消費しないtransaction、typed payloadとmodule-private領域、whole-range copyを検証する。[Memory Safety Matrix](./docs/EFFECTS_WASM_MEMORY_SAFETY_MATRIX.md)と[実装結果](./docs/EFFECTS_WASM_MEMORY_SAFETY_HARDENING_RESULTS.md)に保証境界を記録する。

[LLVM実験backend 最小比較](./docs/LLVM_EXPERIMENTAL_BACKEND_IMPLEMENTATION_PLAN.md)を実装した。`module-collection-v1`のchecked `sum(List<i32>)`をreference、製品Wasm、実験用直接Wasm、LLVM Wasm O0/O2/O3、LLVM Native O0/O2/O3で比較し、165件のdifferential比較と再現buildを通した。[実装結果](./docs/LLVM_EXPERIMENTAL_BACKEND_RESULTS.md)の事前規則ではLLVM Wasmが性能Gateを満たさなかったため、現行backendを維持し、LLVM経路は製品ABIやmanifestへ統合しない。

追跡hashとsnapshot、CLIヘルプ・JSONエラー、format協調ロック、host v2、JSONC smoke、coverage逐次出力を実装した。[改善記録](./docs/IMPROVEMENTS_RESULTS_20260917.md)に検証結果と限界を集約する。

[4通りの入出力例](./examples/source-output-matrix/README.md)と[修正・配備・切戻し例](./examples/capability-lifecycle/README.md)を追加。人の開発時間・実モデルの成功率・本番配備はこのオフライン例では測定しない。Phase 4の機能実装と同一revisionのUbuntu／macOS／Windows CIは完了した。残る評価は、SAAAでの利用に合わせて行うsoak／capability確認、実運用TLS、長期性能・memory観測であり、現時点のcorrectness Gateには含めない。

## 評価済みの範囲と未実証事項

| 評価 | 証拠の範囲 | 未実証 |
| --- | --- | --- |
| Project Fit live A/B | 限定されたSemantic TypeScriptの6 case | JSONCの実モデル精度、未知の実プロジェクトへの一般化 |
| ERP CRUD Pilot | 合成shadow protocolの初回生成・schema変更 | 実開発者の作業時間改善と外部domain妥当性 |
| Wasm性能探索 | 当時の環境と入力でTSと比較 | 一般的な高速化・省メモリ優位 |
| CapabilityとJSONC fixture | 部品検証、故障検出、修正、replay | 自然言語の正しさ、実モデルの成功率 |
| SDK接続 | 記録された1課題の実生成 | provider間の品質優劣、JSONC v2の一般的品質 |

証跡：[Project Fit](./benchmarks/project-fit-v2/evidence/README.md)、[Pilot](./pilots/erp-crud-v1/evidence/go-no-go.md)、[Wasm](./docs/WASM_POC_RESULTS.md)、[SDK](./docs/CODEX_SDK_PI_EVALUATION.md)。Semantic TypeScriptの詳細な過去状況は[2026-08-08記録](./docs/records/semantic-status-2026-08-08.md)へ整理した。

## 言語としての拡張方針

[第四弾の実装計画](./docs/GENERAL_PURPOSE_LANGUAGE_PHASE4_IMPLEMENTATION_PLAN.md)は完了した。第三弾のnative Wasm補完、IO、非同期、取消・timeout、失敗/cleanup、権限/予算、bytes、追加数値、制限付き並行、streamを`module-effects-v1`として実装した。完了範囲と証跡は[第四弾の実装結果](./docs/GENERAL_PURPOSE_LANGUAGE_PHASE4_IMPLEMENTATION_RESULTS.md)を参照する。人間向け抽象化の追加や旧G5全体は今回の完了範囲ではない。

`module-effects-v1`のall-target bundleを実行せずに再構築・検査する[Effects Bundle事後検査](./docs/EFFECTS_BUNDLE_INSPECTION_IMPLEMENTATION_PLAN.md)を実装した。静的なbundle整合を対象とし、実行時grantやtranscriptの証跡化は後続へ分離している。

検査済みbundleの実Wasm、hostが与えたgrant、redacted transcript、結果・失敗・取消・cleanupを結び付ける[Effects実行証跡](./docs/EFFECTS_EXECUTION_EVIDENCE_IMPLEMENTATION_PLAN.md)を実装した。CLIは実行前intent、hash chain journal、最終report、再実行しないcrash回収を提供する。unsigned version 1/2は互換のまま維持する。

[要求に結び付くEffects実行監査](./docs/EFFECTS_REQUIREMENT_AUDIT_IMPLEMENTATION_PLAN.md)を実装した。利用者または上位hostが実行前に固定した要求契約、authority ceiling、bundle identity、実grant、version 2実行証跡を一つのchainへ結び、非実行の事後監査で機械検査できる対応と人間判断が残る対応を分離する。要求なしversion 1実行と非replay回収は互換を維持する。結果と保証境界は[実装結果](./docs/EFFECTS_REQUIREMENT_AUDIT_IMPLEMENTATION_RESULTS.md)に記録する。

[Effects署名付きattestationとtrust policy](./docs/EFFECTS_SIGNED_ATTESTATION_IMPLEMENTATION_PLAN.md)を実装した。要求承認者、実行host、監査者を別roleとしてEd25519署名へ結び、独立して渡す現行trust policyでrotation、revocation、role分離を検査する。version 3実行証跡、二種類の署名付きcrash回収、trust-aware audit、監査者署名付きportable package、offline verifierを提供する。[実装結果](./docs/EFFECTS_SIGNED_ATTESTATION_IMPLEMENTATION_RESULTS.md)に受け入れ条件と保証境界を記録する。timestamp authority、anti-replay ledger、remote attestation、鍵の現実世界identity証明は未実装である。

[Trust／Data分離とadversarial評価基盤](./docs/TRUST_DATA_SEPARATION_AND_EVALUATION_IMPLEMENTATION_PLAN.md)を実装し、[Effects assurance core v1](./docs/EFFECTS_ASSURANCE_CORE_V1.md)として中核artifactとmetricの意味を固定した。外部dataからauthority-bearing valueを導出しない静的provenance、明示的なsource-to-sink flow、署名証跡へ結び付く決定的監査summary、公平なTypeScript baseline protocolを提供する。fixtureはharness回帰専用であり、外部data命令への一般的耐性、人間の監査改善、通常TypeScriptに対する優位性を実証済みとはしない。[実装結果](./docs/TRUST_DATA_SEPARATION_AND_EVALUATION_RESULTS.md)に保証境界を記録する。

[Effects adversarial比較benchmark](./docs/EFFECTS_ADVERSARIAL_BENCHMARK_IMPLEMENTATION_PLAN.md)のPR-0〜PR-9を実装した。runnableなL-Lang／TypeScript armを同じhost、grant、budgetへ接続し、全arm終了後にhidden Oracleで採点する。freeze、checkpoint／resume、統計解析、portable result、raw-to-paper再生成をoffline fixtureで検証できる。[実装結果](./docs/EFFECTS_ADVERSARIAL_BENCHMARK_IMPLEMENTATION_RESULTS.md)にEAB1〜EAB40との対応を記録する。checked-in fixtureは研究証拠へ昇格させず、独立dataset author、domain reviewer、外部timestamp、owner実行承認が揃うまで比較結果を`not-run`とする。live model生成品質、人間の監査性、TypeScript一般への優位、実運用安全性は別研究が必要である。

[第一弾の実装計画](./docs/GENERAL_PURPOSE_LANGUAGE_PHASE1_IMPLEMENTATION_PLAN.md)の型付き関数・複数module、TS／JSONC混在入力と3形式出力は実装済み。利用仕様は[Phase 1仕様](./docs/LLANG_MODULE_SPEC.md)を参照する。最終品質Gate・対象CIの証跡は第一弾計画の未チェック欄を開始時に照合する。

[第二弾の実装計画](./docs/GENERAL_PURPOSE_LANGUAGE_PHASE2_IMPLEMENTATION_PLAN.md)では、整数・文字列・record／union戻り値・局所束縛・分岐・型付き失敗と最小memory ABIを、10の変更単位に分けた。単一注文明細の計算は[第二弾の実装結果](./docs/GENERAL_PURPOSE_LANGUAGE_PHASE2_IMPLEMENTATION_RESULTS.md)を参照する。指定Bunとの差と対象OSの未確認事項は同記録に残っている。

[第三弾の実装計画](./docs/GENERAL_PURPOSE_LANGUAGE_PHASE3_IMPLEMENTATION_PLAN.md)では、可変長List、反復・再帰、generics、closure、局所更新と呼出し内のメモリ寿命を11の実装単位に分けた。注文一覧の変換・集計・安定ソートの[実装結果](./docs/GENERAL_PURPOSE_LANGUAGE_PHASE3_IMPLEMENTATION_RESULTS.md)がある。当時残っていたcollection本体の直接Wasm生成は第四弾で補完した。

[汎用言語化コンセプト](./docs/GENERAL_PURPOSE_LANGUAGE_EXPANSION_CONCEPT.md)に、関数・module、型とデータ構造、状態、入出力、非同期・並行処理、標準libraryの拡張方針をまとめた。TypeScript／JSONCの両入力・両出力とWasmを目標とする設計提案であり、全範囲が提供済みという意味ではない。現行Predicate v1と実装済みのboolean moduleを維持し、第二弾以降で値・制御・実行環境を段階的に広げる。

## 計画の適用範囲

現行の差分解消は整合計画、SAAA接続は[接続依頼](./docs/SAAA_CONNECTION_POC_REQUEST.md)を参照する。外部SAAAのコードは本リポジトリの文書だけで実装済みと判定しない。

[Post-MVP](./POST_MVP_IMPLEMENTATION_PLAN.md)、[Private Pilot](./PRIVATE_PILOT_IMPLEMENTATION_PLAN.md)、[Public Alpha](./PUBLIC_ALPHA_PRODUCTIZATION_PLAN.md)、[Stable](./STABLE_RELEASE_IMPLEMENTATION_PLAN.md)はSemantic TypeScriptの研究・製品化Gateを定めた計画。そこで提案されたpackage、LSP、設定、CI matrixは提供済み機能ではない。

実利用価値の測定は[研究評価の条件](./RESEARCH_EVALUATION_PREREQUISITES.md)に従い、対象・予算・期待値を結果観測前に固定する。fixture成功を理由にlive評価や公開を実施済みとはしない。現在は研究段階で、npm公開やSAAAの本配備を完了した状態ではない。
