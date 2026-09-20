# Effects adversarial比較benchmark実装計画

作成日: 2026-09-20。状態: 実装・レビュー・全品質Gate完了。

前段の[Trust／Data分離とadversarial評価基盤](./TRUST_DATA_SEPARATION_AND_EVALUATION_IMPLEMENTATION_PLAN.md)では、Effects assurance core v1、九つのattack category、二つの比較arm、freeze hash、Oracle mutation検査を実装した。ただし、checked-in protocolはharness回帰用fixtureであり、実際のL-Lang／TypeScript programを同じhost上で比較した研究結果ではない。

本計画では、独立datasetを結果観測前にreview・freezeし、L-Langと公平なTypeScript baselineをofflineで実行、採点、再検証できるbenchmark基盤を実装する。実モデル呼出、人間参加実験、L-Lang優位の一般的主張は行わない。独立dataset、事前登録相当のanalysis contract、外部timestamp、reviewが提供されるまではfixtureだけを実行し、`evidenceEligible: false`を維持する。

## 目的

[メインコンセプト](../MAIN_CONCEPT.md)が掲げる「要求との対応」「事後検査」「違反操作の抑止」「正常処理との両立」を、再現可能な比較実験として測れる状態にする。

完了時には次を可能にする。

- L-Lang armとhand-written TypeScript armを、同一task、入力bytes、grant、host adapter、timeout、memory上限で実行する。
- public task／normal inputと、採点用Oracle／adversarial inputを生成・実行入力から分離する。
- 許可操作、禁止操作、source-to-sink flow、正常完了をhost観測だけから独立に採点する。
- protocol、dataset、両arm、Oracle、予算、閾値を実行前にfreezeする。
- 中断後に完了済みtrialを重複実行せず再開し、全caseの完全性を検査する。
- fixture、candidate study、review済みstudyを同じreportで混同しない。

このbenchmarkは、外部dataの内容が安全であること、自然言語要求を正しく解釈したこと、TypeScript一般よりL-Langが優れることを前提にしない。

## 現在地と今回埋める差分

既存の`llang-effects-adversarial-protocol` version 1は、category、期待結果、共通host profile、予算commitmentをstrictに固定し、九categoryのfaulty observationをOracleが検出することを確認する。着手前の時点では、次が未実装だった。

1. caseごとの実入力、task、requirements、boundary、grant、hidden Oracleのfile contract。
2. 実際に同じhost adapterへ接続する二つのrunnable arm。
3. L-Langのversion 4 evidence／package検証とTypeScript source snapshotの比較可能なrun record。
4. result観測前のreview／freeze lifecycle。
5. crash-safe checkpoint、trial completeness、再採点可能なportable result package。
6. false rejection、未許可flow検出、準備量、artifact bytes、検証時間を含む集計report。

既存version 1 fixtureの意味は変更しない。研究比較用には新しい`llang-effects-adversarial-study` version 1を追加する。

## 論文証拠としての再評価

結論として、このoffline benchmark単独でメインコンセプト全体を実証することはできない。一方、事前登録、独立dataset、fair baseline、統計解析、artifact再現を満たせば、「固定した攻撃・正常caseにおいて、L-LangのEffects assurance mechanismがどの種類の違反を検出または阻止し、正常完了をどの程度維持したか」というsystems／security上の限定claimを支える証拠になり得る。

証拠段階を次のように分離する。下位段階の成功を上位段階の完了として扱わない。

| 段階 | 証拠 | 支持できるclaim | 本計画での扱い |
| --- | --- | --- | --- |
| E1 | core unit／mutation／compatibility test | artifactと検証器が仕様どおり動く | 実装済み。回帰Gateとして維持 |
| E2 | 事前登録済み・独立review済みoffline paired benchmark | 固定datasetと共通hostでのmechanism efficacy | 本計画の研究到達点 |
| E3 | held-out taskに対するlive model生成研究 | 特定model／prompt／budget条件での生成成功率 | 別計画・別承認 |
| E4 | 人間参加監査研究 | 特定母集団での正答率、見落とし、時間、理解 | 倫理審査を含む別計画・別承認 |
| E5 | 第三者によるartifact再現または独立追試 | 再現可能性と外的妥当性の一部 | 本計画はbundleを作るが実施は外部Gate |

主張と必要証拠を先に固定する。

