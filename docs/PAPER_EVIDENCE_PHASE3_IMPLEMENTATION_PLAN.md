# 論文根拠充足・第三弾 実装計画

作成：2026-09-27。状態：未着手。想定実装者：GPT-6 Sol（`gpt-6-sol`）、low effort。

文書レビュー反映：2026-09-27。保存前検査とcheckpoint後検査、採点途中の停止、旧runの未検証値、hashの計算対象を明確化した。ソースコードの変更はまだ行っていない。

関連：[実装結果](./PAPER_EVIDENCE_RESULTS.md)、[第二弾](./PAPER_EVIDENCE_PHASE2_IMPLEMENTATION_PLAN.md)、[根拠一覧](./PAPER_EVIDENCE_PLAN.md)、[論文草稿](./PAPER_DRAFT.md)。第三弾の範囲では本書の仕様を優先する。過去の計画・結果は当時の記録として保持する。

## 1．今回の一回分

**Oracleのcase別採点記録を保存し、対象candidate・Wasm・入力契約・Oracle・development記録との対応を検査してreportへ反映する。** 対応する根拠項目はE05・E08・E11。

第二弾までにstudy/runの検査、予定trialを正本とする分母、review資料が実装された。一方、Oracleの採点は`paper-study.ts`の`oracle.cases.every(...)`で行われ、`trial.oracleStatus`のpass/failだけが保存される。最初の失敗で評価が短絡し、どの入力がどの結果だったかを後から照合できない。

第三弾は採点記録を残す一つの変更セットとする。新しい共通module一つとtestを追加し、既存study/reportへ接続する。新CLIは追加しない。fixtureによる実装確認まで行い、新しいlive呼出しは行わない。

### 今回含めないもの

- 実行入力全体のsnapshot、実行中の全入力差し替え対策、同時resume排他。
- 過去runへ採点証跡を後付けする移行・再採点コマンド。
- 意味保存の形式証明、他profileへの拡張、Wasm compiler・ABI・Binaryen設定変更。
- Oracleの独立した人間review、dataset確定、モデル・予算・承認の確定。
- 第三者再現、署名、外部timestamp、外部公開。

`evidenceEligible: false`と`study-evidence-verifier-pending`は維持する。case別記録が揃っても、研究上の適格性全体を完成扱いにしない。

## 2．確認した現行コードと変更箇所

| 現行の箇所 | 状態 | 今回の変更 |
| --- | --- | --- |
| `paper-study.ts: continueStudy` | development pass後にOracleを読み、everyで評価 | 全caseの結果行を記録し、証跡保存後にoracleStatusを確定（実行例外後はnot-run） |
| `paper-study.ts: verifyTrialRecords` | developmentとcandidateの基本対応を確認 | 新しい証跡が存在する場合は同じ照合関数で検査 |
| `paper-study-validation.ts` | StudyRun version 1、固定field集合 | 原則変更しない。sidecar方式で旧runとの互換を保つ |
| `paper-report.ts: buildPaperReport` | candidateがあれば自己申告oracleStatusを集計 | case証跡から検証できた値と旧自己申告値を分離 |
| `paper-evaluate.ts: parsePaperOracle` | 既存Oracleの読込み | 再利用し、第二弾で実装済みの厳密なcase検査も適用 |

予定ファイル：

- 新規：`src/paper-oracle-evidence.ts`、`src/paper-oracle-evidence.test.ts`。
- 更新：`src/paper-study.ts`、`src/paper-report.ts`、対応test。
- 必要時のみ：`src/paper-study-validation.ts`の既存Oracle検査を再利用しやすい形でexport。意味・schemaを勝手に変えない。
- 文書：`docs/PAPER_EVIDENCE_RESULTS.md`、`research/paper-v1/README.md`、草稿の証跡説明。

依存方向：study/report → oracle-evidence → 既存parser・hash・capability/runtime。oracle-evidenceからstudy/reportをimportしない。型だけ必要なら`paper-study-validation.ts`からimport typeする。

## 3．保存形式を先に固定する

### 3.1．置き場所と互換性

新規runの生成経路がpassしたtrialにだけ、次のsidecarを保存する。

```text
<run-dir>/<trial-id>/oracle-evidence.json
```

