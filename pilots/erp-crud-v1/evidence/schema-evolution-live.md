# ERP CRUD Private Pilot — Schema Evolution live result

Recorded: 2026-07-24

Result: **passed**

The same eight Concepts were applied to nested and renamed ERP Schemas using three independent Azure OpenAI `gpt-5-4-mini` responses per case and a type-aware 2/3 quorum.

| Metric | Result |
| --- | ---: |
| Consensus quorum | 8/8 |
| Unanimous semantic signatures | 8/8 |
| Resolved / unresolved / no quorum | 8 / 0 / 0 |
| Changed-Schema hidden cases | 16/16 |
| False resolutions | 0 |
| API attempts | 24 |
| Completed 60-second cooldowns | 24 |
| HTTP 429 / API errors | 0 / 0 |
| Input / output tokens | 13,701 / 3,035 |
| Provider latency | 51,026.48 ms |
| Estimated cost | $0.02393325 |
| Business writes / external I/O | 0 / 0 |
| Workspace mutations | 0 |

All three samples produced the same type-aware semantic signature in all eight cases.

## Artifact hashes

| Artifact | SHA-256 |
| --- | --- |
| Frozen Schema Evolution manifest | `18cd33dd432218eb773ca7a2bb8c47b1876a6976412dfb69a484d5d92de49191` |
| Schema Evolution freeze metadata | `b506685896a9c76f22d3d8d946dfbc6a0c54072706bfef6b84681e049b21b06d` |
| Consensus report JSON | `d39c0cd2b0674cacefb8cc55c0186fb848d50d4aeb0f2f22eede5027d54e8880` |
| Consensus report Markdown | `0e472e3c3913e9ad6931d217c4ca0cbca8730b8bddd0674eecc9e11aa818dd3d` |
| Sample 1 report / responses | `470e6dfa9851c1a9f239d607e221b901b27dcc9563100944eb5a90b8dc2cb9a9` / `e8639d1f574c3f5c30b4091d34c81bdbb06544afd4085c612ad7b47f1aa6e607` |
| Sample 2 report / responses | `348fbcc6fd3962f54b970183d4a4c26ce16b2f07d86531319b9b30267f91ebc6` / `6ce0c5aa513a05d572b63a55bc0a69a4eba6b503b92f49c5787f1538e1f57740` |
| Sample 3 report / responses | `20e385f6369c0d5e98e2f1323b41beca0fd5229d987f70ce24b162dde5fda875` / `2ee5f1378d95ce1d4560c428b1eda86aba4be5fd44077abadbc9d3b3cba242c6` |

The machine-readable evidence is [`schema-evolution-live.json`](./schema-evolution-live.json).

This is ERP-specific Schema Evolution evidence. Human baseline change time and external ERP domain validation remain unmeasured.
