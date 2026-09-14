# Prompt Sourceの要求変更評価：draft harness

このdatasetは評価runnerの開発用に作成した4課題であり、独立した人間によるレビュー・freezeは未実施。fixture reportは常に`evidenceEligible:false`で、実モデル精度の根拠には使わない。

| 課題 | 変更 | 期待される動作 |
| --- | --- | --- |
| suspension-update | enabled条件を維持し、suspendedを除外 | 型・既存例を維持し、新しい組合せでfalse |
| tier-update | email存在条件を維持し、premiumに限定 | basicを除外、空文字と欠損の区別を維持 |
| contradiction | enabledにtrueとfalseを同時に要求 | unresolved |
| unsupported-clock | 入力にない現在時刻を参照 | unresolved |

`source.examples`はLock公開前に照合する例。`probes`はLock公開後のWasmを照合する別の入力で、Sourceにもmodel requestにも含めない。各課題の自然言語要求、許可する要求ID、Source、期待outcome、probesをdataset hashに含める。

```bash
bun run prompt:evaluate hash benchmarks/prompt-source/dataset.json
bun run prompt:evaluate benchmarks/prompt-source/dataset.json --fixtures benchmarks/prompt-source/responses.fixture.json --out-dir artifacts/prompt-evaluation/run --dataset-hash 0d6ab2cb1b1cf6d6075de46c62f23fbecddc9595a86735e1b738b7687038e3af
```

out-dirは未作成のパスを指定する。既存runは上書きしない。datasetとfixtureのsnapshot、各caseのSource/Lock/Wasm、`report.json`を保存する。reportはcaseごとに更新し、中断時は`complete:false`のまま残る。dataset hash不一致やcase不足は書込み前に拒否する。

CLIはcaseが不合格ならexit 1。`rejected`と`unresolved`は別の結果で、不正なmodel outputを正しい未解決回答に数えない。`falseResolutions`は、未解決であるべき課題を解決した場合、または生成物がprobesに違反する場合を数える。build/IO等の障害は失敗として記録し、それだけで意味上のfalse resolutionに数えない。

fixtureのみを受け付け、API callは行わない。live評価と人間参加のA/B比較に進む条件は[BLOCKER.md](./BLOCKER.md)を参照。現在の4例の正解率を一般的なモデル性能として報告しない。
