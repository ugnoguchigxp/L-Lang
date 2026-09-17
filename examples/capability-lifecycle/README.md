# 要件変更から修正・配備・切戻しまで

「enabledなら許可」というv1から「enabledかつ非suspendedなら許可」というv2へ変更します。期待値を先に固定し、誤った初回実装、修正、再検証、移動後のパッケージ実行、旧版への切戻しをオフラインで確認します。

```sh
mkdir -p artifacts
bun run examples:lifecycle artifacts/capability-lifecycle
```

出力先は未作成のディレクトリを指定します。API認証は不要です。`lifecycle.json`に次を記録します。

1. v1パッケージを検証して`active.json`へhashとrelease名を保存。
2. 変更後のrequest/suiteを固定。fixtureの初回候補が失敗し、修正候補が成功。
3. 保存済み応答でreplayし、結果の再現を確認。
4. 成功したパッケージを`releases/v2`へコピーし、再検証して有効化。
5. v1を再検証して有効化し、切戻し後の挙動を確認。

`{enabled:true,suspended:true}`への結果は`true → false → true`です。検証に失敗した版は有効化しません。activeのhashに一致するパッケージsnapshotを実行し、ファイルの改変を拒否します。

これは単一プロセスによるローカルファイルシステムへの配備例です。リリースディレクトリは有効化後に編集しない運用を想定します。複数の運用者による同時昇格、リモートサービスの切替、SAAA受け入れは含みません。`acceptance`は`not-run`のままです。

## コンパイラなしのhostへ配る

Capability v2用の移動可能なキットも作れます。ここでは同じ判定条件の保存済みJSONC例を使います。

```sh
bun run capability:host-kit artifacts/jsonc-host-kit --jsonc
bun artifacts/jsonc-host-kit/runtime/capability-host-cli.ts artifacts/jsonc-host-kit/candidate/capability.json < artifacts/jsonc-host-kit/request.json
```

キット全体をリポジトリ外へ移しても、Bunだけでinspect・verify・invokeを実行できます。hostプロトコル名の`llang-host-v1`とパッケージversion 2は別の版番号です。`--jsonc`を省略すると従来のCapability v1キットを作ります。

[4通りの入力・出力例](../source-output-matrix/README.md) · [JSONC CLI](../../docs/LLANG_CLI_REFERENCE.md)
