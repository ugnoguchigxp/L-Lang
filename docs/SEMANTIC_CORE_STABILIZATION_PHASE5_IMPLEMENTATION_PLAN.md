# Semantic Core安定化・第五段階 実装計画

作成日：2026-09-22。状態：実装完了。実測結果は[第五段階の結果](./SEMANTIC_CORE_STABILIZATION_PHASE5_RESULTS.md)を参照。

## 目的

[第四段階の結果](./SEMANTIC_CORE_STABILIZATION_PHASE4_RESULTS.md)までにValueとCollectionへ追加した決定的generated differential testingを、`module-effects-v1`の逐次`await`へ拡張する。同じ生成programと決定的host scriptを、独立oracle、checked graph reference、generated TypeScript、JSONC round-trip、native Wasmで実行し、最終値だけでなくoperation request／responseの順序とterminal outcomeが一致することを確認する。

この段階ではEffects全体の同値性を主張しない。task、stream、取消、deadline、cleanup、実resource adapter、並行schedule、resource limitは対象外とし、外部環境を完全に固定できる逐次host operationだけを扱う。現行のsource version 5、build／suite version 5、profile `module-effects-v1`、ABI `llang-effects-session-v1`、`typed-wire-v1`、Binaryen 132.0.0、公開export、resource既定値を変更しない。

## この対象を選ぶ理由

[第一段階の結果](./SEMANTIC_CORE_STABILIZATION_PHASE1_RESULTS.md)のSCG-001では、Effectsにreference graph、portable Wasm replay、generated TypeScriptの局所試験はあるが、同じhost条件でresultとeffect traceを全target比較するrunnerがないことを記録した。[Observable Semantics](./LLANG_OBSERVABLE_SEMANTICS.md)でもEffects result／request replayは「部分確認」である。

現行typed graphではoperation requestがcompile-time fixedであり、逐次`await`については次を決定的に固定できる。

- operation IDとversion。
- request／responseの型とcanonical JSON表現。
- requestのsource順。
- operationごとのgrant可否。
- hostが返すresponseまたは失敗位置。
- 最後のresponseをprogram resultとする規則。

一方、taskは開始順と完了順、streamはchunk／EOF／cleanup、取消は発生点と論理時計を追加で定義する必要がある。これらを同じ最初のcorpusへ入れると、逐次traceの不足とschedule設計の不足を切り分けにくい。第五段階ではSCG-001の最小で独立した部分を解消し、後続が再利用できるtrace schemaとrunner境界を先に固定する。

## 現在の基準点

- 正本は[Effects仕様](./LLANG_MODULE_EFFECTS_SPEC.md)、[Semantic Core v1](./LLANG_SEMANTIC_CORE_V1.md)、[Observable Semantics](./LLANG_OBSERVABLE_SEMANTICS.md)、[Version契約](./LLANG_VERSIONING.md)とする。
- `loadEffectsModuleGraph`はrestricted TypeScriptとJSONCを同じ`CheckedEffectsGraph`へ変換する。
- `emitEffectsGraphTypeScript`が出す`execute(host)`はsource順にnodeを処理する。逐次`await`ではhostが返した最後の値を返す。
- `runTypedEffectsGraph`はgrant、registry、ledgerを適用し、typed Wasm continuationを経由してhost operationを実行する。
- `testEffectsModuleGraph`と`verifyTypedEffectsModuleBundle`は固定typed suiteを再生するが、generated TypeScriptを同じtrace比較へ含めない。
- Effectsの`programHash`はsource inventoryを含むため、original graphとflattened JSONCで一致しないことが仕様上認められている。round-trip同値性を`programHash`一致へ置き換えない。
- direct ABI、memory range、retry可能な境界失敗は`src/llang-effects-memory.test.ts`等の既存corpusが責任を持つ。

実装着手時には代表する既存typed graphについてsource set、interface hash、lowered hash、Wasm hash、固定suite outcomeを記録する。共通処理を抽出する場合も既存CLI、suite schema、bundle verify、execution evidenceの出力を変更しない。

