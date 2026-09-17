# SAAA接続前の製造・検証・1回の修正

SAAA、模擬SAAA、能力レジストリ、配備処理は使用しない。固定したPrompt Sourceからテストと実装を別々に製造し、Wasmで部品検証する。失敗したらテストを変更せず1回だけ実装を修正する。

テスト検証コードは既存のJSON suite形式。テスト製造adapterの応答は`outcome / suiteJson / diagnostics`で、suiteJsonの内部を既存schemaでも検査する。既存Source例や実装の出力をテスト製造モデルへ渡さない。

## fixtureで一巡させる

リポジトリのルートから、新しい出力ディレクトリ名を使って実行する。

```sh
bun run capability develop examples/capability-development/access/source.json --metadata examples/capability-development/access/metadata.json --fixtures examples/capability-development/access/responses.fixture.json --out-dir artifacts/development-access
bun run capability replay-development artifacts/development-access --out-dir artifacts/development-access-replay
bun run capability mutation-check artifacts/development-access/attempt-1/candidate/capability.json --report artifacts/development-access-mutations.json
```

accessは受付判定、contactはpremium区分とメールの存在、logicはAND・OR・NOTの組み合わせを扱う。上のaccessをcontactまたはlogicに替えると別の課題を試せる。

各fixtureは、テスト製造、意図的な誤実装、修正版の3応答を含む。実際のモデルの正解率を測るデータではない。実装とは別のテストが初回候補を不合格にし、同じテストで修正版を合格にできることを確認する。

| 記録 | 内容 |
| --- | --- |
| source.json / metadata.json | 実行開始時の固定入力 |
| tests.json | 生成・検査後に固定したsuite |
| run.json | 入力hash、設定、依頼と応答、呼び出し数、usage、各試行のhash・成否、停止理由、checksum |
| attempt-0 / attempt-1 | それぞれのSource、Lock、候補、部品検証report |
| replay-check.json | 再生成した候補と記録済みの結果が一致したか |

runの`complete`は処理が終了したことを示し、合格とは限らない。`status`と各attemptの結果を確認する。`acceptance`と`mutation`は常にnot-runで、変異検査は別のreportを読む。

replayは応答を再利用し、APIを呼ばずに再ビルド・実行する。成功・不合格・未解決の元runでは候補hashと結果を照合する。予算や実行環境に依存した停止・エラーは同じ結果の再現比較の対象外として`comparable:false`を記録する。途中runと、呼び出しが一つもないrunはreplayを拒否する。記録済み候補を実行検証するだけなら、コンパイラ不要の既存capability verifyを利用する。

## 変異reportの読み方

最大32の合法なIR変異を実行する。元と変異の比較には、現行profileが観測できる状態を最大4096通り列挙する。文字列の中身は存在状態にまとめる。列挙上限までに差を見つけられない場合はunknownで、同値と断定しない。

- killed-source：既存Source例で検出した。通常の意味解決検査でも拒否されるため、suiteによる検出とは分ける。
- killed-suite：Source例では見逃すが、追加suiteが実Wasmで検出した。
- survived：元IRと異なる入力を見つけたのに、テストが見逃した。
- equivalent：現行profileの全観測状態で元IRと同じ結果だった。
- unknown / error：比較の上限到達、または実行上の問題。

変異は一時的な試験成果物として実行して削除する。元のLockや公開候補は書き換えない。omittedProposalsは32変異の上限以降に未処理となった提案数であり、重複除去後の変異数とは限らない。検出できた件数だけで自然言語に対する正しさを認定しない。

CLI終了コードは、develop/replayで0=pass、1=部品検証fail、2=未解決・停止・エラー。mutation-checkでは0=検査した範囲で未検出なし、1=survivedあり、2=unknown・errorまたは未処理提案あり。JSON reportで項目ごとの結果を確認する。

## 実モデル接続

実装には既存のOpenAI/Azure接続を利用するadapterもある。この節のOpenAI/Azure直接接続例の実モデル評価は示していない。後述のCodex SDK接続の実測とは分けて扱う。設定例のMODEL_IDは利用者が選ぶモデルIDに置き換える。

```sh
bun run capability develop examples/capability-development/access/source.json --metadata examples/capability-development/access/metadata.json --out-dir artifacts/development-live --model MODEL_ID --max-output-tokens 4096 --max-total-tokens 200000 --max-wall-ms 120000
```

認証情報と接続先は既存のOPENAI/AZURE_OPENAI環境変数を使う。fixtureとlive設定は混在できない。最大3呼び出し、修正は最大1回。max-callsで3より少なく設定することもできる。

各呼び出し前に依頼のUTF-8 byte数と4096の余裕分、最大出力token数を予算へ予約する。依頼予約は64 KiB、応答JSONは64 KiB、run記録は1 MiBを上限とする。usage不明・予約超過・通信失敗では次の呼び出しを行わない。失敗した呼び出しも数え、usageが得られなければ予約を消費済みとして扱う。

このtoken予約は保守的な見積もりであり、providerの課金額を保証するものではない。料金換算は実装していない。モデル待機は総時間の残量で中断し、既存通信timeoutも維持する。ローカルの製造・検証は段階の前後で期限を確認し、Wasm実行は既存Workerの10秒上限を使う。

SAAAによる利用目的の検証と配備は、この検証結果を確認した後の別段階とする。

## Codex SDK：Terra・mediumで実製造する

既存のCodexログインを使う経路を追加した。APIキーの設定を必須にせず、SDKが利用するCodex認証を使う。モデルは`gpt-5.6-terra`、reasoningは`medium`に固定し、利用できなければ別モデルへ自動変更しない。

```sh
bun run capability develop examples/capability-development/access/source.json --metadata examples/capability-development/access/metadata.json --agent codex-sdk --out-dir artifacts/terra-access --max-output-tokens 16384 --max-total-tokens 250000 --max-wall-ms 180000
bun run capability replay-development artifacts/terra-access --out-dir artifacts/terra-access-replay
```

各段階で新しいSDK threadを作り、空の一時作業ディレクトリ、read-only、承認なし、web検索なし、shell/MCP/pluginを抑制する設定で、schema付きのJSON応答を要求する。想定外のツール利用を含む結果は拒否する。これは任意の外部Coding AgentのOSレベル隔離を保証するものではない。ユーザーや管理環境のCodex設定・認証の影響は残る。

Codexは独自のsystem promptを持つため、1turnの入力予約は64 Ki tokensとする。上記は最大3turn、各出力16384、全体250000 tokens、180秒。SDKはmax-output-tokensをproviderへhard capとして渡せないため、出力・usageの上限はturn完了後に検査し、超過時は次のturnへ進まない。過大な最終応答も拒否する。厳密な課金上限とは扱わない。

run.config.agentにcodex-sdk、reply.providerにcodex-sdk/medium、reply.modelに指定モデル、responseIdに新規thread IDを保存する。apiCallsはSDK turnの数であり、SDK内部の通信再試行を数えた物理HTTP数ではない。usage不明は既存と同じく停止する。通常呼び出し時にはSDKもLLMも不要で、[単発実行キット](../saaa-host/README.md)を使える。

[SDKとpiの比較・今回の実測](../../docs/CODEX_SDK_PI_EVALUATION.md)を参照。SAAA用の受け入れ失敗から元suiteを引き継ぐ修正adapterは、引き続き別の実装対象である。