StudyRun version 1やTrialにfieldを追加しない。検証器は固定相対pathからsidecarを探す。過去run、Oracle、candidateを書き換えない。新規runのrun.jsonは第4節のcheckpointとして更新する。旧runにsidecarがない場合、未検証としてreportを作れる状態を維持する。既存ファイルを見つけたときに上書き・自動再採点しない。

### 3.2．OracleEvidence version 1

新recordは固定fieldを厳密に検査する。以下のfieldを採用する。

| field | 値・意味 |
| --- | --- |
| `version` | `1` |
| `format` | `llang-paper-oracle-evidence` |
| `studyHash`、`trialId`、`taskId` | 採点対象のstudy/trial |
| `sourceHash`、`metadataHash` | developmentとtrialが保持する値 |
| `developmentHash` | `contentHash`で計算した保存development JSON全体のhash（checksumも含める） |
| `attemptIndex` | 実際に採点した最終pass attemptのindex |
| `candidatePath` | run rootからの固定相対path。`<trial-id>/attempt-<index>/candidate/capability.json` |
| `packageHash` | `readCapability`のpackageHash |
| `wasmHash` | 実行に使用したbytesのdigest。manifestの値と照合 |
| `contractHash` | 実行に使用したbuild contractの`contentHash` |
| `oracleHash` | 検査済みOracle JSON全体の`contentHash`。trialの値と一致 |
| `oracle` | 採点に使用したOracleの検査済み内容をそのまま保持 |
| `cases` | 全caseのid、inputHash、expected、actual、statusをOracle順に保存 |
| `result` | `pass | fail | error` |
| `checksum` | checksum自身を除いたrecord全体の`contentHash` |

現在のOracle入力はJSON値のみであり、undefinedを新規拡張しない。inputHashは当該case.inputのcontentHash。expectedはOracleのexpectedそのものを保持する。casesに入力本体を重複保存せず、oracle.casesとid・順序・inputHashで対応させる。

hashの計算対象を固定する。developmentHashはファイルを一度JSONとして読んだraw object（checksumを含む）へ`contentHash`を適用する。`parseDevelopmentRun`はchecksumを取り除いた戻り値を返すため、その戻り値をhashしない。rawを保持したままparserで検査する。Oracleも検査前後でfieldを削除・正規化せず、検査に通ったJSON全体を保持する。Wasm hashだけはbytesの`digest`、その他のJSON hashは既存のcanonicalな`contentHash`を使う。記録checksumとreportのoracleEvidenceHashは別であり、後者はchecksumを含むsidecar JSON全体のcontentHashとする。

attemptIndexは`development.attempts.at(-1).index`を使い、配列位置から推測しない。attemptが空、indexが不正、最後のattemptがpassでない場合は採点を開始しない。sourceとmetadataはそれぞれ`contentHash(pkg.source)`、`contentHash(pkg.manifest.metadata)`をdevelopment/trialへ照合する。

`actual`は次のいずれかとする。

- `{ kind: "value", value: boolean }`
- `{ kind: "error", code: "INVALID_INPUT" }`
- `{ kind: "execution-error", code: "EXECUTION_ERROR" }`
- `{ kind: "not-run", reason: "prior-execution-error" }`

予期しない例外を`INVALID_INPUT`へ丸めない。未知の例外は必ず`EXECUTION_ERROR`とし、任意の例外code・message・stackをこの決定的recordへ入れない。runtimeの`INVALID_INPUT`だけを通常の契約拒否として扱う。

case.statusは、期待との型付き一致ならpass、通常の値／INVALID_INPUTが期待と違うならfail、execution-errorならerror、not-runならnot-runとする。通常のfailでは評価を続けるが、execution-errorでは後続を実行せずnot-run行として残す。全Oracle caseに一行を割り当て、未実行を欠落させない。not-runは最初のexecution-errorより後でのみ許可し、それ以降に実行結果を置くことを禁止する。resultはerrorがあればerror、そうでなくfailがあればfail、全件passならpassとする。JSON objectのkey順による比較はしない。

日時・経過時間・絶対pathはこのrecordに含めない。同じ採点入力と結果から同じrecordを構成できるようにする。

