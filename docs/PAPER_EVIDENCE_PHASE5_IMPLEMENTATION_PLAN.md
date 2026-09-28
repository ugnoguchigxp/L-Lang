# 論文根拠充足・第五弾 実装計画

作成：2026-09-28。状態：未着手。想定実装者：GPT-6 Sol（`gpt-6-sol`）、low effort。

関連：[第四弾](./PAPER_EVIDENCE_PHASE4_IMPLEMENTATION_PLAN.md)、[実装結果](./PAPER_EVIDENCE_RESULTS.md)、[再現手順](../research/paper-v1/README.md)、[根拠一覧](./PAPER_EVIDENCE_PLAN.md)。第五弾の変更仕様は本書を優先し、過去の計画・結果は履歴として保持する。

## 1．今回の一回分

**同じrun directoryを更新するrun-studyとresume-studyを、processをまたぐ協調lockで直列化する。競合した呼出しは待機・再送せず終了する。** 対応する根拠項目はE08・E11。

第四弾により新規runはStudyRun v2となり、inputs.jsonの保存入力から実行・照合する。ただし`resumeStudy`はrun.jsonを読んだ後にそのまま処理を進めるため、二つのprocessが同じpending trialを読んで実行する余地がある。今回はrun全体を排他区間にする。

確認したコードは`src/paper-study.ts`のrunStudy/resumeStudy/continueStudy、既存`src/source-write-lock.ts`。既存source lockはsourceファイル用で、解放時の所有者照合がないためそのまま転用しない。変更せず、研究runner専用の小さなhelperを追加する。

第四弾の結果文書は対象テスト58 passを報告しているが、全体checkとcoverageは未通過である。この計画作成では再実行していない。第5弾開始時にbaselineを採り、未通過を引き継ぐ。排他実装の成功だけで研究基盤全体の検証完了とはしない。

### 今回含めないもの

- stale lockの自動削除、PID生存判定による奪取、TTL・heartbeat・待機retry。
- unlock/recovery CLI、uncertainの自動復旧、生成の再送。
- 分散lock、ネットワークfilesystem上の保証、悪意ある別processの削除・差し替えへの完全防御。
- 読取り専用reportのtransaction化、実行中runの一貫したreport snapshot。
- compiler・ABI・生成設定・課題・review・承認・live実験の変更。
- 第四弾と無関係なeffects/semantic系の修正、依存追加、全体リファクタリング。

StudyRun v1/v2、InputSnapshot v1、OracleEvidence v1、summary v2のschemaを変更しない。`evidenceEligible: false`と`study-evidence-verifier-pending`を維持する。

## 2．変更箇所と実装順序

| 箇所 | 内容 |
| --- | --- |
| 新規 `src/paper-study-lock.ts` とtest | 正規化run root、非置換取得、所有者確認付き解放、安定したエラーcode |
| `src/paper-study.ts` | runStudy/resumeStudyの排他区間を作る。continueStudyは非公開のまま |
| `src/paper-study.test.ts` | 新規実行対resume、v1/v2、例外・uncertain時の解放 |
| `src/paper-cli.test.ts` | lock競合・解放失敗がCLI終了値2になること |
| 新規 `src/paper-study-concurrency.test.ts` | 独立process間の競合と強制終了試験 |
| 結果文書、再現README | lockの範囲、残留時の停止、検証結果と残条件 |

実装順序は、baseline→lock単体→runner接続→同一processの競合→独立processの競合・中断→fixture CLI→全体Gate。各段階で対象testを通す。lockからstudy/reportをimportしない。CLIだけをlockで包む実装は禁止し、直接関数呼出しにも適用する。

## 3．lockの固定仕様

固定pathは`<canonical-run-dir>/.paper-study.lock`。canonical-run-dirは既存directoryのrealpathで求め、その同じrootを取得後のrun読書きにも使う。run rootへのsymlink aliasは同じlockへ収束させる。directoryを実行中に移動する操作は対象外。

