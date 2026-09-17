# L-Lang — Staged Semantic TypeScript

[日本語](./README.md) · [Project status and roadmap](./PROJECT_STATUS_AND_ROADMAP.md) · [Quality gates](./QUALITY_GATES.md) · [Post-MVP implementation plan](./POST_MVP_IMPLEMENTATION_PLAN.md) · [Security](./SECURITY.md) · [Contributing](./CONTRIBUTING.md) · [MIT License](./LICENSE)

> **Turn abstract intent into deterministic TypeScript that fits the project’s types, tests, and history.**
>
> Keep the speed of vibe coding while confining LLM flexibility to a verifiable build-time transformation.

L-Lang is a research compiler and TypeScript DSL that turns natural-language Concepts into pure Boolean predicates or static boolean constants adapted to project-specific TypeScript types, Semantic Tests, and prior semantic history. Its central value is turning an underspecified request into an implementation that fits the project without prescribing every detail.

The LLM does not generate unrestricted code. At compile time it returns a restricted Semantic IR. L-Lang validates that IR against the type context, semantic tests, and the full project test suite before deterministically converting it into ordinary TypeScript. Generated runtime code does not require an LLM, the L-Lang DSL, or an API key.

The [seven-stage Hybrid Compiler demo](./examples/hybrid-wasm-scenarios/README.md) (Japanese) also imports existing TypeScript types and restricted predicates statically and produces reproducible Wasm artifacts. Its 30 cases progress from booleans through nullable values and composite business rules to Unicode enums.

The [browser-based World Clock Wasm demo](./examples/saaa-world-clock/README.md) (Japanese) is an end-to-end example of SAAA shaping a conversational request into a UI capability. It deterministically generates a purpose-specific Wasm ABI and manifest, then renders live IANA timezone data through a host adapter.

An experimental path also compiles a limited predicate from JSON Prompt Source to WebAssembly without a TypeScript DSL. It supports source creation, updates scoped to requirement IDs, resolution into a separate Lock, and offline build/test/inspect. See the [usage guide](./examples/prompt-active-customer/README.md) and [results and limitations](./docs/PROMPT_SOURCE_RESULTS.md) (Japanese).

The [capability candidate workflow](./examples/capability-access/README.md) (Japanese) packages Wasm with its source and separate tests for offline verification in another process. SAAA acceptance and deployment remain future work.

The [development and repair workflow](./examples/capability-development/README.md) (Japanese) independently generates tests and implementation, checks mutants, and replays one repair without SAAA.

> [!IMPORTANT]
> This project is a research MVP. `semantic build` **automatically promotes** the generated artifact and `semantic.lock` after restricted-IR validation, type-context validation, Semantic Tests, and full-project regression checks pass. Semantic TDD mechanically validates Test Plan traceability, the Red Certificate, and mutation detection. The trust boundary is machine-checked project fit.
> Semantic TDD also automatically freezes its Test Plan after trace, type, and Red validation and before implementation synthesis.

## 1. The problem L-Lang is exploring

Conventional software implements the same business meaning as a separate condition for every schema.

```text
Storefront: customer.status === "active" && customer.email !== null
Back office: account.enabled === true && account.contactAddress !== null
Legacy:     record.stateCode === 1 && record.deletedAt === null
```

L-Lang moves the primary reusable asset from individual conditions to meaning, intent, and constraints.

```text
Project context
  Concept + types + Semantic Tests + prior history
                         │
                         ▼ build time only
              LLM maps meaning onto the type
                         │
                         ▼
                 Restricted Predicate IR
                         │
          ┌──────────────┴──────────────┐
          ▼                             ▼
   Validate with types/tests      unresolved if ambiguous
          │
          ▼
   Deterministic ordinary TypeScript
```

Binding one Concept to different types produces static implementations for environments with different names and representations. This project calls that property **Semantic Polymorphism**.

## 2. Intended and non-intended use

### Good fits

- Vibe coding from abstract requirements into project-fitting implementations
- Research into using an LLM as a safe compiler stage
- Pure, deterministic Boolean predicates
- Adapting one Concept to different TypeScript schemas
- Adapting abstract intent across schema evolution
- Boolean Static Judgments over natural-language values known at build time
- Experiments that constrain LLM output with an IR, types, tests, a lockfile, and audit logs

### Poor fits

- Authentication or authorization
- Money, billing, or accounting calculations
- Cryptography
- Database transactions or locking
- Network, filesystem, or secret-bearing effects
- Runtime LLM decisions
- Unrestricted TypeScript or arbitrary function generation

