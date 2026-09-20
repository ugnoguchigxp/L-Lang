# Research evaluation prerequisites

最終更新: 2026-09-20

適用範囲：以下の研究評価と外部実行の準備条件。通常の文書修正、オフライン検証、機能実装の完了条件ではない。

この文書は、未実施のlive評価を「実装が終わったから」という理由だけで開始しないための事前条件を定める。API費用が発生する実行、人間参加者の調整、独立datasetの確定は、このリポジトリのコード変更とは別の明示的な承認を必要とする。

## Measured developer A/B

開始前に、参加者、domain owner、同意とデータ取扱い、手書きbaseline、同一8 task、時間計測方法、停止権限、API予算を固定する。主要Gateはfalse resolution 0を維持し、median total-task-timeが手書きより20%以上短いことである。詳細手順は[`PRIVATE_PILOT_IMPLEMENTATION_PLAN.md`](./PRIVATE_PILOT_IMPLEMENTATION_PLAN.md)を正とする。

## Static Judgment live benchmark

結果を観測する前に、独立した48 case、Oracle、3回反復、閾値、model/provider、token・費用・wall-clock上限をreviewしてfreezeする。fixture reportはharness検証専用であり、`evidenceEligible: false`のまま精度根拠には使わない。

## Schema Evolution held-out benchmark

[`benchmarks/schema-evolution/BLOCKER.md`](./benchmarks/schema-evolution/BLOCKER.md)の意味境界を解消し、旧評価入力から独立した新規入力を作成する。独立reviewとfreezeを完了するまでlive実行せず、既存のdraft入力を結果に合わせて変更して成功証拠へ転用しない。

## Effects adversarial offline benchmark

実装完了と論文用の証拠完成を分ける。fixture、candidate、pilotはすべて`evidenceEligible: false`とし、confirmatory結果へ転用しない。reviewed run前に、claim-to-evidence matrix、research question、confirmatory hypothesis、estimand、最小実用差、precision／power analysis、primary／secondary endpoint、欠測・除外・多重比較・sensitivity analysisを固定する。

実装担当から独立したdataset authorと、authorとは別のdomain reviewerを必要とする。datasetはsampling frame、inclusion／exclusion、source、license、task strata、重複・contamination検査を持つ。preregistration bundleへ外部のimmutable timestampを付与し、repository ownerがrunを明示承認するまでconfirmatory armを実行しない。

offline benchmarkが支持できるのは、固定datasetと共通hostにおけるmechanism efficacyである。live modelの生成品質、人間の監査性、TypeScript一般に対する優位性、実運用安全性には、それぞれ別の研究protocolと承認を要求する。詳細は[`docs/EFFECTS_ADVERSARIAL_BENCHMARK_IMPLEMENTATION_PLAN.md`](./docs/EFFECTS_ADVERSARIAL_BENCHMARK_IMPLEMENTATION_PLAN.md)を正とする。

## 実行記録

承認後のlive実行は、commit、入力hash、model/provider、全応答、失敗、`unresolved`、token、費用、latency、停止理由を保存する。Oracleとhidden caseをmodel入力やconsensus候補選択へ含めない。
