# Semantic TDD・Sol 6.1とLunaの比較

実行日：2026-10-01。ユーザー指定の`gpt-6.1-sol`、reasoning lowをCodex SDK経由で評価した。比較対象の`gpt-5.6-luna`も同じCLIで再測定し、[以前のLuna評価](./SEMANTIC_TDD_CODEX_LIVE_EVALUATION_RESULTS.md)は別記録として維持した。

## 接続と比較条件

SDK同梱runtimeとインストール済みCLI 0.155.1では、Sol 6.1をChatGPTログインで未対応とする400エラーを受けた。公開CLI 0.159.3をgit管理外の一時領域へ導入し、SDKの`codexPathOverride`で明示指定したところ生成に成功した。SDK依存の0.154.0、普段のCLI、ユーザーの設定や認証情報は変更していない。別モデルへの自動fallbackも実装していない。

両モデルともCLI 0.159.3、SDK 0.154.0、reasoning low、同じ凍結課題・prompt builder・出力schema・停止条件を使用。各36候補、3 Conceptを各4 batch、batchごとに3候補を逐次生成した。単発baselineは同じbatchの最初の候補。候補ごとに新しいthreadと一時directoryを用い、tool、project instruction、MCP、pluginを隔離し、API key／API base URLの環境変数をSDK子プロセスへ渡さない。model欄はSDKへ要求したモデル名であり、SDKは実snapshot名を返していない。

入力のfreeze hashと実行用source hashを照合し、一致した。既に観測済みの合成課題であり、第三者blind評価ではない。visible planがboolean全8組を含み、held-outは文字列／配列noiseを主に変える。この結果は一般的な実課題のモデル優劣を示すものではない。

## 結果

| 指標 | gpt-6.1-sol low | gpt-5.6-luna low |
| --- | --- | --- |
| 単発の成功 | 12 / 12 | 12 / 12 |
| Best-of-Nの成功 | 12 / 12 | 12 / 12 |
| 検査入力（各方式） | 192 | 192 |
| false acceptance／false rejection（両方式） | 0 / 0 | 0 / 0 |
| 採用候補のProperty Test成功 | 12 / 12 | 12 / 12 |
| 観測token（36候補） | 492,024 | 395,280 |
| 単発baselineの観測token | 166,354 | 130,994 |
| 12 batchの合計時間 | 364.36秒 | 288.09秒 |
| batch時間の中央値 | 29.73秒 | 22.88秒 |
| API参考単価による換算USD | 1.006360 | 0.083487 |

今回は品質差を観測できなかった。Solの観測tokenは約24.5%多く、合計時間は約26.5%長かった。ただし実行順はSol→Lunaで固定し、各モデル1 runのみ。時間の差には接続先の負荷・cache・実行時刻の影響があり、因果関係や普遍的な速度差は主張しない。batch時間には契約・plan処理と後処理を含み、最初のsource読み込みは含めない。SDKが加えるsystem promptの同一性も保証しない。

[公式API料金](https://developers.openai.com/api/docs/pricing)の参考単価はSolが入力2／出力10、Lunaが入力0.20／出力1.20 USD per million tokens。全inputをこの単価で換算し、cache・地域加算等は再現していない。これはChatGPTプランの請求額や消費枠ではない。換算5 USD、合計100万token、各応答8192 token、各候補120秒を停止条件とした。SDKにはserver側の出力token上限指定がなく、token上限は応答後に検査する。

品質改善やBest-of-Nの既定採用を支持する証拠としては扱わず、明示指定の機能を維持する。より難しい未観測課題での独立評価は未実施。

## 証拠と検証

`artifacts/semantic-tdd-extensions/codex-sol-6.1-low-20261001/`へ両モデルの全候補・応答・thread ID・usage・完成report、budget、CLI version、実行script、manifest、比較集計、probeと失敗logを保存した。通常の評価CLIから、両完成reportを新規モデル呼出し0で再生し、一致を確認した。接続probeは本評価とは別で、Solの成功probeは15,805 tokenを観測した。失敗probeのusageは不明として0に置き換えない。

再実行用scriptは同directoryの`run.ts`。一時CLIのpathをSDK factoryへ明示指定している。artifactはgit管理外なので、この文書を公開しただけでは実行記録は配布されない。共有・公開用の証拠配布は別工程。

コード変更は評価adapterのSol 6.1許可とlow指定の回帰testに限定した。関連testは25 pass / 0 fail、typecheck・対象format／lintは成功。全repositoryのtest・coverageは今回再実行しておらず、以前の975件の結果を今回の結果として扱わない。Paper v1のscopeと既定採用条件は変更しない。
