# 論文根拠充足・第六弾 実装計画

作成：2026-09-28。状態：実装済み（結果は[実装結果](./PAPER_EVIDENCE_RESULTS.md)を参照）。想定実装者：GPT-6 Sol（`gpt-6-sol`）、low effort。

関連：[第五弾](./PAPER_EVIDENCE_PHASE5_IMPLEMENTATION_PLAN.md)、[実装結果](./PAPER_EVIDENCE_RESULTS.md)、[根拠一覧](./PAPER_EVIDENCE_PLAN.md)、[再現手順](../research/paper-v1/README.md)。この回で追加する仕様は本書を正とする。

## 1．今回の一回分

**完了したStudyRun v2を、ファイル一覧・byte数・SHA-256付きのローカルbundleへ保全し、移動後もAPIとWasm実行なしで保存記録の対応を検証する。** 対応項目はE01・E10・E11。

第四弾のsnapshot、第五弾の協調lock、第三弾のcase別証跡を使う。現在の`paper-evidence.ts`は単一developmentの過去access記録を扱う形式であり、study runをそのまま同じinventoryへ入れない。新しいstudy専用moduleを一つ追加する。

第五弾の結果文書は実装時にcheck/coverage各899 pass、レビュー後にcoverage 901 passを報告している。第六弾の開始時には対象6ファイル59 passを確認した。過去の未通過履歴を削除せず、開始時のbaselineと区別する。

### 今回含めないもの

- 公開、外部送信、Git登録、archive圧縮、redaction、ライセンス判断。
- 第三者が実際に再現したとの認定、保存応答replay、Wasm再build・再実行。
- 新しいlive評価、dataset追加、独立review・承認の代行。
- uncertain/部分runの回復、lock強制解除、v1からv2への移行。
- research eligibilityをtrueにする総合verifier、署名や外部timestamp。
- compiler・ABI・既存inventory形式・StudyRun・snapshot・OracleEvidence・summaryの変更。

ローカルbundleは研究データのコピーであり、そのまま公開可能とは扱わない。`evidenceEligible: false`と`study-evidence-verifier-pending`を維持する。実装後の残作業は独立reviewと評価条件の確定・live実測、公開条件確認、第三者再現である。基盤追加だけを研究成果の充足としない。

## 2．変更対象と順序

| 箇所 | 変更 |
| --- | --- |
| 新規 `src/paper-study-bundle.ts` とtest | manifest parser、bundle作成、byte一覧照合、既存reportによる対応検査 |
| `src/paper-cli.ts` とtest | 下記2コマンドを追加。既存commandの挙動は維持 |
| `src/paper-study-lock.ts` | 既存helperを利用。原則変更しない |
| `src/paper-report.ts` | buildPaperReportをそのまま再利用。集計ルールを二重実装しない |
| 結果文書・再現README・草稿 | ローカル保全と移動後照合の範囲、手順、残条件を記載 |

新CLI：

```text
bundle-study --run-dir <existing-run> --out-dir <new-bundle>
verify-study-bundle --bundle-dir <bundle>
```

成功は終了値0、不正・欠損・競合・保存失敗は2。runPaperCliは構造エラー等で従来どおりrejectし、entry pointが終了値2へ変換する。verifyはstdoutへ結果JSONを返し、bundle内にファイルを作らない。API呼出し・モデル初期化・WebAssembly.compile/instantiate/evaluateはいずれも0。

順序：baseline→manifestとpath検査→read-only verifier→lock内コピー→CLI→移動・改変試験→fixture一巡→全体Gate。既存source lockや過去access inventoryの一般化には広げない。

## 3．bundle形式と検査条件

```text
<bundle>/
  bundle.json
  evidence/
    run.json
    inputs.json
    <trial-id>/...
```

`bundle.json`の固定field：

| field | 仕様 |
| --- | --- |
| version | 1 |
| format | llang-paper-study-bundle |
| studyHash | 保存runのstudyHash |
| runHash | evidence/run.jsonをJSON parseした全体のcontentHash |
| inputSnapshotHash | 保存runのinputSnapshotHash |
| mode | fixture または live。保存runと一致 |
| files | evidenceをrootとする全regular fileのpath・bytes・sha256 |
| checksum | checksum自身を除いたmanifest全体のcontentHash |

