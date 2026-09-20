# ドキュメント一覧

[プロジェクト概要](../README.md) · [実行例の一覧](../examples/README.md)

TypeScriptとJSONC、各出力経路を目的から選べるように案内します。利用ガイドは`guides/`へまとめ、既存の仕様・設計・結果は参照パスを維持しています。

## 利用ガイド

- [JSONC CLIリファレンス](./LLANG_CLI_REFERENCE.md)
- [入力言語・変換処理・出力形式](./guides/language-routes.md)
- [Semantic TypeScript](./guides/semantic-typescript.md) / [English](./guides/semantic-typescript.en.md)
- [JSONCの最小例](../examples/jsonc-enabled-user/README.md)
- [貢献手順](../CONTRIBUTING.md)、[品質Gate](../QUALITY_GATES.md)、[セキュリティ](../SECURITY.md)

## 言語仕様・設計

プロジェクト全体の研究方針は[メインコンセプト](../MAIN_CONCEPT.md)を参照してください。要求と実行物の対応、TypeScriptによる事後検査、プロンプト保護と実行制限を中心に、今後検証する主張をまとめています。

| 領域 | 文書 |
| --- | --- |
| 汎用言語への拡張 | [拡張方針コンセプト](./GENERAL_PURPOSE_LANGUAGE_EXPANSION_CONCEPT.md)。関数・moduleから一般プログラムへ広げる提案 |
| JSONC | [Predicate v1仕様](./LLANG_JSONC_SPEC.md) |
| Typed modules | [Phase 1仕様](./LLANG_MODULE_SPEC.md)：boolean module、[Phase 2仕様](./LLANG_MODULE_VALUE_SPEC.md)：値・制御・型付き結果 |
| Wasm | [コンパイラ構想](./WASM_COMPILER_CONCEPT.md)、[Effects runtime仕様](./LLANG_MODULE_EFFECTS_SPEC.md) |
| メモリー安全性・最適化 | [段階的検証のコンセプト](./MEMORY_SAFETY_AND_SEMANTIC_OPTIMIZATION_CONCEPT.md)、[Collection実装計画](./COLLECTION_MEMORY_SAFETY_AND_OPTIMIZATION_IMPLEMENTATION_PLAN.md)、[実装結果](./COLLECTION_MEMORY_SAFETY_AND_OPTIMIZATION_RESULTS.md) |
| Hybrid | [コンパイラ構想](./HYBRID_COMPILER_CONCEPT.md) |
| Prompt Source | [v2設計提案](./PROMPT_SOURCE_V2_DESIGN.md)。採用状態はJSONC仕様を参照 |
| Capability | [エージェント能力構想](./AGENT_CAPABILITY_IMPLEMENTATION_CONCEPT.md) |

## 実装計画・進捗