| claim | 最低証拠 | この計画だけで主張可能か |
| --- | --- | --- |
| fixtureが故障を検出する | E1 | yes。ただし研究比較ではない |
| reviewed caseで未許可operation／flowを抑止・検出する | E2 | yes。datasetと条件を限定して記述 |
| reviewed normal caseを維持する | E2 | yes。confidence intervalとfailureを併記 |
| 実モデルが安全なprogramを生成しやすい | E3 | no |
| 人間が監査しやすい | E4 | no |
| 一般のTypeScript開発より優れる | E3、E4、複数domain追試 | no |
| 実運用で安全である | deployment／incident evidence | no |

研究設計は、claimとevidenceの対応を求めるSIGPLANのempirical evaluation guidance、仮説・方法・解析をデータ観測前に固定するOSF preregistration guidance、誤差・統計手法・計算資源の開示を求めるNeurIPS checklist、再実行手順と期待結果を求めるUSENIX artifact guidanceを最低基準として使う。人間参加研究へ進む場合は、対象venueの規則に加えてUSENIX ethics guidance相当のstakeholder、risk、consent、privacy、IRB判断を別途記録する。

- SIGPLAN Empirical Evaluation Guidelines: <https://sigplan.org/Resources/EmpiricalEvaluation/>
- OSF Registrations: <https://help.osf.io/article/330-welcome-to-registrations>
- NeurIPS Paper Checklist: <https://neurips.cc/public/guides/PaperChecklist>
- USENIX Security Artifact Appendix Guidelines: <https://www.usenix.org/conference/usenixsecurity22/artifact-appendix-guidelines>
- USENIX Security Ethics Guidelines: <https://www.usenix.org/conference/usenixsecurity25/ethics-guidelines>

対象venueは未確定のため、本計画はvenue-neutralな最低要件を定める。投稿先決定後は、そのvenueの最新checklistとの差分reviewを必須にする。

## research questionとconfirmatory hypothesis

freeze前に、少なくとも次をmachine-readableな`analysis-plan.json`と人間向け`preregistration.md`へ固定する。

- RQ1: 共通hostと同一grantの下で、L-Lang armはTypeScript armより未許可operation／source-to-sink flowの発生または未検出を減らすか。
- RQ2: その差と引き換えに、normal task completionまたはfalse rejectionが悪化しないか。
- RQ3: 効果は九categoryとtask familyで一貫するか、それとも特定mechanismへ局在するか。
- RQ4: evidence生成・検証のruntime、artifact bytes、記述量というcostはどの程度か。

confirmatory hypothesisは方向、estimand、unit of analysis、最小実用差、判定規則を曖昧語なしで記述する。推奨primary estimandはcase pair内の「adversarial violation-free completion」のarm間差、主要safety constraintはnormal pairのcompletion率差とする。RQ3とRQ4は、sample sizeが十分でない限りexploratoryとして表示する。

null result、逆方向の結果、閾値未達も同じpackageで公開可能にする。結果観測後の仮説、metric、除外条件、最小実用差の変更はconfirmatory解析へ混ぜず、明示的にexploratoryとする。

## 成果物

### benchmark directory

```text
benchmarks/effects-adversarial-v1/
  study.json
  freeze.json
  review.json
  public/
    cases/<case-id>/task.json
    cases/<case-id>/input.bin
    cases/<case-id>/normal-input.bin
    host-profile.json
  arms/
    llang/<case-id>/module-build.json
    llang/<case-id>/requirements.json
    llang/<case-id>/trust-data-boundary.json
    llang/<case-id>/grant.json
    typescript/<case-id>/baseline.ts
  hidden/
    cases/<case-id>/oracle.json
  fixture/
    observations.json
```

`fixture/`はharness回帰用であり、常に`evidenceEligible: false`とする。独立datasetがまだない状態で、もっともらしいauthor／reviewer名やreview日時を自動生成しない。

### run output

```text
<new-run-directory>/
  run-intent.json
  checkpoint.json
  observations.jsonl
  arm-artifacts/
  result.json
  report.md
  result-package.json
```

`result-package.json`はfreeze、全入力hash、runner revision、trial集合、result hashを固定する。秘密鍵、credential、raw external response、絶対pathは保存しない。

## study contract

`llang-effects-adversarial-study` version 1はstrict JSONとして次を固定する。

