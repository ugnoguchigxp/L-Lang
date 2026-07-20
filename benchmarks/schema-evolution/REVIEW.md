# Blind Schema Evolution v1 review

This review must be completed before the live Azure OpenAI run. The reviewer must not use model outputs from this benchmark when deciding expected results.

## Review checklist

- Confirm the three Concept definitions express the intended business semantics.
- Confirm every evolved schema represents the stated change type and does not contain accidental semantic hints.
- Confirm all `add-property`, `rename`, `representation`, and `optionality` oracles contain the expected Predicate IR.
- Confirm all `remove-role` and `ambiguity` cases should be `unresolved` rather than guessed.
- Confirm hidden cases cover the positive case and every required negative condition.
- Do not change any reviewed input after recording approval. A changed input will fail its frozen SHA-256 check.

## Matrix

| Concept | add-property | rename | representation | optionality | remove-role | ambiguity |
| --- | --- | --- | --- | --- | --- | --- |
| Active Customer | compatible | compatible | compatible | compatible | unresolved | unresolved |
| Shippable Order | compatible | compatible | compatible | compatible | unresolved | unresolved |
| Publishable Article | compatible | compatible | compatible | compatible | unresolved | unresolved |

## Record approval

After review, edit only the review metadata in `freeze.json`:

```json
{
  "status": "human-reviewed",
  "humanReviewed": true,
  "reviewer": "reviewer name or identifier",
  "reviewedAt": "2026-07-20T00:00:00.000Z"
}
```

Do not regenerate hashes to conceal a post-review input change. Then run:

```bash
bun run benchmark:schema-evolution
```
