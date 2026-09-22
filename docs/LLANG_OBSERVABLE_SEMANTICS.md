# L-Lang Observable Semantics

更新日：2026-09-21。対象snapshot：`381ccf9adb281d6339444941120a5aca4ae7e5ad`。

## 目的

複数targetが「同じ意味」と判断されるために比較する観測値と実行条件を定める。内部実装の完全一致ではなく、profileの利用者、host、verifierから観測できる契約を対象にする。

この定義は比較規則であり、全項目のcross-target検証が実装済みという宣言ではない。現在の証拠を後半の表で区別する。

## 比較ケース

一つの比較ケースは、次の組で識別する。

```text
ComparisonCase {
  profile
  checkedProgram
  input
  operationRegistry?
  grant?
  hostResponses?
  logicalClock?
  resourceBudget?
  schedule?
  cancellationPoint?
}
```

pure profileではoperation以降を使用しない。Effectsではprogramとinputが同じだけでは比較条件が揃わない。registry、grant、host response、deadline、schedule等が違えば、別の比較ケースである。

source bytesやfrontend syntaxが異なっても、同じprofileのchecked representationと実行条件へ正規化される場合は意味比較の対象にできる。provenance hashの一致は別に検査する。

## 観測値

| 観測値 | 比較する内容 | 正規化・注意点 |
| --- | --- | --- |
| result | terminal success valueと型 | record field順に依存しないcanonical form。bytes、i64、decimalはtagged valueを保つ |
| input rejection | entry前に拒否されたことと安定code | host codecだけの拒否とWasm内検査を区別できる試験も保持する |
| language fault | overflow、division by zero、index、resource等のcodeと発生点 | message、stack、JS classの完全一致は共通条件にしない |
| host failure | operation failure typeとterminal／retry状態 | language faultやrunner障害へ丸めない |
| emitted effects | operation ID／version、typed request、dispatchの有無 | credential値やredacted targetを比較出力へ漏らさない |
| effect order | 仕様が拘束する先行関係と、固定scheduleでの列 | 並行taskの実時間による偶然の順序は要求しない |
| task | spawnとのresult対応、返却順、failure propagation、取消、terminal state | 現行structured taskはjoin resultをspawn順に返す |
| stream | value／chunk列、emptyとEOF、early cancel、close | profileがchunk境界を公開する場合だけ境界を比較する |
| resources | 論理counter、上限判定、peak、超過前後のdispatch、terminal outcome | backend固有の物理memory／実時間を共通counterとみなさない |
| cleanup | close順、idempotency、主失敗とcleanup失敗、残存resource | 外部serviceのrollback成功までは推定しない |
| cancellation／timeout | generation、late responseの扱い、境界での勝者 | wall clockではなく固定logical clock／発生点で比較する |
| execution failure | unexpected trap、timeout、process exit、malformed artifact | semantic faultとして成功扱いせず、harness／artifact failureとして残す |

内部memory layout、一時変数、Wasm instruction、JIT、GC、実行時間、物理RSSは一般のsemantic equivalence条件ではない。ABI layout、performance、memory safetyはそれぞれ専用の適合試験と評価で扱う。

## Profile別の比較規則

### Predicate／Bool

正常boolean、invalid input、短絡による非評価を比較する。Predicateのproperty存在判定ではown data propertyとcontractを守り、prototypeやaccessorの副作用を観測可能な意味へ混入させない。Bool moduleではcall depthとevaluation stepのlimit outcomeも対象になる。

### Value

i32の値とfault、Unicode scalar、NUL、record／union value、selected branchだけの評価、fuel outcomeを比較する。業務failure variantは成功値、ABI statusのfaultは失敗として分ける。invalid UTF-8や不正union tagはinput rejectionである。

### Collection

List内容と順序、persistent update、callback訪問順、stable sort、closure capture、loop／recursionの結果とfaultを比較する。arenaやfuelの全counterがTS実行とWasmで同じ論理単位かは項目別に確認する。現時点では成功／fault outcomeの一致を優先し、物理allocation量の一致を要求しない。

### Effects

typed resultだけでなく、外部operation列とtyped request、host responseの消費、task／streamのterminal stateを比較する。Wasm continuation内部の`$task.join`はhost副作用ではないため、外部effect列と内部state transitionを別の観測欄に置く。

並行taskではspawn順、join result順、仕様上のfailure propagationを比較する。dispatch順を比較する場合は同じdeterministic scheduler条件を固定する。streamではone outstanding pull、maximum chunk、EOF、empty bytes、早期cancelを扱う。grant拒否、budget超過、timeout、cleanup失敗を正常fixtureと分けて比較する。

