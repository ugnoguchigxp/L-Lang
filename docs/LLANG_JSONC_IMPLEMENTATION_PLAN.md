# JSONC言語・linterの実装記録

更新：2026-09-17。[JSONC仕様](./LLANG_JSONC_SPEC.md)を規範、[CLIリファレンス](./LLANG_CLI_REFERENCE.md)を現在の操作契約とする。TypeScript経路も併存する。

本書は最初のP0〜P6で実装した機能の記録。追加の仕様適合作業は[整合計画](./DOCUMENTATION_AND_IMPLEMENTATION_ALIGNMENT_PLAN.md)で管理する。P0〜P6の機能実装を、全仕様への適合、全OS検証、実モデル精度の証明とは扱わない。

## 実装した流れ

固定要求と独立suite → JSONC実装 → lint → Wasm build/test → Capability v2 package/verify。`develop`は既存suiteを固定して初回実装と最大1回修正を行う。テスト生成やSAAAへの配備は含まない。

操作は[最小例](../examples/jsonc-enabled-user/README.md)で再実行できる。単体lint/buildにSAAAやAPI認証は不要。

## 実装構成

| ファイル | 責務 |
| --- | --- |
| `src/llang-jsonc.ts` | JSONC・strict JSON parser、Unicode/深さ/byte上限、コメント保持format |
| `src/llang-program.ts` | Program/schema・型・profile検査、programHash |
| `src/llang-diagnostics.ts` | code、range、JSON Pointer、診断の上限 |
| `src/llang-build.ts` | 検証済みProgramからWasm・Build Manifest v2を生成、成果物読込 |
| `src/llang-cli.ts` | 全10コマンドの引数・入出力・終了値 |
| `src/llang-capability.ts` | Capability v2の公開export |
| `src/llang-capability-contracts.ts` | request/suite/manifestの検証とパッケージ読込 |
| `src/llang-capability-runtime.ts` | suite実行、package/verify、mutation check |
| `src/llang-capability-worker.ts` | パッケージ検証のWorker |
| `src/llang-development.ts` | 固定入力、実装・修正、checkpoint、replay |
| `src/llang-development-protocol.ts` | 設定・agent応答・fixture契約 |
| `src/llang-migrate.ts` | Prompt Sourceと有効LockからJSONCへの非破壊変換 |
| `schemas/llang-program-v1.schema.json` | 公開Program schema |

以前の計画で候補名だった`llang-check.ts`・`llang-format.ts`は独立ファイルとしては作成していない。対応責務は上表のProgram/JSONC/CLIに実装した。

## 段階別の結果

| 段階 | 実装済みの範囲 | 留保 |
| --- | --- | --- |
| P0 | jsonc-parser 3.3.1の採用、既存経路の基準確認 | 実行環境は[品質Gate](../QUALITY_GATES.md)を参照 |
| P1 | parser、Program、公開schema、位置付き診断 | schemaだけでは意味検証を完了しない |
| P2 | lint、format、CLI | 汎用help、エラー出力契約、format排他の差分が残る |
| P3 | 直接Wasm build、manifest v2、決定的生成と改変拒否 | 任意の外部writerを含む完全排他は保証しない |
| P4 | suite、package、verify、専用Worker、移動後検証 | 追加改善でtestのhashとhost v2対応を実装。詳細は改善記録を参照 |
| P5 | 実装・最大1回修正・replay、予算と失敗記録、SDK接続 | 既存suiteを入力にする。v2での独立テスト生成・実モデル品質評価は別項目 |
| P6 | 有効なPrompt Source/Lockの非破壊変換 | 旧例のrequirementIds不足は利用者が確認する。旧期待値を自動改変しない |

## 安全境界と再現性

Programのcontractを固定requestと照合し、契約を狭めてsuiteを回避する候補を拒否する。JSONC原文とprogramHashを分けて保持し、パッケージ読込時に各ファイルのhash・契約・Wasmの対応を照合する。package作成だけでは検証済みと表示しない。

formatは構文不正や重複キーを推測で修復しない。追加改善ではSource単位の協調ロックと書込前の再読込、atomic renameを使う。外部writerまで完全排他する保証ではない。単体testは取り込んだsnapshotをbuildする。

## 現在の検証と残作業

[整合計画](./DOCUMENTATION_AND_IMPLEMENTATION_ALIGNMENT_PLAN.md)に報告hash・CLI・競合・host互換性・品質Gateの残作業を集約する。過去のcoverageやテスト件数を現在値として複製しない。

数値演算、module、effect、memory、新しいWasm ABI、全入出力間の汎用変換、SAAAへの実配備はこの実装の対象外。live評価は実装完了から分離し、同一モデル・予算・要求で生成成功率、修正、総token/timeを測る。