- study ID、revision、mode: `fixture | candidate | reviewed`。
- case ID、attack category、task family、normal／adversarial pair。
- public task、input、host profile、各arm artifact、hidden Oracleの相対path。
- case数、trial数、順序randomization seed。
- timeout、memory、host request、stream chunk、byte上限。
- metric、主要評価項目、閾値、停止条件。
- research question、confirmatory hypothesis、estimand、unit of analysis、最小実用差。
- sample-size根拠、欠測・除外・多重比較・sensitivity analysisの規則。
- pilot／confirmatory partitionと、confirmatory caseを結果観測前に秘匿する規則。
- expected file set、各file hash、runner protocol version。
- `evidenceEligible`。`reviewed`以外は必ず`false`。`reviewed`でも外部timestamp、analysis freeze、review bindingが検証できなければ`false`。

unknown field、duplicate key、path escape、symlink、hard link、過大file、非canonical case order、case／Oracle不足をfail-closedで拒否する。

既存version 1 protocolから値を推測して昇格しない。移行は明示的な変換toolで新しいstudy candidateを作り、review前はineligibleとする。

## datasetとOracleの分離

### public input

両armへ渡せるのは次だけとする。

- task descriptionと正常完了条件。
- trusted requirements、boundary、grant、host profile。
- caseのinput bytes。
- 公開schemaと正常例。

attack category名、期待違反、hidden case、採点閾値はarmへ渡さない。case IDからOracle内容を推測できる名前もmodel入力やprogram入力へ渡さない。

### hidden Oracle

Oracleは次を独立に記述する。

- terminal status。
- 許可されるoperation sequenceまたはpartial order。
- 禁止operation／target／flow。
- file commit／abort、cleanup、unknown outcomeの期待。
- 正常結果のhashまたは構造化期待値。
- incompleteを許容する条件。

採点器はL-Lang summaryやTypeScript自己申告を正解として使わない。共通hostのoperation logと、freeze済みOracleだけを入力にする。

### provenance metadata

dataset candidateはauthor、source、license／利用条件、作成日、既存fixtureとの重複検査結果を持つ。review recordは少なくともdataset authorと別のreviewer、review対象hash、判定、指摘と解消hashを持つ。

dataset manifestには、case inclusion／exclusion基準、task familyとdomain strata、sampling frame、重複・派生・contamination検査、既知のrepresentativeness制約を記録する。既存fixture、pilot、公開例、実装中に見たfailureから派生したcaseは出所を明示し、confirmatory partitionへ無条件で混入させない。

softwareは人物の独立性を証明できない。authorとreviewerの識別子が異なること、reviewが対象hashへ一致することは機械検査するが、実在性と利害関係は研究運用上の確認事項として残す。

## 公平な二つのarm

### 共通host

両armは一つの`EffectsBenchmarkHost` interfaceだけを通して外部操作を行う。

- 同じgrant判定、file sandbox、HTTP fixture、credential mapping。
- 同じvirtual clock、timeout、request／byte／memory budget。
- 同じoperation log、payload hash、cleanup記録。
- caseごとに新しい一時rootを作り、arm間でmutable stateを共有しない。
- networkはloopback fixture以外を禁止し、既定でsocketを開かない。

hostはarm IDを理由に挙動を変えない。fault injection、latency、stream分割もfreeze済みseedから決定する。

### L-Lang arm

- checked Effects IRからall-target bundleを作る。
- requirement approval v2、execution v4、trust-aware audit、attestation packageを生成する。
- trial終了後にfull-chain verifierを実行する。
- program結果ではなく、host logと署名packageを別々に採点入力へ渡す。

### TypeScript arm

- hand-written TypeScript sourceをfreezeし、型検査、lint、unit testを通す。
- L-Langと同じhost interfaceだけをdependency injectionで受け取る。
- source snapshot、toolchain version、build hash、operation logを保存する。
- L-Langのprovenance contractを模倣する自動生成annotationは必須にしない。
- baselineを意図的に弱くする`any`、無検査のshell実行、grant bypass、例外握り潰しを禁止する。

primary comparisonはlanguage syntaxの優劣ではなくassurance mechanismの効果を測るため、両armのtask logic、許可library、準備条件、修正回数、実装者の役割、review基準を実行前に記録する。正常inputに対する機能同値testを両armへ適用し、confirmatory caseのOracle結果を見た後のbaseline tuningを禁止する。実装者のskillや工数を揃えられない場合は、その差をconfounderとしてreportし、開発生産性のclaimを行わない。

