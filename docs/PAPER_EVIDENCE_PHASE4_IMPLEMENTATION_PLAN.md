# 論文根拠充足・第四弾 実装計画

作成：2026-09-28。状態：実装済み。全体check・coverageは既存統合試験の失敗により未通過（[実装結果](./PAPER_EVIDENCE_RESULTS.md)参照）。想定実装者：GPT-6 Sol（`gpt-6-sol`）、low effort。

レビュー反映：2026-09-28。状態遷移、入力診断の互換性、snapshotとrunの照合、承認・fixtureの検査条件を現行コードに合わせて明確化した。実装コードは変更していない。

関連：[第三弾](./PAPER_EVIDENCE_PHASE3_IMPLEMENTATION_PLAN.md)、[実装結果](./PAPER_EVIDENCE_RESULTS.md)、[根拠一覧](./PAPER_EVIDENCE_PLAN.md)、[草稿](./PAPER_DRAFT.md)、[再現手順](../research/paper-v1/README.md)。第四弾で変更する仕様は本書を優先し、過去の計画・結果は履歴として残す。

## 1．今回の一回分

**studyの実行入力をrun内の一つのsnapshotへ保存し、新規runの実行・再開・reportが、その保存入力を正本として使うようにする。** 対応項目はE08・E10・E11。固定入力から結果を追えるようにする基盤整備であり、新しい実モデル実験ではない。

第三弾の結果文書ではcase別証跡、非実行照合、対象テスト41 pass、全体875 passが報告されている。今回の計画作成では該当コードとの対応を確認したが、この数値の再実行はしていない。実装開始時に対象テストのbaselineを取る。

現状は`runStudy`、`continueStudy`、`resumeStudy`、`buildPaperReport`がstudyや関連ファイルを複数回読み、development CLIもsource・metadata・fixtureをpathから読む。開始時のhash検査と実際に使う入力が同じ読込みに基づいておらず、元studyを移動するとreportも作れない。今回はこの参照関係を解消する。

### 範囲外

- 同時resumeの排他、stale lock回復、複数processによる同一run更新。
- 悪意あるhost、snapshotとrun両方の書換え、OSレベルの全TOCTOU対策。
- compiler、Wasm ABI、Binaryen、意味保存の形式証明。
- datasetの追加、独立reviewの代行、モデル・予算・反復条件の確定、live実行。
- 旧runへのsnapshot後付け、過去記録の移行、新CLI、外部公開。
- 依存追加、development全体の再設計。

`evidenceEligible: false`と`study-evidence-verifier-pending`を維持する。snapshotは保存入力と結果の対応を強めるが、独立reviewや実モデル評価の代替にはならない。

## 2．変更対象と実装順序

| 箇所 | 変更 |
| --- | --- |
| 新規 `src/paper-study-inputs.ts` とtest | 入力bundleの読込み、共通validation、snapshotのstrict parser・保存・照合 |
| `src/paper-study-validation.ts` | StudyRun v1/v2のdiscriminated unionと厳密parse。TrialとStudyは変更しない |
| `src/paper-study.ts` | 新規runをv2化し、snapshotから実行・再開。validate/reviewにも同じ入力読込みを使う |
| `src/capability-development-cli.ts`、新規 `src/capability-development-cli.test.ts` | 検査したobjectを直接渡せる実行helperを抽出。既存CLI引数・挙動を維持 |
| `src/paper-report.ts` とtest | v2はsnapshotからstudy・Oracle・承認の保存内容を取得。v1は既存経路 |
| `src/paper-study.test.ts`、`src/paper-cli.test.ts` | 中断・入力変更・移動・互換性の回帰試験 |
| 結果文書・再現README・草稿 | 保存形式と保証範囲、残条件を更新 |

順番は、入力bundleとvalidation→snapshot schemaとI/O→object実行helper→新規run→resume/report→CLI一巡→品質Gate。各段階で対象testを通す。

依存方向はstudy/report → study-inputs → study-validationと既存parser。study-inputsからstudy/reportをimportしない。既存`validateStudy(path)`は公開signatureと戻り値を維持し、bundleを受ける共通validationへのwrapperにする。review資料も同じbundleとvalidationから構築し、hash計算後に元ファイルを読み直さない。