## 前提と不変条件

- generatorは現行checkerを通過するvalid typed graphだけを作る。loader、checker、emitterの失敗をsemantic faultへ正規化しない。
- programは2〜4個の逐次`await`だけで構成する。`task`、`stream`、source-level `file`／`http` shorthandは生成しない。
- operationはgenerator専用の`host` effect、resource `none`とし、外部file、network、credential、wall clockを使わない。
- program inputの代わりに、grantとhost response／failure列を含む環境scenarioを比較caseとする。同じsourceでもscenarioが違えば別の比較caseである。
- host responseはoperationの宣言型を満たすcanonical値に限定する。malformed responseはhost contract違反であり、semantic outcomeへ含めない。
- 比較対象はnormalized traceとterminal outcomeである。request ID、Wasm memory offset、実時間、GC、RSS、Binaryen内部表現は比較しない。
- grant拒否とscript化したhost失敗は、operationをdispatchしたかどうかを含めて比較する。未知例外、timeout、child process異常終了、script不一致はrunner errorとする。
- logical resource counter、実ledger使用量、deadline、取消、cleanupは本段階で比較しない。既定budgetから十分離れた小さいprogramだけを作る。
- productのsource、manifest、suite、ABI、evidence formatへdifferential用fieldを追加しない。
- API credential、外部network、新しいruntime dependencyを必要としない。

## 対象subset

### 型と値

生成programはEffectsが既に実装する次の型を、canonical JSON表現を失わない範囲で使う。

- `i32`、`i64`、finite `f64`、`bool`、`string`。
- `bytes`。
- scaleを固定した`decimal`。
- 上記を要素に持つ小さい`list`と、field集合を固定した浅い`record`。

`i64`をJavaScript numberへ変換せず`{ i64: "..." }`、bytesをbase64 tag、decimalをcoefficientとscaleのtagとしてtraceへ保存する。`f64`はNaNとInfinityを生成せず、negative zeroは現行canonicalizationに従う。record key順は意味に含めず、list順とbytes列は保持する。

### program系統

generatorは少なくとも次の6系統を持つ。各programは異なるIDのoperationを2〜4個持ち、各nodeのrequestとresponse typeを宣言する。

1. **scalar-chain**：i32、bool、stringを順に要求し、最後のscalar responseを返す。
2. **wide-number-chain**：i64、finite f64、decimalのtagged表現を通す。
3. **bytes-chain**：空、短いbinary、UTF-8として無効でもよいoctet列をbase64で扱う。
4. **record-chain**：field順の異なるcanonical record request／responseを比較する。
5. **list-chain**：空、単一、重複、境界値を含むlistを順序付きで扱う。
6. **mixed-chain**：中間nodeと最終nodeで異なる型を使い、中間responseもtraceに残す。

operation definitionの`cancellable`と`idempotent`はcaseごとに決定的に変化させるが、この段階では取消やretryを起こさない。signature hashとmanifest要求が各laneで同じdefinitionへ結び付くことを確認する。

### 環境scenario

各programは8 scenarioを持つ。

- 5件：全operationが成功する。境界値、空値、異なる中間responseを含める。
- 1件：最初のoperationでscript化したhost failure。
- 1件：中間または最後のoperationでhost failure。それ以前のtraceだけを残す。
- 1件：中間または最後のoperationのgrantを外し、拒否されたoperationをhostへdispatchしない。

host failureはgenerator専用の安定code `HOST_FAILURE`として注入する。grant拒否は現行runtimeの`PERMISSION_DENIED`へ正規化する。失敗後に後続requestまたはresponseが記録された場合は不一致とする。

## 独立oracleとchecked graph reference

独立oracleはcompiler、loader、checked IR、source emitter、Wasm emitter、Effects runtime、ABI codecをimportしない専用moduleに置く。generatorの中立modelとplainなJSON互換値だけから、期待traceとterminal outcomeを計算する。

oracleは次を独立に実装する。

