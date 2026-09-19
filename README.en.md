# L-Lang

Runnable examples: [TypeScript/JSONC → TypeScript/Wasm matrix](./examples/source-output-matrix/README.md) · [Requirement change, repair, deployment and rollback](./examples/capability-lifecycle/README.md)

[日本語](./README.md) · [Documentation index](./docs/README.md) · [Status and roadmap](./PROJECT_STATUS_AND_ROADMAP.md) · [Quality gates](./QUALITY_GATES.md)

L-Lang is a research project for validating predicates through restricted IR and tests, then producing reproducible artifacts. **TypeScript and JSONC coexist.** Input languages and output formats are separate choices.

## Research concept

L-Lang anticipates a setting where LLM-generated executable binaries are used without mandatory human source-code review. Its research goal is to preserve the connection between requirements and executable behavior, while allowing people to inspect that behavior through TypeScript derived from a shared, checked semantic representation. Protecting trusted instructions from untrusted data is combined with independently defined permissions and runtime enforcement.

These are research goals, not established guarantees. Current supported paths compile checked intermediate representations to Wasm; they do not establish the safety of arbitrary directly generated binaries or complete agreement with natural-language requirements. See the [main concept (Japanese)](./MAIN_CONCEPT.md) for the proposed approach and open research questions.

| Task | Input → output | Guide |
| --- | --- | --- |
| Adapt a natural-language Concept to project types | TypeScript DSL → ordinary TypeScript | [Semantic TypeScript](./docs/guides/semantic-typescript.en.md) |
| Compile an explicit predicate | JSONC → Wasm | [JSONC example](./examples/jsonc-enabled-user/README.md), [specification](./docs/LLANG_JSONC_SPEC.md), [CLI reference](./docs/LLANG_CLI_REFERENCE.md) |
| Generate a JSONC implementation | Fixed request and suite → candidate package containing JSONC | [Route guide](./docs/guides/language-routes.md) |
| Convert a resolved Prompt Source | Prompt Source v1 and Lock → JSONC, request, suite | [Route guide](./docs/guides/language-routes.md) |
| Import existing types and a restricted predicate | TypeScript → Wasm | [Hybrid demos](./examples/hybrid-wasm-scenarios/README.md) |
| Resolve a Prompt Source | Prompt Source JSON → resolution Lock → Wasm | [Prompt Source example](./examples/prompt-active-customer/README.md) |
| Run typed local I/O and asynchronous workflows | TypeScript/JSONC → TypeScript/JSONC/Wasm | [Effects specification](./docs/LLANG_MODULE_EFFECTS_SPEC.md), [module I/O example](./examples/module-io-pipeline/README.md) |

JSONC output is available through `develop` and `migrate`. This does not imply arbitrary TypeScript/JSONC conversion or a universal output-format switch. The route guide distinguishes implemented conversions from possible future combinations. Guides other than Semantic TypeScript are currently in Japanese.

## Try without an API

Use the Bun version in [package.json](./package.json), currently 1.4.2. Run from the repository root:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run semantic explain examples/active-customer/semantic.ts --json
bun run semantic verify semantic-closure.json --json
bun run llang lint examples/jsonc-enabled-user/enabled-user.llang.jsonc --json
bun run llang test examples/jsonc-enabled-user/enabled-user.llang.jsonc --request examples/jsonc-enabled-user/request.json --suite examples/jsonc-enabled-user/tests.json
```

These checks need no API credentials. See the TypeScript guide for fixture-based generation and the JSONC example for build, package, and verification. Live agent generation requires the selected route's authentication.

## Scope and evidence

In addition to restricted Boolean predicates, `module-effects-v1` lowers bytes, i64, finite f64, decimal, typed I/O, await, structured tasks, and pull streams from TypeScript or JSONC to Wasm. This remains a restricted IR with registered host operations; it does not accept arbitrary TypeScript, arbitrary external APIs, or a general package ecosystem. Input validation, tests, hashes, and replay help detect invalid inputs and tampering; hashes are not signatures, and passing tests does not prove complete compliance with natural-language requirements. Package verification is separate from SAAA acceptance and deployment. See [Security](./SECURITY.md).

Evidence applies to its recorded route and conditions. TypeScript results do not establish JSONC generation accuracy; fixtures do not measure live model accuracy. See [Status and roadmap](./PROJECT_STATUS_AND_ROADMAP.md).

Phase 4 is implemented and verified for local files, granted HTTP requests, fixture replay, and loopback integration. SAAA soak and capability evaluation, operational TLS testing, and long-running performance and memory evidence are intentionally deferred until representative usage data exists. See the [Phase 4 results](./docs/GENERAL_PURPOSE_LANGUAGE_PHASE4_IMPLEMENTATION_RESULTS.md).

## Repository

- `src/`: compiler, CLI, runtime, validation, and tests.
- `docs/guides/`: usage guides and input/output routes.
- `docs/`: specifications, designs, plans, and results, organized by the [documentation index](./docs/README.md).
- `examples/`: runnable examples listed in the [example index](./examples/README.md).
- `benchmarks/` and `pilots/`: evaluation inputs and evidence.
- `schemas/`: published structured-data schemas.

See [Contributing](./CONTRIBUTING.md), [Quality gates](./QUALITY_GATES.md), and the [alignment plan](./docs/DOCUMENTATION_AND_IMPLEMENTATION_ALIGNMENT_PLAN.md).

## License

[MIT License](./LICENSE). `private: true` prevents accidental npm publication.