取得は`open(lockPath, "wx", 0o600)`。成功したprocessだけが所有者になる。EEXISTなら内容やPIDにかかわらず`PAPER_STUDY_LOCKED`をthrowし、待機しない。既存lockが空、不正JSON、directory、symlinkの場合も触らず停止する。EEXIST以外の取得エラーは`PAPER_STUDY_LOCK_IO`とする。

lock内容はJSONで次のfieldだけを持つ。

| field | 値 |
| --- | --- |
| version | 1 |
| format | llang-paper-study-lock |
| ownerToken | 取得ごとにcrypto.randomUUIDで作るtoken |
| pid | process.pid。診断専用 |

これは一時的な運用情報であり、研究証拠のhash・snapshot・集計には入れない。PIDやtokenをモデルへ渡さない。作成したFileHandleのstatを取り、dev/inoとtokenを解放時の識別に使う。内容を書込み・syncし、取得処理を完了してからactionを開始する。FileHandleは解放まで保持する。

書込み・sync等が失敗したらactionは呼ばない。自分が作成したentryとdev/inoが一致する場合だけunlinkを試み、handleをcloseする。内容が未完成でも自分の作成物はidentityで判定する。identityを確認できない場合は削除せず、残留lockと取得失敗を報告する。

### 解放と例外

`withStudyRunLock<T>(runDir, action: (canonicalDir: string) => Promise<T>): Promise<T>`を基本形とする。actionのPromiseが解決・rejectするまでlockを保持し、finally相当の処理で解放する。内部の呼出しは必ずawaitし、backgroundへ処理を残さない。

正常な解放ではlstatでregular fileかつ作成時dev/inoと一致することを確認し、内容のownerTokenも照合する。違うtoken、別inode、欠損、symlink、読めない内容ならunlinkしない。自分のhandleはcloseを試み、`PAPER_STUDY_LOCK_RELEASE_FAILED`を返す。一致する場合だけunlinkし、closeする。unlink/close双方の失敗を取り落とさない。

所有者照合とunlinkの間の悪意ある差し替えまでは防がない。通常の協調processは保持中lockを変更・削除しないため、この条件下で排他を保証する。

- action成功・解放成功：元の結果を返す。
- action失敗・解放成功：元のerrorを再throwする。
- action成功・解放失敗：解放失敗をthrowし、CLI終了値2。runがcompleteでも成功終了にしない。
- action失敗・解放失敗：元errorをcause等に保持した解放失敗をthrowし、両方の失敗が分かる診断を出す。元の失敗を消さない。

lock helperはrun.jsonの状態を変更しない。解放失敗を理由にcompleteをuncertainへ書き戻さない。研究結果の状態と、このCLI呼出しの終了値を分ける。例外messageへ無条件に入力全文や認証情報を含めない。

## 4．runnerへの接続

### 新規runStudy

元studyの読込み・validation等は出力directory作成前の現行順序を保つ。新規outputのmkdir成功後、**inputs.json公開と初期run.json保存より前**にlockを取得する。取得後はsnapshot保存、初期run保存、全trial、Oracle採点・証跡保存、最終checkpointまで一つのactionでawaitする。

同じoutDirへの二つのrunStudyは既存の非再帰mkdirが片方を拒否する。拒否側は既存runやlockを削除しない。mkdirから取得までの間にresumeが先にlockを取った場合、resumeはrun.json未作成で失敗し自分のlockを解放する。新規run側が競合で失敗する場合も自動retryしない。残った未完成directoryを自動再利用しない。

### resumeStudy

run directoryの存在確認・realpath解決の後、**run.jsonの最初の読込みより前**にlockを取得する。runのparse、uncertain停止、snapshot/旧入力検査、既存trial証跡、live承認の検査、continueStudy、最終checkpointまで保持する。

lock取得前にrunを読んで保持する実装にしない。既に完了したrunでも取得後に最新状態を読み、既存検査を通す。二番目の呼出しが先行処理の解放後に取得できた場合、最新状態から再判定するので完了trialを再送しない。

