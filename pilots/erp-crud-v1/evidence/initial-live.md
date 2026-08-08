# ERP CRUD Private Pilot — initial live result

Recorded: 2026-07-24

Result: **passed**

Azure OpenAI `gpt-5-4-mini` evaluated the eight frozen initial-generation cases. All eight resolved on the first response and passed every hidden case.

| Metric | Result |
| --- | ---: |
| First-pass Project Fit | 8/8 |
| Hidden cases | 25/25 |
| False resolutions | 0 |
| API attempts | 8 |
| Completed 60-second cooldowns | 8 |
| HTTP 429 / API errors | 0 / 0 |
| Input / output tokens | 4,477 / 1,048 |
| Provider latency | 18,955.27 ms |
| Estimated cost | $0.00807375 |
| Business writes / external I/O | 0 / 0 |
| Workspace mutations | 0 |
| Confidential-data incidents | 0 |

The reviewer `Jane Doe` and the eight `Doe` case owners are synthetic Pilot identities assigned by user direction. They authorize this synthetic shadow run but do not constitute external ERP domain validation.

## Artifact hashes

| Artifact | SHA-256 |
| --- | --- |
| Frozen manifest | `828ffc25e2e4fad7e0799171e0eacfe9036174c8234bbbc21ad184f03b55ef48` |
| Approved review | `b7849ff7daa6e2ffd2a5c64abc4b7a433e247c90b8af656fb2aafb67c10e1bd4` |
| Freeze metadata | `460ddd39c8cd8f5c5a87943cd90443df92ff122cfac458707c5f4905f2909eeb` |
| Live report JSON | `7dd2607546021451809e92462f1c2083c30d081640d23e60ec22177a79a5c21c` |
| Live report Markdown | `bb8f971404584150ff997fd91e1be7edec613ef44bf408dac781373cd8ff73c7` |
| Sanitized responses | `ecea479a9f71219939da64ab37aec7b49c182c396e018b053f70861cd06ed3da` |
| Final checkpoint | `74400d4f4878ffef41d1046cea10b35226087b5f97deae352bf52acaf68f4108` |

The machine-readable evidence is [`initial-live.json`](./initial-live.json).

Human baseline authoring and review time were not measured, so this result establishes initial-generation correctness and operational safety, not a time-saving claim. Schema Evolution remains a separate stage.
