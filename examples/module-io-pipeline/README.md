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

This is the current operational starting point: local files and deterministic
fixtures require no external credentials, while HTTP access is granted by the
embedding host. The example is not a soak, TLS deployment, or performance
benchmark. Those measurements should use representative SAAA workloads and a
recorded observation window rather than this short correctness test.
