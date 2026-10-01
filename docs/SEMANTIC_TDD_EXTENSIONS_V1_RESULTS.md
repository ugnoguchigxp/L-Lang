# Semantic TDD拡張・限定初版の実装結果

確認日：2026-10-01。対象はHEAD `e0cadbb62627106acee7754bbc00d55a7b769126`からのローカル作業ツリー。コミット・公開・新規live評価は行っていない。

[実装計画](./SEMANTIC_TDD_EXTENSIONS_V1_IMPLEMENTATION_PLAN.md) · [実行例と保証境界](../examples/semantic-tdd-extensions/README.md) · [Paper v1の範囲](./PAPER_V1_SCOPE.md)

## 実装した範囲

- 明示指定の`semantic tdd-build --best-of-n <config.json>`。最大5候補を逐次生成し、同一の要求・型・Project Context・凍結Test Planで検査する。
- Hard／Mutationを通過した候補を事前定義した順序で選ぶ。選択後の生成コード・source例・型検査・Project回帰が失敗しても自動fallbackしない。
- Selection Report v2に全候補、入力snapshot、設定、応答・usage、失敗段階、hash、資源集計を保存する。旧v1記録は引き続き読める。
- `tdd-test`、対応するv2記録を持つnodeの`semantic verify`で保存候補と選択をread-only再検証する。`tdd-replay`はAPIなしにtransactionを再実行するが、audit等の書込みは行う。
- `semantic:property check/replay`。明示した期待式、有限domain、seed付き入力、型を維持した局所的縮小、反例とreportの再生を提供する。property検査は既存buildのHard Gateへ自動追加しない。

## 検証

限定初版のunit／integration／CLIテストで、候補順変更と同一IRの同点、型不正・全候補不適格、個別fixture失敗、timeout、usage不明、token／費用超過、IR・入力・順位・hashの改変拒否を確認した。全候補不適格では既存artifactとimplementation lockを保持した。旧単一候補のbuild・verify・replayも確認した。

Property Testでは同一seed、optional／nullish入力、既知欠陥の検出と局所的縮小、縮小未完了の表示、予算超過、期待式の矛盾、未対応型、保存反例の改変拒否を確認した。CLIはsource例と凍結Test Planの両方へ期待式を照合する。

ローカルの保存例は`artifacts/semantic-tdd-extensions/20261001-limited-v1/`に置く。fixtureの選択・正常IRのproperty pass・欠陥IRのproperty fail・それぞれのreplayをAPI keyなしで確認する例であり、実モデルの品質測定ではない。検査ログは検証完了後に同じ領域へ保存する。

| 検査 | 結果 |
| --- | --- |
| `bun run check` | format・lint・typecheck・13分割の全体testが成功。追加修正後の個別testと最終coverageで再確認 |
| 最終`bun run coverage` | 952 pass / 0 fail、171 test files。全体functions 92.99%、lines 91.94%。transaction functions 98.36%、lines 96.88%。既定閾値をすべて通過 |
| 最終format・lint・typecheck | 成功。lintの既存warningは残す |
| `bun run ci:docs` | ローカルリンクと文書契約に成功 |
| `bun run ci:protected` | 保護されたbenchmark入力の照合に成功 |
| `git diff --check` | 成功 |

最終coverage中に対象18ファイルのhashが変わっていないことを確認した。ログ、source hash一覧、集計を`artifacts/semantic-tdd-extensions/20261001-limited-v1/validation/`へ保存した。初回coverageは実行開始後のコード変更で旧コードと新テストが混在したため、一件の失敗を確認して中止した。そのログも保持し、コードを固定した最終runを別ログとして保存した。remote CIや独立した第三者による実行は今回の結果に含めない。

## 残る事項

本書は限定初版時点の記録。[追加実装と合成制御実験](./SEMANTIC_TDD_EXTENSIONS_COMPLETION_RESULTS.md)でbounded array・単一containerのnullable union・時間上限・verify照合を追加した。独立live評価による品質改善・費用比較、既定機能への採用、一般object union、build gateへの導入は未実施。反例の大域的最小性、secretの自動検出・除去、provider請求の絶対上限は保証しない。価格は設定の申告値を用い、合計usage・費用超過は応答後に検出する。

旧compilerはv2 reportを読むことができない。旧版へ戻す場合は対応する旧lockとartifactの組を用いる。機能実装とfixture検証を、元計画全体の独立評価完了やPaper v1の新しい実測証拠へ昇格させない。
