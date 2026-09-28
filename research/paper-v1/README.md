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
