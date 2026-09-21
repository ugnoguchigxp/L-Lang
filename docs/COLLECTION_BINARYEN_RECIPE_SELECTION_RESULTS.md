# Collection Binaryen最適化レシピ選定 実装結果

実施日: 2026-09-21。計画基点revision: `0da5caeff8a5d36b56620dd127912c2c4acf7ce0`。対象計画: [Collection Binaryen最適化レシピ選定 実装計画](./COLLECTION_BINARYEN_RECIPE_SELECTION_IMPLEMENTATION_PLAN.md)。

## 結論

PR-0〜PR-8とCBR1〜CBR36を実装した。canonical環境で固定候補を評価した結果は`retain-baseline`であり、`emitCollectionModuleWasm`の既定artifactは変更していない。

O2、O3、O2＋shrink 1、O2＋shrink 2は、全correctness、raw ABI、再現build、artifact size、memory Gateを通過した。多くのholdoutでend-to-end medianは改善したが、95% bootstrap intervalの上限で判定する5%退行Gateに全候補が違反した。計測揺らぎを性能改善として採用しない規則に従い、全候補を`rejected-regression`とした。

## 実装した範囲

- version付きstrict recipe、canonical JSON、recipe hash、5候補のfreeze。
- Binaryen global settingを共有しない、一process一recipeのoptimizer child。
- input／output path、symlink、size、timeout、stdout／stderr上限、validation前後の検査。
- fold、map、filter、stable sort、closure、generic、合成処理、string、unionの9 program corpus。
- exploration 7件、holdout 8件、nested ABI correctness 2件。
- reference evaluatorとのdifferential、checked overflow、top-level range／wraparound／overlap、invalid UTF-8、invalid union tag。
- 二つのtemporary rootと逆順・並行生成によるWasm hash再現性検査。
- parse／lowering、baseline emit、optimizer内部phase、compile、instantiate、encode、host validation、evaluate、decode、end-to-endのraw timingを分離した。実行計測はrecipe／caseごとの専用child processに隔離した。
- artifact、linear memory、arena peak、allocation／copy回数・bytes、process peak RSSを時間とは別に記録した。
- median、MAD、p95、固定seedの95% bootstrap interval、事前Gateによるdecision再生成。
- canonical環境以外からchecked-in evidenceを更新できないrecord guardと、3証跡の失敗時rollbackを伴う順次publish。
- Ubuntu／macOS／Windows CIを同じsharded test入口へ統一。

## 固定環境と証跡

canonical runはBun 1.4.2、Binaryen 132.0.0、macOS arm64、Apple M4で実行した。

| 証跡 | 内容 |
| --- | --- |
| `benchmarks/collection-binaryen-v1/freeze.json` | 入力hash、9 programのIR hash、45 artifactのhash、correctness／raw ABI／再現性 |
| `benchmarks/collection-binaryen-v1/observations/darwin-arm64.json` | 15 performance case × 5 recipe × 9 sample、計675 raw sample |
| `benchmarks/collection-binaryen-v1/decision.json` | 全候補の比較、Gate結果、`retain-baseline` |

`collection:binaryen:report`はraw sampleからsummaryとdecisionを再生成し、checked-in decisionとの完全一致を検査する。

## 測定結果

| recipe | 最大artifact比 | holdout幾何平均speedup | 最大memory退行（arena／RSS） | 最大build時間 | 判断 |
| --- | ---: | ---: | ---: | ---: | --- |
| `binaryen-o2-v1` | 0.720434 | 1.249743x | 0% | 358.159750 ms | rejected-regression |
| `binaryen-o3-v1` | 0.721183 | 1.342289x | 1.229183% | 431.159125 ms | rejected-regression |
| `binaryen-o2s-v1` | 0.710329 | 1.277034x | 0.052868% | 440.423999 ms | rejected-regression |
| `binaryen-o2sz-v1` | 0.711078 | 1.261994x | 0.898758% | 393.778542 ms | rejected-regression |

各programのbaseline artifactは1,646〜2,672 bytes、O3 artifactは718〜1,927 bytesだった。parse／lowering、baseline emit、隔離childを含むO3 build時間はprogramごとに約319〜431 msであり、製品buildへ採用した場合のbuild costとして無視できない。

O3のmedian end-to-endはholdout全8件で19.26〜30.10%改善した。一方、95% bootstrap intervalの保守端で10%以上改善したのはclosure、fold medium、sortの3件に留まり、filter mediumでは13.10%退行し得るintervalとなった。ほかの候補も保守的退行が5%を超えるcaseを含み、採用条件を満たさなかった。

## 製品判断

- `emitCollectionModuleWasm`は従来どおり未最適化Wasmを返す。
- `module-collection-v1`のABI、manifest version 4、export、memory、fault、rebuild verifierは変更していない。
- optimizerとbenchmarkは製品artifactから分離した実験経路として残す。
- Binaryen recipeを指定する利用者向けflagや暗黙fallbackは追加していない。

rollbackは不要である。製品既定値を変更していないため、実験経路を無効化する場合は新規commandと`benchmarks/collection-binaryen-v1`を除去すればよい。

## 保証境界

確認済みなのは、freezeした9 program、固定入力、Bun 1.4.2／Binaryen 132.0.0、Apple M4上の結果である。sortと合成処理は言語のfuel上限内で256／512要素を使い、List上限4,096要素は線形処理で検証した。

別CPU、別runtime、実SAAA workload、長時間運用、ほかのWasm profileへの性能一般化は未実証である。RSSはrecipe／caseごとの専用child processが報告したprocess peakであり、Wasmだけのheap使用量ではない。今回の結果から独自pass列、`select`書換え、`trapsNeverHappen`、低memory前提を採用してはならない。

次に性能改善を検討する場合は、同じ候補の再測定を繰り返すのではなく、encode／decode、IR形状、data layout、実workloadの支配区間を先に特定する。