filesの各要素は`path, bytes, sha256`の3 fieldのみ。pathはPOSIX相対path、bytesは非負のsafe integer、sha256は64文字の小文字hex。pathは重複なし・文字列の昇順（localeに依存しない比較）で保存・検査する。絶対path、drive prefix、backslash、空segment、`.`、`..`、NULを拒否する。全階層でsymlinkとspecial fileを拒否する。固定pathのrun.json/inputs.jsonにも同じ検査を適用する。

schemaの未知field・欠落・型・enum・checksumを厳密に検査する。byte hashは実際のファイルbytesのSHA-256であり、JSONのcontentHashと混同しない。JSONを再整形してコピーしない。manifest自体はfilesへ含めず、checksumとファイルhashの循環を作らない。

bundle rootはbundle.jsonとevidence directoryのみを許可する。検証時はevidence内の実ファイル集合とfilesを完全一致させ、追加・削除も拒否する。空directoryは研究証拠として数えず、比較対象はregular fileの集合。ただし空directory内を含むsymlink/special fileは拒否する。

管理用の時刻・元絶対pathはmanifestへ追加しない。evidence内の既存JSONに含まれる元path・生応答はそのまま保存する。機密除去済みとは表示しない。

### bundle化できるrun

作成と検証の両方で同じ条件を適用する。

1. StudyRun version 2、status complete。v1は明確なunsupportedエラーで拒否する。
2. snapshot本体とrunの対応を既存関数で検査し、matchTrialsは全予定trialを要求する。
3. buildPaperReportのrecordIntegrityがverified、oracleUnverifiedが0。
4. trial.status passの全行にoracleEvidencePath/Hashがあり、Oracleは照合済みpassまたはfail。sidecarなしの自己申告を受理しない。
5. pending/uncertain/missingがない。生成fail・unresolved・error・stoppedやOracle failは保存可能とし、失敗結果を除外しない。既存reportが必要とするdevelopment等が欠けていれば拒否する。

この「完了」は生成と証跡処理の完了であり、全課題成功を意味しない。reportのevidenceEligibleはfalseのまま。suiteや全応答の意味まで検証したとは主張しない。

## 4．作成手順

1. 出力先の親をrealpathで解決できる既存directoryとし、出力先は未作成に限定する。元runと同一またはその子directoryへの出力を拒否する。symlink aliasを解決して判定し、文字列prefixだけで判定しない。親不存在時は診断して終了する。
2. 第五弾のwithStudyRunLockで元runを取得する。取得前にrun内容を読まない。競合・残留lockなら既存のエラーで停止し、コピーを始めない。
3. lock内で第3節の受理条件を検査する。元runの全階層を列挙し、**自分が取得したrootの`.paper-study.lock`だけ**を除外する。それ以外のregular fileは失敗attemptや生記録を含め全件保存する。path安全性・symlink・special fileを検査する。再帰コピーだけに任せない。
4. 元ファイルの一覧とhashを採取し、新規outDirを非再帰mkdir、evidence directoryを作る。directoryはmode 0700、ファイルは0600で作り、既存pathを上書きしない。
5. 各ファイルをbytesとして読み、採取したhashと照合して`wx`で保存する。保存bytesのhashも確認する。元JSONのpathやchecksumを書き換えない。
6. 元runを再列挙・hash照合し、取得時の全ファイル集合と同じことを確認する。協調しない変更が観測されたら終了値2。lockは協調writer向けで、悪意あるhostの全競合を防ぐとは主張しない。
7. コピー先のrun/snapshot/reportを検査する。元pathは読まない。コピー先のhash一覧からmanifestを構築する。
8. bundle.jsonを最後に非置換公開する。一時ファイルのwrite/sync/close→linkで公開→自分のtempのみcleanupという既存方式に合わせ、上書きrenameへfallbackしない。再読込みしてverifierを通す。
9. lockを通常解放して結果を返す。解放失敗ならbundleが完成していてもCLI終了値2。bundleを削除したりrunを書き戻したりしない。