- [要求付きWasmパッケージの事後検査](./CAPABILITY_INSPECTION_IMPLEMENTATION_PLAN.md)：既存Capability v2から要求・成果物の対応情報と検査用TypeScriptを出す機能（実装済み）
- [Effects Bundleの事後検査](./EFFECTS_BUNDLE_INSPECTION_IMPLEMENTATION_PLAN.md)：同梱JSONCからTypeScriptとWasmを再生成し、外部操作・effect・資源・成果物の対応を実行せずに確認する実装済みの検査機能
- [Effects実行証跡](./EFFECTS_EXECUTION_EVIDENCE_IMPLEMENTATION_PLAN.md)：検査済みbundle、実grant、redacted transcript、結果・失敗・取消・cleanupを結び付ける実装済み機能
- [Effects実行証跡の実装結果](./EFFECTS_EXECUTION_EVIDENCE_IMPLEMENTATION_RESULTS.md)：CLI、grant、journal、回収、受け入れ条件、保証境界
- [要求に結び付くEffects実行監査](./EFFECTS_REQUIREMENT_AUDIT_IMPLEMENTATION_PLAN.md)：要求契約、bundle identity、authority ceiling、実grant、実行証跡を一つのchainへ結ぶ実装済み機能
- [要求に結び付くEffects実行監査の結果](./EFFECTS_REQUIREMENT_AUDIT_IMPLEMENTATION_RESULTS.md)：CLI、v2証跡、回収、監査、受け入れ条件、保証境界
- [Effects署名付きattestationとtrust policy](./EFFECTS_SIGNED_ATTESTATION_IMPLEMENTATION_PLAN.md)：要求承認者、実行host、監査者のEd25519署名、role、rotation、revocation、offline verificationを扱う実装済み機能
- [Effects署名付きattestationの実装結果](./EFFECTS_SIGNED_ATTESTATION_IMPLEMENTATION_RESULTS.md)：CLI、version 3証跡、回収、portable package、受け入れ条件、保証境界
- [Effects attestation鍵運用runbook](./EFFECTS_ATTESTATION_KEY_RUNBOOK.md)：rotation、revocation、鍵紛失、backup、Windows ACL
- [Trust／Data分離とadversarial評価基盤](./TRUST_DATA_SEPARATION_AND_EVALUATION_IMPLEMENTATION_PLAN.md)：外部dataのprovenance、authority／data-flow制約、決定的監査summary、公平なTypeScript baselineを扱う実装済みの中核v1
- [Trust／Data分離の実装結果](./TRUST_DATA_SEPARATION_AND_EVALUATION_RESULTS.md)、[Effects assurance core v1](./EFFECTS_ASSURANCE_CORE_V1.md)
- [Effects adversarial比較benchmark](./EFFECTS_ADVERSARIAL_BENCHMARK_IMPLEMENTATION_PLAN.md)：独立dataset、共通host、runnable L-Lang／TypeScript arm、freeze、Oracle、checkpoint、portable resultを定義した実装済み計画
- [Effects adversarial benchmark実装引継ぎプロンプト](./EFFECTS_ADVERSARIAL_BENCHMARK_HANDOFF_PROMPT.md)：正本設計、論文証拠の境界、PR-0〜PR-9、EAB1〜EAB40、品質Gateを別sessionへ引き継ぐ
- [Effects adversarial benchmark実装結果](./EFFECTS_ADVERSARIAL_BENCHMARK_IMPLEMENTATION_RESULTS.md)：PR-0〜PR-9、EAB1〜EAB40のoffline fixture基盤と未実証範囲。
- [Collectionメモリー安全性と最適化基盤 実装計画](./COLLECTION_MEMORY_SAFETY_AND_OPTIMIZATION_IMPLEMENTATION_PLAN.md)：direct Wasm境界、safe allocator、RegionMemory metadata、cost計測、一候補だけの条件付き最適化を完了した計画
- [Collectionメモリー安全性Matrix](./COLLECTION_MEMORY_SAFETY_MATRIX.md)、[実装結果](./COLLECTION_MEMORY_SAFETY_AND_OPTIMIZATION_RESULTS.md)：Wasm自身の境界検査、allocator、RegionMemory有界化、決定的cost観測と最適化判断

- [第四弾の実装計画](./GENERAL_PURPOSE_LANGUAGE_PHASE4_IMPLEMENTATION_PLAN.md)：native Wasm補完、IO・非同期・権限・bytes・数値・並行処理・stream（実装完了）

- [汎用言語化・第三弾の実装計画](./GENERAL_PURPOSE_LANGUAGE_PHASE3_IMPLEMENTATION_PLAN.md)：List・反復・再帰・generics・closure・メモリ寿命（当時の直接Wasm未完了分は第四弾で補完）