Keep these responsibilities in ordinary, human-owned TypeScript—what the project calls Exact Code.

## 3. Current implementation

| Area | Status | Current scope |
| --- | --- | --- |
| Predicate generation | Implemented | Generate pure boolean functions from a Concept and local record type |
| Semantic IR | Implemented | `all`, `any`, `not`, `equals`, and `present` |
| Semantic Test | Implemented | `accept` / `reject`, boundary, counterfactual, and invariance cases |
| Semantic Polymorphism | Implemented | Bind a shared Concept to multiple schemas |
| Static Judgment | MVP implemented | Freeze a literal string value into a boolean constant, with a blind benchmark freeze, Oracle separation, and fixture harness |
| Lock / Replay | Implemented | Deterministically regenerate from `semantic.lock` without an API |
| Candidate staging | Compatibility feature | `build --review → diff → approve` |
| Schema Evolution | Implemented, under evaluation | Type-aware 2-of-3 consensus, diff, and explicit approval |
| Explain | Implemented | Read-only explanation of lock state, input hashes, and artifact integrity |
| Semantic Closure | Project Fit-aware | Check manifest nodes, Context and validation provenance, and dependencies |
| Semantic Verify | Implemented | Read-only Closure, deterministic regeneration, Semantic Tests, and typecheck |
| Semantic TDD | Predicate POC implemented | Contract tracing, Test IR, Red Certificate, automatic Test Plan freeze, Selection Report, and read-only verification |
| Arbitrary code or effects | Unsupported | Deliberately outside the design |

See [PROJECT_STATUS_AND_ROADMAP.md](./PROJECT_STATUS_AND_ROADMAP.md) for detailed progress, unproven hypotheses, and the next evaluation gates.

## 4. Requirements

