# Semantic Core安定化・第二段階 実施結果

実施日：2026-09-21。コードレビュー・改善完了日：2026-09-22。対象：[第二段階 実装計画](./SEMANTIC_CORE_STABILIZATION_PHASE2_IMPLEMENTATION_PLAN.md)。

## 実装結果

`module-value-v1`のpure i32 subsetに、決定的なgenerated differential testingを追加した。各programを独立BigInt oracle、reference evaluator、生成TypeScript、JSONC round-trip、Wasmで実行し、i32 valueまたは安定fault codeを比較する。

generatorはseedとcase indexから独立にcaseを生成する。programにはi32 field、boundary literal、unary minus、五つの算術演算、六つの比較、ifを含める。inputにはmin／max、zero divisor、負数division／remainderとseeded i32を含める。

差分時のreproductionにはsourceと式だけでなく、全lane outcome、input、単一case replay引数を含める。CLIはmachine-readable resultを出力し、指定されたfailure pathへ反例を書き出す。

完了後のコードレビューでは、五つのlaneを実行時にも必須化し、outcome比較のJSON property順依存を除去した。case indexとcase rangeはuint32へ制限してPRNG周期への暗黙の折り返しを防いだ。生成TypeScriptの子プロセスには空の環境変数と5秒timeoutを設定した。CLIは重複・未知・欠損optionを拒否し、反例をatomic writeする。反例保存自体の失敗もmachine-readable errorとして返す。

## 検出した問題

初回の固定corpusで、生成器の内部`if.whenTrue/whenFalse`をJSONC sourceの`then/else`へ変換せず直列化する問題を検出した。source専用encoderを追加し、checked representationとsource syntaxの境界を明示した。修正後、同じcorpusは全laneで一致した。

これはcompiler本体の不具合ではなく、新規generatorのsource生成不具合である。既存artifactやlanguage contractへの変更はない。

## 検証結果

最終結果は、実装完了後に実行した局所試験と品質Gateに基づく。固定testは24 program／192 input、`value:differential`は64 program／512 inputを対象とする。

| 検証 | 結果 |
| --- | --- |
| generator決定性・独立case | 成功 |
| BigInt boundary oracle | 成功 |
| mutated lane検出とreproduction | 成功 |
| lane欠落／property順非依存 | 成功 |
| CLI option境界／atomic反例保存 | 成功 |
| 5 lane固定corpus | 24 program／192 input成功 |
| 単一case replay | 成功 |
| 明示的corpus | 64 program／512 input成功 |
| install／audit | frozen lockfileに変更なし、109 packageに既知脆弱性なし |
| format／lint／typecheck | 成功。今回の追加3ファイルはlint警告0。全体lintには既存警告87件があるが終了コード0 |
| documentation contracts | 成功。24 command、3 version、JSONC、module、effects smokeを検証 |
| full test | 151 file、799 test、0 fail |
| coverage | 799 test、0 fail、既定のfunctions 90%／lines 90%閾値を通過 |
| smoke | semantic、L-Lang、module、effectsの全smoke成功 |
| protected inputs | 成功 |
| `git diff --check` | 成功 |

初回coverageでは、同一プロセスへ動的importした一時生成TypeScriptも製品コードの集計母数に入り、functionsが89.83%となった。生成TypeScript laneを子プロセスで実行するよう変更し、比較対象を維持したまま一時コードを親のcoverageから分離した。閾値は変更せず、再実行で通過した。

## 保証範囲

固定seedで生成されたpure i32 subsetについて、五つの実行経路が同じobservable outcomeを返したことを確認する。独立oracleにより、reference evaluatorとbackendが同じ誤りを共有するだけの比較を避ける。

有限corpusの結果であり、`module-value-v1`全体の同値性証明ではない。string、record／union output、call、block／match、fuel、invalid inputは既存固定試験を維持し、このgeneratorの範囲には含めない。case数の増加だけを証拠の独立性向上とは扱わない。

## 次の候補

次の拡張は、今回のgeneratorへ機能を無差別に追加せず、既存証拠表の空白から選ぶ。第三段階にはValueのblock／match／tagged unionを選定し、[実装計画](./SEMANTIC_CORE_STABILIZATION_PHASE3_IMPLEMENTATION_PLAN.md)で既存corpusを維持した拡張方法を定めた。

残る候補はCollectionのpersistent Listとcallback、Effectsのdeterministic trace runnerである。Effectsへ進む前に、[第一段階のSCG-001／003／004](./SEMANTIC_CORE_STABILIZATION_PHASE1_RESULTS.md)にあるhost環境、resource単位、並行順序を確定する。
