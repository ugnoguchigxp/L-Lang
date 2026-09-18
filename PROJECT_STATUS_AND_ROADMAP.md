# 現在の実装状況とロードマップ

更新：2026-09-18。[入出力の対応](./docs/guides/language-routes.md) · [文書一覧](./docs/README.md)

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

[第一弾の実装計画](./docs/GENERAL_PURPOSE_LANGUAGE_PHASE1_IMPLEMENTATION_PLAN.md)の型付き関数・複数module、TS／JSONC混在入力と3形式出力は実装済み。利用仕様は[Phase 1仕様](./docs/LLANG_MODULE_SPEC.md)を参照する。最終品質Gate・対象CIの証跡は第一弾計画の未チェック欄を開始時に照合する。

[第二弾の実装計画](./docs/GENERAL_PURPOSE_LANGUAGE_PHASE2_IMPLEMENTATION_PLAN.md)では、整数・文字列・record／union戻り値・局所束縛・分岐・型付き失敗と最小memory ABIを、10の変更単位に分けた。単一注文明細の計算は[第二弾の実装結果](./docs/GENERAL_PURPOSE_LANGUAGE_PHASE2_IMPLEMENTATION_RESULTS.md)を参照する。指定Bunとの差と対象OSの未確認事項は同記録に残っている。

[第三弾の実装計画](./docs/GENERAL_PURPOSE_LANGUAGE_PHASE3_IMPLEMENTATION_PLAN.md)では、可変長List、反復・再帰、generics、closure、局所更新と呼出し内のメモリ寿命を11の実装単位に分けた。注文一覧の変換・集計・安定ソートの[実装結果](./docs/GENERAL_PURPOSE_LANGUAGE_PHASE3_IMPLEMENTATION_RESULTS.md)がある。当時残っていたcollection本体の直接Wasm生成は第四弾で補完した。

[汎用言語化コンセプト](./docs/GENERAL_PURPOSE_LANGUAGE_EXPANSION_CONCEPT.md)に、関数・module、型とデータ構造、状態、入出力、非同期・並行処理、標準libraryの拡張方針をまとめた。TypeScript／JSONCの両入力・両出力とWasmを目標とする設計提案であり、全範囲が提供済みという意味ではない。現行Predicate v1と実装済みのboolean moduleを維持し、第二弾以降で値・制御・実行環境を段階的に広げる。

## 計画の適用範囲

現行の差分解消は整合計画、SAAA接続は[接続依頼](./docs/SAAA_CONNECTION_POC_REQUEST.md)を参照する。外部SAAAのコードは本リポジトリの文書だけで実装済みと判定しない。

[Post-MVP](./POST_MVP_IMPLEMENTATION_PLAN.md)、[Private Pilot](./PRIVATE_PILOT_IMPLEMENTATION_PLAN.md)、[Public Alpha](./PUBLIC_ALPHA_PRODUCTIZATION_PLAN.md)、[Stable](./STABLE_RELEASE_IMPLEMENTATION_PLAN.md)はSemantic TypeScriptの研究・製品化Gateを定めた計画。そこで提案されたpackage、LSP、設定、CI matrixは提供済み機能ではない。

実利用価値の測定は[研究評価の条件](./RESEARCH_EVALUATION_PREREQUISITES.md)に従い、対象・予算・期待値を結果観測前に固定する。fixture成功を理由にlive評価や公開を実施済みとはしない。現在は研究段階で、npm公開やSAAAの本配備を完了した状態ではない。
