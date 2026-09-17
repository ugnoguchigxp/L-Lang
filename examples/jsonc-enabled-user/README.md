# JSONC Predicateの実行・生成・変換例

[例の一覧](../README.md) · [CLIリファレンス](../../docs/LLANG_CLI_REFERENCE.md) · [言語仕様](../../docs/LLANG_JSONC_SPEC.md)

JSONCソースを直接lintし、Resolution LockやAPI呼出しなしでWasmへbuildする。TypeScript経路も併存する。以下はリポジトリルートで実行する。初回用の出力名なので、再実行時はpackage/develop/replay/migrateに新しい名前を指定する。

## lint・build・独立テスト

```sh
bun run llang lint examples/jsonc-enabled-user/enabled-user.llang.jsonc
bun run llang lint examples/jsonc-enabled-user/enabled-user.llang.jsonc --json
bun run llang format examples/jsonc-enabled-user/enabled-user.llang.jsonc --check
bun run llang build examples/jsonc-enabled-user/enabled-user.llang.jsonc --out-dir artifacts/jsonc-enabled-user
bun run llang test examples/jsonc-enabled-user/enabled-user.llang.jsonc --request examples/jsonc-enabled-user/request.json --suite examples/jsonc-enabled-user/tests.json
```

`request.json`は固定要求、`tests.json`は実装から独立した受け入れ条件である。lint/buildにこれらの入力は不要で、test/packageで使う。testは3ケースがpass、必須要求の未網羅なしとなる。単体testはrequest/suite/source/program/artifactのhashを返す。

## パッケージと変異検査

```sh
bun run llang package examples/jsonc-enabled-user/enabled-user.llang.jsonc --request examples/jsonc-enabled-user/request.json --suite examples/jsonc-enabled-user/tests.json --metadata examples/jsonc-enabled-user/metadata.json --out-dir artifacts/jsonc-enabled-user-package
bun run llang verify artifacts/jsonc-enabled-user-package/capability.json
bun run llang mutation-check examples/jsonc-enabled-user/enabled-user.llang.jsonc --request examples/jsonc-enabled-user/request.json --suite examples/jsonc-enabled-user/tests.json
```

packageは作成のみで`verification:not-run`。verifyは`status:pass`、`acceptance:not-run`、API呼出0となる。mutation-checkではこの例の8変異をsuiteが検出する。どちらもSAAAへの登録・配備ではない。v2パッケージは`llang verify`またはv1/v2対応の`capability:host`で検証・実行できる。

## JSONCを生成し、1回修正する

[development.fixture.json](./development.fixture.json)は、停止条件を欠く初回実装と、その修正版を保存した2応答である。モデル精度の証拠ではなく、固定suiteで誤実装を検出・修正できることを確認する。

上のbuildで`artifacts/`を作成した後、または既存の親ディレクトリの下で実行する。

```sh
bun run llang develop examples/jsonc-enabled-user/request.json --suite examples/jsonc-enabled-user/tests.json --metadata examples/jsonc-enabled-user/metadata.json --fixtures examples/jsonc-enabled-user/development.fixture.json --out-dir artifacts/jsonc-development
bun run llang replay-development artifacts/jsonc-development --out-dir artifacts/jsonc-development-replay
```

両方とも`status:pass`になる。runには初回のfailと修正版のpassが記録され、JSONC実装を含む候補が残る。suite自体は生成・変更しない。live agentを使用する場合の引数・予算・認証の違いはCLIリファレンスを参照。

## 解決済みPrompt SourceをJSONCへ変換する

```sh
bun run llang migrate examples/prompt-active-customer/customer.prompt.json --out artifacts/migrated-customer.llang.jsonc
bun run llang lint artifacts/migrated-customer.llang.jsonc --json
```

有効な同梱LockからProgramを生成し、隣に`.request.json`と`.tests.json`も保存する。移行は元ファイル・期待値を変更しない。元の例はrequirementIdsを持たないため、生成suiteの要求網羅が不足し得る。警告に従い、要求と例の対応を確認してから受け入れ検証する。

生成物の比較は[4通りの入出力](../source-output-matrix/README.md)、要件変更から配備までは[ライフサイクル例](../capability-lifecycle/README.md)を参照。