runStudyからcontinueStudy、resumeStudyからcontinueStudyでは追加取得しない。再入可能lockにせず、外側一回の所有を維持する。

### 停止と読取り

- uncertainを返す／検出してthrowする通常の終了経路でもfinallyで解放する。次resumeはlock取得後に既存uncertain規則で停止する。
- lock競合側はrun/inputs/development/Oracleを変更せず、モデル呼出し・Oracle実行0。runのstatusをuncertainへ変更しない。
- SIGKILL等でfinallyが動かなければlockは残る。次回はPIDや時刻で奪取せず停止する。新たなsignal handlerは追加しない。
- report/validate/reviewはlockを取得・削除しない。reportは保存記録の非実行照合を続けるが、実行中runの一貫した表示は保証しない。再現READMEでは実行停止後のreport生成を基本手順にする。
- v1もv2も同じ排他を適用する。schema移行やsnapshot後付けは行わない。

残留lockの案内は「自動再開できない。実行processと保存checkpointの確認が必要」とする。今回は削除コマンドや強制解除を提供しない。lockを消すこととuncertainの解決は別であり、送信済みか不明なtrialを再実行可能に変更しない。

## 5．必須test

| ID | ケース | 期待結果 |
| --- | --- | --- |
| P5-01 | 単独の取得・action・解放 | action中だけlockがあり、結果を保持して終了 |
| P5-02 | 同一processから二つの取得 | barrierで先行を保持し、後行はLOCKED、action 0 |
| P5-03 | 独立した二つのBun process | 同じrootで一方だけactionに入る |
| P5-04 | realpathとsymlink alias | 同じlockとして競合する |
| P5-05 | 異なる二つのrun root | 両方が取得可能。全研究を直列化しない |
| P5-06 | 既存lockが空・不正JSON・directory・symlink | 既存entry不変、action 0、自動削除なし |
| P5-07 | 取得時のwrite/sync失敗 | action 0。自分のentryだけcleanupし、失敗を報告 |
| P5-08 | actionがthrow | lock解放後、元errorを保持 |
| P5-09 | 解放前にtoken/inodeが変化 | 他者のentryを削除せず解放失敗 |
| P5-10 | unlink/close失敗、actionとの複合失敗 | 終了値2、元errorを失わず診断。runは書き戻さない |
| P5-11 | 新規runのsnapshot公開中にresume | lock競合側はrun読込み・モデル・Oracle実行0 |
| P5-12 | pendingを持つrunに二つのresume | 実行は一方だけ。候補・sidecar・usageが二重生成されない |
| P5-13 | 先行resume完了後に後行を開始 | 最新runを読み、完了trialを再実行しない |
| P5-14 | uncertain runのresume、採点失敗でuncertain return | 通常終了時lock解放。再開しても自動再送なし |
| P5-15 | v1/v2・fixture/live double | 全経路がlock内で動作。実network接続0 |
| P5-16 | lock保持processを強制終了 | lock残留、別processは停止。PIDが消えていても奪取なし |
| P5-17 | 同じ出力先へのrunStudy二つ | 片方は既存mkdir規則で拒否、先行記録不変 |
| P5-18 | lock存在中のreport | lockに触れず非実行照合。研究適格性を昇格しない |
| P5-19 | 初期snapshot/run保存失敗 | lockは通常解放、部分成果は既存方針どおり保持 |
| P5-20 | CLIの競合・解放失敗 | exitCode 2。研究run.statusとCLI終了値を混同しない |

並行試験は時間待ちで順序を推測せず、子processのready通知とrelease指示（pipe/IPC等）で同期する。timeoutはhang検出だけに使い、全子processをfinallyで停止・回収する。P5-03はhelper単体、P5-12は独立した二つのprocessでrunner接続まで検査し、Promise.allだけでprocess間排他を確認したことにしない。

P5-12のpartial runはtest用fixtureと既存hookで作る。原本runの状態を改変しない。liveはprovider/実行境界のdoubleだけで検証する。必要なhookは狭い境界に限定し、製品CLIにlock回避optionを追加しない。

