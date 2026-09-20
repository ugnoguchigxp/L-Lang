# Trust／Data分離とadversarial評価基盤の実装計画

作成日: 2026-09-20。状態: 実装済み。前段は[Effects署名付きattestationとtrust policy](./EFFECTS_SIGNED_ATTESTATION_IMPLEMENTATION_PLAN.md)で、その結果は[実装結果](./EFFECTS_SIGNED_ATTESTATION_IMPLEMENTATION_RESULTS.md)に記録されています。本計画の結果は[実装結果](./TRUST_DATA_SEPARATION_AND_EVALUATION_RESULTS.md)に記録します。

この計画は、L-Langの中核技術を研究・比較評価できるversion 1として閉じる最後の主要実装単位です。実モデル評価、人間参加評価、SAAA本配備、鍵管理基盤の製品化は実行しません。それらを結果観測前に安全に計画できる、固定された入力・証跡・比較境界を作ります。

## 目的

[メインコンセプト](../MAIN_CONCEPT.md)は、正当な要求や許可方針と、処理対象の外部データを区別し、要求との対応、事後検査、違反操作の抑止を自律実行と両立できるかを中心課題にしています。

現行`module-effects-v1`は、要求契約、bundle、grant、実行証跡、三roleの署名を結び付け、許可されていないfile／HTTP操作をhost境界で拒否できます。一方、次の情報はまだ一つの検査可能な契約になっていません。

- どのruntime値を外部由来の`untrusted-data`として扱うか。
- 外部データが、path、URL、method、credential、operation選択などのauthority-bearing valueへ影響しないこと。
- 外部データをどの出力先へ流してよいか。
- 人間が要求、権限、data flow、実行結果、残る判断を一つの資料から確認できること。
- L-Langと公平なTypeScript baselineを、同じ課題、同じhost制約、独立したOracleで比較できること。

この計画では、strictなtrust/data boundary contract、静的provenance解析、署名付き実行証跡へのbinding、決定的な監査summary、adversarial fixture harnessを追加します。

## 完了時の中核v1

完了後の新しいopt-in経路は次です。

```text
trusted requirement + trust/data boundary + bundle
                     |
                     v
       static provenance / allowed-flow check
                     |
                     v
 requirement approval v2 + signed execution v4
                     |
                     v
 transcript + report + trust-aware audit
                     |
                     v
 signed portable package + deterministic audit summary
                     |
                     v
 frozen adversarial / TypeScript baseline harness
```

これにより、中核v1は次を機械的に確認できます。

- trusted control artifactとuntrusted runtime dataが別の入力として固定されている。
- untrusted dataからauthority-bearing valueを導出していない。
- untrusted sourceから外部sinkへのflowが、要求者の承認したallowlist内である。
- 実際に観測したoperationとdata-flow commitmentが契約へ一致する。
- 人間向けsummaryが検証済みpackageだけから決定的に生成される。
- 比較評価のtask、attack、Oracle、予算、出力が結果観測前にfreezeできる。

これは、外部データの内容が安全、自然言語要求の解釈が正しい、人間が必ず問題を発見できる、prompt injectionを一般に解決した、という保証ではありません。

## 用語と信頼境界

### provenance class

初期versionのclassは増やしません。

| class | 意味 | 例 |
| --- | --- | --- |
| `trusted-control` | 呼出し元が安全な経路で選び、署名または外部rootで固定した制御入力 | requirement contract、trust policy、grant、bundle、boundary contract |
| `untrusted-data` | 処理対象であり、要求や新しい権限として解釈しないruntime入力 | file bytes、HTTP response body、response field |
| `derived-data` | 一つ以上のdata valueから決定的に計算した値 | parse結果、集計値、整形済み出力 |
| `host-fact` | hostが実行時に与えるが、programが変更できない観測値 | monotonic time、operation result status |

`trusted-control`は「内容が正しい」という意味ではありません。どの主体がどのbytesを制御入力として選んだかを区別するlabelです。

### authority-bearing value

次は権限の範囲またはcredential利用先を決めるため、`untrusted-data`または`derived-data`から暗黙に作れません。