読込み結果と実行可能bundleは区別する。読込み結果はtaskごとの成功値または読込み・parse失敗を保持し、validateでは従来どおり課題別diagnosticsを収集する。task入力が欠損しても即座に全体throwへ変更しない。study自体の読込み・parse失敗は従来どおりthrowする。実行可能bundleへの変換はdiagnosticsが空で必要入力が揃った場合だけ許可し、欠損値を空object等で補わない。reviewも再読込みせず、従来なら失敗する入力欠損では失敗を返す。validateのdiagnostics時の終了値1、構造的失敗の終了値2を維持する。

## 3．snapshotの形式

### 3.1．固定pathとhash

新規runは`<run-dir>/inputs.json`を一度だけ作る。snapshotを構成する各入力はJSONとして読んだ内容であり、元ファイルの空白・改行等のbyte列の保存ではない。元pathを再配置するためにstudy.tasksを書き換えない。studyHashと承認対象hashを維持する。

| field | 仕様 |
| --- | --- |
| `version` | `1` |
| `format` | `llang-paper-study-inputs` |
| `study` | `parseStudy`で検査した元study全体。taskのpath文字列を保持 |
| `studyHash` | `contentHash(study)` |
| `tasks` | study.tasksと同じ順序で、下記task recordを各1件 |
| `approval` | liveでは検査した承認JSON全体、fixtureではnull |
| `approvalHash` | approvalのcontentHash、fixtureではnull |
| `checksum` | checksum自身を除いたsnapshot全体のcontentHash |

各task recordのfieldは`taskId, source, metadata, oracle, fixture`の5つに固定する。sourceとmetadataとoracleは既存parserで検査したobject、fixtureはtask.fixtureがあれば読み込んだJSON全体、なければnull。liveでもstudyがfixtureを参照している場合は保存する。現在のvalidation/frozenHashesがfixtureもhash集合に含めるためであり、liveでfixtureをモデルへ渡す意味ではない。

fieldの追加・欠落、taskの重複・欠落・未知ID・順序変更、fixture参照の有無とnullの不一致、studyHash・approvalHash・checksum不一致を拒否する。source/metadata/Oracleのtask identity、profile、Oracle caseと入力契約の対応は既存validationを再利用する。未知field等の検査を弱めない。fixture実行時は全taskにfixtureが必要で、欠けていれば送信前に拒否する。

snapshotから従来と同じ`${taskId}:source|metadata|oracle|fixture`のhash集合を導出する。trialとfrozenHashesへの照合にはこの集合を使う。保存objectのhash定義は既存validationと同一にし、parserが返す値と保存値の違いでhashが変わる設計にしない。source/metadataは既存parserの戻り値を保存し、保存後の再parseでもcontentHashが変わらないことを確認する。Oracle/studyは既存parserが検査した全体、fixture/承認は保存JSON全体をhashする。新たな正規化やfield削除は追加しない。

snapshotの管理fieldには日時、絶対path、認証情報を追加しない。元studyや承認等の保存内容に含まれるpath・記述は削除せず保持するため、snapshot全体に絶対pathが存在しないとは保証しない。source/metadata/Oracle等の内容を保存するため、自動公開やGit登録は行わない。

### 3.2．StudyRun version 2

旧v1の全fieldを保持し、versionを2にし、必須field `inputSnapshotHash` を追加する。このhashはchecksumを含むinputs.jsonのJSON全体のcontentHash。snapshot pathは固定なのでfieldを追加しない。

- v1は従来のfield集合だけを受理する。v2はinputSnapshotHashが必須。
- Study version 1、Trial、OracleEvidence version 1、study report summary version 2は維持する。
- 新規runはfixture/liveともv2。旧v1は読み取り・resume互換を維持し、自動でv2へ変換しない。
- v2のstudyPathは元studyの来歴情報。v2のreport/resumeでは実行入力の読込みに使わない。
- fixture v2のapprovalPath/approvalHashはnull。live v2は元承認pathとhashを保持し、snapshot内承認とも一致させる。
- v2でsnapshotが欠損・不正なら終了値2。元studyやv1経路へfallbackしない。

