# Trust／Data分離とadversarial評価基盤の実装結果

実施日: 2026-09-20。対象計画: [実装計画](./TRUST_DATA_SEPARATION_AND_EVALUATION_IMPLEMENTATION_PLAN.md)。

## 実装したもの

- requirements commitmentへ固定するstrictなtrust/data boundary contract。
- checked Effects IRの全operationをsource／sinkとして被覆する保守的provenance解析。
- data-derived authorityを持たない現行固定request IRの明示と、source-to-sink allowlist。
- requirement approval payload version 2、execution version 4、execution／audit attestation payload version 2。
- normal、failed、cancelled、crash recoveryに継承されるboundary／flow commitment。
- boundaryとstatic provenanceを含むportable packageとoffline verification。
- full-chain検証後だけ生成する決定的JSON／Markdown summary。
- 九attack category、共通host profile、共通input／grant／Oracleを固定するoffline protocolと集計器。
- 既存execution version 1〜3、ABI、Wasm経路の互換性。

## TDS条件との対応

| 条件 | 主な実装・検証 |
| --- | --- |
| TDS1〜TDS4 | strict parser、requirements binding、operation source／sink coverage |
| TDS5〜TDS9 | 現行IRのfixed request authority、record path、task／stream、保守的flow候補、未知operation／pathのfail-closed検査。現行IRに存在しないresponse由来request、branch、callback変換は未対応のまま許可せず、将来IR追加時に新しい解析規則を要求 |
| TDS10〜TDS13 | approval v2、execution v4、署名付きnormal／recovery、audit status分離 |
| TDS14〜TDS18 | package exact files、hash／signature、relocation、summary redaction、API呼出0 |
| TDS19〜TDS23 | 九category protocol、Oracle mismatch、normal case、両arm共通host、freeze hash、`evidenceEligible: false` |
| TDS24 | version 1〜3の回帰testとEffects smoke |

## 検証結果

同一revisionをBun 1.4.2、macOS arm64で検証しました。

- `bunx bun@1.4.2 run check`: 678 tests passed、0 failed。format、TypeScript型検査、全testを含む。
- `bunx bun@1.4.2 run ci:docs`: Markdown linkと24 CLI commandのdocumentation contractが成功。
- `bunx bun@1.4.2 run ci:protected`: protected benchmark input検証が成功。
- `bunx bun@1.4.2 run ci:smoke`: semantic、L-Lang、module、Effectsの全smokeが成功。API callは0。
- `git diff --check`: 成功。

局所testでは、boundary変更後の旧approval拒否、version 4 package全fileの改ざん拒否、source削除後の移設検証、policy rotation、normal／failed／cancelled／crash recovery、summaryのbyte決定性、入力とのpath重複拒否、九attack categoryすべてのOracle mutation検出を確認しました。

UbuntuとWindowsはこの作業環境では未実行です。成功とは記録しません。

## 評価上の制約

checked-in adversarial protocolはharnessを検証するfixtureです。実際のモデルが外部data中の命令へ従う確率、開発者が監査で問題を発見する正答率、TypeScript baselineとの優劣を測定した結果ではありません。

現行IRではoperation requestはcompile時固定であり、解析はその性質を利用します。record fieldのsource／sink解決とtask／streamのoperation被覆は検査しますが、現行IRにないbranch、callback、responseから次のrequestを組み立てる値依存を実装済みとは扱いません。将来の動的request構築を自動的に安全とみなさず、対応規則がないnodeはcore v1へ昇格させません。任意TypeScript／Wasmのinformation-flow解析やprogram内部の完全なdynamic taint trackingも提供しません。

## 次の段階

中核artifactとmetricの意味は[Effects assurance core v1](./EFFECTS_ASSURANCE_CORE_V1.md)で凍結します。次は独立datasetのreview、事前登録したL-Lang／TypeScript比較、人間参加監査、SAAA受け入れPoCの順に進めます。
