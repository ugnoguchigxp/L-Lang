# 文書メンテナンス記録・全Markdown台帳

> 本書は文書整備完了時点の記録。後続の実装修正・新examples・検証結果は[改善記録](./IMPROVEMENTS_RESULTS_20260917.md)を参照。以下の未実装事項は当時の状態を残している。

確認日：2026-09-17。**文書メンテナンスは完了。** TypeScriptとJSONCおよびTypeScript/JSONC/Wasm出力の併存を維持した。[文書一覧](./README.md)・[現在地](../PROJECT_STATUS_AND_ROADMAP.md)・[実装の残作業](./DOCUMENTATION_AND_IMPLEMENTATION_ALIGNMENT_PLAN.md)。

## 完了した範囲

- 日英README、経路ガイド、TypeScript利用ガイド、全実行例の案内・前提を照合。
- JSONC全10コマンドの引数・出力・終了値を実装と照合し、CLIリファレンスを作成。help未提供・testのhash不足・host v1/v2非互換を明示。
- JSONC仕様・実装記録の過大な完了表現、仮ファイル名、古いparser採用予定を訂正。
- Hybridの実装済み段階を未実装としていた状態表記、Capabilityの古い修正機能説明、現行Bun/CI記載を訂正。
- 構想・計画・外部依頼・過去結果の適用時点を分類し、過去ロードマップの詳細を`records/`へ分離。
- 固定要求・suiteを維持したJSONC生成・1回修正・replayの実行例とfixtureを追加。
- benchmark/Pilotの凍結済み証跡・要求仕様を保持。元の実測値・hash・採用しなかった提案を現在の結果へ書き換えていない。

## 確認方法と結果

文書だけの作業として、次を確認した。新しいfixtureはドキュメントの再実行用データであり、コンパイラ・CLIの挙動は変更していない。

| 確認 | 結果・範囲 |
| --- | --- |
| 全Markdownの分類 | 下記台帳で全ファイルを分類。現在の操作と過去の記録を区別 |
| ローカルリンク | `bun run ci:docs`で存在確認 |
| 見出しfragment | 全Markdownのローカルfragmentを走査。現時点の対象は0件 |
| 現行コマンドのscript名 | package.jsonのscripts・実在する実行ファイルと照合 |
| 現行ガイドのソースパス | 記載したsrc/examples/schemasの具体パスの存在を確認 |
| 実コマンド | 下記の31件が期待する終了値で完了 |
| 凍結入力 | `bun run ci:protected`成功。benchmark/Pilot等の15 Markdownを作業開始時hashと比較して不変 |
| 空白・差分 | `git diff --check`と新規文書の末尾空白検査 |

実行環境はmacOS・Bun 1.3.14。リポジトリ指定は1.4.2で、今回の操作例の結果を指定版での全品質Gate・coverage・remote CI成功とは扱わない。外部サービスのlive呼出し、外部URLの到達性確認、外部SAAAの状態確認は行っていない。過去結果文書の外部参照は引用元として保持した。

実コマンドのstdout/stderrと引数・終了値は次のローカルログに保存した。artifactsはGit管理外であり、他環境では操作例から再実行する。

`artifacts/documentation-maintenance-20260917-171925/summary.json`

| 実行対象 | 期待・実測終了値 |
| --- | --- |
| lint | 0 / 0 |
| format-check | 0 / 0 |
| format-write | 0 / 0 |
| build | 0 / 0 |
| test | 0 / 0 |
| package | 0 / 0 |
| verify | 0 / 0 |
| mutation | 0 / 0 |
| develop | 0 / 0 |
| replay | 0 / 0 |
| migrate | 0 / 0 |
| migrated-lint | 0 / 0 |
| help-current-error | 2 / 2 |
| lint-invalid | 1 / 1 |
| lint-missing | 2 / 2 |
| semantic-explain | 0 / 0 |
| semantic-verify | 0 / 0 |
| wasm-build | 0 / 0 |
| wasm-run | 0 / 0 |
| prompt-check | 0 / 0 |
| prompt-build | 0 / 0 |
| prompt-test | 0 / 0 |
| hybrid-inspect | 0 / 0 |
| hybrid-build | 0 / 0 |
| hybrid-verify | 0 / 0 |
| capability-package | 0 / 0 |
| capability-verify | 0 / 0 |
| host-kit | 0 / 0 |
| docs-links | 0 / 0 |
| protected | 0 / 0 |
| sort-example | 0 / 0 |

