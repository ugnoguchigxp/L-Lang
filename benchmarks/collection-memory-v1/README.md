# Collection memory v1 benchmark

This fixture records deterministic allocation, copy, validation, and arena
metrics for the checked-in Collection example. Generate a local observation:

```sh
bun run collection:memory
```

Generate the reproducible portion used by tests and review:

```sh
bun run src/llang-collection-cost-cli.ts benchmarks/collection-memory-v1/benchmark.json /tmp/collection-cost.json --deterministic --verify benchmarks/collection-memory-v1/expected/cost.json
```

`fixtures/direct-corpus.json` is the shared source for canonical host/direct
parity sizes and raw top-level ABI cases. Regenerate the Markdown safety matrix
from its JSON source with `bun run collection:memory:matrix`; the test suite
also rejects drift between them.

Timing and RSS remain observations of the executing host. The checked-in
fixture is not evidence for production workloads or other operating systems.
The local timing command uses five warmups and thirty recorded repetitions.
There is one baseline arm because the measured optimization candidate was
rejected before a comparison arm could be created.
