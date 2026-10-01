# Semantic TDD・Codex SDK Luna実評価

実行日：2026-10-01。ユーザーがCodex SDK経由のLuna利用を許可した実評価。既存のChatGPTログインを使い、直接OpenAI/Azure API keyを使う経路とは分ける。Paper v1の範囲と既定採用条件を変更しない。

## 実行条件

既存のSDK 0.154.0を使用し、[候補生成adapter](../src/semantic-tdd-codex-resolver.ts)を[評価runner](../src/semantic-tdd-extension-evaluation.ts)へ接続した。要求モデルは`gpt-5.6-luna`、reasoningはlow。SDKから実モデルsnapshotは返らないため、保存したmodel欄は要求モデルを示す。

候補ごとに新しいthreadと一時directoryを用意し、project instruction、MCP、plugin、shell、app、web操作を無効にする。予期しないtool itemは拒否する。SDK子プロセスにはAPI keyとAPI base URLの環境変数を渡さない。与える情報は対象型、仕様、凍結Test Plan、出力schemaで、hidden labelは生成へ渡さない。SDKが加えるsystem promptや内部処理の完全な同一性までは保証しない。

[凍結済みの合成課題](../benchmarks/semantic-tdd-extensions-v1/benchmark.json)を使用した。3 Conceptを各4 batch、各batchで独立した3候補を生成する。単発baselineは同じbatchの最初の候補。candidate attempt数を既存reportの`apiCalls`へ記録し、SDK内部のHTTP request数とは区別する。

この入力は既にfixture評価で観測済みであり、新規のblind／第三者独立評価ではない。visible planがbooleanの全8組を含み、held-outは主に新しい文字列と配列noiseを用いるため、未知の要求への一般化を検査する課題ではない。結果に合わせて入力、正解、採用基準を変更していない。

## 結果

| 指標 | 単発（最初の候補） | Best-of-N（3候補） |
| --- | --- | --- |
| 解決したbatch | 12 / 12 | 12 / 12 |
| held-out検査入力 | 192 | 192 |
| false acceptance／false rejection | 0 / 0 | 0 / 0 |
| 観測token | 133,762 | 396,766 |
| API参考単価による換算USD | 0.0280654 | 0.0834722 |

候補生成は36 attempt。採用候補のProperty Testは12 / 12でpassed。既知のfixture欠陥に対する検出・縮小・反例再現も12 / 12だが、これは合成制御実験であり、Lunaの生成候補に12件の欠陥があったという意味ではない。

12 batchの合計所要時間は308.10秒、中央値は25.16秒。契約・planの処理とbatch後処理を含み、最初のsource読み込みは含まない。モデルだけのlatencyではない。単発の独立した時間測定はしていない。選択結果は10 batchでcandidate-1、2 batchでcandidate-2。

今回は両方式が全件成功したため、Best-of-Nの品質優位性は観測できなかった。観測tokenは単発の約2.97倍。既定採用を支持する証拠とは扱わず、明示指定の機能を維持する。

## 使用量と失敗記録

正の申告単価は[公式API料金](https://developers.openai.com/api/docs/pricing)の参考値（入力0.20／出力1.20 USD per million tokens）を使用した。ChatGPTプランの実請求額、残枠、cached token／cache write／地域加算を再現するものではない。1 USDの換算値、合計100万token、出力8192 token、各候補120秒を停止条件とした。SDKにserver側の出力token指定がないため、出力上限は応答後に検査する。これらは実請求の絶対上限ではない。

最初の`gpt-6-luna`実行はusage不明で停止し、途中auditを保存した。診断probeでChatGPTログインに対するunsupported-model 400を確認。終了後の中断がSDK子プロセスへ伝わる問題も修正し、回帰testを追加した。`gpt-5.6-luna`の接続probeが成功してから、新しい保存先で本評価を実行した。モデル間の自動fallbackは実装していない。

本評価とは別に接続確認probeで10,939 tokenを観測した。失敗したSDK attemptのusageは不明であり、0と扱わない。これらの診断記録も削除していない。

## 証拠と検証

ローカルの`artifacts/semantic-tdd-extensions/codex-luna-20261001/`へbudget、実行manifest、全候補・応答・usage・thread ID、完成report、再生結果、summary、失敗audit、probeを保存した。artifactはgit管理対象外なので、文書だけを公開しても再現証拠は配布されない。公開用の証拠配布は別工程である。

本評価前後のadapter／runnerのsource hashは一致した。完成reportは保存した全候補をAPI呼出し0で再評価し、結果一致を確認する。SDKのunit testはmock経路で、接続・生成の証拠は本評価の保存応答による。

第三者blind課題、Private Pilot価値Gate、Public Alpha製品化Gateは未完了。実モデル接続・比較実行の完了と、品質改善の実証・既定採用を区別する。

最終検証は`bun run check`でformat・lint・typecheckと13分割の975 pass / 0 failを確認した。SDK関連の単独検証も13 pass / 0 fail（新規adapter 4件、既存SDK連携9件）。完成reportのAPIなしreplay、`ci:docs`、`ci:protected`、差分の空白検査も成功。全repositoryのcoverageと旧JSONC CLI経由の一括`verify`は今回再実行しておらず、以前の検証記録を今回の成功として読み替えない。最終集計は同じartifact directoryの`validation.json`へ保存した。