## 実装上の残項目

文書メンテナンスを完了しても、単体testの証跡、snapshot競合、help/例外出力、format排他、host v2対応、CI smoke拡充は未実装・未検証のまま。[整合計画](./DOCUMENTATION_AND_IMPLEMENTATION_ALIGNMENT_PLAN.md)のI/Q項目へ分離した。これらは仕様を弱めて解決済みとはしていない。

## 全Markdown台帳

「現行案内」は利用・仕様・保守手順、「計画・構想」は将来条件を含む文書、「時点記録」は記載revisionでの結果、「保存対象」は凍結データや評価プロトコルに関係し内容を保持する文書。全ファイルの分類・参照を確認し、修正不要な証跡はそのまま保存した。

| 文書 | 分類・扱い |
| --- | --- |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | 現行案内：操作・仕様・保守 |
| [POST_MVP_IMPLEMENTATION_PLAN.md](../POST_MVP_IMPLEMENTATION_PLAN.md) | 計画・構想：提供済み仕様と区別 |
| [PRIVATE_PILOT_IMPLEMENTATION_PLAN.md](../PRIVATE_PILOT_IMPLEMENTATION_PLAN.md) | 計画・構想：提供済み仕様と区別 |
| [PROJECT_STATUS_AND_ROADMAP.md](../PROJECT_STATUS_AND_ROADMAP.md) | 現行案内：操作・仕様・保守 |
| [PUBLIC_ALPHA_PRODUCTIZATION_PLAN.md](../PUBLIC_ALPHA_PRODUCTIZATION_PLAN.md) | 計画・構想：提供済み仕様と区別 |
| [QUALITY_GATES.md](../QUALITY_GATES.md) | 現行案内：操作・仕様・保守 |
| [README.en.md](../README.en.md) | 現行案内：操作・仕様・保守 |
| [README.md](../README.md) | 現行案内：操作・仕様・保守 |
| [RELEASE_0_1_ALPHA_IMPLEMENTATION_PLAN.md](../RELEASE_0_1_ALPHA_IMPLEMENTATION_PLAN.md) | 計画・構想：提供済み仕様と区別 |
| [RESEARCH_EVALUATION_PREREQUISITES.md](../RESEARCH_EVALUATION_PREREQUISITES.md) | 現行案内：操作・仕様・保守 |
| [SECURITY.md](../SECURITY.md) | 現行案内：操作・仕様・保守 |
| [SEMANTIC_TDD_IMPLEMENTATION_PLAN.md](../SEMANTIC_TDD_IMPLEMENTATION_PLAN.md) | 計画・構想：提供済み仕様と区別 |
| [STABLE_RELEASE_IMPLEMENTATION_PLAN.md](../STABLE_RELEASE_IMPLEMENTATION_PLAN.md) | 計画・構想：提供済み仕様と区別 |
| [benchmarks/project-fit-v2/README.md](../benchmarks/project-fit-v2/README.md) | 保存対象：内容・hash保持 |
| [benchmarks/project-fit-v2/evidence/2026-07-24-token-gated-baseline/report.md](../benchmarks/project-fit-v2/evidence/2026-07-24-token-gated-baseline/report.md) | 保存対象：内容・hash保持 |
| [benchmarks/project-fit-v2/evidence/2026-07-24-token-observation-only/report.md](../benchmarks/project-fit-v2/evidence/2026-07-24-token-observation-only/report.md) | 保存対象：内容・hash保持 |
| [benchmarks/project-fit-v2/evidence/README.md](../benchmarks/project-fit-v2/evidence/README.md) | 保存対象：内容・hash保持 |
| [benchmarks/prompt-source/BLOCKER.md](../benchmarks/prompt-source/BLOCKER.md) | 保存対象：内容・hash保持 |
| [benchmarks/prompt-source/README.md](../benchmarks/prompt-source/README.md) | 保存対象：内容・hash保持 |
| [benchmarks/schema-evolution/BLOCKER.md](../benchmarks/schema-evolution/BLOCKER.md) | 保存対象：内容・hash保持 |
| [benchmarks/schema-evolution/REVIEW.md](../benchmarks/schema-evolution/REVIEW.md) | 保存対象：内容・hash保持 |
| [concept.md](../concept.md) | 計画・構想：提供済み仕様と区別 |
| [docs/AGENT_CAPABILITY_IMPLEMENTATION_CONCEPT.md](AGENT_CAPABILITY_IMPLEMENTATION_CONCEPT.md) | 計画・構想：提供済み仕様と区別 |
| [docs/CAPABILITY_PACKAGE_IMPLEMENTATION_PLAN.md](CAPABILITY_PACKAGE_IMPLEMENTATION_PLAN.md) | 計画・構想：提供済み仕様と区別 |
| [docs/CAPABILITY_PACKAGE_RESULTS.md](CAPABILITY_PACKAGE_RESULTS.md) | 時点記録：対象revisionの結果 |
| [docs/CODEX_SDK_PI_EVALUATION.md](CODEX_SDK_PI_EVALUATION.md) | 時点記録：対象revisionの結果 |
| [docs/CODING_AGENT_VERIFICATION_IMPLEMENTATION_PLAN.md](CODING_AGENT_VERIFICATION_IMPLEMENTATION_PLAN.md) | 計画・構想：提供済み仕様と区別 |
| [docs/CODING_AGENT_VERIFICATION_RESULTS.md](CODING_AGENT_VERIFICATION_RESULTS.md) | 時点記録：対象revisionの結果 |
| [docs/DOCUMENTATION_AND_IMPLEMENTATION_ALIGNMENT_PLAN.md](DOCUMENTATION_AND_IMPLEMENTATION_ALIGNMENT_PLAN.md) | 現行計画：文書完了／実装残作業 |
| [docs/EFFECTS_WASM_MEMORY_SAFETY_HARDENING_IMPLEMENTATION_PLAN.md](EFFECTS_WASM_MEMORY_SAFETY_HARDENING_IMPLEMENTATION_PLAN.md) | 実装済み計画：Effects continuation Wasmのdirect ABI安全性強化 |
| [docs/EFFECTS_WASM_MEMORY_SAFETY_HARDENING_RESULTS.md](EFFECTS_WASM_MEMORY_SAFETY_HARDENING_RESULTS.md) | 時点記録：Effects continuation Wasmのdirect ABI安全性強化の結果 |
| [docs/EFFECTS_WASM_MEMORY_SAFETY_MATRIX.md](EFFECTS_WASM_MEMORY_SAFETY_MATRIX.md) | 現行案内：machine-readable matrixから生成したEffects保証境界 |
| [docs/LLVM_EXPERIMENTAL_BACKEND_IMPLEMENTATION_PLAN.md](LLVM_EXPERIMENTAL_BACKEND_IMPLEMENTATION_PLAN.md) | 実装済み計画：checked List sumによるLLVM Wasm／Native最小比較 |
| [docs/LLVM_EXPERIMENTAL_BACKEND_RESULTS.md](LLVM_EXPERIMENTAL_BACKEND_RESULTS.md) | 時点記録：LLVM実験backendの意味比較、再現build、性能と採否 |
| [docs/COLLECTION_BINARYEN_RECIPE_SELECTION_IMPLEMENTATION_PLAN.md](COLLECTION_BINARYEN_RECIPE_SELECTION_IMPLEMENTATION_PLAN.md) | 実装済み計画：Collection製品Wasmの固定Binaryenレシピ選定と条件付き採用 |
| [docs/COLLECTION_BINARYEN_RECIPE_SELECTION_RESULTS.md](COLLECTION_BINARYEN_RECIPE_SELECTION_RESULTS.md) | 時点記録：固定候補のcorrectness、再現性、holdout性能とbaseline維持判断 |
| [docs/COLLECTION_END_TO_END_BOTTLENECK_ATTRIBUTION_IMPLEMENTATION_PLAN.md](COLLECTION_END_TO_END_BOTTLENECK_ATTRIBUTION_IMPLEMENTATION_PLAN.md) | 実装済み計画：Collection製品baselineのphase、bytes、cost、IR形状から次の改善対象を選定 |
| [docs/COLLECTION_END_TO_END_BOTTLENECK_ATTRIBUTION_RESULTS.md](COLLECTION_END_TO_END_BOTTLENECK_ATTRIBUTION_RESULTS.md) | 時点記録：startup優位の記述統計と品質Gateによる`inconclusive`判断 |
| [docs/HYBRID_COMPILER_CONCEPT.md](HYBRID_COMPILER_CONCEPT.md) | 計画・構想：提供済み仕様と区別 |
| [docs/HYBRID_COMPILER_FIRST_IMPLEMENTATION_PLAN.md](HYBRID_COMPILER_FIRST_IMPLEMENTATION_PLAN.md) | 計画・構想：提供済み仕様と区別 |
| [docs/HYBRID_COMPILER_FIRST_IMPLEMENTATION_RESULTS.md](HYBRID_COMPILER_FIRST_IMPLEMENTATION_RESULTS.md) | 時点記録：対象revisionの結果 |
| [docs/HYBRID_COMPILER_SECOND_IMPLEMENTATION_PLAN.md](HYBRID_COMPILER_SECOND_IMPLEMENTATION_PLAN.md) | 計画・構想：提供済み仕様と区別 |
| [docs/HYBRID_COMPILER_SECOND_IMPLEMENTATION_RESULTS.md](HYBRID_COMPILER_SECOND_IMPLEMENTATION_RESULTS.md) | 時点記録：対象revisionの結果 |
| [docs/HYBRID_COMPILER_THIRD_IMPLEMENTATION_PLAN.md](HYBRID_COMPILER_THIRD_IMPLEMENTATION_PLAN.md) | 計画・構想：提供済み仕様と区別 |
| [docs/HYBRID_COMPILER_THIRD_IMPLEMENTATION_RESULTS.md](HYBRID_COMPILER_THIRD_IMPLEMENTATION_RESULTS.md) | 時点記録：対象revisionの結果 |
| [docs/LLANG_CLI_REFERENCE.md](LLANG_CLI_REFERENCE.md) | 現行案内：操作・仕様・保守 |
| [docs/LLANG_JSONC_IMPLEMENTATION_PLAN.md](LLANG_JSONC_IMPLEMENTATION_PLAN.md) | 現行実装記録：残差分を別管理 |
| [docs/LLANG_JSONC_SPEC.md](LLANG_JSONC_SPEC.md) | 現行案内：操作・仕様・保守 |
| [docs/MAINTENANCE_STATUS.md](MAINTENANCE_STATUS.md) | 現行案内：操作・仕様・保守 |
| [docs/PROMPT_SOURCE_EVALUATION_RESULTS.md](PROMPT_SOURCE_EVALUATION_RESULTS.md) | 時点記録：対象revisionの結果 |
| [docs/PROMPT_SOURCE_IMPLEMENTATION_PLAN.md](PROMPT_SOURCE_IMPLEMENTATION_PLAN.md) | 計画・構想：提供済み仕様と区別 |
| [docs/PROMPT_SOURCE_RESULTS.md](PROMPT_SOURCE_RESULTS.md) | 時点記録：対象revisionの結果 |
| [docs/PROMPT_SOURCE_V2_DESIGN.md](PROMPT_SOURCE_V2_DESIGN.md) | 計画・構想：提供済み仕様と区別 |
| [docs/README.md](README.md) | 現行案内：操作・仕様・保守 |
| [docs/SAAA_CONNECTION_POC_REQUEST.md](SAAA_CONNECTION_POC_REQUEST.md) | 計画・構想：提供済み仕様と区別 |
| [docs/SAAA_INTEGRATION_REQUEST.md](SAAA_INTEGRATION_REQUEST.md) | 計画・構想：提供済み仕様と区別 |
| [docs/SAAA_POC_PREPARATION_PLAN.md](SAAA_POC_PREPARATION_PLAN.md) | 計画・構想：提供済み仕様と区別 |
| [docs/VALUE_WASM_MEMORY_SAFETY_HARDENING_IMPLEMENTATION_PLAN.md](VALUE_WASM_MEMORY_SAFETY_HARDENING_IMPLEMENTATION_PLAN.md) | 実装済み計画：`module-value-v1`のdirect ABI安全性強化 |
| [docs/VALUE_WASM_MEMORY_SAFETY_HARDENING_RESULTS.md](VALUE_WASM_MEMORY_SAFETY_HARDENING_RESULTS.md) | 時点記録：Value Wasm direct ABI安全性強化の結果 |
| [docs/VALUE_WASM_MEMORY_SAFETY_MATRIX.md](VALUE_WASM_MEMORY_SAFETY_MATRIX.md) | 現行案内：machine-readable matrixから生成した保証境界 |
| [docs/WASM_COMPILER_CONCEPT.md](WASM_COMPILER_CONCEPT.md) | 計画・構想：提供済み仕様と区別 |
| [docs/WASM_POC_IMPLEMENTATION_PLAN.md](WASM_POC_IMPLEMENTATION_PLAN.md) | 計画・構想：提供済み仕様と区別 |
| [docs/WASM_POC_RESULTS.md](WASM_POC_RESULTS.md) | 時点記録：対象revisionの結果 |
| [docs/guides/language-routes.md](guides/language-routes.md) | 現行案内：操作・仕様・保守 |
| [docs/guides/semantic-typescript.en.md](guides/semantic-typescript.en.md) | 現行案内：操作・仕様・保守 |
| [docs/guides/semantic-typescript.md](guides/semantic-typescript.md) | 現行案内：操作・仕様・保守 |
| [docs/records/semantic-status-2026-08-08.md](records/semantic-status-2026-08-08.md) | 時点記録：対象revisionの結果 |
| [examples/README.md](../examples/README.md) | 現行案内：操作・仕様・保守 |
| [examples/active-customer/predicate.spec.md](../examples/active-customer/predicate.spec.md) | 保存対象：内容・hash保持 |
| [examples/capability-access/README.md](../examples/capability-access/README.md) | 現行案内：操作・仕様・保守 |
| [examples/capability-development/README.md](../examples/capability-development/README.md) | 現行案内：操作・仕様・保守 |
| [examples/hybrid-order/README.md](../examples/hybrid-order/README.md) | 現行案内：操作・仕様・保守 |
| [examples/hybrid-wasm-scenarios/README.md](../examples/hybrid-wasm-scenarios/README.md) | 現行案内：操作・仕様・保守 |
| [examples/jsonc-enabled-user/README.md](../examples/jsonc-enabled-user/README.md) | 現行案内：操作・仕様・保守 |
| [examples/order-fulfillment/README.md](../examples/order-fulfillment/README.md) | 現行案内：操作・仕様・保守 |
| [examples/prompt-active-customer/README.md](../examples/prompt-active-customer/README.md) | 現行案内：操作・仕様・保守 |
| [examples/saaa-host/README.md](../examples/saaa-host/README.md) | 現行案内：操作・仕様・保守 |
| [examples/saaa-world-clock/README.md](../examples/saaa-world-clock/README.md) | 現行案内：操作・仕様・保守 |
| [examples/wasm-active-customer/README.md](../examples/wasm-active-customer/README.md) | 現行案内：操作・仕様・保守 |
| [examples/wasm-json-sort/README.md](../examples/wasm-json-sort/README.md) | 現行案内：操作・仕様・保守 |
| [examples/wasm-json-sort/RESULTS.md](../examples/wasm-json-sort/RESULTS.md) | 時点記録：対象revisionの結果 |
| [pilots/README.md](../pilots/README.md) | 保存対象：内容・hash保持 |
| [pilots/erp-crud-v1/evidence/go-no-go.md](../pilots/erp-crud-v1/evidence/go-no-go.md) | 保存対象：内容・hash保持 |
| [pilots/erp-crud-v1/evidence/initial-live.md](../pilots/erp-crud-v1/evidence/initial-live.md) | 保存対象：内容・hash保持 |
| [pilots/erp-crud-v1/evidence/phase-0-2.md](../pilots/erp-crud-v1/evidence/phase-0-2.md) | 保存対象：内容・hash保持 |
| [pilots/erp-crud-v1/evidence/phase-3-4-readiness.md](../pilots/erp-crud-v1/evidence/phase-3-4-readiness.md) | 保存対象：内容・hash保持 |
| [pilots/erp-crud-v1/evidence/schema-evolution-live.md](../pilots/erp-crud-v1/evidence/schema-evolution-live.md) | 保存対象：内容・hash保持 |

新規文書を追加・移動した場合は、本台帳と文書一覧を同時に更新する。実行結果はこの日付の確認記録であり、将来のコード変更後も自動的に有効とはしない。