- [Bun](https://bun.sh/) 1.3.14
- TypeScript 5.9, installed by `bun install`
- An OpenAI or Azure OpenAI API key only for live resolution

Fixtures, lock replay, `semantic explain`, `semantic closure`, and `semantic verify` do not require an API key.

## 5. API-free quick start

```bash
git clone <repository-url>
cd L-Lang
bun install

bun run typecheck
bun test
```

Build a Predicate with a saved OpenAI response fixture.

```bash
bun run semantic build examples/active-customer/semantic.ts \
  --fixture examples/active-customer/openai-response.fixture.json
```

This command uses the same automatic-promotion path as a normal build. After validation succeeds, it finalizes:

- `examples/active-customer/is-active-customer.generated.ts`
- `semantic.lock`
- an audit record under `.semantic/candidates/<run-id>/`

Inspect the locked meaning and generated-artifact integrity without an API or mutations.

```bash
bun run semantic explain examples/active-customer/semantic.ts
bun run semantic:closure
bun run semantic:verify
```

## 6. The TypeScript DSL in 30 seconds

A semantic source contains the target type, Concept, generation target, and Semantic Test.

```ts
import {
  concept,
  generatePredicate,
  semanticTest,
} from "../../src/dsl";

type Customer = {
  status: "active" | "suspended";
  deletedAt: string | null;
  email: string | null;
};

const ActiveCustomer = concept<Customer>`
Definition:
An active customer is permitted to use the service.

Requirements:
- status is "active".
- deletedAt is null.
- email is present.

Exclusions:
- Suspended or deleted customers.

Out of scope:
- Email deliverability.

Leave unresolved when:
- Status, deletion, or email roles cannot be mapped unambiguously.
`;

export const isActiveCustomer = generatePredicate(ActiveCustomer);

semanticTest(isActiveCustomer, {
  accept: [
    { status: "active", deletedAt: null, email: "a@example.com" },
  ],
  reject: [
    { status: "suspended", deletedAt: null, email: "a@example.com" },
    { status: "active", deletedAt: null, email: null },
  ],
});
```

Only the Concept specification, target TypeScript declaration, and target metadata are sent to the LLM. The model never receives `semanticTest` values; L-Lang uses them as an independent post-resolution check.

The generated artifact is ordinary TypeScript.

```ts
// Generated by staged-semantic-typescript-mvp. Do not edit.
import type { Customer } from "./semantic";

export function isActiveCustomer(customer: Customer): boolean {
  return (
    customer.status === "active" &&
    customer.deletedAt === null &&
    (customer.email !== null && customer.email !== undefined)
  );
}
```

## 7. Concept specification

Concept bodies use named sections.

| Section | Required | Meaning |
| --- | --- | --- |
| `Definition` | Always | The central definition of the Concept |
| `Requirements` | One of these two for Predicates | Conditions required for membership |
| `Exclusions` | One of these two for Predicates | Conditions explicitly excluded |
| `Out of scope` | Optional | What the Concept does not decide |
| `Leave unresolved when` | Optional | Ambiguity that must stop resolution instead of being guessed |

Sections that are present must follow the table order, and list entries use one-line `- item` syntax. The compiler rejects the following before calling an LLM or fixture resolver:

- A missing `Definition`
- Unknown, duplicate, empty, or reordered sections
- Unsectioned free-form prose
- The legacy TOML form
- Template substitutions
- A Predicate Concept with neither `Requirements` nor `Exclusions`

Static Judgment may use a Definition-only Concept for simple classification.

## 8. Shared Concepts and Semantic Polymorphism

Define a type-independent Concept once.

```ts
// concepts/active-customer.ts
import { defineConcept } from "../src/dsl";

export const ActiveCustomer = defineConcept("customer.active")`
Definition:
A customer that is currently permitted to use the service.

Requirements:
- The account is enabled.
- A usable contact method is present.

Exclusions:
- Suspended or deleted accounts.

Leave unresolved when:
- A required semantic role cannot be mapped uniquely.
`;
```

Bind it in each schema.

```ts
const ActiveServiceAccount =
  bindConcept<ServiceAccount>(ActiveCustomer);

export const isActiveServiceAccount =
  generatePredicate(ActiveServiceAccount);
```

Executable examples:

```bash
bun run semantic:test:customer-schema
bun run semantic:test:account-schema
bun run semantic:fulfillment:test
```

See [`examples/semantic-polymorphism/`](./examples/semantic-polymorphism/) and [`examples/order-fulfillment/`](./examples/order-fulfillment/) for the corresponding sources.

## 9. Automatic adaptation and promotion

The default path adapts a candidate to project context, validates it mechanically, and commits it.

| Path | Purpose | Artifact and lock update |
| --- | --- | --- |
| `semantic build` | Default vibe-coding path | Automatically promotes after machine validation |
| `semantic build --review` | Compatibility candidate staging | Saves a candidate; `approve` applies it |
| `semantic replay` | Reproduce a locked result | Finalizes after validation |
| `semantic check` | Re-adapt after schema change | Creates a consensus candidate |
| `semantic approve` | Explicitly apply a staged candidate | Revalidates and promotes |

### Default automatic promotion

```bash
bun run semantic build <semantic-source.ts>
```

On a lock miss, L-Lang calls the LLM once. It automatically updates the generated artifact and `semantic.lock` after the candidate passes:

1. Strict IR parsing
2. Property-path and literal validation against the TypeScript context
3. Deterministic code generation
4. Candidate-specific type checking
5. Candidate-specific Semantic Tests
6. Full-project type checking
7. Full-project tests
8. Lockfile persistence

On failure, promotion stops and the previous generated artifact and lock are restored.

### Compatibility candidate staging

```bash
bun run semantic build <semantic-source.ts> --review
bun run semantic diff <review-id>
bun run semantic approve <review-id> --reviewer <id>
```

`--review` remains as a staging mechanism for compatibility with existing workflows. It stores the validated candidate and diff under `.semantic/reviews/` without updating tracked artifacts until explicitly applied. L-Lang’s primary workflow and value proposition are the automatic adaptation performed by ordinary `semantic build`.

### Semantic TDD (Predicate POC)

Semantic TDD independently generates a Test Plan from only the Contract and type, automatically freezes it into `semantic-test.lock` after trace, type, and pre-implementation Red validation, and only then synthesizes the implementation.

```bash
# Machine-validate and automatically freeze the Test Plan before implementation
bun run semantic tdd-build examples/active-customer/semantic.ts \
  --test-fixture examples/active-customer/semantic-test-response.fixture.json \
  --fixture examples/active-customer/openai-response.fixture.json

# Verify without API calls or writes, or replay from both locks
bun run semantic tdd-test examples/active-customer/semantic.ts
bun run semantic tdd-replay examples/active-customer/semantic.ts
```

`tdd-build` does not give the Test Synthesizer an Implementation IR, generated TypeScript, or candidate results. Automatic freeze requires complete hard-clause tracing and a pre-implementation Red check. `tdd-plan → diff → approve` remains only as compatibility staging for existing workflows. `tdd-test` read-only checks the Contract, both locks, generated hash, Red Certificate, and Selection Report.

## 10. CLI reference

| Command | API use | Main behavior |
| --- | --- | --- |
| `semantic build <source>` | Only on a lock miss | Build a Predicate or Static Judgment and automatically promote by default |
| `semantic build <source> --review` | Only on a lock miss | Save a validated review candidate |
| `semantic replay <source>` | Never | Regenerate and revalidate from a matching lock entry |
| `semantic test <source>` | Never | Run interpretation and Semantic Tests for a locked Predicate |
| `semantic check <source>` | When inputs changed | Create a Schema Evolution candidate with 2-of-3 consensus |
| `semantic diff <candidate-id>` | Never | Display a review or evolution candidate |
| `semantic approve <candidate-id> --reviewer <id>` | Never | Revalidate and promote a candidate |
| `semantic explain <source>` | Never | Read-only explanation of source, lock, and artifact |
| `semantic closure <manifest>` | Never | Read-only multi-artifact check including Context and validation provenance |
| `semantic verify <manifest>` | Never | Run Closure, deterministic regeneration, Semantic Tests, and typecheck |
| `semantic tdd-plan <source>` | 0 with a fixture, 1 live | Save an implementation-blind candidate for staged freeze |
| `semantic tdd-build <source>` | Only on each lock miss | Validate and freeze the Test Plan first, then validate and promote a Predicate |
| `semantic tdd-test <source>` | Never | Read-only verification of plans, implementation, artifact, and proof records |
| `semantic tdd-replay <source>` | Never | Re-run the Semantic TDD transaction from both locks |

### Fixtures

`build` and `check` can consume a saved Responses API response.

```bash
bun run semantic build <source> --fixture <response.json>
bun run semantic check <source> --fixture <response.json>
```

Fixture use does not count as an API call.

### Consensus

`semantic check` defaults to three samples with a quorum of two. Responses start concurrently, and L-Lang finalizes a candidate only when two type-aware semantic signatures agree.

```bash
# Default 2-of-3 consensus
bun run semantic check <source>

# Legacy single-sample mode
bun run semantic check <source> --samples 1 --quorum 1
```

## 11. Static Judgment

L-Lang can classify a literal natural-language value that exists at build time and freeze the result as an ordinary boolean constant.

```ts
import { judgeStatic, staticValue } from "../../src/dsl";
import { Cat } from "./cat";

const mike = staticValue(`
  A small domesticated calico animal that meows.
`);

export const mikeIsCat = judgeStatic(mike, Cat);
```

Generated artifact:

```ts
// Generated by the semantic compiler. Do not edit.
export const mikeIsCat = true as const;
```

API-free fixture build and lock replay:

```bash
bun run semantic:judgment:fixture
bun run semantic:judgment:replay
```

The blind benchmark foundation keeps model input, Oracle, and three fixture results in separate files. It runs read-only evaluation only when every frozen input hash, including the manifest, matches. The manifest `profile` is either `fixture` or `held-out`; `held-out` requires exactly 48 cases.

```bash
bun run benchmark:static-judgment:fixture -- <manifest> --json
```

Oracle labels and hidden reasons are not included in model requests. Fixture-runner reports set `evidenceEligible: false` regardless of profile: fixture success validates the harness, not model accuracy. The current MVP supports one `staticValue`, one `judgeStatic`, and a boolean result per source. It rejects runtime variables, function results, and template substitutions before resolution. The independent 48-case dataset and live judgment-accuracy evaluation remain incomplete.

## 12. Explain and Closure

### Semantic Explain

```bash
bun run semantic explain examples/active-customer/semantic.ts
bun run semantic explain examples/static-judgment/semantic.ts
bun run semantic explain examples/active-customer/semantic.ts --json
```

`explain` reads only the source, `semantic.lock`, and generated TypeScript. It never calls an API or resolver and does not build, update the lock, or create audit data.

| Status | Meaning |
| --- | --- |
| `current` | Current inputs, lock entry, and generated hash match |
| `stale` | A history entry exists for the source/symbol, but semantic inputs changed |
| `unlocked` | No matching lock entry exists |
| `integrity-error` | A current lock entry exists, but the artifact is missing or has the wrong hash |

The current `explain` command does not provide a CI-oriented `--strict` mode or status-specific exit codes.

### Semantic Closure

```bash
bun run semantic:closure
bun run semantic closure semantic-closure.json --json
```

Closure checks the declared Predicates and Static Judgments in a manifest and builds a Project Fit-aware graph.

- Every node is `current`: `closed`, exit code 0
- Any `stale`, `unlocked`, `integrity-error`, `verification-required`, or `dependency-open` node: `open`, exit code 2
- Invalid manifest, source, lock, or graph: exit code 1

Closure does not discover the entire repository automatically. Nodes and dependency edges must be declared in the manifest, and the current report does not establish domain correctness itself.

### Semantic Verify

```bash
bun run semantic:verify
bun run semantic verify semantic-closure.json --json
```

This command combines Closure, deterministic regeneration from the lock, each Predicate's Semantic Tests, and project typecheck without API calls or persistent writes. Text and JSON reports include concrete remediation. Verification failures exit 2; operational errors such as invalid manifests or I/O failures exit 1.

## 13. OpenAI and Azure OpenAI

Copy `.env.example`. Bun loads `.env` without an additional dotenv dependency.

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

The default `OPENAI_MODEL` is `gpt-5.4-mini`. For Azure, set the deployment name rather than a model ID. L-Lang detects `.openai.azure.com`, normalizes the endpoint to `/openai/v1/responses`, and uses the `api-key` header. Standard OpenAI connections use Bearer authentication.

Requests use Responses API Structured Outputs and set `store: false`.

## 14. Trust boundary and data

### Sent to the model

- Concept ID and Concept specification
- Target TypeScript declaration
- Target symbol, parameter, and type names

### Not sent in normal model input

- `semanticTest` values
- Benchmark Oracles
- Hidden cases
- The whole repository
- API keys

### Stored locally

- Model response and metadata
- Resolved IR or boolean
- Candidate code and validation reports
- Input and output hashes
- Promotion provenance

Audit data is stored under `.semantic/` and ignored by Git. Inspect it before external sharing, and do not place confidential information in Concepts or type declarations.

Automatic promotion trusts machine gates—restricted IR, type-context validation, candidate tests, full regression tests, and a crash-consistent transaction. Promotions are serialized with a workspace lock, and previous/next bytes plus a journal support rollback or commit verification after interruption. These improve project fit but do not prove that the generated behavior is always correct for the business domain.

See [SECURITY.md](./SECURITY.md) for more detail.

## 15. Reproducibility and audit

`semantic.lock` stores Predicates and Static Judgments in separate namespaces and records:

- Source, Concept, type, test, and prompt hashes
- Resolved Predicate IR or boolean
- Provider/model and token metadata
- Generated-code SHA-256
- Creation time
- promotion provenance (`reviewed` is a legacy name from compatibility staging)

When an entry matches the current semantic inputs, `replay` reproduces the same generated-code hash without connecting to the provider or model.

Audit directories:

| Directory | Contents |
| --- | --- |
| `.semantic/candidates/` | Predicate build attempts |
| `.semantic/judgments/` | Static Judgment attempts |
| `.semantic/reviews/` | Compatibility staging candidates |
| `.semantic/evolution/` | Schema Evolution candidates |
| `.semantic/benchmarks/` | Benchmark reports and responses |
| `.semantic/transactions/` | Previous/next promotion snapshots and state journals |

CLI failures carry a stable `SEMANTIC_*` code, stage, message, and remediation. Commands that accept `--json` emit the same code in a version 1 JSON error contract. Credential-like values are redacted from messages.

## 16. Examples and benchmarks

### Executable examples

| Example | Demonstrates |
| --- | --- |
| [`examples/active-customer/`](./examples/active-customer/) | Basic Predicate build, replay, and test |
| [`examples/semantic-polymorphism/`](./examples/semantic-polymorphism/) | Binding a shared Concept to two schemas |
| [`examples/order-fulfillment/`](./examples/order-fulfillment/) | Elaborating one Concept into three business representations |
| [`examples/static-judgment/`](./examples/static-judgment/) | Freezing a literal natural-language value into a boolean |
| [`semantic-closure.json`](./semantic-closure.json) | Multi-artifact Closure manifest |

### Current evidence

Local verification as of 2026-07-25:

- TypeScript typecheck passed
- Sample Semantic Closure: 4/4 nodes Project Fit verified
- `semantic verify`: 4/4 deterministic regenerations, 3/3 Predicate Semantic Tests, and typecheck passed

Saved research results:

| Evaluation | Result | Caveat |
| --- | --- | --- |
| Blind Cross-schema | 27/27 trials passed, 0 false resolutions | Limited to 3 Concepts and 9 schemas |
| Prior Schema Evolution evaluation | 50/54 trials passed, 0 false resolutions | Single responses still vary |
| Consensus replay over prior responses | 18/18 cases passed | Post-hoc reuse of the same responses; not held out |
| Schema Evolution | Not run | Waiting for the design blocker to be resolved and a new frozen input |

The current design has unresolved questions around `present` versus “usable,”
optional nullable semantics, and independence from prior evaluation inputs.
The current input will not be edited and reused as successful evidence. A new
held-out evaluation will run only after the restart conditions are satisfied.
See [`benchmarks/schema-evolution/BLOCKER.md`](./benchmarks/schema-evolution/BLOCKER.md).

## 17. Current limitations

- One Concept, one generated Predicate, and one `semanticTest` per Predicate source
- One `staticValue` and one `judgeStatic` per Static Judgment source
- One source and one symbol per `semantic explain`
- Predicate IR is limited to `all`, `any`, `not`, `equals`, and `present`
- Predicate IR is capped at 256 nodes, depth 32, 64 conditions per array, and 8 property-path segments
- Fixture/API JSON is capped at 2 MiB, `semantic.lock` at 16 MiB, and diagnostics at 32 items of 2,000 characters each
- No collection-wide `some`, `every`, or length comparison
- Input types are limited to local records, primitives, literal unions, arrays, `null`, `undefined`, and nesting up to three levels
- Semantic Test property generators and shrinkers are not implemented
- Closure requires an explicit manifest and does not auto-discover the import graph
- No automatic repair
- Static Judgment live accuracy is unmeasured
- The independent Schema Evolution held-out evaluation and measured developer Pilot are incomplete
- No LSP, custom syntax, custom runtime, or non-TypeScript backend
- Not published as an npm package
- Multi-file atomic visibility is not guaranteed to non-L-Lang processes reading during promotion
- Workspace-lock contention fails fast with `SEMANTIC_WORKSPACE_BUSY` instead of waiting

## 18. Repository map

```text
src/
  dsl.ts                         Compile-time forms embedded in TypeScript
  semantic-source.ts             Predicate source scanner
  static-judgment-source.ts      Static Judgment source scanner
  ir.ts                          Restricted Predicate IR
  context-validator.ts           IR validation against TypeScript context
  generator.ts                   Deterministic Predicate generator
  semantic-compiler.ts           Predicate compiler transaction
  static-judgment-compiler.ts    Static Judgment compiler transaction
  static-judgment-benchmark.ts   Blind benchmark read-only execution and reporting
  static-judgment-benchmark-parser.ts  Strict manifest, freeze, and Oracle parser
  semantic-pipeline.ts           Shared compiler run, audit, and command infrastructure
  semantic-transaction.ts        Workspace lock, journal, and recovery
  semantic-limits.ts             IR and external-input resource budgets
  semantic-error.ts              Stable error codes and safe diagnostics
  semantic-review.ts             Compatibility staging workflow
  semantic-evolution.ts          Schema Evolution workflow
  semantic-explain.ts            Read-only explanation
  semantic-closure.ts            Artifact-level Closure
  semantic-test-runner.ts        Read-only extended Semantic Test execution
  semantic-verify.ts             Project-level aggregate read-only verification

concepts/                        Shared Concepts
examples/                        Executable fixtures and generated artifacts
benchmarks/                      Frozen evaluation inputs, Oracles, and results
semantic.lock                   Reproducible resolutions
```

## 19. Development

```bash
bun install
bun run check
bun run coverage
bun run ci:docs
bun run ci:smoke
bun run ci:protected
git diff --check
```

[`QUALITY_GATES.md`](./QUALITY_GATES.md) is the source of truth for pinned tool versions, coverage thresholds, the CI OS matrix, and how current results are recorded. Test counts and measured coverage are produced by each CI run instead of being copied into this README.

Preserve these principles when making changes:

- Never execute unrestricted TypeScript returned by an LLM
- Give each new generation target its own IR, validator, deterministic generator, and tests
- Do not guess ambiguous inputs into a resolved result
- Do not use Oracles or hidden cases as model input or consensus-selection signals
- Do not tune frozen benchmarks after observing results
- Preserve the boundary between Exact Code and Semantic Code

See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## 20. License

L-Lang is available under the [MIT License](./LICENSE). You may use, copy, modify, distribute, sublicense, and sell copies as long as the license notice and disclaimer are preserved.

`private: true` in `package.json` prevents accidental npm publication. It does not restrict source use under the MIT License.