## 6．検証コマンドとGate

開始時baseline：

```sh
bun test src/paper-study.test.ts src/paper-study-inputs.test.ts src/paper-oracle-evidence.test.ts src/paper-report.test.ts src/paper-cli.test.ts
```

実装後は新規`src/paper-study-lock.test.ts`と`src/paper-study-concurrency.test.ts`を加える。fixture CLIは未使用directoryで行う。

```sh
bun run src/paper-cli.ts run-study --study research/paper-v1/study-draft.json --mode fixture --out-dir artifacts/paper-v5/fixture-new
bun run src/paper-cli.ts resume-study --run-dir artifacts/paper-v5/fixture-new
bun run src/paper-cli.ts report --run-dir artifacts/paper-v5/fixture-new --out-dir artifacts/paper-v5/report-new
```

期待結果：全コマンド終了値0。生成pass 3・unresolved 1、照合済みOracle pass 3・not-run 1。完了runのresumeによるdevelopment/Oracle再実行0、正常終了後のlockなし。StudyRun v2、summary v2、evidenceEligible falseを維持する。

次を逐次実行する。

```sh
bun run check
bun run coverage
bun run ci:docs
bun run ci:protected
bun run ci:smoke
git diff --check
```

第四弾の全体Gate未通過を消さない。開始時または最初の全体Gateでeffects再開・semantic closure・semantic verifyの既知失敗が残るか確認し、実際の失敗test名とログを残す。失敗したものは必要に応じ一度単独実行して切り分ける。今回の回帰なら修正し再検証する。変更前からの別領域の失敗ならこの回で無関係な実装修正へ広げず、対象検証結果と未通過Gateを別々に報告する。再実行で通るまで繰り返して失敗履歴を隠さない。

## 7．完了条件と次の作業

- [ ] P5-01〜20を対応するtestで確認した。
- [ ] run読込み・snapshot保存から最終checkpointまで、対象writerが同じlockに従う。
- [ ] 独立process間の競合で二重dispatchを防ぎ、uncertain再送禁止を維持した。
- [ ] 正常終了・例外・解放失敗・強制終了を区別できる。
- [ ] 旧run/schema、研究入力、承認、既存live記録を変更していない。
- [ ] 結果文書へHEAD、未commit差分、baseline、試験結果、fixture出力先、未通過Gateを記録した。
- [ ] 新規live API呼出し0、研究適格性は未確定のまま。

全体Gateが未通過なら「第五弾の対象検証完了、全体Gate未通過」と分けて報告する。論文提出に必要な検証がすべて完了したとは記載しない。

次に残るのは全体Gate失敗の解消、独立review、モデル・反復・予算・承認の確定とlive実測、第三者再現・配布である。実施条件は[研究評価の実行条件](../RESEARCH_EVALUATION_PREREQUISITES.md)を参照する。追加の基盤拡張へ自動で進まない。

## 8．実装者へ渡す依頼文

```text
docs/PAPER_EVIDENCE_PHASE5_IMPLEMENTATION_PLAN.md の第五弾だけを実装してください。
GPT-6 Sol / low effort向けに第2節の順で進めてください。
対象は同じstudy runへのrun-study/resume-studyのprocess間排他です。
run読込みやsnapshot公開より前に取得し、全処理のawait完了まで保持してください。
競合時は待機・再送・stale奪取をせず停止し、uncertainの既存規則を維持してください。
P5-01〜20、fixture CLI一巡、品質Gateを実施してください。
第四弾の全体Gate未通過を引き継ぎ、今回の回帰と別領域の失敗を分けて記録してください。
新規live呼出し、研究review・承認の確定、compiler変更、unlock CLIは追加しないでください。
evidenceEligible=falseとstudy-evidence-verifier-pendingを維持してください。
結果をdocs/PAPER_EVIDENCE_RESULTS.mdへ追記して終了してください。
```