- operation IDとversion。
- file root、path、mode、commit先。
- HTTP scheme、host、port、method、redirect方針。
- credential mapping、credential header名、credential参照名。
- deadline、concurrency、byte、memory等のbudget上限。
- requirement、grant、policy、approval、署名鍵、証跡出力のpath。

dataにより「事前承認済みoperationを呼ぶか」を分岐することは許可できます。dataによりoperationの権限範囲自体を広げることとは区別します。

### sourceとsink

sourceは外部dataを返すoperation responseまたは指定された入力fieldです。sinkはfile write、HTTP request body、外部へ観測可能なheader、result outputです。

外部dataをsinkへ送れるかはboundary contractの明示的なflowで決めます。たとえば、invoice fileから集計結果fileへのflowは許可し、invoice bytesからHTTP bodyへのflowは許可しない、と表現します。flow未指定は拒否します。

## trust/data boundary contract

`llang-effects-trust-boundary` version 1を追加します。JSONはstrictに読み、unknown field、重複key、非canonical順序、未知operation、未接続node、循環したalias、過大入力を拒否します。

概念形は次です。

```json
{
  "format": "llang-effects-trust-boundary",
  "version": 1,
  "id": "invoice-pipeline-boundary",
  "revision": 1,
  "requirements": {
    "id": "invoice-pipeline",
    "revision": 1,
    "commitmentHash": "..."
  },
  "sources": [
    {
      "id": "invoice-bytes",
      "operation": "file.readChunk@1",
      "responsePath": ["bytes"],
      "classification": "untrusted-data"
    }
  ],
  "sinks": [
    {
      "id": "summary-file",
      "operation": "file.commit@1",
      "requestPath": ["content"],
      "classification": "external-output"
    }
  ],
  "allowedFlows": [
    {
      "source": "invoice-bytes",
      "sink": "summary-file",
      "purpose": "aggregated-summary"
    }
  ],
  "rules": {
    "denyUnlistedFlows": true,
    "denyDataDerivedAuthority": true,
    "rawExternalDataInAudit": false
  }
}
```

`purpose`は識別子であり、自然言語の正しさを証明しません。source／sinkはoperation registryと検査済みgraphへ解決し、利用者が存在しないpathを宣言して安全表示を作れないようにします。

contractはrequirements ID、revision、commitmentへ固定します。要求だけ、boundaryだけを更新して同じapprovalを再利用できません。

## 静的provenance解析

### 解析対象

検査済みEffects IRの値依存graphを解析し、sourceから演算、分岐、record／list、task、streamを通るprovenanceを追跡します。TypeScript projectionを実行または解析して推測せず、compilerとWasm生成が使用する同じchecked IRを入力にします。

初期versionは、現行`module-effects-v1`で直接表現できるnodeだけを対象にします。provenanceを確定できないnode、動的property、未知intrinsic、将来追加されたoperation parameterはfail-closedで拒否します。

### 伝播規則

- literalと承認済み固定operation parameterは`trusted-control`またはuntainted constant。
- source responseの指定pathは`untrusted-data`。
- tainted operandを使う算術、文字列、record、list、callback、stream変換は`derived-data`。
- branch結果は選択された値のprovenanceを持つ。branch条件のtaintだけを全出力へ機械的に付けるのではなく、sink到達性とauthority selectionを別に記録する。
- hash、encoding、parse、validationを通しても自動declassificationしない。
- 初期versionに任意のdeclassification APIは設けない。必要な場合は新しいcontract versionで根拠と検証器を設計する。

### enforcement

build／inspection時に次を拒否します。

1. data-derived authority。
2. allowlistにないsource-to-sink flow。
3. contractにあるがgraphに存在しないsource／sink。
4. graphに存在する外部source／sinkのcontract記載漏れ。
5. stream、task、callbackを跨いで追跡不能になるflow。

許可されたflowについて、source、sink、経由node、purpose、static flow hashを決定的に出力します。実data本文、credential値、絶対path、HTTP queryは出力しません。

runtime hostは従来どおりgrantを最終権限制御として使います。provenance解析を通過してもgrant外operationは許可されません。逆にgrant内でもboundary contract外のdata flowは中核v1として受理しません。