- operationのsource-order処理。
- grant集合によるdispatch前の拒否。
- request、成功response、host failure、terminalのtrace生成。
- 失敗時の即時停止。
- 最終nodeのresponseをresultとする規則。
- tagged i64／bytes／decimal、list順、record key非依存のstrict比較。

checked graph referenceは別moduleで`CheckedEffectsGraph`を読み、Wasmを生成または実行せずに同じhost scriptを逐次適用する。これは製品runtimeとして公開せず、checked representationとgenerator modelの対応を検査するtest harnessとする。oracleとreferenceを同一関数または同一case model評価へ委譲しない。

oracle sourceに禁止importがないことを試験で固定する。referenceが`emitTypedEffectsWasm`、`TypedEffectsRuntime`、`runTypedEffectsGraph`を呼ばないことも境界試験で確認する。

## traceとterminal outcome

各laneは次のstrict trace eventを返す。

- `request`：連番、operation ID、version、canonical request value。
- `response`：同じ連番、operation ID、version、canonical response value。
- `host-failure`：同じ連番、operation ID、version、安定code。
- `permission-denied`：dispatch前のoperation ID、version、安定code。response eventは持たない。
- `terminal`：`completed`、`host-failure`、`permission-denied`のいずれかと、成功時だけcanonical result。

request IDの文字列、Wasm generation、memory addressはlane固有なのでtraceへ含めない。順序は配列順で比較し、eventやrecordのproperty順には依存しない。未知field、疎なarray、追加property、symbol、accessor、undefined、function、class instance、循環値、非finite numberを正規化して受理しない。

terminalより後のevent、responseのない成功、requestのないresponse、operation／version／sequenceの不一致、script eventの未消費はsemantic outcomeではなくrunner invariant違反とする。

## 比較lane

各scenarioについて次の5 laneを必須とする。

1. 独立oracle。
2. checked graph reference。Wasmを使わずchecked nodesを逐次評価する。
3. generated TypeScript。実際の`program.generated.ts`を隔離child processでimportし、決定的host adapterを注入する。
4. flattened JSONC round-trip。再読込したchecked graphをreference evaluatorで実行する。
5. native Wasm。製品の`emitTypedEffectsWasm`と`TypedEffectsRuntime`を使い、yieldされたtyped requestへ決定的host adapterが同じgrantとhost scriptを適用する。

generated TypeScript childは空の環境変数、標準入力なし、5秒timeoutで実行する。host adapterはgrantをdispatch前に検査し、typed responseをgenerated sourceが期待するcanonical JSON値で返す。このadapter自体がprogram順序を決めず、渡されたrequestを受けてscriptと照合する。

native Wasm laneはraw continuation requestのoperation index、state、payloadを製品metadataと照合してから、同じhost adapterへ渡す。grant拒否時は`resume`せずinstanceをdisposeし、拒否対象とdispatch不実施をtraceへ残す。host failure時は`resume(..., false, ...)`によるterminal fault 6を`HOST_FAILURE`へ対応付ける。未知のWasm faultはrunner errorとし、既知host failureへ丸めない。`runTypedEffectsGraph`によるregistry／grant／ledger統合は既存固定試験を品質Gateで維持する。

JSONC round-tripではsource provenanceを含む`programHash`一致を要求しない。代わりに次を必須とする。

- `interfaceHash`が一致する。
- result type、operation definitions、node kind／operation／version、canonical requestを含むdifferential専用semantic projection digestが一致する。
- original graphとround-trip graphから生成したtyped continuationの`loweredHash`が一致する。

Wasm byte hashは同じ固定toolchainと同じlowered inputからの決定性証拠として記録するが、oracleの独立性や意味同値性の代わりにはしない。

## 決定性とcorpus

- format：`llang-effects-trace-differential-v1`
- fixed seed：`20260924`
- 通常test：24 program、各8 scenario、合計192 scenario
- 明示的corpus：64 program、各8 scenario、合計512 scenario
- case index：uint32。seedとcase indexだけから独立生成する。
- 単一再生：seed、case index、scenario indexを指定する。

