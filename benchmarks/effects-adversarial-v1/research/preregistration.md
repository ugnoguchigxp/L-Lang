# Effects preregistration template

Unregistered fixture template. No independent identities, external timestamp or reproduction record has been supplied.

The machine-readable analysis and sample-size plans are authoritative. These choices require independent review before confirmatory use.

## Analysis contract

```json
{
  "format": "llang-effects-analysis-plan",
  "version": 1,
  "id": "effects-fixture",
  "revision": 1,
  "researchQuestions": [
    {
      "id": "RQ1",
      "question": "Does the assurance mechanism improve adversarial violation-free completion on the frozen dataset?",
      "lane": "confirmatory"
    },
    {
      "id": "RQ2",
      "question": "Is normal completion maintained within the preregistered margin?",
      "lane": "confirmatory"
    },
    {
      "id": "RQ3",
      "question": "How do outcomes vary by category and task family?",
      "lane": "exploratory"
    },
    {
      "id": "RQ4",
      "question": "What runtime, verification, artifact and description costs are observed?",
      "lane": "exploratory"
    }
  ],
  "primaryArms": [
    "llang",
    "typescript"
  ],
  "unitOfAnalysis": "normal-adversarial-case-pair",
  "repetitionReduction": "all-repetitions-must-pass",
  "familyAggregation": "equal-weight-family-means",
  "hypotheses": [
    {
      "id": "adversarial-efficacy",
      "rq": "RQ1",
      "endpoint": "adversarial-violation-free-completion",
      "estimand": "llang-minus-typescript",
      "alternative": "superiority",
      "minimumPracticalDifference": 0.05,
      "decisionRule": "simultaneous-lower-bound-exceeds-margin"
    },
    {
      "id": "normal-maintenance",
      "rq": "RQ2",
      "endpoint": "normal-completion",
      "estimand": "llang-minus-typescript",
      "alternative": "noninferiority",
      "minimumPracticalDifference": 0.05,
      "decisionRule": "simultaneous-lower-bound-exceeds-margin"
    }
  ],
  "statistics": {
    "method": "paired-family-hoeffding-v1",
    "confidenceLevel": 0.95,
    "test": "hoeffding-one-sided-bound",
    "multiplicity": "bonferroni-two-confirmatory-endpoints",
    "secondary": "exploratory-no-confirmatory-claims",
    "seed": 20260920,
    "digits": 6,
    "softwareVersion": "llang-effects-analysis-v1"
  },
  "missingness": {
    "failed": "failure",
    "timeout": "failure",
    "unknown": "missing",
    "uncertain": "missing",
    "excluded": "retain-with-reason",
    "primary": "complete-pairs-with-attrition",
    "sensitivity": "missing-llang-failure-typescript-success",
    "emptyAnalysis": "not-estimable"
  },
  "stopping": "fixed-sample-no-optional-stopping",
  "ablations": {
    "lane": "exploratory-separate",
    "omissionReason": "Fixture template only; fair runnable ablations have not been implemented or independently reviewed."
  },
  "validity": {
    "construct": "Host operation and flow observations are proxies for the specified mechanism, not general safety.",
    "internal": "Arm implementation differences, order, reviewer bias and Oracle leakage require independent review.",
    "external": "Synthetic fixture tasks and the common host do not represent deployed applications.",
    "conclusion": "Independent-family assumptions, missingness and conservative bounds limit interpretation; repeated trials are not independent cases."
  }
}
```

## Precision contract

```json
{
  "format": "llang-effects-sample-size-plan",
  "version": 1,
  "method": "paired-family-hoeffding-precision-v1",
  "formula": "ceil(2*ln(2*endpoints/alpha)/(halfWidth*halfWidth))",
  "softwareVersion": "llang-effects-analysis-v1",
  "seed": 20260920,
  "alpha": 0.05,
  "endpoints": 2,
  "halfWidth": 1,
  "pairsPerFamily": 1,
  "independentFamilies": 9,
  "requiredCasePairs": 9,
  "assumptions": {
    "independentFamilies": true,
    "withinFamilyDependence": "arbitrary",
    "pairedDifferenceRange": [
      -1,
      1
    ],
    "repetitionsIncreaseSampleSize": false
  },
  "purpose": "fixture"
}
```

Each family mean is in [-1, 1]. For n independent families and half-width h, the two-sided Hoeffding bound is 2 exp(-n h^2 / 2). Bonferroni over two endpoints gives n = ceil(2 ln(4 / 0.05) / h^2). This is a conservative precision bound, not a power calculation or a guarantee of family independence. Within-family dependence is unrestricted; repetition never increases n.

Reference: [Hoeffding (1963)](https://doi.org/10.1080/01621459.1963.10500830). The seed is committed for the later runner; this analytic formula uses no random draws.

## Registration status

```json
{
  "format": "llang-effects-preregistration-bundle",
  "version": 1,
  "analysisHash": "8079544e5726f62a42f2f1288e63e3dbbf147858ea78c7bb1f8abc0b7fe7e9c5",
  "sampleSizeHash": "0b48fca5327c181cc8f28a798850dd75104d75abf0ee1fcdb8f7bff2807ca8c3",
  "claimsHash": "e77e1eaab40e33ab129261a6d36d959295c2e891adc85a7a92186e7e214767dc",
  "registered": false,
  "externalTimestamp": null,
  "independentlyReproduced": false,
  "independentReproductionRecord": null,
  "evidenceEligible": false,
  "ethics": {
    "humanParticipants": false,
    "realCredentials": false,
    "realBusinessData": false,
    "externalNetwork": false,
    "externalRegistrationPerformed": false
  },
  "externalGates": [
    "independent-dataset-author",
    "independent-domain-review",
    "immutable-external-timestamp",
    "owner-run-approval",
    "third-party-reproduction"
  ]
}
```