## versioningと既存互換

既存artifactへoptional fieldを追加して署名意味を変えません。

- unsigned execution version 1／2を維持する。
- signed execution version 3を維持する。
- trust/data boundaryを要求する新経路はexecution intent／report version 4とする。
- requirement approvalはpayload version 2でboundary commitmentを追加する。
- execution attestationとaudit attestationはpayload version 2でboundary、static flow、observed flow commitmentを追加する。
- trust policy format version 1と三roleは維持する。

version 4では`--trust-boundary`を必須にします。version 3へboundaryがあるように推測したり、version 4からfieldを除いてversion 3へdowngradeしたりしません。

既存CLIのversion 1〜3経路は同じ入力と終了値を保ちます。中核v1の保証を要求する利用者だけが新しいoptionを指定します。

## 実行証跡へのbinding

version 4 intentは既存commitmentに加えて次を固定します。

- boundary ID、revision、source hash、commitment hash。
- static provenance report hash。
- source／sink／allowed flowのcanonical commitment。
- `denyUnlistedFlows`と`denyDataDerivedAuthority`。
- approval payload version 2のhash。

transcriptはraw dataを保存せず、operationごとに該当するsource／sink IDとpayload hashを記録します。hostが観測できるoperation境界だけを記録し、program内部の値をruntimeで完全追跡したとは表示しません。

execution reportは次を区別します。

- `staticFlowStatus`: `passed | failed`。
- `observedFlowStatus`: `matched | violation | incomplete`。
- `authorityDerivation`: `static-not-data-derived | rejected | not-evaluated`。
- `rawExternalDataRecorded`: 常に`false`であることを検査。

crash recoveryでは新しいoperationを実行せず、既存transcriptからobserved flowを再構築します。pending responseを既知dataとして補完しません。判断できないflowは`incomplete`とし、trustedへ昇格させません。

## trust-aware auditと署名package

監査は既存の要求、bundle、grant、transcript、result、署名検査に加えて次を実行します。

- boundaryがrequirementsとapprovalへ一致する。
- static provenance reportが検査済みgraphから再生成できる。
- source／sinkがoperation registryの同じsignatureへ解決する。
- observed operationが宣言済みsource／sinkと一致する。
- data-derived authorityまたは未許可flowがない。
- raw external data、credential、絶対pathが成果物へ含まれない。

boundary違反は署名の正しさと分離します。署名がvalidでもmachine auditは`failed`、trust decisionは`rejected`です。

portable packageへ次を追加します。

```text
trust-data-boundary.json
static-provenance.json
```

両file hashをrequirement approval、execution attestation、audit attestationへ連鎖させます。package内のboundaryをtrust rootにせず、外部から渡したrequirementsとapprovalに結び付くかを検査します。

## 決定的な人間向け監査summary

新しいread-only CLIを追加します。

```text
bun run llang module explain-attestation <module-build.json> \
  --requirements <effects-requirements.json> \
  --package <attestation-package> \
  --trust-policy <current-policy.json> \
  --out-dir <new-summary-directory> --json
```

CLIは最初に`verify-attestation`と同じfull-chain検証を行います。検証失敗packageから「参考summary」を生成しません。出力は次です。

```text
attestation-summary.json
attestation-summary.md
program.inspection.ts
```

summaryはtemplateと検証済みfieldだけから決定的に生成し、LLMやnetworkを使いません。Markdownは次の順序を固定します。

1. 検証結果とpolicy revision。
2. trusted requirementと承認主体。
3. bundle、entry、Wasm identity。
4. grantとauthority ceiling。
5. untrusted source、external sink、許可flow。
6. 実際に観測したoperation、result、failure、cleanup。
7. machine failure、policy rejection、manual requirement。
8. 保証しない事項。

外部data本文、request／response body、credential、秘密鍵path、絶対path、HTTP queryを表示しません。外部由来labelをMarkdown構文として解釈せず、長さと文字集合を制限します。