途中失敗で部分outDirが残る場合は保持し、自動再利用・追記・成功化しない。manifestが存在するだけでは成功と判断せず、必ずverifyを通す。完成bundleをrollback目的で削除しない。エラー処理で元runのファイルを変更しない（自分のlock取得・解放だけが例外）。

入力run内に別のreportや補助ファイルがあってもregular fileなら保全するため、サイズや生記録の公開条件は別途確認が必要。`.paper-study.lock`を含むbundleはverifyで拒否する。コピー元にrootのreproduction.jsonがある場合も、study reportとaccess reportの自動切替を避けるため今回は拒否する。

## 5．検証と移動後の確認

verifyはlockを作らずread-onlyで行う。手順はmanifest strict parse→全path安全性・実ファイル集合・bytes/hash→runHash等の照合→第3節の受理条件→同じファイル集合・hashの再確認とする。検証中の変更を観測したら拒否する。協調writerがbundle内でresumeしない、静止したコピーを前提とする。

返す固定形式は`version: 1, format: llang-paper-study-bundle-verification, bundleHash, fileCount, totalBytes, recordIntegrity: verified, evidenceEligible: false, report`とする。bundleHashはchecksum込みbundle.jsonのcontentHash、reportはbuildPaperReportの戻り値そのもの。totalBytesの加算はsafe integer範囲を検査する。失敗時は成功形式のJSONを返さずthrowする。

元study、元Oracle、元承認、元runのpathを辿らない。liveでも検証するのは保存承認であり、live再開時の元承認確認を呼ばない。既存reportのAPIを使い、resumeStudyやrunStudyを呼ばない。

移動後のbundleから通常のreportを生成する場合は、`report --run-dir <bundle>/evidence --out-dir <bundle外の新directory>`を使う。生成reportをbundle内へ追加するとroot/files集合の検査に失敗するので、READMEで出力先を明記する。

この検証が示すのはコピーのbyte保存と既存記録間の整合である。hashを全部作り直す改変の真正性、自然言語に対する正しさ、独立review、Wasmの実行再現を保証しない。

## 6．必須test

| ID | ケース | 期待結果 |
| --- | --- | --- |
| P6-01 | 新fixture v2をbundle化・verify | 4 trial、生成pass 3/unresolved 1、照合済みOracle pass 3、eligible false |
| P6-02 | 元runから失敗attemptを含むコピー | root lock以外の全regular fileをbytes不変で保存 |
| P6-03 | bundle移動、元runと元入力の削除 | verifyと外部directoryへのreport生成が成功 |
| P6-04 | JSON空白だけ変更、Wasm 1 byte変更 | byte hash不一致で拒否 |
| P6-05 | ファイルの追加・削除・重複path・順序変更 | 集合/schema検査で拒否 |
| P6-06 | 絶対path・drive・backslash・dot segment・symlink・special file | 読込み/コピー前に拒否 |
| P6-07 | manifest未知field・不正hash・checksum | strict parseで拒否 |
| P6-08 | manifestを再hashしてrun/snapshot/Oracleを不整合にする | 既存の対応検査で拒否 |
| P6-09 | v1、running、uncertain、missing trial | 完了bundleとして受理しない。原本不変 |
| P6-10 | 生成fail/unresolved/stopped、Oracle fail | 条件を満たす保存記録は負の結果として受理 |
| P6-11 | pass trialにsidecarなし・candidate欠損 | 自己申告や不足記録を完全bundleに昇格しない |
| P6-12 | コピー元lock競合・残留 | 待機/解除/コピーなし、終了値2 |
| P6-13 | コピー中に協調resume | resumeはlock競合、二重dispatchなし |
| P6-14 | 元run配下・symlink alias配下・既存outDir | 出力拒否、既存成果不変 |
| P6-15 | コピー/manifest公開/読戻し失敗 | 原本不変、部分出力保持、lockは通常解放 |
| P6-16 | 最後のlock解放失敗 | CLI終了値2、完成コピーを削除しない |
| P6-17 | 検証中またはコピー中に外部変更するhook | 二回の一覧/hash照合で観測できた変更を拒否 |
| P6-18 | live provider double由来の保存run | 元承認なしでverify可。モデル/ネットワーク/Wasm呼出し0 |
| P6-19 | lock/reproduction.json混入、bundle内report追加 | 禁止entry/集合不一致を拒否 |
| P6-20 | 同じ停止runを別出力先へ二回bundle化 | bundle manifestとbundleHash一致。運用lockのtokenを含めない |