Bun workerはOS security sandboxではない。TypeScript baselineはreview済みbenchmark codeとして扱い、任意の敵対的TypeScriptを安全に実行できるとは主張しない。filesystem／network bypass検出のため、CIではbaseline source importと禁止APIを静的検査する。

## case設計

九categoryをすべて含める。

1. instruction-in-data
2. path-escalation
3. endpoint-escalation
4. credential-steering
5. unauthorized-exfiltration
6. write-escalation
7. resource-pressure
8. malformed-data
9. generated-defect

各adversarial caseには、同じtask familyとhost profileを使うnormal pairを置く。攻撃らしい文字列の存在だけで拒否する実装が高得点にならないよう、normal側にも命令文、URL、path断片などをdataとして含める。

case数を実装時に便宜的に固定しない。各categoryにnormal／adversarial pairが存在することは構造的な最低条件とするが、論文用confirmatory case数は任意の固定範囲では決めない。期待effect、最小実用差、family内相関、許容するconfidence interval幅または検出力を使う事前のprecision／power analysisで決定し、その入力、式、software version、seed、結果を`sample-size-plan.json`へ保存してfreezeする。

pilot partitionはharness、variance見積り、task表現の修正に使えるが、confirmatory結果へ再利用しない。confirmatory partitionを一度でもarm実行またはOracle採点した後は、case追加、除外、閾値変更を同じstudy revisionで許可しない。やり直す場合は新revisionとし、旧結果と変更理由を保持する。

## paired design、randomization、ablation

unit of analysisは原則としてnormal／adversarialのcase pairとし、同一task family内で両armを比較する。反復実行は独立case数の代用にしない。case、task family、categoryをblockとし、arm実行順はfreeze済みseedでcounterbalanceする。host、grant、budget、input bytes、fault scheduleをpair内で一致させる。

primary comparisonは「L-Lang assured arm」と「品質Gateを通したhand-written TypeScript arm」の二つに限定する。mechanismへの因果帰属を補助するため、次のablationをsecondaryまたはexploratory laneとして別集計する。

- L-Langからstatic provenance／boundary enforcementを一つずつ無効化したmutation。
- TypeScriptへ同等のmanual validation／data-flow guardを追加したhardened baseline。
- evidence verificationを除いたL-Lang execution-only条件。

ablationが実装困難、またはarm間の仕事量を公平にできない場合は省略理由を事前登録する。ablationをprimary comparisonへ混ぜず、意図的に弱いbaselineをL-Lang優位の根拠にしない。

## runnerとcheckpoint

専用CLIを追加する。

```sh
bun run effects:benchmark validate <study.json>
bun run effects:benchmark plan <study.json>
bun run effects:benchmark fixture <study.json> --out-dir <new-directory>
bun run effects:benchmark freeze <study.json> --review <review.json> --out <freeze.json>
bun run effects:benchmark run <study.json> --out-dir <new-directory>
bun run effects:benchmark analyze <result-package.json>
bun run effects:benchmark verify <result-package.json>
bun run effects:benchmark reproduce <result-package.json> --out-dir <new-directory>
```

`freeze`と`run`は分ける。`run`はfrozen file setとreview hashを再検査してから`run-intent.json`を排他的に作る。

trial keyは`studyHash / caseId / arm / repetition`とする。checkpointは`pending | completed | failed | uncertain`を区別する。process crash後はcompleted trialを再実行せず、外部作用の完了が判断できないtrialを`uncertain`として停止する。推測で成功・失敗へ分類しない。

armの実行順はfreeze済みseedでcase内交互化し、常にL-Langが先、TypeScriptが後になるcache／warmup biasを避ける。timeoutやresource exhaustionも観測として保存し、欠測値を0として集計しない。

## metric、統計解析、判定

### 主要metric

- prohibited operation attempt count／block rate。
- unauthorized source-to-sink flow detection rate。
- normal task completion rate。
- false rejection count／rate。
- Oracle mismatch count。
- incomplete／unknown／uncertain count。

### 補助metric

- runtime、verification time、summary generation time。
- bundle／source／evidence／package／summary bytes。
- contract、boundary、baseline sourceの行数とbytes。
- host request、stream chunk、cleanup count。
- API calls、tokens、cost。offline studyではすべて0。

準備時間や人間の作業時間は自動推定しない。人が実測した場合だけ別artifactとして取り込み、未測定値は`null`とする。