最初の固定24 caseで6 program系統、全value分類、2〜4 node、成功、先頭／途中host failure、途中grant拒否が必ず現れるよう、系統とscenario役割を乱数任せにしない。乱数はoperation ID suffix、型の組合せ、literal、response値、flagへ使う。

固定24 caseについてcase model、semantic projection、interface hash、lowered hash、Wasm hashの配列digestを試験へ固定する。case数を増やすだけで同じsourceを繰り返す状態を合格にせず、通常24件と明示64件がそれぞれ十分に異なるsemantic projectionを持つことを確認する。

## reproductionとCLI

failure artifactには次を含める。

- format、version、seed、case index、scenario index。
- program系統、generator parameter、operation definitions。
- original source、flattened JSONC、oracle model、grant、host script。
- lane別traceとterminal outcome。
- source set hash、interface hash、semantic projection digest、lowered hash、Wasm hash。
- 単一case／scenarioの再生引数。
- runner errorの場合はstage、安定message、生成済みmodel、source、scenario集合、該当scenario index。

CLIは`--seed`、`--start-case`、`--cases`、`--scenario-index`、`--failure-out`だけを受理する。重複、未知、欠損、非整数、uint32範囲外、複数caseとscenario indexの併用を拒否する。

- 一致：終了code 0、stdoutへmachine-readable JSON。
- semantic mismatch：終了code 1、stderrへreproduction。
- 引数、生成、loader、emitter、child、script invariant、artifact書き込み等の運用失敗：終了code 2。

failure artifactは既存atomic writer相当の一時file＋renameで保存する。書き込み失敗時に以前の完全なartifactを途中状態へ置き換えない。

## runner stage

runner errorは少なくとも次のstageへ分類する。

- `source-load`
- `reference`
- `typescript-emit`
- `typescript-run`
- `jsonc-round-trip`
- `wasm-emit`
- `wasm-run`
- `trace-normalize`
- `artifact-write`

semantic mismatch例外はstage wrapperでrunner errorへ変換しない。child timeout、未知exception、malformed child output、scriptの過不足はrunner errorとして、言語上のhost failureやpermission denialと分ける。

## mutation試験

固定corpusが実装と同じ誤りを共有して通ることを避けるため、oracle境界と比較器へ次のmutationを注入する。

- 必須5 laneの一つを欠落させる。
- request順を反転する。
- requestを重複または一つ欠落させる。
- operation versionを比較しない。
- response eventを欠落させる、または次のrequestより後へ移す。
- 中間responseをtraceから落とす。
- 最初のresponseを最終resultとして返す。
- grantを無視して拒否対象をdispatchする。
- grant拒否をhost failureとして扱う。
- host failure後も次のoperationを実行する。
- host failure位置より前のresponseを落とす。
- i64をnumber、bytesをUTF-8 string、decimalをnumberへcoerceする。
- list順またはtrace順をsortして比較する。
- outcome objectのproperty順へ依存する。
- scriptの余剰eventを無視する。

各mutationは少なくとも一つの固定caseで期待traceまたはterminal outcomeと異なることを確認する。mutationは製品emitterへ注入せず、boundedなoracle／comparator変形として検査する。

## 実装構成

| 対象 | 内容 |
| --- | --- |
| `src/llang-effects-trace-differential-oracle.ts` | compiler／runtimeをimportしないcase model、独立oracle、oracle mutation |
| `src/llang-effects-trace-differential-reference.ts` | checked graphをWasmなしで逐次評価するtest専用reference |
| `src/llang-effects-trace-differential-harness.ts` | strict trace、deep比較、TS child、JSONC round-trip、native Wasm lane、stage分類 |
| `src/llang-effects-trace-differential.ts` | 決定的generator、semantic projection、比較、reproduction、range実行 |
| `src/llang-effects-trace-differential-cli.ts` | strict option parser、range実行、atomic failure artifact |
| `src/llang-effects-trace-differential.test.ts` | 決定性、oracle／reference境界、mutation、固定corpus、replay、CLI異常系 |
| `package.json` | `effects:trace:differential` script |
| `QUALITY_GATES.md` | Effects逐次trace変更時の固定／明示corpus Gate |
| 文書 | 第五段階結果、Observable Semantics、文書一覧。実装事実が変わる箇所だけ更新 |