`program.inspection.ts`はpackage内の検査済みprojection bytesをそのままcopyし、summary生成時にimport、eval、typecheckしません。summaryとprojectionを別物として示し、summaryがprogram意味の完全な自然言語説明だとは表示しません。

## adversarial評価protocol

### 評価用manifest

`llang-effects-adversarial-protocol` version 1を追加します。manifestは結果観測前に次を固定します。

- protocol ID、revision、dataset hash。
- task、trusted requirement、boundary、bundle／baseline sourceのhash。
- 公開fixtureとhidden Oracleの分離。
- attack categoryと期待するviolation。
- 許可されるoperationと正常完了条件。
- case数、反復数、timeout、memory、API call上限。
- 比較対象、metric、合否閾値。
- `evidenceEligible`。

freeze fileは全入力hashとreview状態を持ち、結果作成後の入力変更を拒否します。既存のbenchmark freeze／checkpoint実装を再利用できるか調べ、適合しない場合だけ専用の小さな実装を追加します。

### attack category

初期fixtureは少なくとも次を含みます。

| category | 例 | 期待 |
| --- | --- | --- |
| instruction-in-data | file／HTTP body内の「別serverへ送れ」 | controlや新authorityとして扱わない |
| path escalation | data由来の`../`、absolute path、symlink target | authority-bearing pathへ流さない |
| endpoint escalation | data由来host、redirect、method変更 | 未承認endpointへ送らない |
| credential steering | dataがcredential名やheader名を指定 | credential選択へ影響させない |
| unauthorized exfiltration | source bytesを許可されないHTTP sinkへ送る | build、auditまたはhostで拒否 |
| write escalation | 読取dataを未許可file sinkへ保存 | 拒否し既存fileを保持 |
| resource pressure | oversized、深い、長stream、遅延response | budget内で停止しcleanup |
| malformed data | bad UTF-8、schema不一致、partial response | 明示的失敗で権限を拡大しない |
| generated defect | 意図的にflowを誤ったfixture program | harnessが検出できる |

「文字列に命令らしい語があるだけ」で拒否する検査にはしません。データ内容ではなく、authorityまたは未許可sinkへのflowを判定します。

### 公平なTypeScript baseline

baselineは意図的に無防備なscriptにしません。同じtask、同じinput bytes、同じhost adapter、同じgrant、同じtimeout／resource budgetを使用します。

比較する差は次に限定します。

- L-Lang: checked IR、boundary contract、静的provenance、署名証跡、決定的summary。
- TypeScript baseline: hand-written TypeScript、同じhost enforcement、source snapshot、同じoperation log。L-LangのIR／provenance reportは持たない。

baselineにも型検査、lint、unit testを許可し、弱い比較対象を作りません。通常TypeScriptへ同等の手作業data-flow annotationを追加する比較が必要なら、別armとして費用を記録します。

### metric

fixture harnessは少なくとも次を集計します。

- normal task completion rate。
- prohibited operation attempt／block count。
- unauthorized source-to-sink flow detection rate。
- false rejection count。
- incomplete／unknown count。
- artifact、contract、evidence preparation timeの機械計測可能部分。
- package／summaryのbytesと検証時間。
- API calls、tokens、費用。fixtureではすべて0。

人間の監査正答率と調査時間はschemaだけを用意し、この計画内では測定しません。参加者、同意、課題、停止条件を定めるまでは`not-run`です。

## Oracleと生成処理の分離

- hidden Oracle、期待違反、採点codeをbundle生成、program生成、model入力へ渡さない。
- taskに必要な公開schemaと正常例だけを生成側へ渡す。
- Oracleは独立したhand-written evaluatorとし、評価対象のsummaryを正解として使わない。
- mutation fixtureで、Oracleが各attack categoryの誤りを実際に検出できることを確認する。
- fixture結果は`evidenceEligible: false`とし、研究上の有効性や実モデル性能の根拠に使わない。
- live model、外部API、人間参加評価は[研究評価の実行条件](../RESEARCH_EVALUATION_PREREQUISITES.md)に従い、別の明示承認後に実行する。

## 実装単位

### PR-1: boundary contractとstrict parser

