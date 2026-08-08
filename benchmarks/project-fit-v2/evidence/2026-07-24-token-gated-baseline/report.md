# project-fit-v2

- Status: failed
- Freeze: frozen
- Provider/model: azure-openai/gpt-5-4-mini
- Context version: 1
- Manifest SHA-256: 93fdea485138a4b323e7b49048c77f1d1a0db8c1b5853015613293942f40f15c

## Initial generation

| Arm | First-pass fit | Unresolved | False resolutions | Median correction | Input tokens | Output tokens | Latency ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| typeOnly | 0/18 | 18 | 0 | 1 | 8295 | 2475 | 58281.81700000027 |
| projectContext | 18/18 | 0 | 0 | 0 | 12741 | 2347 | 37763.37104299986 |

- First-pass delta: 18
- Unresolved-rate delta: -1
- Median correction delta: -1
- Input-token delta: 4446
- Latency delta ms: -20518.44595700041
- Gate status: failed
- minimumProjectContextFirstPass: true
- minimumFirstPassDelta: true
- falseResolutionDelta: true
- unresolvedRateRegression: true
- inputTokenBudget: false
- latencyBudget: true
- projectContextFalseResolutionSafety: true

## Schema change

| Arm | First-pass fit | Unresolved | False resolutions | Median correction | Input tokens | Output tokens | Latency ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| typeOnly | 0/0 | 0 | 0 | 0 | 0 | 0 | 0 |
| projectContext | 0/0 | 0 | 0 | 0 | 0 | 0 | 0 |

- First-pass delta: 0
- Unresolved-rate delta: 0
- Median correction delta: 0
- Input-token delta: 0
- Latency delta ms: 0
- Gate status: not-run

## Safety

- False resolutions: 0
- Workspace mutations: 0
- Context contamination: 0
- Integrity incidents: 0
- Gate C passed: false
- Estimated cost: 0.037476
- initialGeneration: false
- schemaChange: false
- totalInputTokenBudget: true
- totalOutputTokenBudget: true
- estimatedCostBudget: true
- falseResolutionSafety: true
