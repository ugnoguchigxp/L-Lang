# 検証付きWasm能力パッケージ：実装結果

2026-09-15。基点`0d30e1a`、`wasm-compiler`上の変更。[計画](./CAPABILITY_PACKAGE_IMPLEMENTATION_PLAN.md)のP1〜P5を対象とする。検証状況は下記に区別して記録する。

## 実装したもの

- Capability Manifest、部品テストsuite、検証reportのstrict parser。能力ID、版、目的・適用範囲、入力参照、boolean出力、権限なしの契約。
- Source、Lock、Build Manifest、Wasm、suiteを同梱する自己完結した候補。各ファイルのbytes hashと、正規化ManifestのpackageHashを保持する。
- `capability package/verify/inspect`のAPI・CLI。候補を上書きせず、完成したManifestを最後に公開する。元入力の変更や書き込み失敗を検出し、自分が作成した未完成候補を片付ける。
- Source例と独立suiteを実Wasmで実行するrunner。JSONで記述されたテスト以外の任意テストコードは実行しない。期待値不一致と実行エラーを区別する。
- 検証中の候補変更、異なる候補へのreport流用、不整合、パス逸脱、symlink、古いsuiteの拒否。
- Workerでの実行と10秒のタイムアウト。検証経路はモデル、Binaryen、TS scannerを読み込まない。

CLIはJSONを返し、verifyの終了コードは0=pass、1=fail、2=error。reportは候補の外へ排他的に保存し、候補自体のhashには含めない。部品検証に合格しても`acceptance: "not-run"`を維持する。

主な実装は[package/API](../src/capability-package.ts)、[suite/runner](../src/capability-tests.ts)、[report parser](../src/capability-report.ts)、[CLI](../src/capability-cli.ts)、[Worker](../src/capability-worker.ts)。既存runtimeは、ファイルからの読み込みと、検証済みsnapshot bytesからのインスタンス生成を分離した。

## 操作例で確認したこと

[受付判定の操作例](../examples/capability-access/README.md)は、既存のbooleanだけで動作する。Sourceの2例と追加suiteの4ケースを使用する。

| 候補 | 観測結果 |
| --- | --- |
| 正しい受付判定 | 6 pass、0 fail、0 error、API 0回 |
| 停止条件を欠いた故障注入候補 | Sourceの2例は成功するが、suiteのstoppedが失敗。5 pass、1 fail、終了コード1 |
| 正しいLockから作る修正版 | 同じsuiteで合格する。誤候補とは異なるpackageHashになる |

正しい候補のpackageHashは`1d31a73c93cb0136ef9b8521112a2c8efd42d79041d5008585b8874ffe3beb68`。ローカル証拠は`artifacts/capability-package/`に保存する。`access-v1-report.json`、`access-bad-report.json`は実行結果、`targeted.log`と`coverage.log`はテストログである。artifactsはGit管理外なので、他の環境では操作例から再生成する。

## 保証の範囲

実装の正本はPrompt Sourceと解決済みIR、テスト検証コードは独立JSON suiteと共通runnerである。新しいLLMテスト生成adapterや、Coding Agentを起動する制御は追加していない。Coding AgentはCLI/APIに従ってこれらを製造・提出できる。

要求IDとケースの対応は検証対象の追跡であり、自然言語の網羅的な正しさの証明ではない。fixtureによる成功を実モデルの意味理解精度とは扱わない。hashやreport parserも発行者の真正性を保証しない。受け入れ側は再検証とSAAA自身の利用目的の検証を行う必要がある。

Workerで無限実行を打ち切れることは確認するが、ホスト全体のメモリ上限や任意の第三者Wasmに対する完全な隔離を保証しない。現行の制限コンパイラが作るローカル候補を対象とする。

SAAAの受け入れrunner、レジストリへの配備、自動修正ループは未実装であり、次の計画の対象である。

## 品質確認

変更箇所の試験では、別ディレクトリ・別プロセスでの再検証、故障注入と修正版、成果物ごとの改変、入力変更と部分書き込み失敗、実行中の候補変更、古いreport、schema不正、ABI不整合、無限実行の打ち切り、offline依存制約を確認する。

ローカル環境はmacOS、Bun 1.3.14。全回帰は332 pass、0 fail、1630 assertionsで、全体の関数94.41%・行92.27%のカバレッジ基準を満たした。その後の最終変更（検証中の候補差し替え検査・report整合性の補強）を含む対象試験は17 pass、0 fail、75 assertionsで、coverage付き実行でも成功した。

format、lint、typecheck、smoke、protected inputs、Markdownリンク検証も成功。最終状態の全回帰再実行と3 OSのCIはコミット・プッシュ時に確認する。CI結果は対象commitとともに作業報告へ記載する。