## 4．採点と保存の手順

### 4.1．再読込の食い違いを避ける

1. 生成と既存suite検証がpassした後、保存されたdevelopmentを`parseDevelopmentRun`で読む。渡された戻り値だけを信用しない。
2. developmentの入力hashをtrialと照合し、complete/passと最終pass attemptを検査する。CLI戻り値との対応も確認する。dispatch前checkpointのtrial.statusはuncertainのため、この時点でそのstatusやusageと完成developmentとの一致を要求しない。
   保存検査に成功したdevelopmentのstatus、development path、calls、tokens、reasonをtrialへ設定し、oracleStatusはnot-run、run.statusはuncertainとして**採点前checkpoint**を保存する。この保存に失敗したらOracleやWasmを実行しない。uncertainは今回、生成結果不明だけでなく採点の確定前にも用いる。
3. `readCapability`でcandidateを検査し、candidate sourceのcontentHashとtrial.sourceHash、packageHashとattempt.packageHashを照合する。task IDが同じだけでは受理しない。
4. Oracleを一度読込み、厳密検査する。contentHashがtrial.oracleHashと一致しなければ採点を始めない。
5. `readCapability`が返した同じbytesとbuild manifestを`instantiateWasmPredicate`へ渡す。manifest pathからもう一度読む`loadWasmPredicate`をこの採点経路では使わない。
6. 検査済みの同じOracle objectで順に評価する。通常の不一致では続行し、予期しない実行例外では残りをnot-runとして記録する。
7. recordのchecksumを計算し、trial directory内の新規sidecarへ保存する。
8. sidecarを読み戻し、**証跡本体・対象照合**を行う。この時点ではtrial.oracleStatusはnot-runのため、まだcheckpointとの一致を要求しない。pass/failの場合だけtrial.oracleStatusを設定し、run.statusをrunningへ戻してcheckpointを保存する。保存成功後に**確定checkpoint照合**を行う。errorの場合はoracleStatus not-run・run uncertainを維持して停止する。

保存は同じtrial directory内の一時ファイルへ完全に書き込んだ後、完成ファイルとして公開する。既存sidecarがあれば拒否する。既存atomic helperが上書きを許す場合、そのまま置換用途で使わない。同時実行全体の排他は範囲外だが、一部だけ書かれたJSONを完成証跡として扱わない。sidecarとrun.jsonの二ファイル更新が一つのtransactionになるとは主張しない。

既定の実装は、一意な一時ファイルを`open(..., "wx")`で作成→書込み・sync・close→`link(temp, final)`で非置換公開→自分のtempのみunlinkとする。EEXISTやhard-link非対応では失敗として停止し、上書きrenameへfallbackしない。最終pathが公開された後にcleanupが失敗した場合も最終pathを削除せず、未確定状態として扱う。process中断時に部分JSONを完成記録として見せないことが対象であり、停電時の永続性までは保証しない。

これは採点対象bytesと記録の一致を狭い範囲で強める作業である。生成段階を含む全入力の競合や悪意あるhostによる改変まで防ぐとは主張しない。

### 4.2．状態遷移と失敗

既存の`trial.status`はdevelopmentの結果を表すため、Oracle不一致を理由に`pass`から`fail`へ変更しない。

| 状況 | trial.oracleStatus | runと証跡の扱い |
| --- | --- | --- |
| 全case一致 | pass | sidecar保存・検証後にcheckpointし次trialへ |
| 正常に採点でき、期待不一致 | fail | sidecarに全caseを保存して次trialへ |
| 予期しない実行例外 | not-run | error sidecarを保存。run.statusをuncertainにして停止 |
| Oracle／candidateのidentity不一致 | not-run | 採点しない。runをuncertainとして停止 |
| sidecar書込み・読戻しの失敗 | not-run | 合格にしない。runをuncertainとして停止 |
| sidecar保存後、run更新前の中断 | 前のcheckpointのまま | 自動で再送・再採点・成功への昇格をしない |
| developmentがfail/unresolved/error/stopped | not-run | sidecarを作らず既存挙動を維持 |

