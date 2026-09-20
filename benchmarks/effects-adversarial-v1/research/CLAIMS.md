# Effects claim-to-evidence matrix

Status: research comparison not-run; evidenceEligible: false.

```json
{
  "format": "llang-effects-claims",
  "version": 1,
  "claims": [
    {
      "id": "fixture-fault-detection",
      "minimumEvidence": "E1",
      "population": "Synthetic negative fixtures",
      "endpoint": null,
      "limitations": "Harness regression only; not an empirical comparison."
    },
    {
      "id": "adversarial-mechanism-efficacy",
      "minimumEvidence": "E2",
      "population": "Independently reviewed frozen dataset and common host",
      "endpoint": "adversarial-violation-free-completion",
      "limitations": "Requires frozen analysis, independent review, timestamp and complete confirmatory observations."
    },
    {
      "id": "normal-completion-maintenance",
      "minimumEvidence": "E2",
      "population": "Normal pairs in the independently reviewed frozen dataset",
      "endpoint": "normal-completion",
      "limitations": "Requires normal-completion confidence bounds, attrition and worst-case sensitivity; does not prove production safety."
    }
  ],
  "unsupportedClaims": [
    "live-model-generation-quality",
    "human-auditability",
    "general-typescript-superiority",
    "production-safety"
  ]
}
```
