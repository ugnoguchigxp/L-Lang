# Collection end-to-endボトルネック特定 実装結果

実施日: 2026-09-21。計画基点revision: `4afb97def2478d05e5132f2604f439246bc579ba`。対象計画: [Collection end-to-endボトルネック特定 実装計画](./COLLECTION_END_TO_END_BOTTLENECK_ATTRIBUTION_IMPLEMENTATION_PLAN.md)。

## 結論

PR-0〜PR-6とCBA1〜CBA36を実装した。canonical環境で23 case、207 sampleのcold traceと同数のmodule-cached診断traceを記録した。事前Gateによる結果は`inconclusive`であり、次の製品最適化対象はまだ確定しない。

記述統計ではstartupが最有力だった。holdout 16件すべてでshare medianが30%以上かつ95% bootstrap interval下限が20%以上となり、固定workload mixでも76.4727%で最大だった。holdout全体のmedian shareは66.7835%、Wasm evaluateは12.0344%だった。holdout caseの多数決と固定mixの首位はいずれもstartupで、順位整合Gateは通過した。

一方、sort maximumのcold totalはMAD／medianが37.7513%となり、固定した25%のデータ品質Gateを超えた。またmediumからmaximumへの増加方向が全scalable familyで揃わず、startupを含む全categoryがscaling consistencyを満たさなかった。結果を見てthresholdやcaseを変更せず、`timing-variation`を理由に`inconclusive`とした。

## 実装した範囲

- 製品baselineのcompile、instantiate、encode、host validation、evaluate、decodeを同一cold trace内で加算可能に測定した。
- module-cached traceを別系列で記録し、cold結果へ混入させなかった。
- total、accounted、unattributedをinteger nanosecondsで保存した。
- 9 program family、7 scalable familyの3サイズ、generic／unionの構造対照を固定した。
- input／output wire bytes、allocation／copy bytes、arena cost、product Wasm bytes、initial／maximum memory pageをcase identityへ結び付けた。
- checked programとWATから、function、statement、expression、block、loop、call、load／store、allocation／copy／validation callの決定的metricを生成した。WATはBinaryenで構文・validationを通過した場合だけ集計する。
- reference evaluator、public runtime、計測childの正常値と、public runtime／direct harnessのchecked overflow faultを比較した。
- 二つのprogram順序でhash、Wasm、metric、costが一致することを検査した。
- childのpath、symlink、size、timeout、stdout／stderr、strict JSON、既存outputを制限した。
- raw sampleからmedian、MAD、p95、固定seedの95% bootstrap interval、category share、decisionを再生成した。
- canonical環境guardと、observation／decisionの失敗時rollbackを伴う順次publishを実装した。

## 固定環境と証跡

canonical runはBun 1.4.2、Binaryen 132.0.0、macOS arm64、Apple M4で実行した。

| 証跡                                                                 | 内容                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------ |
| `benchmarks/collection-bottleneck-v1/benchmark.json`                 | sample、warmup、環境、resource limit、decision threshold     |
| `benchmarks/collection-bottleneck-v1/workload.json`                  | 23 caseと固定workload mix                                    |
| `benchmarks/collection-bottleneck-v1/observations/darwin-arm64.json` | 207 cold trace、207 cached trace、program／case metric、集計 |
| `benchmarks/collection-bottleneck-v1/decision.json`                  | data quality、4 categoryの根拠、`inconclusive`判断           |

`collection:bottleneck:verify`はprogram、Wasm、metric、costの決定的証跡を再生成する。`collection:bottleneck:report`はraw sampleからsummaryとdecisionを再生成し、checked-in値との完全一致を検査する。

## 測定結果

| category      | holdout median share | mix share | 30%以上のcase | robust case | scaling | 判断   |
| ------------- | -------------------: | --------: | ------------: | ----------: | ------- | ------ |
| startup       |             66.7835% |  76.4727% |            16 |          16 | 不一致  | 非確定 |
| host input    |              6.1370% |   8.2448% |             0 |           0 | 不一致  | 非確定 |
| Wasm evaluate |             12.0344% |  11.7279% |             3 |           3 | 不一致  | 非確定 |
| host output   |              0.9773% |   0.8986% |             0 |           0 | 不一致  | 非確定 |

holdout case medianの中央値はcold total 2,814,979 ns、module-cached total 233,104 nsだった。phase medianのcase間中央値はcompile 1,085,250 ns、instantiate 724,916.5 ns、encode 85,479.5 ns、evaluate 368,792 ns、decode 30,125 nsだった。これはcaseごとのmedianをさらに比較した診断値であり、単一traceの合計ではない。

unattributed shareの全case p95最大値は18.3883%で、20% Gateを満たした。初回観測でexport解決とmemory view作成がphase外へ落ちた問題を検出し、製品runtime上の位置に合わせてinstantiateへ含めた。最終観測では製品runtimeと同じWasm構造検査もcompileへ含め、decode後の値をreference結果と照合してcanonical証跡を取り直した。

input wireは4〜16,396 bytes、output wireは4〜32,804 bytesだった。product Wasmは1,646〜2,672 bytes、静的WAT命令数は636〜1,092だった。sort maximumはallocation 4,120 bytesに対してcopy 226,616 bytesで、data movementの大きさは確認できたが、cold totalの支配categoryを単独で確定する証拠にはしない。

## 製品判断

- `emitCollectionModuleWasm`、ABI、manifest、fault、memory limitを変更していない。
- Binaryen recipe、pass、利用者向けflagを追加していない。
- startupを製品最適化対象として採用していない。
- checked-in evidenceと診断commandは製品artifactから分離している。

rollbackは不要である。製品経路を変更していないため、診断基盤を除去する場合は`collection:bottleneck:*` command、対応するsource、schema、`benchmarks/collection-bottleneck-v1`を削除すればよい。

## 保証境界と次の判断

確認済みなのはfrozenした公開proxy、Bun 1.4.2、Binaryen 132.0.0、Apple M4上の短時間観測である。実SAAA workload、別CPU、長時間稼働、OS scheduler、JIT／GCの一般的挙動は未実証である。静的IR／WAT metricと時間の対応は診断であり、因果証明ではない。

次は最適化実装へ進まず、sort maximumで観測したcompile 823,542〜1,401,584 ns、instantiate 54,333〜1,188,834 ns、encode 38,000〜1,758,833 nsの揺らぎを、child起動後の安定化、GC／JIT、case順序から分離する。data quality Gateを満たすまでstartup cacheやlifecycle変更を製品へ入れない。