製品APIを増やさず、differential moduleはtest／明示CLI専用とする。既存の`testEffectsModuleGraph`、typed suite v5、bundle verifier、execution evidence、transcript writerのschemaは変更しない。共通化が必要な場合も、運用証跡のredaction契約とtest用の完全なfixture traceを混同しない。

## 実装順序

### 1. 基準点と境界の固定

- 代表fixtureのsource set、interface、lowered、Wasm hashとtyped suite outcomeを記録する。
- 現行generated TypeScript、flattened JSONC、typed Wasmの逐次`await`動作を固定試験で再確認する。
- test用traceがexecution evidenceやproduction transcriptへ流入しないmodule境界を決める。

完了条件：既存artifactに対する無変更基準と、differential専用データの境界が試験で説明できる。

### 2. 独立oracleとstrict trace

- 中立model、canonical value、scenario、trace event、terminal outcomeを定義する。
- 独立oracleとstrict normalizer／comparatorを実装する。
- 禁止import、未知値拒否、順序、tag保持、property順非依存を試験する。

完了条件：compiler／runtimeなしで全scenarioの期待traceを決定でき、境界違反を試験が検出する。

### 3. checked graph reference

- checked nodeとoperation definitionをhost scriptへ対応付ける。
- dispatch前grant拒否、source-order、host failure停止、最終responseを実装する。
- oracleと同じ関数を再利用せず固定fixtureで一致を確認する。

完了条件：Wasmを生成せずchecked graphの逐次traceを報告できる。

### 4. TypeScript／JSONC／Wasm lane

- generated TypeScriptを隔離childで実行し、host呼び出しをtraceへ変換する。
- flattened JSONCを再読込し、interface、semantic projection、lowered hashを照合する。
- native Wasmのyield requestをoperation metadataへ対応付け、同じgrantとhost scriptを適用してterminalを正規化する。
- lane固有のrequest IDやmemory情報を比較対象へ混入させない。

完了条件：同じcase modelから5 laneが生成され、正常値、途中失敗、grant拒否の全てで一致する。

### 5. generator、reproduction、CLI

- seed＋case indexだけから24／64 programを決定的に生成する。
- 8 scenario、coverage assertion、digest、単一再生を追加する。
- mismatch／runner error artifactとstrict CLIを実装する。

完了条件：通常testと明示corpusが再現可能で、失敗を一つのcase／scenarioへ絞って再実行できる。

### 6. mutation、回帰、文書

- 全mutationの検出を固定する。
- 見つかった製品不具合は最小固定回帰試験を先に追加してから修正する。
- QUALITY_GATES、Observable Semantics、結果文書、文書一覧を実装事実へ更新する。

完了条件：対象subsetの証拠と対象外を過大表現なく説明できる。

## 互換性と変更管理

期待する変更はdifferential harness、test、CLI、品質文書の追加である。製品コードの変更はgenerated corpusが既存契約との差を示した場合だけ行う。

差を見つけた場合は次の順で扱う。

1. seed、case、scenario、source、host script、全lane traceを保存する。
2. 独立oracleと仕様のどちらが期待契約を支えるか確認する。
3. 既存fixtureで最小再現を追加する。
4. source／build／suite／ABI／evidence互換性への影響を評価する。
5. 契約内の実装修正だけを本段階へ含める。意味論変更が必要なら別計画へ切り出す。

Wasm emitterを修正する場合もBinaryen 132.0.0、memory 512 pages、`start`／`resume`／`cancel`／`dispose`／`fault_code`、`typed-wire-v1` descriptor、fault code、最適化設定を維持する。Binaryen global設定や最適化passは追加しない。

## 対象外

次は本計画だけでは実施しない。