development pass後の採点失敗は`trial.reason`へ上書きしない。reasonはdevelopment.stopReasonとの照合に使われるためである。エラー理由はtrial内の`oracle-error.json`へ記録し、run.statusはuncertainにする。診断recordには後述の固定fieldだけを保存し、秘密を含み得る例外内容を無条件で保存しない。診断書込みにも失敗した場合はstderrに失敗段階を出して終了値2とする。

このため、`continueStudy`のdevelopment段階と採点段階のcatchを分ける。採点失敗時はtrial.statusをpassのまま保持し、uncertainへ上書きしない。保存developmentとの対応を維持し、run.statusだけをuncertainとする。

resumeはrun.status uncertainならモデル呼出し・Oracle実行より前に停止する。sidecarだけが残る中断状態はそのまま残す。新しい回復CLIは今回追加しない。

resumeのuncertain判定は`verifyTrialRecords`より前へ移す（runの構造検査は先に行う）。これにより不完全なcheckpointを修復しようとして生成へ戻ることを防ぐ。正常に確定したpass/fail sidecarは再開時も検査するが、再採点しない。

`oracle-error.json`の形式はversion 1、format `llang-paper-oracle-diagnostic`、studyHash、trialId、stage、codeに固定する。stageは`prepare | instantiate | evaluate | publish | readback | checkpoint`、codeは`ORACLE_PREPARATION_FAILED | ORACLE_INSTANTIATION_FAILED | ORACLE_EXECUTION_FAILED | ORACLE_PUBLISH_FAILED | ORACLE_READBACK_FAILED | ORACLE_CHECKPOINT_FAILED`とする。診断は研究結果の正本ではなく、上書きせず保存し、reportの合否計算には使わない。runtime作成前の失敗ではcase結果を捏造せず、診断だけを保存する。

checkpoint書込みが失敗した場合は終了値2で停止し、エラー処理からrunをcompleteにしない。既存atomic helperはrename後のdirectory syncでも例外を返し得るため、「失敗なら以前のuncertainが必ず残る」と仮定しない。ディスク上のrecordを読み直す場合も観測に留め、ロールバックや自動成功化はしない。次のresumeは保存済みrecordとsidecarを照合し、uncertainなら停止、完全に整合したrunningなら確定済みtrialを再送せずpendingだけへ進む。sidecarや診断を消して成功を作らない。

## 5．非実行の検証関数

`paper-oracle-evidence.ts`に、採点と保存から分離した検証関数を作る。reportとresumeは同じ関数を使う。検証関数はモデル・Wasmを実行しない。

検査項目：

1. 固定field、version、enum、型、digest、id、相対path、checksum。
2. study/trial/source/metadata/oracle hashの一致。
3. development JSON全体のhash、最終attempt index、attempt.packageHash。
4. `readCapability`が検査したcandidateとpackageHash、wasmHash、contractHashの一致。
5. 同梱Oracleのhashと現在確認しているOracleのhashが一致すること。
6. case数・id・順序・inputHash・expectedの一致。caseの欠落、追加、重複、順序変更を拒否。
7. 各caseのexpected/actualからstatusを再計算し、全caseからresultを再計算する。
8. **確定checkpoint照合の段階だけで**、記録resultがpass/failならtrial.oracleStatusとの一致を要求する。result errorではtrial.oracleStatusがnot-run、runがuncertainであること。

関数を二層に分ける。証跡本体・対象照合はschema/checksum/candidate/Oracleとcase集計を検査し、結果を返す。確定checkpoint照合はその結果をrun/trialと比較する。reportとresumeは両方を行い、runnerの保存直後は前者だけを行う。単一関数の「検査を省略するboolean」で両者を曖昧に切り替えない。

非実行とはWebAssembly.compile／instantiate／evaluateを呼ばないことを含む。`readCapability`は保存ファイルの検査に利用できるが、reportの検証経路からruntime作成関数を呼ばない。

既存のpath解決関数を使用し、run root外参照やsymlinkの差し替えを受理しない。固定candidatePathでも同じ検査を通す。

hashやcase計算の照合は保存記録の整合検査であり、記録者が本当にその時刻に実行したことの外部証明ではない。checksumとactualを一緒に再作成する攻撃への真正性保証を主張しない。reportのためにWasmを再実行する機能も含めない。