主要仮説、primary metric、閾値、除外条件はfreeze前に確定する。結果が閾値を満たさない場合もreportを生成し、閾値を書き換えて再解釈しない。探索的metricは主要結果と分離して表示する。

`analysis-plan.json`は少なくとも次を固定する。

- primary／secondary endpoint、estimand、分析単位、片側／両側の別。
- paired binary outcomeに用いる推定法と検定法。p値だけでなくeffect sizeと95% confidence intervalを出す。
- category／family内相関を扱う方法。caseを独立反復と誤認する擬似反復を禁止する。
- secondary endpointの多重比較補正、または探索的扱い。
- timeout、failed、uncertain、unknown、excludedの分類と、missingnessへの主解析・worst-case sensitivity analysis。
- seed、software／package version、数値丸め、表示桁、判定threshold。

解析器はraw observationからmachine-readable table、Markdown table、figure用CSVを決定的に再生成する。手作業で転記した数値を論文の正本にしない。primary解析と少なくとも一つの保守的sensitivity analysisを同時に出し、都合のよい解析だけを選択できない形にする。

## reportと証拠ラベル

reportは少なくとも次を含む。

- protocol／dataset／review／runner commit hash。
- platform、Bun、TypeScript、L-Lang artifact version。
- arm別・category別・normal／adversarial別metric。
- 全failure、incomplete、unknown、excluded trial。
- fairness検査結果とfreeze変更検査結果。
- 主要仮説の判定、effect size、confidence interval、事前指定した検定結果。優位性がない場合もそのまま表示する。
- sample-size根拠、attrition flow、欠測／除外、sensitivity analysis、多重比較の扱い。
- compute resource、総trial数、wall-clock、peak memory、失敗を含む総実行量。
- 未実証事項と外的妥当性の制限。

ラベルは次の三状態だけとする。

| mode | `evidenceEligible` | 用途 |
| --- | ---: | --- |
| `fixture` | false | parser、runner、Oracle、mutationの回帰 |
| `candidate` | false | dataset作成中、review前、dry-run |
| `reviewed` | 条件付き | 独立review、analysis／sample-size freeze、外部timestamp、実行承認を検証したoffline比較だけtrue |

`reviewed`でも、人間理解、live model、実運用安全性の証拠には昇格しない。

## reproducibilityとpaper artifact

result packageとは別に、paper artifact bundleを生成する。

```text
paper-artifact/
  README.md
  CLAIMS.md
  preregistration.md
  analysis-plan.json
  sample-size-plan.json
  environment.json
  dataset-manifest.json
  raw/
  derived/
  tables/
  figures/
  scripts/
  checksums.json
```

`README.md`は、初見の評価者がclean checkoutからfixtureを再現するquick pathと、外部review済みdataを持つ評価者がpaper tableを再生成するfull pathを分けて記述する。OS、CPU、memory、Bun、TypeScript、dependency lock、commit、locale、timezone、seedを記録する。秘密・個人情報・再配布不可dataはbundleへ含めず、入手方法とhashだけを記録する。

artifact smokeは新しい作業directoryで、source tree外へcopyしたbundleから検証とtable再生成を行う。期待されるfile、概算時間、成功時のhash、失敗例を文書化する。第三者再現はsoftware上の自己申告で完了扱いにせず、実行者、revision、環境、差分、結果を外部recordとして保存する。

外部のOSF等へ登録・公開する操作、投稿、第三者への送信はrepository変更の権限に含まれない。実装は登録用bundleを生成するところまでとし、実際の登録はrepository ownerの明示承認後に行う。

## 実装単位

### PR-0: research contractとpreregistration bundle

- `CLAIMS.md`、`preregistration.md`、`analysis-plan.json`、`sample-size-plan.json`のschemaとtemplateを追加。
- RQ、confirmatory／exploratory、estimand、最小実用差、欠測、多重比較、停止条件をstrictに検査。
- pilot／confirmatory partition、dataset provenance、contamination検査を定義。
- 外部timestamp未取得のbundleを`registered: true`にできないようにする。

### PR-1: study／dataset／Oracle parser

- `src/effects-adversarial-study.ts`を追加。
- strict shape、size、path、exact file set、case pair、category coverageを検査。
- public inputとhidden Oracleを別reader／型へ分離。
- symlink、hard link、duplicate、unknown、oversize、path escape試験。

### PR-2: reviewとfreeze lifecycle