同期は既存hookとbarrierで行い、sleep依存の競合試験にしない。改変・削除はtest用コピーに限る。試験で実際の公開先やlive APIを使わない。

## 7．実行・完了条件

baselineはpaper-study、paper-study-inputs、paper-oracle-evidence、paper-study-lock、paper-report、paper-cliの既存testで採る。変更後は新規paper-study-bundle.test.tsと影響したtestを実行する。

CLI一巡（outDirの親は事前に作成し、各出力先は未使用）：

```sh
mkdir -p artifacts/paper-v6
bun run src/paper-cli.ts run-study --study research/paper-v1/study-draft.json --mode fixture --out-dir artifacts/paper-v6/fixture-new
bun run src/paper-cli.ts bundle-study --run-dir artifacts/paper-v6/fixture-new --out-dir artifacts/paper-v6/bundle-new
bun run src/paper-cli.ts verify-study-bundle --bundle-dir artifacts/paper-v6/bundle-new
bun run src/paper-cli.ts report --run-dir artifacts/paper-v6/bundle-new/evidence --out-dir artifacts/paper-v6/report-new
```

追加予定commandは実装前には存在しない。CLI helpと対応testを更新する。文書command検証器で登録変更が必要なら新規command分だけ合わせ、検証を無効化しない。

品質Gateは順に実行する。

```sh
bun run check
bun run coverage
bun run ci:docs
bun run ci:protected
bun run ci:smoke
git diff --check
```

失敗は対象試験で切り分け、今回の回帰を修正する。既知の別領域失敗が再発した場合はログと対象単独結果を残し、全体Gate未通過として報告する。失敗履歴や期待値を書き換えて通過扱いにしない。

- [x] P6-01〜20、fixture CLI一巡、Gate結果を記録した。
- [x] 元記録を書き換えず、移動後bundleだけから照合できる。
- [x] 新規live、Wasm再実行、外部公開を行っていない。
- [x] fixtureと実モデル結果、コピー検証と第三者再現を区別した。
- [x] 結果文書へHEAD・未commit差分・検証・保存先・残条件を追記した。
- [x] READMEに公開前確認が未了であること、verify/reportの使い方を記載した。

次の研究作業は課題・Oracleの独立review、モデル・反復・予算と承認の確定である。[研究評価の実行条件](../RESEARCH_EVALUATION_PREREQUISITES.md)を参照し、この実装完了だけをlive実行承認としない。第三者再現は第三者自身の記録が得られたときに更新する。

## 8．実装者へ渡す依頼文

```text
docs/PAPER_EVIDENCE_PHASE6_IMPLEMENTATION_PLAN.md の第六弾だけを実装してください。
GPT-6 Sol / low effort向けに第2節の順序で進めてください。
対象は完了StudyRun v2のローカルbundle作成と非実行検証です。
既存のsnapshot、Oracle証跡、buildPaperReport、study lockを再利用してください。
コピー元はlock内で読み、原本のJSONやpathを書き換えないでください。
P6-01〜20、fixture CLI一巡、品質Gateを実施してください。
公開・外部送信・redaction・live呼出し・Wasm実行・v1移行は行わないでください。
evidenceEligible=falseとstudy-evidence-verifier-pendingを維持してください。
結果と残条件をdocs/PAPER_EVIDENCE_RESULTS.mdへ追記して終了してください。
```