snapshot検証は二段階にする。本体検査は固定schema・checksum・入力validationを行い、run照合はinputSnapshotHash、studyHash、modeに応じた承認の有無、approvalHash、予定trialと各入力hashを検査する。初回保存読戻しでは構築値と本体を照合し、run構築後からは両段階を行う。reportだけはmatchTrialsのallowMissing=trueを維持し、欠落trialをmissing行にする。resumeとrunnerは全予定trialを要求する。snapshotのtask欠落はreportでも許容しない。

承認は非配列objectで、studyHashが一致し、scopeがlive、reviewer/recordが非空stringであることを検査する。追加fieldは従来互換のため保持し、hash対象に含める。fixture runはsnapshotのapproval/approvalHashもnull、live runは双方が非nullでrunと一致しなければ拒否する。report/resumeは不正なv2承認を単なる適格性理由へ格下げせず終了値2にする。v1の既存診断は維持する。

型はversionで分岐し、`version: 1 | 2`とoptional fieldだけで不正な組合せを許す形にはしない。

## 4．入力の取得と保存

1. 元studyを一度読み、parseする。この同じobjectからtask一覧を決める。
2. 各taskのsource/metadata/Oracle/参照fixtureを読込み、bundleを作る。同じ解決済みpathは同じ読込み結果を再利用する。元study内の`../../examples/...`は現行入力なので拒否しない。
3. 同じbundleでvalidation、hash集合、readyForLiveを計算する。validation後にstudyや入力を再読込みしてsnapshotを構成しない。
4. liveは元承認を一度読み、既存のreadyForLive条件とstudyHash/scope/reviewer/record検査を適用する。fixtureでapprovalPathを指定した場合はCLIと同様にrunStudy直接呼出しでも拒否する。
5. fixture実行では全fixtureを`fixtureDevelopmentAgent`へ渡して形式検査する（agentを呼び出さず破棄する）。liveでは参照fixtureはJSONとして保存・hash照合するだけとし、fixture agentを作らない。この実行前検査をvalidate-studyの既存判定へ追加しない。新規出力directoryを確保し、snapshotを一時ファイルにmode 0600で書込み・sync・close後、非置換公開する。第三弾のpublish方式を小さく再利用するか同等に実装する。上書きrenameへのfallbackは禁止。EEXISTやhard-link非対応は終了値2。失敗時は自分のtempだけを削除し、公開済みinputs.jsonは削除しない。公開後cleanup失敗でもrun作成・実行へ進まない。
6. 固定pathを安全に読み戻し、schema/checksumと構築したsnapshot全体のhashを照合する。その値をinputSnapshotHashにして最初のrun.jsonを保存する。
7. 初期run保存成功後にのみtrialを開始する。保存失敗ならモデル・development・Oracle実行0で終了値2。残ったsnapshotや部分runを自動削除・修復・再利用しない。

run内のsnapshotは既存`resolveContainedFile`のsymlink拒否付きで読む。固定pathでも検査を省略しない。元入力の読み方は現行互換を保ち、snapshotに保存されたtaskの元pathをrun内pathとして解決し直さない。

複数ファイルを同時刻に取得した保証はしない。frozenHashesがある場合は取得したbundleがその全hashと一致する必要がある。draftでは「読み込んで保存した入力の組」を固定する。書込み権限を持つ別processへの完全な保護は今回の主張外。

## 5．実行するobjectを固定する

### 5.1．developmentへの入口

snapshotを検査した後にpath指定CLIでsource等を再読込みすると隙間が残るため、v2 runnerは検査したobjectを直接渡す。

`capability-development-cli.ts`にobject実行helperを抽出する。引数はsource、metadata、outputと、fixture/liveを区別する設定とする。fixture設定は保存fixture object、live設定は検査済みDevelopmentConfig。設定はmodeで分岐する型とし、fixtureとlive configの同時指定を許さない。helperでもlive configを既存parserで検査し、TypeScriptの型だけで受理しない。agent作成とdevelopCapability呼出しは既存コードを共有し、providerの初期化を二重実装しない。Oracle、study全体、承認、snapshot全体をhelperへ渡さない。

既存`runDevelopmentCli(args)`は従来どおり引数をparseしてファイルを読み、同じhelperへ委譲する。fixture/liveの混在拒否、認証の扱い、config、戻り値とexitCodeを維持する。既存development CLIのreplay/mutation-checkは変更しない。