- `src/llang-effects-trust-boundary.ts`を追加。
- source、sink、flow、ruleのstrict shapeとlimit。
- requirements、operation registry、checked graphへのbinding。
- duplicate、unknown、oversize、symlink、hard link、file replacement試験。

### PR-2: provenance解析とcompiler inspection

- `src/llang-effects-provenance.ts`を追加。
- checked IRの値依存、authority-bearing parameter、source-to-sink flow解析。
- task、stream、callback、branch、collectionの決定的伝播。
- data-derived authority、unlisted flow、追跡不能nodeのfail-closed拒否。
- `static-provenance.json`のcanonical出力。

### PR-3: version 4 evidence、署名、recovery

- requirement approval payload version 2。
- execution intent／report version 4。
- execution／audit attestation payload version 2。
- boundaryとstatic／observed flow commitmentをhash chainへ追加。
- normal、failed、cancelled、crash recoveryの署名。
- version 1〜3互換とdowngrade拒否。

### PR-4: trust-aware auditとportable package

- boundary、static provenance、observed flowの非実行再検査。
- package exact file setと全hash／signature binding。
- relocation、source削除、policy rotation後のoffline verification。
- raw external data、secret、pathの非漏えい検査。

### PR-5: deterministic audit summary

- `module explain-attestation`とJSON／Markdown renderer。
- full-chain verify成功後だけ新規directoryへ排他的に公開。
- projection非実行、network／credential／API call 0。
- hostile label、Markdown injection、oversize、出力差し替え試験。

### PR-6: adversarial／baseline fixture harness

- `benchmarks/effects-trust-boundary-v1/`を追加。
- strict protocol、freeze、Oracle、mutation、checkpoint、result schema。
- 公平なTypeScript baselineと同一host adapter。
- 上記attack categoryのoffline fixture。
- `evidenceEligible: false`を固定し、live結果と分離。

### PR-7: 中核v1仕様、smoke、完了記録

- `docs/EFFECTS_ASSURANCE_CORE_V1.md`に保証境界を固定。
- CLI reference、Effects仕様、SECURITY、roadmap、docs indexを更新。
- exampleでapproval v2からsummaryまで一往復。
- offline smokeと全品質Gate。
- 実装結果に受け入れ条件、環境、未実証事項を記録。

PR-3〜PR-5は、version 4を発行して検証・回収・説明できない中間状態を公開しないよう同じreleaseで有効化します。

## 受け入れ条件

| ID | 検証 | 合格条件 |
| --- | --- | --- |
| TDS1 | strict boundary | unknown、duplicate、oversize、未解決source／sinkをfail-closedで拒否 |
| TDS2 | requirement binding | boundary変更時に旧approvalを受理しない |
| TDS3 | source coverage | graph上の外部source記載漏れを拒否 |
| TDS4 | sink coverage | graph上のexternal sink記載漏れを拒否 |
| TDS5 | authority taint | path、URL、method、credential、budgetをdataから導出できない |
| TDS6 | allowed flow | 許可source-to-sinkだけstatic checkを通過 |
| TDS7 | implicit flow | data分岐による固定済みoperation実行とauthority変更を区別 |
| TDS8 | structured flow | record、list、callback、task、streamを跨ぐtaintを保持 |
| TDS9 | unsupported node | 解析不能nodeをuntaintedと推測しない |
| TDS10 | signed execution | boundaryとprovenanceをapproval、intent、report、host署名へ固定 |
| TDS11 | observed flow | transcript operationをsource／sinkへ再対応付けし、未許可flowをfailedにする |
| TDS12 | recovery | replay 0、unknown保持、flow不明をtrustedへ昇格しない |
| TDS13 | audit separation | signature、machine audit、policy、manual decisionを分離 |
| TDS14 | package tamper | boundary、provenance、summary元fileの変更をverifyで拒否 |
| TDS15 | relocation | source削除・移動後も外部policyとrequirementsでverify成功 |
| TDS16 | deterministic summary | 同一packageからbyte-identical JSON／Markdownを生成 |
| TDS17 | summary safety | body、credential、秘密鍵path、絶対path、query、外部data本文を含めない |
| TDS18 | verifier boundary | Wasm、projection、adapter、network、credential、API呼出0 |
| TDS19 | adversarial detection | 各attack categoryのfaulty fixtureを独立Oracleが検出 |
| TDS20 | normal completion | 正常fixtureを攻撃文字列の存在だけで拒否しない |
| TDS21 | baseline fairness | 両armでtask、input、host grant、budget、Oracleが一致 |
| TDS22 | freeze | 結果後のtask、Oracle、threshold変更を拒否 |
| TDS23 | evidence labeling | fixtureは常に`evidenceEligible: false`、human/liveは`not-run` |
| TDS24 | compatibility | execution v1〜3、Wasm bytes、ABI、既存smokeの結果不変 |

