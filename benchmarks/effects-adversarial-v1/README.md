# Effects adversarial benchmark implementation

PR-0〜PR-9のoffline benchmark基盤を実装済みです。このdirectoryはsynthetic harness fixtureであり、実行済み研究比較として扱わないでください。

`research/`にはfixture用のanalysis plan、sample-size plan、claim-to-evidence matrix、未登録のpreregistration bundleがあります。人物、review、外部timestamp、第三者再現recordは生成していません。`evidenceEligible: false`、研究比較は`not-run`です。

テンプレートの最小実用差、precision、解析法は研究用に承認された値ではありません。独立review前にconfirmatory runへ使わないでください。9 pairはhalf-width 1.0のfixture precision入力から計算した数であり、独立review済みの実datasetが存在するという意味ではありません。

検証:

```sh
bun run effects:benchmark plan benchmarks/effects-adversarial-v1/study.json
bun run effects:benchmark fixture benchmarks/effects-adversarial-v1/study.json --out-dir <new-directory>
bun run effects:benchmark verify <new-directory>/result-package.json
bun run effects:benchmark reproduce <new-directory>/result-package.json --out-dir <second-new-directory>
```

validatorは`src/effects-adversarial-research.ts`と`src/effects-adversarial-study.ts`、runnerは`src/effects-adversarial-benchmark.ts`です。`renderEffectsResearchTemplates`がCLAIMS.md、preregistration.md、bundle JSONを生成し、checked-in文書とのbyte一致をtestで検査します。

[実装計画](../../docs/EFFECTS_ADVERSARIAL_BENCHMARK_IMPLEMENTATION_PLAN.md)と[実装進捗](../../docs/EFFECTS_ADVERSARIAL_BENCHMARK_IMPLEMENTATION_RESULTS.md)を参照してください。
