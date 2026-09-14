# Prompt Source継続実装・評価基盤の結果

2026-09-15。前回の[段階C・D](./PROMPT_SOURCE_RESULTS.md)に続き、成果物検証の競合修正と、要求変更・未解決課題のfixture評価runnerを実装した。

## 実装

`prompt test`はSource/Lockを一度読み取り、そのsnapshotに対応するManifestを検証する。runtimeへ検証済みManifest hashを渡し、実際の読込みまでにManifestが変わっていれば拒否する。結果にはSource revision、Lock hash、Wasm hashを返す。旧host APIの呼出し方も維持した。

`prompt:evaluate`は、入力hashで固定したdraft datasetとfixtureから、要求更新→意味解決→Wasm build→検証入力との照合を行う。model inputにはprobesやexamplesを入れない。caseごとに結果を保存し、既存runを上書きしない。モデルが未解決を返すことと、不正出力をvalidatorが拒否することを区別する。

[4課題](../benchmarks/prompt-source/README.md)のfixture runは4件成功、false resolution 0件、API call 0回。別の回帰テストでは、公開前の例を通過した誤Predicateがheld-out probesに違反し、失敗として報告されることを確認した。これらはrunnerの動作証拠であり、fixture由来のreportは常に`evidenceEligible:false`である。

## 検証記録

ログは`artifacts/prompt-evaluation/`。局所検証は`targeted.log`、CLIの例は`report.json`、caseごとのSource/Lock/成果物は`run/`に保存した。ローカルの全309テスト成功（73 files、1,547 assertions、238.94秒）。coverageはfunctions 94.15% / lines 92.28%、semantic-transactionは98.36% / 96.88%でGateを通過した。format・lint・typecheck・文書リンク・保護対象データ・frozen installも成功。依存変更はなく、npm advisory APIへの照会は0件だった。CIはpush後に確認する。

## 次へ進む際のblocker

実モデル精度と開発作業時間の比較には、独立したdatasetレビュー、provider/modelと予算・停止条件、必要なら人間参加者と計測条件が不足している。[具体的な不足条件](../benchmarks/prompt-source/BLOCKER.md)を記録した。今回の実装では実モデルの評価値を作らず、draftを独立評価済みと認定していない。

## Windows CIで判明した既存経路の問題と修正

`303267e`の[CI](https://github.com/ugnoguchigxp/L-Lang/actions/runs/34864654787)はmacOS・Ubuntuで全Gate成功。WindowsはPrompt Source・評価runnerのテストに成功したが、既存経路で失敗した。

- `URL.pathname`をOSのファイルパスとして渡していたテストを`fileURLToPath`へ変更した。Windowsのドライブ名重複とURLエンコードを正しく扱う。
- 一時領域とrepositoryが別ドライブの場合、相対化の結果が絶対パスになる。benchmarkのimport生成で、そのパスへ`./`を付けないようにした。
- パスを比較するテストとcoverage集計をWindowsの区切り文字に対応させた。
- Windowsで同時renameが一時的にEPERM等を返す場合に限り、atomicなrenameを最大8回再試行する。既存targetを削除するfallbackは行わない。
- 複数回のTypeScript scan/CLI実行を行う3テストは、実際に超過した5秒/60秒から20秒/120秒へtimeoutを変更した。assertion・coverage閾値は維持した。

該当する局所28テスト、format・lint・typecheckは成功。ログは`artifacts/windows-portability/`へ保存した。修正後の全体coverageと3 OS CIを再実行する。