## 6．reportの互換性と集計

旧runと新runを同じreportで扱えるようにする。ただし旧runの自己申告を検証済みへ読み替えない。

| 入力 | 出力 |
| --- | --- |
| sidecarなし、trial.oracleStatus pass/fail | oraclePass null、oracleUnverified true。自己申告はoracleStatusに残す |
| sidecarなし、oracleStatus not-run | oraclePass null、oracleUnverified false。旧来どおり未実行 |
| sidecarあり、pass/failと全対応が一致 | oraclePassを記録resultから設定。oracleUnverified false |
| sidecarまたは自己申告採点があり、安全な参照先のcandidate/developmentが欠損 | oraclePass null、oracleUnverified true。記録不足を診断 |
| sidecarのschema・checksum・identity・集計結果が不一致 | 終了値2。黙って旧run扱いへfallbackしない |
| 整合したerror sidecar | oraclePass null、oracleExecutionError true、runは未完了 |
| sidecarがあるがrun checkpointと対応しない | 終了値2で中断状態を診断。runを書き換えない |

検査順序はpathの安全性→sidecarのschema/checksum→取得できるtrial/Oracle情報との対応→candidate/developmentの読込みと照合→確定checkpoint照合とする。関連ファイル欠損とsidecar自体の改変が同時にある場合、読めるsidecarの改変を先に拒否する。欠損を理由に不正sidecarの検査を省略しない。

sidecarはplanned trialごとの固定pathを調べ、developmentがないことを理由に存在確認を省略しない。pending・unresolved等にsidecarが付いている場合は状態矛盾として拒否する。sidecarが存在するtrial.status pass・oracleStatus not-runは、error sidecarかつrun uncertainの場合だけ整合した停止状態として扱う。sidecarが存在しない採点前checkpointは表のnot-runとして可視化でき、run-uncertainにより未完了となる。

行に`oracleEvidencePath: string | null`、`oracleEvidenceHash: string | null`、`oracleExecutionError: boolean`を追加する。既存`oracleStatus`はrunの記録値として維持し、`oraclePass`は第三弾以降「sidecar照合済みのpass/fail」の意味へ変更する。CSV・Markdown・READMEにこの定義変更を記載する。

oracleEvidencePathとoracleEvidenceHashは証跡本体・対象・checkpointまでの照合が成功した場合のみ値を持たせる。関連証拠不足なら両方nullとする。schema不正ならreport自体を拒否するため、未検証hashを検証済みとして出力しない。

summaryのoraclePassは照合済みtrueの件数。新たにoracleFail、oracleExecutionErrorを集計する。oracleNotRunは引き続きrunのnot-run／missing件数であり、error sidecarのある行は重なる可能性があるので、これらの列を排他的な内訳として合計しない。oracleUnverifiedは自己申告採点または存在するsidecarを関連証拠不足で照合できない件数とする。

`oracle-evidence-not-recorded`は自己申告のpass/failにsidecarがない場合だけ付与する。関連candidate等が欠損した場合は`oracle-evidence-incomplete`を追加する。error sidecarには`oracle-execution-error`を追加する。正常な新fixtureでは`oracle-evidence-not-recorded`は消えるが、`fixture-only`・`study-evidence-verifier-pending`等は残る。

`recordIntegrity`は第二弾の意味（記録間の対応）を維持する。ただし新sidecarの関連証拠が欠損していればincompleteにする。旧runにsidecarがないだけでは第二弾のrecordIntegrityを変更せず、適格性理由とoracleUnverifiedで示す。

run.status uncertainならrecordIntegrityはincompleteとし、eligibilityReasonsへ`run-uncertain`を追加する。全trialの生成statusが終端でも、採点がuncertainなら研究として完了とは表示しない。既存completedTrialsは生成工程の終端数のまま維持し、その意味をMarkdownに明記する。理由codeは第二弾と同様に重複なし・辞書順とする。

study用summaryは意味変更を明示するためversionを2にする。StudyRun、OracleEvidence、履歴access summaryのversionはそれぞれ1のまま維持する。MarkdownのOracle欄では、旧自己申告は`unverified`、整合した実行例外は`execution-error`、純粋な未実行は`not-run`と表示する。正常に表を出せたreportは終了値0、構造・対応の不正は2。run-studyは通常のOracle不一致だけなら既存どおりcompleteで0、採点uncertainなら2とする。

