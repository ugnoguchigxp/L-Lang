# JSONC主言語の最小例

JSONCソースを直接lintし、意味解決LockやAPI呼出しなしでWasmへbuildする。

```sh
bun run llang lint examples/jsonc-enabled-user/enabled-user.llang.jsonc
bun run llang lint examples/jsonc-enabled-user/enabled-user.llang.jsonc --json
bun run llang format examples/jsonc-enabled-user/enabled-user.llang.jsonc --check
bun run llang build examples/jsonc-enabled-user/enabled-user.llang.jsonc --out-dir artifacts/jsonc-enabled-user
bun run llang test examples/jsonc-enabled-user/enabled-user.llang.jsonc --request examples/jsonc-enabled-user/request.json --suite examples/jsonc-enabled-user/tests.json
bun run llang package examples/jsonc-enabled-user/enabled-user.llang.jsonc --request examples/jsonc-enabled-user/request.json --suite examples/jsonc-enabled-user/tests.json --metadata examples/jsonc-enabled-user/metadata.json --out-dir artifacts/jsonc-enabled-user-package
bun run llang verify artifacts/jsonc-enabled-user-package/capability.json
bun run llang mutation-check examples/jsonc-enabled-user/enabled-user.llang.jsonc --request examples/jsonc-enabled-user/request.json --suite examples/jsonc-enabled-user/tests.json
```

限定 `predicate-i32-v1` のparse、lint、format、直接Wasm build、独立suite、Capability Package v2、製造・最大1回修正・replay、旧Prompt Source移行まで実装済み。`request.json` はSAAA所有の固定要求、`tests.json` は実装から独立した受け入れ条件であり、JSONCソースやWasmの代替ではない。
