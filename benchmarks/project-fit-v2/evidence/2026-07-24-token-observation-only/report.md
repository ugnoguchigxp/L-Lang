# project-fit-v2

- Status: passed
- Freeze: frozen
- Provider/model: azure-openai/gpt-5-4-mini
- Context version: 1
- Manifest SHA-256: 37af7c7cc6d1f2baf49a1ecbd4e4cd51fe0d2e2a7035ab3d3cc488f108853323

## Initial generation

| Arm | First-pass fit | Unresolved | False resolutions | Median correction | Input tokens | Output tokens | Latency ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| typeOnly | 0/18 | 18 | 0 | 1 | 8295 | 2250 | 48180.80850299979 |
| projectContext | 18/18 | 0 | 0 | 0 | 12741 | 2455 | 38034.66666500039 |

- First-pass delta: 18
- Unresolved-rate delta: -1
- Median correction delta: -1
- Input-token delta: 4446
- Latency delta ms: -10146.1418379994
- Gate status: passed
- minimumProjectContextFirstPass: true
- minimumFirstPassDelta: true
- falseResolutionDelta: true
- unresolvedRateRegression: true
- latencyBudget: true
- projectContextFalseResolutionSafety: true

## Schema change

| Arm | First-pass fit | Unresolved | False resolutions | Median correction | Input tokens | Output tokens | Latency ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| typeOnly | 1/18 | 17 | 0 | 1 | 8406 | 2751 | 40726.76837400207 |
| projectContext | 18/18 | 0 | 0 | 0 | 12999 | 2545 | 34716.056749000214 |

- First-pass delta: 17
- Unresolved-rate delta: -0.9444444444444444
- Median correction delta: -1
- Input-token delta: 4593
- Latency delta ms: -6010.711625001859
- Gate status: passed
- minimumProjectContextFirstPass: true
- minimumFirstPassDelta: true
- falseResolutionDelta: true
- unresolvedRateRegression: true
- latencyBudget: true
- projectContextFalseResolutionSafety: true

## Safety

- False resolutions: 0
- Workspace mutations: 0
- Context contamination: 0
- Integrity incidents: 0
- Gate C passed: true
- Estimated cost: 0.07683525
- initialGeneration: true
- schemaChange: true
- estimatedCostBudget: true
- falseResolutionSafety: true
