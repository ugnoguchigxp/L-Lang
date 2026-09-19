# Module IO pipeline

This Phase 4 vertical example reads newline-delimited typed orders with the
pull file adapter, carries UTF-8 state across chunks, runs enrichment work in a
structured task scope with concurrency four, computes totals with explicit
scale-2 half-even decimal arithmetic, streams NDJSON output to a temporary
file, and publishes only on commit.

```sh
bun test examples/module-io-pipeline/pipeline.test.ts
```

The failure test proves that malformed typed JSON does not publish a partial
output. The adapter refuses traversal, symlink escapes, and implicit replace.

The static effects bundle inspection path can be exercised without running
the file operations:

```sh
bun run llang module build inspection.llang.jsonc --root examples/module-io-pipeline --entry main --profile module-effects-v1 --target all --out-dir artifacts/module-io-inspection-bundle --json
bun run llang module inspect artifacts/module-io-inspection-bundle/module-build.json --out-dir artifacts/module-io-inspection --json
```

Inspection rechecks the flattened JSONC and deterministically regenerates the
TypeScript and Wasm artifacts. It reports declared file operations, but does
not grant file access, invoke an adapter, execute Wasm, or create a runtime
transcript.

This is the current operational starting point: local files and deterministic
fixtures require no external credentials, while HTTP access is granted by the
embedding host. The example is not a soak, TLS deployment, or performance
benchmark. Those measurements should use representative SAAA workloads and a
recorded observation window rather than this short correctness test.
