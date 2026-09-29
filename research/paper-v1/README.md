# paper-v1のローカル再現

必要条件はBun 1.4.2と`bun.lock`に固定した依存である。依存導入にはネットワークが必要になる場合がある。以下の再生・build自体は生成APIへ接続しない。

原本の`artifacts/codex-terra/access-live`がある場合、リポジトリルートで未使用の出力先を選び、次を実行する。

```sh
bun install --frozen-lockfile
bun run src/paper-cli.ts inventory --input artifacts/codex-terra/access-live --out-dir artifacts/paper-v1/local-inventory
bun run src/paper-cli.ts reproduce --inventory artifacts/paper-v1/local-inventory/inventory.json --out-dir artifacts/paper-v1/local-reproduction
bun run src/paper-cli.ts evaluate --inventory artifacts/paper-v1/local-inventory/inventory.json --oracle research/paper-v1/access-oracle.json --out-dir artifacts/paper-v1/local-evaluation
bun run src/paper-cli.ts validate-study --study research/paper-v1/study-draft.json --out-dir artifacts/paper-v1/local-study-validation
bun run src/paper-cli.ts run-study --study research/paper-v1/study-draft.json --mode fixture --out-dir artifacts/paper-v1/local-fixture
bun run src/paper-cli.ts report --run-dir artifacts/paper-v1/local-fixture --out-dir artifacts/paper-v1/local-report
bun run src/paper-cli.ts review-study --study research/paper-v1/study-draft.json --out-dir artifacts/paper-v2/local-review
```

`inventory.json`と`evidence/`は同じディレクトリ内で相対参照するため、まとまったまま移動できる。出力先の再利用は拒否する。`reproduction.json`の`status: pass`、`comparison.byteEqual: true`、`apiCalls: 0`を確認する。`evaluation.json`と`negative-results.json`を別に読む。`table.md`のfixture結果は研究の実測値ではない。

studyのreportはtask×反復回数を分母とし、欠落trialを`missing`行にする。第三弾以降、生成がpassしたtrialには`<trial-id>/oracle-evidence.json`を保存し、全caseの期待値・実測値・判定とcandidate、Wasm、契約、Oracle、developmentのhashを結び付ける。reportはWasmを再実行せずにこれらの対応とcase集計を検査する。study用summaryはversion 2で、`oraclePass`と`oracleFail`はsidecarまで照合できた件数である。旧runのsidecarがない`oracleStatus: pass/fail`は自己申告値のまま残し、`oraclePass: null`、`oracleUnverified: true`とする。`oracleEvidencePath`と`oracleEvidenceHash`は照合が完了した行だけに付く。実行例外は`oracleExecutionError`で示し、`oracleNotRun`と重なる場合がある。`completedTrials`は生成工程で終端に達した件数を指す。case別証跡の追加後も`evidenceEligible`はfalseである。[レビュー手順](./REVIEW_GUIDE.md)に確認項目を記した。

studyの`budget`は全trialで予約できるモデル呼出し数の上限で、試行前に`maxCalls`分を予約する。費用や請求tokenの厳密な上限ではない。live実行にはreview済みの入力hash、モデル・provider・tokenと時間の設定、別の承認記録が必要である。`resume-study`は送信済みか不明な`uncertain` trialを自動再送しない。

過去access 1課題の表を機械的に作る場合は、`evaluate`の`--out-dir`を再現出力の未使用サブディレクトリ`<reproduction>/evaluation`に指定し、`report --run-dir <reproduction> --out-dir <new-directory>`を実行する。`reproduction.json`と`evaluation/evaluation.json`のpackage/Wasm hashが一致しなければ表生成を拒否する。

ローカルの生記録はGit管理外であり、配布条件とredactionの必要性は未確認である。原本がないcheckoutでは[`paper-test-fixture.ts`](../../src/paper-test-fixture.ts)を使うテストは実行できるが、過去liveの再現とは呼ばない。第三者による再現記録はまだない。

[再検証index](./audit-index.json)は2026-09-27のオフライン監査33ファイルの相対path・サイズ・SHA-256を列挙し、元live Wasmは[元記録index](./bundle-index.json)へ参照する。監査summaryの4 Wasmは両indexのhash・サイズと照合済みである。両方の生bundleはローカルにのみ保存している。