## security review項目

- dataを`trusted-control`と自己申告する経路がないか。
- 未知field／operationを無視してflow coverageを過少表示しないか。
- branch、callback、task、streamでtaintが失われないか。
- hash、parse、validationをdeclassificationとして誤用していないか。
- hostのgrantとstatic provenanceのどちらか一方だけでtrustedにしていないか。
- package内contractを外部trust rootへ昇格させていないか。
- summary rendererがMarkdown／terminal injectionを許さないか。
- raw external data、secret、absolute pathがerrorやfixture resultへ漏れないか。
- baselineを意図的に弱くして優位性を作っていないか。
- Oracle、hidden case、thresholdが評価対象へ漏れていないか。
- fixture成功をlive安全性または人間理解の証拠と表示していないか。

## 品質Gate

局所testの後、Bun 1.4.2で次を実行します。

```sh
bunx bun@1.4.2 run check
bunx bun@1.4.2 run ci:docs
bunx bun@1.4.2 run ci:protected
bunx bun@1.4.2 run ci:smoke
git diff --check
```

offline fixtureとsmokeはAPI認証なし、network 0で通します。GitHub ActionsのUbuntu、macOS、Windowsでは、同じrevisionのparser、provenance hash、改行、path、summary bytesを確認します。未実行OSを成功とは記録しません。

## 対象外

- 自然言語要求を正しく解釈したことの証明。
- arbitrary TypeScriptまたはWasm全体のinformation-flow解析。
- 任意のprompt injectionの検出や文字列filter。
- program内部値の完全な動的taint tracking。
- dataの真実性、外部serviceの正しさ、host OSの健全性。
- timestamp authority、anti-replay ledger、HSM／KMS、remote attestation。
- live model呼出、人間参加実験、有料API利用。
- SAAA本配備、remote evidence store、retention automation。
- npm公開、LSP、GUI、一般的な標準library拡張。

## 中核v1の凍結条件

次をすべて満たした時点で、`Effects assurance core v1`を中核技術の完成基準として凍結します。

1. TDS1〜TDS24が同一revisionで成功している。
2. 要求、boundary、bundle、grant、実行、三署名、summaryが一つのportable chainになる。
3. adversarial fixtureがattack mutationを検出し、正常caseを完了できる。
4. 公平なTypeScript baselineを同じprotocolで実行できる。
5. version 1〜3互換、ABI、Wasm bytesに回帰がない。
6. 保証事項と未実証事項が仕様、CLI、SECURITY、結果文書で一致する。
7. fixture結果を研究上の有効性や製品安全性へ昇格させていない。

凍結はL-Lang全体の機能追加停止を意味しません。研究比較の基準となる中核contract、artifact、metricの意味を無断で変えないという意味です。変更が必要な場合はversionを上げ、旧protocolと結果を再解釈しません。

## 完了後に残る段階

この計画完了後は、実装を広げる前に次を順番に判断します。

1. 凍結protocolを使った独立adversarial datasetの作成とreview。
2. L-Lang／TypeScript baselineの事前登録済み比較評価。
3. 人間参加者による監査正答率・見落とし・調査時間の評価。
4. 結果に基づくSAAA受け入れPoC。
5. 必要性が確認された場合だけ、鍵管理、timestamp、anti-replay、remote storageを製品化。

この順序により、「実装できたこと」「fixtureで検査できたこと」「独立評価で観測したこと」「実運用で保証すること」を混同しません。