履歴accessの`saveAccessReport`と`evaluatePaper`は今回の変更対象外。既存1課題の成果物をこのstudy sidecar形式に移行しない。

## 7．実装順序と検証項目

### Sol・low effort用の順序

1. 既存差分とBunを確認し、第二弾結果を読む。未追跡ファイルも既存成果として保持する。
2. `continueStudy`の採点、`verifyTrialRecords`、`buildPaperReport`、`parseStudyRun`を読む。
3. `readCapability`の戻り値、`instantiateWasmPredicate`、Oracle検査、atomic writeの既存実装を確認する。
4. 新recordの型・strict parser・純粋なcase/result計算をtestとともに実装する。
5. 全case採点とsidecar保存を実装し、fixtureのstudy runnerへ接続する。
6. report/resumeへ非実行の照合を接続する。採点失敗時の状態整合を確認する。
7. 旧run・中断・改変testを通す。旧入力ファイルや期待hashを書き換えない。
8. fixture CLI一巡と品質Gateを実施し、結果・README・草稿を更新する。
9. 完了条件を照合して終了する。次のsnapshot／排他実装へ進まない。

### 必須test

| ID | ケース | 期待結果 |
| --- | --- | --- |
| P3-01 | 新しい4課題fixture run | pass 3 trialにsidecar、unresolvedにはなし |
| P3-02 | 最初のOracle caseを不一致にする | 後続も全件採点。result fail、生成statusはpass |
| P3-03 | 不正入力 | actual INVALID_INPUTと期待を型付き比較 |
| P3-04 | runtimeが未知例外を投げるtest double | execution-errorとして記録、run uncertain、successにしない |
| P3-05 | case欠落／追加／重複／反転／expected改変 | checksumを再計算してもOracleとの不一致を拒否 |
| P3-06 | actualとcase.statusまたは全体resultが不整合 | 再計算で拒否 |
| P3-07 | 別trial・study・Oracleのsidecarを流用 | identity不一致で拒否 |
| P3-08 | 同じtask IDだが別candidate | packageHash・sourceHash・Wasm等で拒否 |
| P3-09 | development・attempt・契約・Wasmを変更 | 対応不一致で拒否 |
| P3-10 | sidecar欠損の旧run | report生成可、自己申告は未検証、旧run不変 |
| P3-11 | candidate/development欠損とsidecar改変 | 欠損は不足診断、改変は終了値2 |
| P3-12 | sidecar保存失敗 | oracleStatus not-run、run uncertain、API再送なし |
| P3-13 | sidecar保存後・checkpoint前の中断 | resumeで再送・再採点・自動昇格しない |
| P3-14 | root外／symlink参照 | 読込み・実行前に拒否 |
| P3-15 | report生成 | Wasm実行・モデル接続0。保存証跡照合のみ |
| P3-16 | 同じ採点入力からrecord構築を2回 | 決定的なrecordとchecksum一致 |
| P3-17 | 新旧run双方の表 | 新runは照合済み3 pass、旧runは自己申告3件を未検証扱い |
| P3-18 | fixtureの表・全不一致の表 | evidenceEligible falseを維持。負の結果を保存 |
| P3-19 | error sidecarと正常development | trial.reason等を壊さず診断できる |
| P3-20 | sidecar checksumだけ改変、未知field、actual型不正 | strict parserで拒否 |
| P3-21 | pass/fail sidecar保存直後のtrial.oracleStatusがnot-run | 本体照合は成功、確定前reportは拒否、checkpoint後は整合 |
| P3-22 | 採点前checkpoint保存失敗／保存直後の中断 | 前者はWasm実行0、後者はuncertainから再送・採点なし |
| P3-23 | 途中caseでexecution-error | 残caseはnot-run、全case行数維持、後続runtime呼出し0 |
| P3-24 | sidecar公開先が既存／公開後cleanup失敗 | 既存不変、完成ファイルを削除せずuncertain停止 |
| P3-25 | raw developmentとparser戻り値のhashが異なる | raw全体のhashを採用し、保存・読戻しで一致 |
| P3-26 | candidate欠損とsidecar改変の複合 | 欠損へfallbackせず改変を拒否 |
| P3-27 | 生成statusは全終端だが採点uncertain | recordIntegrity incomplete、run-uncertain理由、report version 2 |
| P3-28 | runtime instantiate失敗 | case actualを捏造せず診断のみ、Oracle passにしない |
| P3-29 | checkpointのrename前／rename後に書込み例外 | 古い／新しいどちらの保存状態も破壊せず終了値2。resumeは実際の保存状態を検査 |
| P3-30 | 採点開始時のdispatch前trial.status uncertain | 完成developmentを検査して採点前checkpointを作れる。未更新statusを理由に正常処理を拒否しない |