fixtureは現行と同じfixtureConfigを使い、liveでは現行studyから構成している設定を使う。study.maxCallsの予約とfixtureの実際のconfigの既存関係を、この回で変更しない。

### 5.2．trialの順序

- 新規実行・resumeともv2ではsnapshotとrunの対応を検査し、予定trialと入力hashをmatchTrialsへ渡す。liveのrunner/resumeはsnapshotから再計算したreadyForLiveも要求し、入力固定を理由に既存の実行条件を省略しない。
- 各pending trialの開始直前にsnapshotを読み直し、inputSnapshotHash・studyHash・approvalHashと全task対応を再検査する。その読込みから得た対象source/metadata/fixture/Oracleを一組として保持する。
- 予算判定とdispatch前checkpointは既存仕様を維持する。trial開始直前の入力検査に失敗した場合は、当該trial.statusとrun.statusをuncertainにし、trial.reasonを固定文字列`input snapshot verification failed before dispatch`としてcheckpointを試み、終了値2。送信していないことが分かっていても自動復旧は今回追加しない。この状態なら既存matchTrialsのuncertain条件を満たす。development path、usage、Oracle合否を捏造しない。
- object helperへ対象source/metadataと第5.1節の実行設定・outputだけを渡す。採点時は同じtrial開始時に保持したOracleを使い、元Oracleを再読込みしない。
- 呼出し先へ渡すsource/metadata/fixture/configはstructuredCloneで切り離し、保持している検証用objectへのmutationを防ぐ。fixture agentは反復ごとに新規生成し、前trialの応答消費状態を共有しない。
- development・candidateとtrial hashの第三弾までの照合は維持する。保存された失敗・unresolved等も既存のrecord照合を弱めない。
- OracleEvidenceに新fieldは不要。既存studyHash/sourceHash/metadataHash/oracleHashをsnapshotへ照合することで対応させる。

実行途中にdisk snapshotが変更されても、現在のtrialは保持objectで実行する。次trial開始とreport/resumeで変更を拒否する。全run入力を攻撃者に対してimmutableにする保証はしない。

checkpointの失敗では終了値2で停止する。rename後の例外もあり得るので、以前の状態が必ず残ると仮定しない。第三弾の再送防止を維持し、自動rollbackや成功化を追加しない。

## 6．resume・report・旧run

| 経路 | 仕様 |
| --- | --- |
| v2 report | snapshotだけからstudyとOracle等を取得。元study・source・metadata・Oracle・fixture・承認のpathを開かない |
| v2 resume fixture | snapshotで検査・続行。元入力一式が移動・削除されても実行できる |
| v2 resume live | snapshotを実行入力とするが、既存の元承認pathの現時点での照合も維持する |
| v1 report/resume | 現行の元path参照・入力変更拒否を維持。snapshot自動作成なし |
| v2 snapshot欠損・不正 | report/resumeとも終了値2。結果を作れた扱いにしない |

liveの元承認をresume時に照合するのは現行の再開条件を弱めないためである。snapshot内承認は当時の保存内容、元承認pathは再開時の条件として区別する。reportは保存内容の照合であり、現在の実行承認を保証しない。live resumeで元承認が欠損・変更なら送信0で拒否する。

resume開始時のrun構造・snapshot検査に失敗した場合はファイルを書き換えず終了値2とする。第5.2節のuncertain保存は、検査済みrunを実行中に各trial（最初のtrialを含む）の開始前検査が失敗した場合に限る。

uncertain停止はrun構造parseの直後、snapshotやdevelopmentの照合より前に行い、第三弾の自動再送・再採点・昇格禁止を維持する。v2でも既存の完了trialの証跡を照合してからpendingだけ進める。run.status completeでpendingがない場合は再実行0。

reportはv2でsnapshotの保存承認を既存の承認検査と照合し、保存snapshot由来のvalidation結果を使う。第三弾のcase別照合、missing trial、生成件数、実行例外、旧自己申告の意味は変えない。summaryのversion変更・新しい集計列は今回は不要。READMEとMarkdown説明へ「v2は保存snapshotを照合、v1は元入力参照」と追記する。