## 現在の検証証拠

状態は、今回実行して確認したものを「確認済み」、一部のtargetまたは観測値だけを扱うものを「部分確認」、対応する統一比較がないものを「未確認」とする。有限fixtureの成功を全programの証明とは扱わない。

| Profile・観測 | Reference | generated TS | JSONC round-trip | Wasm | 状態・根拠 |
| --- | --- | --- | --- | --- | --- |
| Boolのresult／expected failure | suite evaluator | child process | programHash再読込 | runtime | 確認済み。`llang-module-suite.ts`とmodule test |
| Valueのresult／fault | evaluator | child process | programHash再読込 | value runtime | 確認済み。value suiteと境界test |
| Collectionのresult／fault | evaluator | dynamic import | checked program再読込 | native runtime | 確認済み。collection suiteとcallback／sort／resource test |
| Effects frontend合流 | typed graph | generated source build test | flattened graph再読込 | emitted Wasm | 確認済み。TS／JSONC checked programとall-target build |
| Effects result／request replay | `runTypedEffectsGraph` | 個別build test | fixture source | `TypedEffectsRuntime` portable verify | 部分確認。referenceとWasmは同じsuite形式を使うが、generated TSを含む単一のtrace比較runnerはない |
| Effects task／stream | host runtime test | generated graph shape | source graph | state-machine／Wasm test | 部分確認。spawn-order、one-pull、cancel等の局所契約はあるが全target共通trace表はない |
| Effects grant／ledger／cleanup | session／host tests | host注入経路 | 対象外 | execution path | 部分確認。runtime契約は確認済み、全target differentialは未確認 |
| Value pure i32 generated programs | 独立BigInt oracle＋evaluator | generated TS | checked JSONC round-trip | direct Wasm runtime | 確認済み。固定seedの24 program／192 inputを通常test、64 program／512 inputを明示scriptで比較 |
| Value block／match／tagged union generated programs | 独立scope／tagged value oracle＋evaluator | generated TS | checked JSONC round-trip | direct Wasm runtime | 確認済み。内部variant構築とunion inputを固定seedの24 program／192 input、明示64 program／512 inputで比較 |
| Collection generated programs | 独立List／closure oracle＋evaluator | generated TS | checked JSONC round-trip | native Wasm runtime | 確認済み。5系統の固定seed 24 program／192 input、明示64 program／512 inputを比較 |
| その他のgenerated programs | 固定fixture中心 | 固定fixture中心 | 固定fixture中心 | 固定fixtureと境界corpus | 未確認。Valueの残りとEffectsは後続 |

2026-09-21に関連する83 testをBun 1.4.2で実行し、83 pass／0 failを確認した。対象コマンドと内訳は[第一段階の結果](./SEMANTIC_CORE_STABILIZATION_PHASE1_RESULTS.md)に記録する。

2026-09-22にValueのblock／match／tagged union向けgenerated differentialを追加し、実測値と保証境界を[第三段階の結果](./SEMANTIC_CORE_STABILIZATION_PHASE3_RESULTS.md)に記録した。

2026-09-22にCollectionのList順序、persistent update、stable sort、capture、snapshot向けgenerated differentialを追加し、実測値と保証境界を[第四段階の結果](./SEMANTIC_CORE_STABILIZATION_PHASE4_RESULTS.md)に記録した。

## 差を扱う規則

比較で差が出た場合、先に次を分類する。

1. sourceまたはchecked programが同一でない。
2. grant、host response、budget、clock、schedule等の環境条件が違う。
3. codec／ABI／runnerのfailureで意味評価へ到達していない。
4. profileが複数のtraceを許している。
5. backend、reference、仕様のいずれかに不一致がある。

差を消すためにcanonicalizationや許容traceを後から広げない。正規化規則の変更は、その理由と既存caseへの影響を記録する。reference evaluatorもoracleの一つであり、独立expected fixture、境界値、mutationで誤り検出能力を補う。

## 保証できる範囲

固定suiteと実行条件で複数targetが同じexpected outcomeを返したこと、round-tripで指定hashが一致したこと、portable runtimeでbundleが検証されたことを主張できる。それぞれの対象profile、case、観測値を併記する。

一般のprogramに対する形式的同値性、自然言語要求との完全一致、外部serviceの正しさ、host OSの完全性、実時間・物理resourceの一致は主張しない。生成テストは証拠範囲を広げるが、形式証明にはならない。