失敗注入はtest doubleとtest用一時directoryで行う。実モデルや任意の悪性Wasmを呼び出さない。書込み失敗や中断の試験を容易にするための依存注入は、保存関数やruntime呼出しの狭い境界に限定する。

## 8．実行コマンドと期待結果

開始時の既存test：

```sh
bun test src/paper-study-validation.test.ts src/paper-study.test.ts src/paper-report.test.ts src/paper-cli.test.ts
```

実装後は`src/paper-oracle-evidence.test.ts`を追加して実行する。CLIは未作成の出力先を使う。

```sh
bun run src/paper-cli.ts run-study --study research/paper-v1/study-draft.json --mode fixture --out-dir artifacts/paper-v3/fixture-new
bun run src/paper-cli.ts report --run-dir artifacts/paper-v3/fixture-new --out-dir artifacts/paper-v3/report-new
```

期待結果：予定4 trial、生成pass 3、unresolved 1、照合済みOracle pass 3、not-run 1、passした各trialのOracle全caseが記録される。新fixtureにoracle-evidence-not-recordedがなく、evidenceEligibleはfalseのまま。case数は既存Oracleから導出し、推測で固定しない。

旧runの互換確認は`artifacts/paper-v2/fixture-new`があれば入力専用で使い、新しいreport先へ出力する。存在しない環境ではtest用の旧形式runを使う。旧runを新しい形式に書き換えない。

品質Gate：

```sh
bun run check
bun run coverage
bun run ci:docs
bun run ci:protected
bun run ci:smoke
git diff --check
```

## 9．完了条件と残す限界

- [ ] P3-01〜30が対応するtestで確認できる。
- [ ] 全case結果と対象Wasm・契約・Oracle・developmentが結び付いている。
- [ ] reportは実行せず、case/result再計算と対応照合を行う。
- [ ] 採点不一致、実行例外、記録欠損、改変を区別する。
- [ ] 中断・保存失敗で生成を再送せず、記録を成功へ昇格しない。
- [ ] 旧runの自己申告と新runの照合済み値を表で区別する。
- [ ] 既存live記録、draft課題、Oracleのreview状態を変更していない。
- [ ] 新規live API呼出し0。実装と研究証拠の完成を区別している。
- [ ] 結果文書に対象commit・差分・検証・保存先・残条件を追記した。

次に残るものは、study実行入力snapshotとtrialごとの固定入力照合、同時resume排他、実在するreview記録と実行条件の確定である。今後のlive実施は[研究評価の実行条件](../RESEARCH_EVALUATION_PREREQUISITES.md)に従う。

## 10．実装者へ渡す依頼文

```text
docs/PAPER_EVIDENCE_PHASE3_IMPLEMENTATION_PLAN.md の第三弾だけを実装してください。
GPT-6 Sol / low effort向けの第7節の順序で進めてください。
対象はOracle case別sidecarの保存、candidate等への結合、非実行の照合、report反映です。
StudyRun version 1と旧runを保持し、新CLIや旧記録の自動移行を追加しないでください。
P3-01〜30、fixture CLI一巡、品質Gateを実行してください。
evidenceEligible=falseとstudy-evidence-verifier-pendingは維持してください。
新規live呼出し、reviewや承認の確定、compiler変更は行わないでください。
結果をdocs/PAPER_EVIDENCE_RESULTS.mdへ追記し、snapshot・同時resume排他には進まず終了してください。
```
