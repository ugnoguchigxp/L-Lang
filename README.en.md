# L-Lang — Staged Semantic TypeScript MVP

[日本語](./README.md) | [Project status and roadmap](./PROJECT_STATUS_AND_ROADMAP.md) | [Contributing](./CONTRIBUTING.md) | [MIT License](./LICENSE)

> **Write the meaning once. Compile it into static logic for every context.**<br>
> LLM flexibility at compile time. TypeScript certainty at runtime.

L-Lang is a TypeScript DSL that treats an LLM not as a runtime agent, but as a **flexible compile-time semantic judge**. Developers describe what must hold as abstract Concepts, Goals, and Constraints. The LLM elaborates that intent against the target types, environment, and requirements into a restricted IR. The compiler validates the IR with type checking and semantic tests, then freezes it as ordinary static TypeScript.

Traditional software treats environment-specific logic as the primary implementation asset. L-Lang aims to make **meaning and intent the reusable implementation asset**: one abstract definition can be adapted into different deterministic logic for different schemas, names, and representations. Generated runtime code has no LLM or DSL dependency.

> Status: research MVP. The current implementation generates pure Boolean predicates only. Do not treat generated candidates as trusted production code without review.

## What L-Lang is trying to change

```text
Traditional:
  Humans implement static logic for each environment and reuse the code.

L-Lang:
  Humans define meaning, goals, and constraints.
  An LLM adapts them to the environment at compile time.
  The compiler freezes the result as validated static TypeScript.
```

L-Lang does not execute natural language directly. LLM judgement exists only during build/check; only restricted IR that passes validation, type checking, semantic tests, and human approval reaches runtime.

## Core idea

```text
Natural-language Concept + TypeScript type
        ↓ build-time OpenAI / Azure OpenAI elaboration
Restricted Predicate IR
        ↓ context validation, typecheck, semantic tests
Deterministic TypeScript candidate
        ↓ explicit human approval
semantic.lock + generated TypeScript
```

The compiler fails closed: if semantic roles cannot be mapped unambiguously or a 2-of-3 consensus cannot be reached, the result is `unresolved` rather than guessed.

## Requirements

- Bun 1.3 or newer
- An OpenAI or Azure OpenAI API key for live elaboration
- No API key is required for fixture tests and lock replay

## Quick start without an API

```bash
bun install
bun run typecheck
bun test

bun run semantic build examples/active-customer/semantic.ts \
  --fixture examples/active-customer/openai-response.fixture.json

bun run semantic:test
```

## Live OpenAI or Azure OpenAI

```bash
cp .env.example .env
```

OpenAI:

```dotenv
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.4-mini
OPENAI_BASE_URL=https://api.openai.com/v1
```

Azure OpenAI:

```dotenv
OPENAI_API_KEY=<Azure OpenAI API key>
OPENAI_MODEL=gpt-5-4-mini
OPENAI_BASE_URL=https://<resource-name>.openai.azure.com
```

Then run:

```bash
bun run semantic build examples/active-customer/semantic.ts
```

The Azure model value is the deployment name. Bun loads `.env` without an additional dotenv dependency.

## TypeScript DSL

```ts
const ActiveCustomer = concept<Customer>`
  An active customer has status "active", has not been deleted,
  and has a present email address.
`;

export const isActiveCustomer = generatePredicate(ActiveCustomer);

semanticTest(isActiveCustomer, {
  accept: [{ status: "active", deletedAt: null, email: "a@example.com" }],
  reject: [{ status: "active", deletedAt: null, email: null }],
});
```

Only the Concept, target TypeScript type, and predicate target are sent to the model. Semantic test values are kept out of the prompt and are used after elaboration for validation.

## Main commands

```bash
# Build or use a matching lock entry
bun run semantic build <semantic-source.ts>

# Replay without an API call
bun run semantic replay <semantic-source.ts>

# Render the interpreted judgement and semantic cases
bun run semantic test <semantic-source.ts>

# Create a schema-evolution candidate using parallel 2-of-3 consensus
bun run semantic check <semantic-source.ts>

# Inspect and explicitly approve a candidate
bun run semantic diff <candidate-id>
bun run semantic approve <candidate-id>

# Use the legacy single-sample mode
bun run semantic check <semantic-source.ts> --samples 1 --quorum 1
```

## Safety and reproducibility

- LLM output must parse as a restricted Predicate IR.
- Property paths and literals are validated against the TypeScript type.
- Code generation is deterministic.
- Candidate-specific typechecking and semantic tests run before promotion.
- A full-test failure rolls the generated file back.
- `semantic.lock` records hashes, model metadata, IR, and generated-code integrity.
- Schema evolution requires explicit human approval.
- Ambiguous inputs and failed consensus remain unresolved.

See [SECURITY.md](./SECURITY.md) for the trust boundary and data-handling notes.

## Current limitations

- Predicate operations are limited to `all`, `any`, `not`, `equals`, and `present`.
- Input schemas support local records, nesting up to the MVP limit, arrays, primitives, literal unions, `null`, and `undefined`.
- Static judgement, arbitrary function generation, effects, LSP support, and runtime LLM calls are not implemented.
- `private: true` in `package.json` prevents accidental npm publication; it does not restrict use of the source under the MIT License.

## Research benchmarks

The repository includes blind cross-schema and schema-evolution benchmarks. Oracles and hidden tests are kept out of model inputs. Frozen benchmark inputs must not be tuned after observing results.

Schema Evolution v2 is currently awaiting independent human review before its 72-call live run. See [PROJECT_STATUS_AND_ROADMAP.md](./PROJECT_STATUS_AND_ROADMAP.md) for evidence, caveats, decision gates, and the next steps.

## Contributing

Issues, experiments, documentation improvements, and code contributions are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md), especially the benchmark-integrity rules, before changing frozen inputs.

## License

L-Lang is available under the [MIT License](./LICENSE). You may use, copy, modify, distribute, sublicense, or sell copies subject to the license notice and disclaimer.
