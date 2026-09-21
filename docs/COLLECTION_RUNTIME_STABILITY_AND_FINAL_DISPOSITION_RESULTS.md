# Collection runtime計測安定化と最終方針 実装結果

実施日: 2026-09-21。基点revision: `d4fb34bce040e9af17389f53f5021d8f61ffb725`。

参照: [実装計画](./COLLECTION_RUNTIME_STABILITY_AND_FINAL_DISPOSITION_IMPLEMENTATION_PLAN.md)、[直前のボトルネック特定結果](./COLLECTION_END_TO_END_BOTTLENECK_ATTRIBUTION_RESULTS.md)、[Collection仕様](./LLANG_MODULE_COLLECTION_SPEC.md)。

## 結論

最終方針は`retain-baseline`、理由は`insufficient-stability`である。Collection製品Wasm、ABI、manifest、memory layout、fault semantics、公開APIは変更していない。これをrepository内で完結するCollection性能探索の最終判断とする。

startupは全6 blockで首位になり、holdout 16件中15件でmodule-cached laneのpaired median reductionが30%以上だった。最低3件というinterval Gateは15件が通過し、全holdoutのpaired ratio 95% interval上限も1.05以下だった。しかし、事前固定したデータ品質Gateのうちoverall変動、block間変動、forward／reverse差が不合格だった。品質Gate不合格時はprepared lifecycleを採用しない規則を結果観測前に固定していたため、性能値だけを理由に製品経路へ反映しない。

既存runtime objectのcompile-once、instance-per-evaluate、fault後の回復、runtime間のstate分離は仕様と回帰testで固定した。この利用境界は既存挙動の明文化であり、global cache、instance reuse、instance poolは追加していない。

## 記録条件

| 項目 | 値 |
| --- | --- |
| runtime | Bun 1.4.2 |
| Binaryen | 132.0.0 |
| host | macOS arm64 / Apple M4 |
| case | 23 |
| block | 6 |
| warmup | laneごとに5回、証跡外 |
| recorded sample | cold 690、module-cached 690 |
| child resource record | 138 |
| case order | 基準、逆順、8回転、8回転逆順、16回転、16回転逆順 |
| lane order | 偶数blockはcold先行、奇数blockはmodule-cached先行 |

raw observationは[`benchmarks/collection-runtime-stability-v1/observations/darwin-arm64.json`](../benchmarks/collection-runtime-stability-v1/observations/darwin-arm64.json)、機械判定は[`decision.json`](../benchmarks/collection-runtime-stability-v1/decision.json)に保存した。旧`collection-bottleneck-v1`証跡は変更していない。

## 品質Gate

| Gate | 上限 | 観測最大 | 結果 |
| --- | ---: | ---: | --- |
| cold unattributed share p95 | 20% | 1.6717% | 合格 |
| holdout overall MAD／median | 25% | 41.2962% | 不合格 |
| block median MAD／median | 15% | 29.4810% | 不合格 |
| forward／reverse median差 | 20% | 73.8199% | 不合格 |
| sample完全matrix | cold 690 / cached 690 | 690 / 690 | 合格 |
| static evidence | 順序不変 | 不変 | 合格 |

overall変動Gateは`closure-medium-b`、`fold-medium-b`、`generic-control`、`map-maximum-c`、`sort-medium-b`、`string-maximum-c`、`string-medium-b`、`union-control`が超過し、最大は`generic-control`の41.2962%だった。block間Gateは`fold-maximum-c`、`fold-medium-b`、`union-control`が超過し、最大は`fold-medium-b`の29.4810%だった。forward／reverse Gateは`closure-maximum-c`、`filter-medium-b`、`fold-medium-b`、`generic-control`、`sort-medium-b`、`string-maximum-c`が超過し、最大は`generic-control`の73.8199%だった。

## dominanceとprepared lifecycle

| 項目 | 観測 |
| --- | ---: |
| startup block首位 | 6 / 6 |
| startup holdout qualifying | 16 / 16 |
| startup holdout robust | 16 / 16 |
| startup median share | 67.5140% |
| 固定mix startup share | 74.6508% |
| paired median reduction 30%以上 | 15 / 16 |
| reduction interval下限20%以上 | 15 / 16 |
| paired ratio interval上限1.05以下 | 16 / 16 |

startupのscaling consistencyは`closure`、`composite`、`fold`で成立しなかった。さらに品質Gateが先に不合格だったため、最終decisionでは`selectedTarget`を`null`、prepared lifecycle Gateを未評価とした。これはcached laneの改善を否定するものではなく、製品採用に必要な安定性をcanonical runで証明できなかったことを示す。

## correctnessと安全性

- reference evaluator、公開runtime、trace childの全正常caseを一致させた。
- `ARITHMETIC_OVERFLOW`後も同じruntime objectの次評価が成功することを確認した。
- runtime objectを二つ生成し、instance memory、fault、allocator stateを共有しないことを確認した。
- 各`evaluate`が新しい`WebAssembly.Instance`を生成する既存境界を回帰testと仕様へ固定した。
- ABI `llang-collection-native-v1`、memory 128 page、artifact hash、exportを変更していない。
- child path、symlink、artifact、JSON、stdout／stderr、timeoutを制限した。
- recordはexclusive lockを使用し、observationとdecisionをtransactionalに公開する。失敗した初回runでは成果物が公開されないことも確認した。

## 再現コマンド

```sh
bun run collection:stability:verify
bun run collection:stability:report
```

新しいcanonical測定を行う場合だけ次を使う。

```sh
bun run collection:stability:benchmark
bun run collection:stability:record
```

`verify`はschema、完全matrix、deterministic evidence、lifecycle safety、rawからのsummary／decision再生成を検査する。`report`はchecked-in raw observationからdecisionを再生成し、JSON値が完全一致することを確認する。

## 完了後の扱い

repository内のCollection memory safety、Binaryen recipe、LLVM最小比較、end-to-end attribution、runtime安定性判断は一巡した。新しいCollection性能作業は、実SAAA workload、別CPU、長時間soakなど、今回と独立した証拠が得られた場合にだけ開始する。

L-Lang全体にはSAAA接続、実運用TLS、live model／人間評価など外部条件を伴う検証が残る。これらは今回の`retain-baseline`判断やCollection製品artifactを変更しない。
