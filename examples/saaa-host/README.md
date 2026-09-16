# SAAAへ渡す単発Wasm実行キット

モデルを呼ばずに候補のinspect、部品verify、単発invokeを行うBunプロセス。SAAAの登録・配備APIではない。候補パスは信頼するホストがargvで渡し、モデルの任意パス指定を受け付けない。

## キットの生成

リポジトリルートで依存をインストールして実行する。出力先は新規ディレクトリにする。

```sh
bun install --frozen-lockfile
bun run capability:host-kit artifacts/saaa-host-kit
```

候補Wasm、runtimeの3ファイル、request/responseのJSON Schema、期待値付きvectors.json、検証report、hash一覧kit.jsonを生成する。キット全体を別ディレクトリへコピーして利用できる。受信側ではkit.jsonのhashと信頼する受け渡し元を確認する。hash一覧は署名ではない。

キットのディレクトリで、Bun 1.3.14を使って実行する。

```sh
bun runtime/capability-host-cli.ts candidate/capability.json < request.json
```

request.jsonは停止中利用者の例なので、正常な`false`が返る。vectors.jsonには受付判定の4通りと型不正の期待値がある。実行環境にAPIキー、Codex、コンパイラ、node_modulesは不要。Bun自体の同梱やTauri配布版での動作は未検証。

## プロトコル

標準入力にJSONを1個送り、EOFを閉じる。標準出力はJSONを1個と末尾改行。入力64 KiB、出力1 MiBが上限。不正JSON・過大入力は終了コード2、stdoutなし。構造化応答を返せたら終了コード0で、業務的な成功を意味しない。

必須項目はprotocol=`llang-host-v1`、requestId、operation、packageHash。invokeだけinput、undefinedFields、timeoutMs（1〜10000）が追加で必須。undefinedFieldsとinputの同じキーを同時指定することは禁止で、この相互制約はJSON Schemaに加えてruntimeで検査する。

request.schema.jsonは要求全体、response.schema.jsonは応答外枠を検査する。resultの中身はoperationごとに読む。invokeは`{value:boolean}`、verifyは既存CapabilityReport、inspectはmanifest・contract・requirements・verification・acceptance。SAAAのRust側でもoperationごとのresult型を検査する必要がある。

応答のstatusはokまたはerror。verifyのstatus:okは「検証reportを返せた」の意味なので、result.status:passも確認する。部品検証reportのacceptanceはnot-runのまま。invokeのfalseをエラーへ変換しない。

errorはinvalid-request、package-mismatch、invalid-input、timeout、execution-error。起動不能・プロセス異常・不正JSON応答はホスト側のtransport error。packageHashは検査できなかった場合null。requestIdも要求が不正ならnull。診断に任意ファイル内容を含めない。

Rust側はshellを介さず起動し、stdinを書いて閉じ、stdout/stderrを同時回収する。invokeは15秒、verifyは30秒などホスト側にも期限を置き、cancel時は子プロセスを終了・回収する。adapter内部のWorker timeoutだけではstdin待機を止められない。今回のTypeScript試験はRust側の終了処理を検証したものではない。

## 実生成候補も呼ぶ

[Codex SDKによる製造](../capability-development/README.md)でできたcandidateのcapability.jsonと、runに記録されたpackageHashを渡せば、同じadapterで呼び出せる。fixtureのhashを実生成候補へ流用しない。

検証・invoke時には全ファイルの対応とhashを確認し、検証したsnapshotのWasmを実行する。呼び出し後の改変も検査する。これだけでは同じOSユーザーの別プロセスに対する権限分離や、SAAAの配備承認を保証しない。候補の保管・有効版・権限はSAAAホストの責務である。

製造依頼、受け入れ計画、修正、配備の全schemaは今回まだ固定していない。このキットはR1の単発接続を試すための資材であり、P1全体やR2の完了ではない。