- [全体の現在地とロードマップ](../PROJECT_STATUS_AND_ROADMAP.md)
- [汎用言語化・第一弾の実装計画](./GENERAL_PURPOSE_LANGUAGE_PHASE1_IMPLEMENTATION_PLAN.md)：型付き関数・複数module・TS/JSONC混在・3形式出力（実装済み）
- [汎用言語化・第二弾の実装計画](./GENERAL_PURPOSE_LANGUAGE_PHASE2_IMPLEMENTATION_PLAN.md)：整数・文字列・構造化戻り値・制御・型付き失敗・memory ABI（実装結果あり）
- [文書整理・仕様実装整合計画](./DOCUMENTATION_AND_IMPLEMENTATION_ALIGNMENT_PLAN.md)
- [JSONC実装計画・記録](./LLANG_JSONC_IMPLEMENTATION_PLAN.md)
- [Wasm PoC](./WASM_POC_IMPLEMENTATION_PLAN.md)
- Hybrid：[第1段階](./HYBRID_COMPILER_FIRST_IMPLEMENTATION_PLAN.md)、[第2段階](./HYBRID_COMPILER_SECOND_IMPLEMENTATION_PLAN.md)、[第3段階](./HYBRID_COMPILER_THIRD_IMPLEMENTATION_PLAN.md)
- [Prompt Source](./PROMPT_SOURCE_IMPLEMENTATION_PLAN.md)、[Capability Package](./CAPABILITY_PACKAGE_IMPLEMENTATION_PLAN.md)、[エージェント検証](./CODING_AGENT_VERIFICATION_IMPLEMENTATION_PLAN.md)
- TypeScript関連：[Semantic TDD](../SEMANTIC_TDD_IMPLEMENTATION_PLAN.md)、[Post-MVP](../POST_MVP_IMPLEMENTATION_PLAN.md)、[Private Pilot](../PRIVATE_PILOT_IMPLEMENTATION_PLAN.md)
- リリース関連：[Public Alpha](../PUBLIC_ALPHA_PRODUCTIZATION_PLAN.md)、[0.1 Alpha](../RELEASE_0_1_ALPHA_IMPLEMENTATION_PLAN.md)、[Stable](../STABLE_RELEASE_IMPLEMENTATION_PLAN.md)。各文書の作成時点・前提を確認する

## 結果・証跡

- [汎用言語化・第四弾の実装結果](./GENERAL_PURPOSE_LANGUAGE_PHASE4_IMPLEMENTATION_RESULTS.md)：Bun 1.4.2、Ubuntu／macOS／Windowsの同一revision証跡とE01〜E16対応表
- [6項目の改善とexamples拡充](./IMPROVEMENTS_RESULTS_20260917.md)

- [Wasm PoC結果](./WASM_POC_RESULTS.md)
- Hybrid：[第1段階](./HYBRID_COMPILER_FIRST_IMPLEMENTATION_RESULTS.md)、[第2段階](./HYBRID_COMPILER_SECOND_IMPLEMENTATION_RESULTS.md)、[第3段階](./HYBRID_COMPILER_THIRD_IMPLEMENTATION_RESULTS.md)
- Prompt Source：[実装結果](./PROMPT_SOURCE_RESULTS.md)、[評価基盤結果](./PROMPT_SOURCE_EVALUATION_RESULTS.md)
- [Capability Package結果](./CAPABILITY_PACKAGE_RESULTS.md)、[エージェント検証結果](./CODING_AGENT_VERIFICATION_RESULTS.md)、[SDK・pi比較](./CODEX_SDK_PI_EVALUATION.md)
- [Project Fit live証跡](../benchmarks/project-fit-v2/evidence/README.md)、[Pilot](../pilots/README.md)

結果文書は過去の対象revision・実行条件の記録です。現在の実装状況はロードマップと各仕様を参照してください。

## SAAA接続

- [接続PoC依頼](./SAAA_CONNECTION_POC_REQUEST.md)
- [統合依頼](./SAAA_INTEGRATION_REQUEST.md)
- [PoC準備計画](./SAAA_POC_PREPARATION_PLAN.md)


## 記録・保守の入口

- [文書メンテナンス記録・全Markdown台帳](./MAINTENANCE_STATUS.md)：すべての文書の分類と今回の確認範囲。
- [Semantic TypeScriptの2026-08-08状態記録](./records/semantic-status-2026-08-08.md)：以前のロードマップの詳細。
- [Semantic TypeScript構想](../concept.md)：設計・将来案。提供済み機能とは区別する。
- [研究評価の実行条件](../RESEARCH_EVALUATION_PREREQUISITES.md)：live評価の前提。

`guides/`は現行の操作、`records/`は過去の状態記録。既存の設計・計画・結果のパスは参照を保ち、この一覧と台帳で分類する。凍結済みbenchmark・Pilot証跡の内容は文書整理でも変更しない。
