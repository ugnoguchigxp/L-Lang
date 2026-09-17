# Typed module example

The `jsonc`, `typescript`, and `mixed` directories define the same three-module
program. Each exposes `application/main#canAccess` and accepts a record with
`enabled` and `suspended` boolean fields.

```sh
bun run llang module lint application/main.llang.jsonc --root examples/module-access/mixed --entry canAccess --json
bun run llang module test application/main.llang.jsonc --root examples/module-access/mixed --entry canAccess --suite examples/module-access/cases.json --json
bun run llang module build application/main.llang.jsonc --root examples/module-access/mixed --entry canAccess --target all --out-dir artifacts/module-access
bun run llang module verify artifacts/module-access/module-build.json --suite examples/module-access/cases.json --json
```