run directory一式を別pathへコピーしたv2 reportが作れることを確認する。live再開やdevelopment内部に記録された全pathまで可搬であるとは主張しない。

## 7．必須test

各行は期待挙動であり、1行につき必ず1つのtest関数にする必要はない。network/model呼出しはtest doubleで計数する。

| ID | ケース | 期待結果 |
| --- | --- | --- |
| P4-01 | draft 4課題fixtureの新規run | run v2、inputs.json保存、生成pass 3・unresolved 1、Oracle照合済みpass 3 |
| P4-02 | 同じ入力からsnapshotを2回構築 | JSON内容・checksum・全体hash一致。path移動でstudy内容を変えなければ同じhash |
| P4-03 | 未知field・欠落・不正version・不正digest | strict parserが拒否 |
| P4-04 | taskの欠落・重複・追加・並べ替え、fixture null不一致 | checksumを再計算してもschema/対応検査で拒否 |
| P4-05 | source/metadata/Oracle/fixtureの改変 | checksum不一致、またはrunのinputSnapshotHash不一致で拒否 |
| P4-06 | frozenHashesと取得bundle不一致 | 初回development開始前に拒否 |
| P4-07 | snapshot保存・公開・読戻し・初期run保存失敗 | development/モデル/Oracle実行0、既存path上書き0 |
| P4-08 | 検証直後に元入力を変更するtest hook | object helperは検証済み入力を使う。元pathの再読込みなし |
| P4-09 | trial間にsnapshot変更 | 次trialは送信0、trial/run uncertainと固定reason、終了値2 |
| P4-10 | 元studyと関連入力を削除してv2 report | 表を生成でき、Oracle検証済み件数が同じ |
| P4-11 | v2 run directory一式を移動してreport | 元pathを読まず同じ判定。Wasm compile/instantiate/model呼出し0 |
| P4-12 | 元入力なしでfixture v2のpendingをresume | 完了trialは再実行0、pendingだけ保存入力で実行 |
| P4-13 | v2 snapshot欠損・symlink・不正JSON | report/resume終了値2、元入力へのfallbackなし |
| P4-14 | v1旧runのreport/resume | 従来挙動、v1不変、snapshot後付けなし |
| P4-15 | v2の必須fieldなし／v1へv2 field追加 | parse拒否。未知versionも拒否 |
| P4-16 | fixtureを2反復 | 各trialのfixture agentを新規生成し、応答消費を共有しない |
| P4-17 | development入力を観測するdouble | source/metadataと実行設定だけ。Oracle・承認・snapshot全体が渡らない |
| P4-18 | live条件・承認の欠損／不一致 | networkなしで拒否。readyForLive判定を弱めない |
| P4-19 | live承認を開始後に変更・削除 | reportは保存内容で作成可能、live resumeは送信0で拒否 |
| P4-20 | uncertain run、Oracle実行例外、既存sidecar | 第三弾の停止・非置換・再送禁止が維持される |
| P4-21 | object helperと既存development CLI | 同じfixture入力でsource/metadata hash・status・candidate結果が一致 |
| P4-22 | 実行helperが引数objectを変更するdouble | 保持Oracleと照合用入力に影響しない |
| P4-23 | validate/reviewの読込み中に元studyを書換え | 一つのbundle由来の内容・hashで出力し、別読込みの値が混在しない |
| P4-24 | 新fixture report・旧run report | evidenceEligible false、pending理由維持。旧自己申告を検証済みに昇格しない |
| P4-25 | task入力欠損・parse失敗のvalidate-study | 課題別diagnosticsを保存し終了値1。study自体の不正は2 |
| P4-26 | 送信前入力検査失敗の保存runを再parse/match | uncertain状態として整合し、resumeは自動再送しない |
| P4-27 | snapshotのstudyHash・承認とrunの対応不一致 | 本体checksumが正しくてもrun照合で拒否 |
| P4-28 | report対象v2のtrialを1件欠落 | snapshot正常ならmissing行。runner/resumeでは拒否 |
| P4-29 | fixture形式不正／fixtureへの承認指定 | 新規runはdevelopment開始前に拒否。validate既存挙動を維持 |
| P4-30 | snapshot公開済みでtemp cleanup失敗 | 完成snapshotを消さず停止。run作成・development実行0 |