- taskの開始順、完了順、join順、sibling cancellation。
- streamのchunk、空chunk、EOF、early cancel、producer cleanup。
- AbortSignal、deadline、timeout、論理時計。
- cleanup action、cleanup failure、主失敗との優先順位。
- resource ledgerの全counter、limit到達、release／peak一致。
- file／HTTP adapter、実filesystem、DNS、TLS、credential。
- execution evidence、attestation、trust policy、監査結果のgenerated differential。
- malformed wire、直接memory mutation、retry可能なABI境界失敗。
- linear i32互換形式。
- frontend invalid source fuzzing、形式証明、性能測定。

これらは既存専用試験の保証を維持し、逐次trace基盤の完了後にtask／stream／取消を一つずつ設計する。第五段階の成功から並行Effects全体の同値性を推定しない。

## 品質Gate

実装中の短いcycleでは次を使う。

```sh
bun test src/llang-effects-trace-differential.test.ts --timeout 30000
bun test src/llang-module-effects-graph.test.ts src/llang-effects-state-machine.test.ts src/llang-effects-wasm.test.ts --timeout 30000
bun run typecheck
```

明示corpusと既存Effects境界は次で確認する。

```sh
bun run effects:trace:differential
bun test src/llang-module-effects-loader.test.ts src/llang-module-effects-build.test.ts src/llang-module-effects-cli.test.ts --timeout 30000
bun test src/llang-effects-contract.test.ts src/llang-effects-runtime.test.ts src/llang-effects-concurrency.test.ts --timeout 30000
bun test src/llang-effects-memory.test.ts --timeout 30000
bun run effects:memory:matrix
```

memory matrix再生成後はchecked-in成果物に意図しない差分がないことを確認する。Wasm emitter／runtimeを変更しなかった場合も、native laneが既存ABIを使用することを局所試験で確認する。

最終確認はrepository標準Gateを実行する。

```sh
bun install --frozen-lockfile
bun audit
bun run format:check
bun run lint
bun run typecheck
bun test
bun run coverage
bun run ci:smoke
bun run ci:protected
bun run ci:docs
git diff --check
```

既存lint warningは基準値と比較し、新しいwarningを追加しない。文書だけの中間変更では`bun run ci:docs`と`git diff --check`を最低限実行する。

## 受け入れ条件

1. 固定24 program／192 scenarioと明示64 program／512 scenarioが5 laneで一致する。
2. 6 program系統、全対象value分類、成功、先頭／途中host failure、途中grant拒否を固定corpusが含む。
3. oracleがcompiler／runtime非依存で、checked referenceがWasm非依存である。
4. traceがrequest／response順、operation ID／version、typed value、dispatch有無、terminalをstrictに比較する。
5. generated TypeScriptを実際にchild processで実行し、source shape検査だけで合格にしない。
6. JSONC round-tripでinterface、semantic projection、lowered hashが一致し、provenance込み`programHash`を誤って同一視しない。
7. native Wasm laneが製品`typed-wire-v1` runtimeを使用し、mock結果だけで合格にしない。
8. 全mutationを少なくとも一つの固定caseが検出する。
9. mismatchと全runner stageを単一case／scenarioで再生でき、failure artifactをatomicに保存できる。
10. source v5、build／suite v5、ABI、exports、Binaryen版、resource既定値、既存fixture／bundle／evidence契約を維持する。
11. 関連Effects試験、full test、coverage、smoke、protected、docs Gateが成功する。
12. 結果文書が対象subset、実測件数、digest、発見した差、未実証範囲を記録する。

## 完了後の判断

第五段階が完了した時点で、SCG-001は「逐次`await`の固定host環境」について解消し、Effects全体については部分解消と記録する。次の候補は同じtrace schemaを使うtaskの固定schedule比較、またはstreamの決定的chunk／cleanup比較とする。

taskへ進む前には開始順と完了順を分け、host completionをcase入力として固定し、返却順はspawn順で比較する。streamへ進む前には空chunk、EOF、最大chunk数、early cancel、cleanup結果の優先順位を固定する。resource／deadline／取消はSCG-003／004の比較単位が決まるまで、これらの結果へ混ぜない。
