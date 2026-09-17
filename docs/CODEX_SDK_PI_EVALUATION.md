# Wasm能力製造に使うCodex SDKとpi CLIの評価

> 分類：2026-09-16時点の接続比較・実測記録です。モデル・SDK・外部SAAAの現在の利用可否を保証しません。JSONC v2の操作は[CLIリファレンス](./LLANG_CLI_REFERENCE.md)、Prompt Source v1の操作は[製造例](../examples/capability-development/README.md)を参照してください。

2026-09-16。対象はL-Langの制限Predicate製造と、SAAAからのジョブ接続。Codex SDK 0.154.0、ローカルpi CLI 0.85.1、SAAA `68af784`のコードを確認した。SAAA側の設定・コードは変更していない。

## 推奨

**今回のL-Lang内部の製造にはCodex SDKを採用する。SAAA側のジョブ管理は既存pi経路を残し、接続先を成果物契約で分離する。**

今回の仕事は要求からJSON suiteとPredicate IRを生成することであり、リポジトリ全体を自由に編集する必要はない。SDKのoutputSchemaを指定でき、生成を既存の型検査・コンパイル・Wasm検証へ直接接続できる点が適している。Terraは`gpt-5.6-terra`、reasoningは`medium`を指定する。

SAAAの開始・進捗・中断・再開を新たにSDK中心へ作り直す利益は、現時点では確認できない。既存piジョブからL-Langの固定コマンドを呼ぶ場合も、piの成功文章ではなくL-Langのrunと候補hashを取得する。ただしこの方式を採用するなら、外側piと内側SDKの呼び出し・予算・cancelを一体で追跡する必要がある。

より単純な接続は、SAAAホストが用途別に「通常のコード変更はpi」「制限Predicate生成はL-LangのSDK adapter」を起動し、共通のジョブ台帳へ結果を登録する方式である。二つのエージェントに同じ実装を重複生成させる必要はない。この接続変更はSAAA側の後続作業であり、今回は実施していない。

## 比較

| 観点 | Codex SDK | pi CLI | 判断 |
| --- | --- | --- | --- |
| 今回の構造化製造 | TypeScript APIでoutputSchema、signal、usageを扱える | JSON/RPCのイベントと最終回答を抽出し、suite/IRを検査するadapterが必要 | L-LangではSDKが小さく実装できる |
| Terra・medium | 今回指定して実生成とWasm検証に成功 | provider/model/thinkingを指定できるが、この環境の通常piモデル一覧ではTerraを確認できなかった | 今回はSDKの接続証拠がある |
| SAAAのジョブ管理 | SAAAが直接使うならジョブ接続の追加が必要 | coding_start/inspect/continue/cancelとSQLite記録が既存 | SAAAの管理機能はpiが有利 |
| Rustからの接続 | SDKを動かすJS runtimeと子プロセスadapterが必要 | stdin/stdoutのRPCがある | 既存SAAA接続の再利用ではpiが有利 |
| 独立したテスト生成 | 毎回新しいthread、空の作業ディレクトリ、schema付き生成にできる | 新sessionとno-tools/no-context-files等の設定が必要 | 両方可能。生成条件・要求検査の設計が本体 |
| 中断 | AbortSignalをSDKへ渡せる | RPC abortとプロセス終了を管理できる | どちらも実プロセス終了と子ジョブを含めた確認が必要 |
| token上限 | turn完了時usageを検査。SDKは今回のmaxOutputTokensをproviderのhard capにはしない | CLIのthinking指定は全体のtoken上限を意味しない | 両方とも全体予算台帳と停止制御が必要 |
| モデルの選択肢 | Codexの利用可能モデル・認証に依存 | providerを切り替える設計 | 将来複数providerを評価する場合はpiが有利 |
| 配布 | SDKに加えCodex実行環境が必要。ホスト検証だけならSDK不要 | piのruntime、認証、拡張の配布が必要 | どちらもTauriへの配布対応は別試験 |
| 生成品質・費用・速度 | 受付判定1課題を観測 | 同条件の実製造は未実施 | 優劣を断定できない |