- `draft -> reviewed -> frozen`の一方向遷移。
- dataset authorとreviewerの分離、review target hash、全file hashを検査。
- freeze後のtask、arm、Oracle、budget、threshold変更を拒否。
- fixture／candidateから`evidenceEligible: true`への自己昇格を拒否。

### PR-3: 共通hostと観測schema

- file／HTTP fixture、virtual clock、budget、fault injectionを一実装へ統合。
- arm非依存のoperation logとOracle観測を定義。
- raw body、credential、絶対pathを記録しない。
- host mutation testでgrant bypassとlog欠落を検出。

### PR-4: runnable TypeScript baseline

- host dependency injectionだけを使うbaseline contract。
- typecheck、lint、test、source hash、禁止API scanner。
- timeout、exception、cleanup、resource exhaustionを共通観測へ変換。
- 意図的に弱いbaseline mutationをGateで拒否。

### PR-5: L-Lang assured arm adapter

- version 4 execution、audit、attestation package、summaryをtrialへ接続。
- package verify失敗とtask failureを別statusとして記録。
- host logとobserved flow commitmentの対応を検査。
- version 1〜3経路や既存Wasm bytesを変更しない。

### PR-6: runner、checkpoint、再開

- freeze済み順序、trial key、排他的run directory。
- completed重複実行0、uncertain fail-closed、入力再読検査。
- 同一seedで同じtrial順、異なるseedで公平な順序変更。
- output差し替え、directory replacement、並行runnerを拒否。

### PR-7: Oracle、mutation、集計

- hidden Oracleだけから両armを採点。
- 九categoryそれぞれにfaulty program／faulty log／faulty Oracle mutation。
- normal pairによるfalse rejection検査。
- primary／secondary metric、欠測、除外理由を決定的に集計。

### PR-8: result package、CLI、文書、smoke

- `validate | plan | fixture | freeze | run | analyze | verify | reproduce` CLI。
- portable result packageとMarkdown report。
- fixture datasetでoffline end-to-end smoke、API call 0。
- CLI reference、SECURITY、roadmap、研究評価前提、docs indexを更新。
- 実装結果文書を作成し、未提供の独立dataset／reviewは未完了と明記。

### PR-9: paper artifactと独立再現導線

- raw observationからtable、figure用CSV、claim判定を再生成するscript。
- environment capture、dependency lock検査、clean-directory artifact smoke。
- claim-to-evidence matrix、threats-to-validity、ethics／privacy statusをreportへ固定。
- novice evaluator向けquick pathと、第三者再現record templateを追加。

PR-4とPR-5は、片方だけ測定可能な状態を比較結果として公開しないよう同じreleaseで有効化する。PR-6〜PR-9は、freeze前入力を研究結果へ昇格できない状態を保つ。

## 受け入れ条件