[著者による隔離snapshotの実行記録](./clean-reproduction.json)には、作業状態から一時Git snapshotを作り、そのクリーンcloneへ固定依存を導入し、保存証跡コピーから再生・Oracle・fixture表を実行した結果を残す。元live実行時の環境を復元した記録ではない。

## 第四弾以降のstudy run

新規study runは`run.json` version 2と`inputs.json`を同じrun directoryに保存する。後者には検査済みstudy、各taskのsource・metadata・Oracle・参照fixture、liveの場合は承認内容を保存し、runの`inputSnapshotHash`と照合する。v2のreportは保存snapshotを正本とするため、元studyや入力を移動した後でもrun directory一式から作れる。fixture v2のresumeも保存入力で続行する。live v2のresumeには元承認pathの現時点での照合も必要である。旧version 1 runのreport/resumeは従来どおり元入力pathを参照し、snapshotを後付けしない。保存snapshotはGit管理外であり、自動公開しない。

## 第五弾以降のstudy実行lock

`run-study`と`resume-study`は、同じrun directoryを更新している間、正規化したrun rootの`.paper-study.lock`を保持する。競合時は`PAPER_STUDY_LOCKED`で終了値2となり、待機や自動再送はしない。正常終了・通常の例外ではlockを解放する。processが強制終了した場合や解放に失敗した場合はlockが残り得る。残留時は自動再開できないため、実行processと保存checkpointを確認する必要がある。lockを消しても`uncertain` trialの送信有無は解決しない。reportはlockを取得しないため、実行停止後に作るのを基本手順とする。

## 第六弾：完了study runのローカルbundle

StudyRun v2が`complete`で、保存snapshotとOracle証跡の対応が検証できる場合、元runの全regular fileをbyte単位でローカルbundleへコピーできる。出力先の親directoryは事前に作成し、bundle出力先は未作成の名前を指定する。作成中は元runのlockを保持する。

```sh
mkdir -p artifacts/paper-v6
bun run src/paper-cli.ts run-study --study research/paper-v1/study-draft.json --mode fixture --out-dir artifacts/paper-v6/fixture-new
bun run src/paper-cli.ts bundle-study --run-dir artifacts/paper-v6/fixture-new --out-dir artifacts/paper-v6/bundle-new
bun run src/paper-cli.ts verify-study-bundle --bundle-dir artifacts/paper-v6/bundle-new
bun run src/paper-cli.ts report --run-dir artifacts/paper-v6/bundle-new/evidence --out-dir artifacts/paper-v6/report-new
```

`bundle.json`にはファイルごとの相対path、byte数、SHA-256を保存する。bundleを移動しても`verify-study-bundle`は保存記録のみで照合し、APIやWasmを実行しない。`report`の出力先はbundleの外に置く。bundle内へファイルを追加すると、次回の検証でファイル集合の不一致として拒否される。強制終了後の残留lock、途中失敗で残る部分出力は自動解除・再利用しない。

このbundleは機密除去や配布条件の確認をしていないローカルコピーである。元JSONの絶対pathや生応答を含み得るため、公開前の内容・権利・機密確認は未了。検証結果はbyte保存と既存記録間の対応を示すもので、第三者再現、自然言語要求への正しさ、研究適格性を保証しない。fixtureの値を実モデル結果へ昇格させない。

## 第七弾：課題・Oracleのレビュー記録

`review-study`は既存の資料に加え、全判断と担当者を未記入にした`review-record.template.json`を作る。実際の担当者が確認後に別名の記録へ記入し、`verify-study-review --study <study.json> --record <review-record.json>`で対象hashと形式を照合する。未記入templateの検査は`pending`・終了値1が正常な結果である。差戻しも終了値1、形式不正または入力変更は終了値2となる。記入手順は[レビュー手順](./REVIEW_GUIDE.md)を参照する。

現時点のtemplateには担当者、日時、独立性、判断を記入していない。検査器は本人確認や判断の正しさを証明せず、runnerのlive条件も変更しない。独立レビュー、評価条件、承認、新規live実測は人による次の作業として残る。