SDKも内部ではCodex CLIを子プロセス起動する。SDKなら子プロセスが不要になるわけではない。また、`--mode json`はイベントをJSONで返す指定であり、モデルの最終回答がL-Langのschemaに従う保証とは区別する。

## SAAAの既存SDK拡張との関係

SAAAの`src-tauri/src/coding/settings.rs`には、通常の`trusted-local-v1`に加え`codex-sdk-v1`がある。後者は`provider=saaa-codex-sdk`と`model=gpt-5.6-luna`、実在する拡張ファイルを要求する。`runtime/pi/process.rs`はその拡張をpiへ渡す。

したがって「piかSDKか」は完全な二者択一ではない。ただし既存SDK profileをそのままTerraとして使えるわけではない。SAAA側でモデル許可、thinkingの伝達、実リクエスト認証を変更・検証する必要がある。既定のcodingは無効で、明示的依頼という起動条件も残る。今回のL-Lang adapter追加が、この許可条件を拡張することはない。

## 今回の実測

Codex SDKの既存ChatGPTログインで、accessの合成要求を送信した。テスト製造と実装製造を別threadで各1回実行し、初回候補が部品検証に合格した。

- 指定モデル：`gpt-5.6-terra`、reasoning：`medium`。
- SDK turn数：2。報告usage合計：24,859 tokens。SDK内の再試行を含めた物理HTTP回数や課金額は計測していない。
- 候補hash：`cc240e8a667847458a26e094f7866a817b6a52ed6e4d8074f55bf53905b37523`。
- 保存応答によるoffline replayで同じ候補を再現した。
- 変異検査：Sourceで8、suiteで1を検出。survived/unknown/error/未処理提案は0。
- SAAA受け入れはnot-run。実SAAAへの登録・配備・会話試験はしていない。

piは`--list-models gpt-5.6-terra`で利用可能モデルなしと表示された。通常のpi設定での観測であり、SAAA専用拡張を起動した試験でも、pi自体がTerra非対応だという判断でもない。認証設定を変更したり、別モデルへ置き換えて比較したりしていない。

この1課題の成功は、一般的な自然言語の製造成功率やSDKの品質優位を示さない。同じTerraでもハーネスのsystem prompt、ツール、文脈、再試行により結果は変わり得る。

## piを実測比較する場合の条件

同じSourceと受け入れケース、同じTerra・medium、同じ修正上限でaccess/contact/logicを実行する。テストと実装は別sessionにし、ツール・拡張・contextを揃える。pi側でも生成JSONを同じL-Lang parserで検査し、同じコンパイラとWasm runnerを通す。

比較するのは初回合格、修正後合格、生成テストが検出した変異、不正JSON、未解決、時間、報告token、起動・cancel失敗。SDKの初回だけとpiの複数試行中の最良だけを比較しない。認証・モデル設定が揃う前は制御方式の比較までとし、費用や品質の勝者は決めない。

## 根拠

- [OpenAI公式Codex SDKドキュメント](https://learn.chatgpt.com/docs/codex-sdk)：SDKの用途、言語runtime、ローカルthread操作。
- インストール済み`@openai/codex-sdk@0.154.0`のREADMEと型定義：outputSchema、AbortSignal、usage、modelReasoningEffort。
- [pi公式RPCドキュメント](https://pi.dev/docs/latest/rpc)：子プロセス接続、model/thinking、abort、イベントとコマンド受理の区別。
- ローカル`pi --help`、`pi --version`、`pi --list-models gpt-5.6-terra`と、SAAA `68af784`のcoding/settings.rs、coding/tools.rs、runtime/pi/process.rs。

## 実装の回帰検証

全376テスト・1879 assertionsが成功し、カバレッジ基準も通過した。関連する43テストにはSDK設定・応答検査、独立session、予算停止、実Wasmの単発呼び出し、無限ループのtimeout、移動したキットのAPI認証なし実行を含む。型検査、format、lint、smoke、保護入力、文書リンク検査も成功。CIでの3 OS実行は今回まだ行っていない。

生の実行記録と配布用キットはGit管理外の`artifacts/codex-terra/`にある。再利用する場合はREADMEのコマンドから再生成する。実モデルの応答は同じになる保証がないため、候補hashの一致を確認する試験は保存応答のoffline replayで行う。
