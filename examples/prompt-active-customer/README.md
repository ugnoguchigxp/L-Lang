# TS DSLを使わないPrompt Sourceの例

`customer.prompt.json`を正本として、解決結果を`customer.prompt.json.lock.json`に保存する。Lockはfixture由来であり、自然言語モデルの正解率の実証ではない。

```bash
bun run prompt check examples/prompt-active-customer/customer.prompt.json
bun run prompt resolve examples/prompt-active-customer/customer.prompt.json
bun run prompt build examples/prompt-active-customer/customer.prompt.json --out-dir artifacts/prompt-source/customer
bun run prompt test examples/prompt-active-customer/customer.prompt.json --manifest artifacts/prompt-source/customer/manifest.json
bun run prompt inspect examples/prompt-active-customer/customer.prompt.json --manifest artifacts/prompt-source/customer/manifest.json
bun run wasm run artifacts/prompt-source/customer/manifest.json --input examples/wasm-active-customer/input.json
```

有効な同梱Lockを使うためAPI呼出しはない。Lockが存在しない、またはSourceを変更した場合には明示的に解決する。

```bash
bun run prompt resolve examples/prompt-active-customer/customer.prompt.json --fixture examples/prompt-active-customer/resolution.fixture.json
```

## 自然言語からの作成と局所更新

次は一時Sourceを作るoffline例。`draft`のモデル入力は要求文と入力契約のみ。利用者が用意した`examples.json`の期待結果はモデルに渡さない。

```bash
bun run prompt draft artifacts/prompt-source/draft.json --id active-customer --request examples/prompt-active-customer/request.txt --contract examples/prompt-active-customer/contract.json --examples examples/prompt-active-customer/examples.json --fixture examples/prompt-active-customer/meaning.fixture.json
```

`draft`が出力した`revision`を使って局所更新する。既に同名のファイルがあると作成は失敗する。Source JSONが既にある場合は`prompt create <path> --from <candidate.json>`で検証して作成できる。

```bash
bun run prompt update artifacts/prompt-source/draft.json --revision <revision> --ids active --request examples/prompt-active-customer/update.txt --fixture examples/prompt-active-customer/patch.fixture.json
bun run prompt resolve artifacts/prompt-source/draft.json --fixture examples/prompt-active-customer/resolution.fixture.json
bun run prompt build artifacts/prompt-source/draft.json --out-dir artifacts/prompt-source/draft-wasm
bun run prompt test artifacts/prompt-source/draft.json --manifest artifacts/prompt-source/draft-wasm/manifest.json
```

`active`以外の要求、型、検証例はupdateの変更対象にできない。前のrevisionを使い回すと失敗する。Sourceを直接編集する場合にもcheckと再resolveが必要。

liveモデルを使うときは`--fixture <path>`を`--model <model-id> --max-output-tokens 4096`へ置き換える。OpenAIは`OPENAI_API_KEY`、Azureは`AZURE_OPENAI_API_KEY`と`AZURE_OPENAI_BASE_URL`を設定する。明示的に設定した`OPENAI_BASE_URL`も利用可能。呼出しは各操作につき最大1回で、自動retryはしない。今回の検証ではlive callは実行していない。

生成されたWasmは[既存host API](../wasm-active-customer/run.ts)からも利用できる。`prompt test`はJSON Sourceに定義した6例をhost adapter経由で実行する。undefinedは検証例の`undefinedFields`で指定する。

詳細は[実装計画](../../docs/PROMPT_SOURCE_IMPLEMENTATION_PLAN.md)と[評価結果](../../docs/PROMPT_SOURCE_RESULTS.md)を参照。
