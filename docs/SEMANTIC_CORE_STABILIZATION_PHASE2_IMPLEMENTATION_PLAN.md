# Semantic Core安定化・第二段階 実装計画

作成日：2026-09-21。状態：完了。実施結果は[第二段階の結果](./SEMANTIC_CORE_STABILIZATION_PHASE2_RESULTS.md)を参照。

## 目的

[第一段階の結果](./SEMANTIC_CORE_STABILIZATION_PHASE1_RESULTS.md)でSCG-002として残したgenerated differentialの不足を、`module-value-v1`のpure i32 subsetで解消する。同じ生成programとinputを、独立oracle、reference evaluator、generated TypeScript、JSONC round-trip、Wasmで評価し、observable outcomeを比較する。

この段階は、生成基盤と再現可能な失敗報告を最小subsetで確立する。Valueのstring／record出力／union／function call、Collection、Effectsへの拡張は含めない。物理resource consumptionや形式的同値性も対象外とする。

## 対象subset

- entry inputはrequired i32 field `left`／`right`を持つrecord、outputはi32。
- terminalはinput fieldまたはi32 boundary literal。
- unary minus、checked `+`／`-`／`*`／`/`／`%`。
- i32比較をconditionとする`if`。選択されないbranchを評価しない。
- 正常値、`ARITHMETIC_OVERFLOW`、`DIVISION_BY_ZERO`を比較する。
- expression depthとcase数を明示的に制限し、languageのfuel上限内で生成する。

## 成果物

| 対象 | 内容 |
| --- | --- |
| `src/llang-value-differential.ts` | 決定的generator、BigInt oracle、5 lane runner、outcome比較、反例 |
| `src/llang-value-differential-cli.ts` | seed／case range指定、JSON report、failure artifact保存 |
| `src/llang-value-differential.test.ts` | 決定性、boundary oracle、mutation検出、固定corpus、単一case replay |
| `package.json` | 再実行可能な`value:differential` script |
| 文書 | Observable Semantics、品質Gate、実施結果、文書一覧の更新 |

## 決定性と反例

各caseの乱数状態はuint32 seedとuint32 case indexから独立に導出する。前のcaseを実行しなくても、`seed + caseIndex`で同じprogramとinputを再生成できる。範囲外やuint32末尾を越えるcase rangeは、乱数周期へ暗黙に折り返さず拒否する。CI corpusはseed `20260921`を固定する。

各programはi32境界を含む6固定inputと2つのseeded inputで評価する。差分時にはformat version、seed、case index、input index、input、式、source、lane別outcome、単一case replay引数を記録する。CLIの`--failure-out`はこのJSONを指定pathへ保存する。

## Oracleと比較

oracleは生成式を直接BigIntで評価し、i32範囲、zero division、truncation、remainder、selected branchを独立に判定する。compilerのreference evaluatorをexpected生成に流用しない。

各laneの結果を`value(i32)`または安定fault codeへ正規化する。未知exception、invalid artifact、process失敗をsemantic faultへ丸めずrunner errorとする。全laneがoracleと一致したcaseだけを合格とする。

## 受け入れ条件

- [x] 同じseed／case indexから同じsourceとinputを生成できる。
- [x] caseを独立に再生できる。
- [x] i32 overflow、zero division、負数division／remainder、branch非評価を独立oracleで固定する。
- [x] reference、TS、JSONC、Wasmがoracleと比較される。
- [x] 意図的に異なるlane outcomeを検出し、完全なreproductionを保持する。
- [x] 五つのlaneが一つでも欠けた比較を合格にしない。
- [x] 生成TypeScriptは空の環境変数と5秒timeoutを持つ子プロセスで実行する。
- [x] 固定seedの試験が通常の`bun test`で実行される。
- [x] API credential、外部network、新しい依存を必要としない。
- [x] full quality gatesを実行し、未実行・失敗を結果文書で区別する。

## 検証

局所検証：

```sh
bun test src/llang-value-differential.test.ts --timeout 30000
bun run value:differential
```

前者は24 program／192 inputを通常testへ組み込み、後者は64 program／512 inputの明示的corpusを実行する。失敗時はseedとcase indexで一件だけ再実行する。

```sh
bun run src/llang-value-differential-cli.ts \
  --seed <seed> --start-case <caseIndex> --cases 1 \
  --failure-out artifacts/value-differential-failure.json
```

コード変更として[品質Gate](../QUALITY_GATES.md)の必須項目を実行する。coverage閾値を下げず、既存fixtureやartifactを更新して差分を隠さない。