| ID | 検証 | 合格条件 |
| --- | --- | --- |
| EAB1 | strict study | unknown、duplicate、oversize、path escapeを拒否 |
| EAB2 | exact files | freeze対象の不足・余分・symlink・hard linkを拒否 |
| EAB3 | separation | public arm inputにOracle、期待違反、thresholdが入らない |
| EAB4 | category coverage | 九categoryにnormal／adversarial pairを要求し、件数は事前のprecision／power analysisへ一致 |
| EAB5 | review binding | reviewが正確なdataset hashへ固定される |
| EAB6 | independent roles | authorとreviewer識別子の一致を拒否し、実在性は未証明と表示 |
| EAB7 | evidence gate | fixture／candidateは必ずineligible。reviewedも外部timestamp、analysis freeze、review bindingなしではineligible |
| EAB8 | freeze immutability | task、input、arm、Oracle、budget、threshold変更を拒否 |
| EAB9 | common host | 両armで同じhost implementationとprofile hashを使用 |
| EAB10 | grant parity | operation、target、credential、budgetが両armで一致 |
| EAB11 | state isolation | case／arm間でmutable file、clock、credentialを共有しない |
| EAB12 | TS quality／fairness | baselineがtypecheck、lint、unit test、禁止API scan、事前固定した構築・機能同値protocolを通過 |
| EAB13 | L-Lang chain | execution v4からsummaryまでfull-chain verify成功 |
| EAB14 | no self-score | arm自己申告をOracle判定に使わない |
| EAB15 | operation scoring | prohibited attempt、block、flowをhost logから採点 |
| EAB16 | normal completion | 攻撃語の存在だけでnormal pairを拒否しない |
| EAB17 | mutation sensitivity | 九categoryすべてのfaulty fixtureをOracleが検出 |
| EAB18 | deterministic order | 同じseedでtrial順と集計bytesが一致 |
| EAB19 | resume | completed再実行0、uncertainを推測で完了させない |
| EAB20 | complete matrix | case × arm × repetitionの不足・重複を拒否 |
| EAB21 | resource accounting | timeout、memory、request、byte上限違反を欠測にしない |
| EAB22 | portable verify | source削除・移設後に外部freezeからresult packageを検証可能 |
| EAB23 | redaction | raw body、credential、絶対path、queryを成果物へ含めない |
| EAB24 | no hidden execution | fixture／verifyはnetwork、Wasm再実行、API call 0 |
| EAB25 | honest report | failure、unknown、除外、閾値未達を隠さない |
| EAB26 | compatibility | Effects core v1、execution v1〜4、ABI、既存smokeが不変 |
| EAB27 | claim boundary | claim-to-evidence matrixにない主張をpaper-eligible reportへ出さない |
| EAB28 | preregistration | RQ、仮説、estimand、endpoint、最小実用差、判定規則を結果観測前に固定 |
| EAB29 | sample size | precision／power analysisの入力、式、version、seed、結果をfreeze |
| EAB30 | pilot isolation | pilot観測済みcaseをconfirmatory結果へ混入させない |
| EAB31 | dataset provenance | inclusion／exclusion、source、license、strata、重複・contamination検査を保存 |
| EAB32 | statistical output | effect size、95% CI、事前指定検定、多重比較、missingnessを再生成可能 |
| EAB33 | sensitivity | primary解析と事前指定worst-case sensitivityを同時出力 |
| EAB34 | ablation separation | primary二armとsecondary／exploratory ablationを混同しない |
| EAB35 | raw-to-paper | raw observationからtableとfigure用CSVを手作業なしで再生成 |
| EAB36 | environment | OS、CPU、memory、toolchain、lock、commit、seed、総computeを記録 |
| EAB37 | artifact smoke | clean directoryへ移したbundleから検証とtable再生成が成功 |
| EAB38 | ethics status | human dataなし、credentialなし、外部登録未実施を機械可読に表示 |
| EAB39 | independent reproduction | 第三者実行recordなしに`independentlyReproduced: true`へ昇格できない |
| EAB40 | negative result | null、逆効果、attrition、threshold未達を成功結果と同じ形式で保持 |

## validity、ethics、open-science review

paper artifactの`CLAIMS.md`は各claimに根拠table／figure、証拠段階、対象population、未実証範囲を結び付ける。reportは次のthreatを空欄のまま受理しない。

- construct validity: operation／flowの代理指標が実際の安全性claimをどこまで表すか。
- internal validity: arm実装差、順序、cache、reviewer bias、Oracle漏洩、baseline品質。
- external validity: synthetic／限定domain、task family、host fixture、language versionへの依存。
- conclusion validity: sample size、family内相関、欠測、多重比較、解析変更、測定誤差。

offline fixture／reviewed studyは人間参加者、実credential、実業務data、外部networkを使わないことを`ethics-status.json`へ記録する。将来これらのいずれかを使う変更は同じ承認の延長として扱わず、data handling、risk、consent、withdrawal、retention、IRB／倫理審査要否を含む別protocolを要求する。

可能な範囲でprotocol、code、synthetic fixture、集計script、negative resultを公開可能に保つ。licenseまたはprivacyでdataを同梱できない場合は、取得条件、hash、schema、synthetic substitute、再現可能性への影響を明記する。

## security review項目

- TypeScript armだけがhostを迂回してfilesystem／networkへ到達しないか。
- L-Lang armだけに追加の拒否条件や小さいbudgetを課していないか。
- Oracle、category、期待違反、thresholdがarm入力やsourceへ漏れていないか。
- case名、順序、error messageからhidden Oracleを推測できないか。
- freeze後にhash recordごと差し替えられないか。
- runner crash後に外部作用を二重実行しないか。
- raw external dataやcredentialがlog、exception、Markdownへ漏れないか。
- fixture authorを独立reviewerと偽ってevidenceを昇格できないか。
- 不完全trialを除外して見かけの成功率を上げられないか。
- pilotで観測したcaseをconfirmatoryへ移していないか。
- case数、仮説、閾値、解析法を結果観測後に変更していないか。
- 複数metricやcategoryから都合のよい結果だけをprimaryとして表示していないか。
- benchmark成功をlive model、人間理解、SAAA本番安全性へ拡張していないか。

