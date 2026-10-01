# Paper v1の範囲と文書案内

確認日：2026-10-01。実装照合の対象HEAD：`e0cadbb62627106acee7754bbc00d55a7b769126`。拡張の限定初版はこのHEADからの作業ツリーに追加した。これは実装と文書の境界を整理した記録であり、最新CIの合格や論文完成を宣言するものではない。

| 区分 | 参照先 | 読み方 |
| --- | --- | --- |
| Historical plans / records | [2026-08-08のSemantic TypeScript記録](./records/semantic-status-2026-08-08.md)、各計画の作成時点の背景・完了済み部分 | 当時の対象と結果。現在の機能一覧や論文の完了条件には使用しない |
| Current implementation | [ロードマップ](../PROJECT_STATUS_AND_ROADMAP.md)、[TypeScript利用ガイド](./guides/semantic-typescript.md)、各仕様・コード・テスト | 提供機能と受理範囲。実装済みでも論文の実測証拠があるとは限らない |
| Paper-v1 scope | [草稿](./PAPER_DRAFT.md)、[方式と実装対応](./PAPER_METHOD.md)、[根拠充足計画](./PAPER_EVIDENCE_PLAN.md)、[結果記録](./PAPER_EVIDENCE_RESULTS.md)、[再現手順](../research/paper-v1/README.md) | 本文の主張、証拠、限界、残る投稿準備を確認する。計画の初期状態と最新の結果を分ける |
| Future work | [Semantic TDD残作業計画](../SEMANTIC_TDD_IMPLEMENTATION_PLAN.md)のPhase 6〜7 | 限定初版後の拡張・独立評価・既定採用の条件。Paper v1の完了条件には含めない |

`SEMANTIC_TDD_IMPLEMENTATION_PLAN.md`は全体を歴史文書に分類しない。未実装作業を管理する計画として保持し、過去の背景・数値と将来の機能条件を区別する。また、Semantic TDDのPhase 6 / 7と、論文証跡整備の「第六弾／第七弾」は別の計画系列である。

## 実装照合

| 機能 | 現在の状態 | 根拠・境界 |
| --- | --- | --- |
| Contract trace、Test Plan、Red／Mutation、freeze、promotion前検査 | Predicate用のSemantic TDD経路に実装済み | [compiler](../src/semantic-tdd-compiler.ts)、[integration test](../src/semantic-tdd-compiler.integration.test.ts)、[held-out fixture test](../src/semantic-tdd-held-out.test.ts)。このfixtureを新規live評価とは扱わない |
| Selection Reportの保存・再検証 | 単一候補v1とBest-of-N v2を実装 | [report生成・parser](../src/semantic-tdd-selection-report.ts)、[test](../src/semantic-tdd-selection-report.test.ts)、[verifier](../src/semantic-tdd-verify.ts)。[Best-of-N評価](../src/semantic-tdd-best-of-n.ts)で全候補と選択規則を再評価する |
| Best-of-N（Phase 6） | 明示指定の限定初版実装済み・独立評価未了 | [評価と選択](../src/semantic-tdd-best-of-n.ts)、[test](../src/semantic-tdd-best-of-n.test.ts)。最大5候補、逐次生成、予算検査、全候補保存とreplay。品質改善と既定採用は未実証 |
| boundary / counterfactual / invariance | Semantic Test IRに実装済み | [Test IR](../src/semantic-test-ir.ts)、[test](../src/semantic-test-ir.test.ts)。明示例と変換による検査であり、seed付きproperty生成・縮小とは区別する |
| Bounded Property Test（Phase 7） | 明示指定の限定初版実装済み・独立評価未了 | [engine](../src/semantic-property-test.ts)、[test](../src/semantic-property-test.test.ts)、[CLI](../src/semantic-property-cli.ts)。明示期待式・有限domain・seed付き生成・局所的縮小・反例replay。config v2でbounded array・時間上限・verify照合に対応。自動Hard Gateは未導入 |
| コンパイラの生成差分試験 | 別用途で実装済み | [Valueの結果](./SEMANTIC_CORE_STABILIZATION_PHASE2_RESULTS.md)など。loweringの差分検証であり、要求から作るSemantic TDDのPhase 7完了を意味しない |

## Paper v1の主張と完了条件

対象は、固定された自然言語要求と入力契約から限定Predicate IRを生成・検査・保存し、Wasmへ接続する方式の実現可能性、および採用済みIR・契約・ビルド条件からの再構築である。現在の草稿の中心証拠は保存済みliveの1課題とオフライン再検証であり、追加fixtureの成功率を実モデルの成功率として使わない。

投稿準備の判定は[根拠充足計画の本文への反映条件](./PAPER_EVIDENCE_PLAN.md)を用い、進捗は[結果記録](./PAPER_EVIDENCE_RESULTS.md)と照合する。主要主張と証跡の対応、要求・Oracle・介入の由来、再構築条件、表の再生成、利用可能な再現資料、関連研究と限界の記載を整える。Oracleのレビューや証拠の配布条件など、既存の未完了事項をこの整理だけで完了にしない。

Best-of-NとBounded Property Testの限定初版は[拡張例](../examples/semantic-tdd-extensions/README.md)として提供するが、草稿の実測証拠には追加しない。これらの実装・独立評価はPaper v1の完了条件に追加しない。生成品質の優位性、propertyによる網羅性、Semantic TDD全計画の完成もv1の主張に含めない。将来これらを主張する場合は、対応する実装と独立評価を追加し、論文範囲を改訂する。