partial runはfixtureとtest用checkpoint hookで作る。保存済みの研究原本を書き換えて試験しない。live成功経路はprovider doubleを用い、実モデルの呼出しはしない。公開helperの依存注入は必要な狭い境界だけにする。

## 8．実行と完了条件

開始時のbaseline：

```sh
bun test src/paper-study-validation.test.ts src/paper-study.test.ts src/paper-oracle-evidence.test.ts src/paper-report.test.ts src/paper-cli.test.ts
```

変更後は上記に`src/paper-study-inputs.test.ts`、`src/capability-development-cli.test.ts`、既存CLI経路を使う`src/codex-development-agent.test.ts`を加える。CLIは未使用の出力先で実行する。

```sh
bun run src/paper-cli.ts validate-study --study research/paper-v1/study-draft.json --out-dir artifacts/paper-v4/validation-new
bun run src/paper-cli.ts review-study --study research/paper-v1/study-draft.json --out-dir artifacts/paper-v4/review-new
bun run src/paper-cli.ts run-study --study research/paper-v1/study-draft.json --mode fixture --out-dir artifacts/paper-v4/fixture-new
bun run src/paper-cli.ts report --run-dir artifacts/paper-v4/fixture-new --out-dir artifacts/paper-v4/report-new
```

期待結果はvalidation診断0、readyForLive false、4 trial、生成pass 3・unresolved 1、照合済みOracle pass 3、Oracle not-run 1。run v2とsnapshot hash対応、summary v2、recordIntegrity verified、evidenceEligible falseを確認する。snapshot作成でreview/approval状態を変更しない。

旧run `artifacts/paper-v3/fixture-new`がある場合は入力専用で使い、`artifacts/paper-v4/report-old`へreportを出す。なければtest用v1 runで互換確認する。元入力削除・移動・改変試験はtest用コピーで行う。

品質Gateは重い処理を並行せず順に実行する。

```sh
bun run check
bun run coverage
bun run ci:docs
bun run ci:protected
bun run ci:smoke
git diff --check
```

失敗時はまず対象testで再現・修正し、その変更に対応するGateを再実行する。無関係な不安定失敗はログと切分け結果を残し、未通過Gateを成功と記載しない。既存の未追跡成果を削除したり、期待hashを実装に合わせて更新したりしない。

完了条件：

- [ ] P4-01〜30に対応する検証とfixture CLI一巡が完了した。
- [ ] 検査したobjectを実行し、v2で元source/metadata/Oracle等へ戻っていない。
- [ ] v2 snapshot欠損で旧経路へfallbackしない。
- [ ] v1互換、第三弾のcase照合・中断・再送防止を維持した。
- [ ] 保存snapshotからreportを再生成できるが、真正性や全競合排除を主張していない。
- [ ] 結果文書へ対象HEADと未commit差分、baseline、検証結果、保存先、残条件を追記した。
- [ ] 新規live API呼出し0。研究review・承認・既存live記録を変更していない。

次回は同時resume排他を別の一回分として扱う。その後も独立review、モデル・反復・予算の確定、live実施、配布と第三者再現が残る。研究実行の条件は[研究評価の実行条件](../RESEARCH_EVALUATION_PREREQUISITES.md)を参照する。

## 9．実装者へ渡す依頼文

```text
docs/PAPER_EVIDENCE_PHASE4_IMPLEMENTATION_PLAN.md の第四弾だけを実装してください。
GPT-6 Sol / low effort向けに、第2節の順序で進めてください。
対象は実行入力snapshot、新規StudyRun v2、検証済みobjectからの実行、snapshotによるresume/reportです。
旧v1を移行せず維持し、v2のsnapshot欠損では元入力へfallbackしないでください。
第三弾のcase証跡・中断時の再送防止を維持してください。
P4-01〜30、fixture CLI一巡、品質Gateを実施してください。
evidenceEligible=falseとstudy-evidence-verifier-pendingを維持してください。
新規live呼出し、研究review・承認の確定、compiler変更は行わないでください。
結果をdocs/PAPER_EVIDENCE_RESULTS.mdへ追記し、同時resume排他には進まず終了してください。
```