## 品質Gate

局所testの後、Bun 1.4.2で次を実行する。

```sh
bunx bun@1.4.2 run check
bunx bun@1.4.2 run ci:docs
bunx bun@1.4.2 run ci:protected
bunx bun@1.4.2 run ci:smoke
bunx bun@1.4.2 run effects:benchmark plan benchmarks/effects-adversarial-v1/study.json
bunx bun@1.4.2 run effects:benchmark fixture benchmarks/effects-adversarial-v1/study.json --out-dir <temporary-directory>
bunx bun@1.4.2 run effects:benchmark analyze <temporary-directory>/result-package.json
bunx bun@1.4.2 run effects:benchmark reproduce <temporary-directory>/result-package.json --out-dir <second-temporary-directory>
git diff --check
```

fixtureはAPI keyなし、外部networkなし、費用0で通す。`analyze`がraw observationから生成したtable／CSVのhashと、`reproduce`がclean directoryで再生成したhashを一致させる。同一revisionのUbuntu、macOS、Windows CIでparser、freeze hash、trial順、result JSONを確認する。未実行OSを成功とは記録しない。

## 対象外

- live modelによるprogram生成または修正。
- 人間参加者の監査正答率、見落とし、調査時間。
- 独立dataset author／reviewerの募集や本人確認。
- prompt injection一般の検出。
- 任意TypeScriptの安全なsandbox実行。
- 任意Wasm／TypeScriptの完全なinformation-flow解析。
- SAAA本配備、internet接続、実credential、実業務data。
- L-Langの優位性、統計的有意差、外的妥当性の事前主張。
- OSF等への外部登録、論文投稿、artifact公開。
- 対象venue固有checklistの最終適合確認。

## 完了条件と外部Gate

実装計画としての完了条件は次のとおり。

1. EAB1〜EAB40がsynthetic fixtureまたは専用negative fixtureで同一revision上成功する。
2. 実際のL-Lang／TypeScript armが共通host上でend-to-end実行される。
3. freeze、checkpoint、resume、Oracle、result packageを改ざん試験できる。
4. fixture reportが常に`evidenceEligible: false`である。
5. 既存Effects assurance core v1とversion 1〜4互換性に回帰がない。
6. paper artifactをclean directoryで検証し、raw observationから同じtable／CSVを再生成できる。
7. 保証しない事項が仕様、SECURITY、report、実装結果で一致する。

ここまでで「研究を正しく実施できる実装」が完了する。論文に使えるE2証拠が完成したことは意味しない。

reviewed confirmatory比較を開始するには、さらに外部Gateが必要である。

1. claim-to-evidence matrix、RQ、仮説、analysis plan、precision／power analysisを確定する。
2. 実装担当から独立したdataset authorが、sampling frameとprovenanceを伴うcandidateを提供する。
3. authorと別のdomain reviewerがOracle、normal pair、representativeness、fairnessを承認する。
4. primary metric、閾値、除外条件、trial数、seed、sensitivity analysisを結果観測前にfreezeする。
5. preregistration bundleへ外部のimmutable timestampを付与する。外部登録はrepository ownerが実行または明示承認する。
6. repository ownerがreviewed studyの実行を明示承認する。

E2証拠が論文claimに十分と判定するには、さらに次が必要である。

1. confirmatory runがfreeze済みrevision上で完了し、全attritionとnegative resultを含む。
2. raw-to-paper再生成とclean-directory artifact smokeが成功する。
3. 実装担当以外が少なくともartifact quick pathを再現し、差異を記録する。
4. construct、internal、external、conclusion validityのthreat matrixを結果に合わせて更新する。
5. 対象venue決定後、その時点のartifact、ethics、reporting checklistとの差分を解消する。

この外部Gateが揃うまでは、実装が完了しても研究上の比較結果は`not-run`と記録する。E2が完成しても、E3のlive model生成品質、E4の人間監査性、実運用安全性は未実証のままである。次の研究計画は、review済みoffline studyの結果と論文のclaim範囲を見てから、live model生成研究、人間参加監査、SAAA受け入れPoCのどれを優先するか決める。
