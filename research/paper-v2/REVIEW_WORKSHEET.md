# 修正版のレビュー用一覧

まず各sourceの要求を読み、期待結果を自分で考えてから下表と照合してください。チェック欄は未記入です。判断できない場合は保留にします。

## logic

[要求と入力契約](./logic-source.json) / [Oracle](./logic-oracle-draft.json)

| 確認 | ID | 入力 | Oracle期待値 |
| --- | --- | --- | --- |
| 未確認 | truth-000 | `{"a": false, "b": false, "c": false}` | false |
| 未確認 | truth-001 | `{"a": false, "b": false, "c": true}` | false |
| 未確認 | truth-010 | `{"a": false, "b": true, "c": false}` | false |
| 未確認 | truth-011 | `{"a": false, "b": true, "c": true}` | false |
| 未確認 | truth-100 | `{"a": true, "b": false, "c": false}` | true |
| 未確認 | truth-101 | `{"a": true, "b": false, "c": true}` | false |
| 未確認 | truth-110 | `{"a": true, "b": true, "c": false}` | true |
| 未確認 | truth-111 | `{"a": true, "b": true, "c": true}` | true |
| 未確認 | missing-a | `{"b": true, "c": false}` | INVALID_INPUT |
| 未確認 | null-a | `{"a": null, "b": true, "c": false}` | INVALID_INPUT |
| 未確認 | string-a | `{"a": "true", "b": true, "c": false}` | INVALID_INPUT |
| 未確認 | number-a | `{"a": 1, "b": true, "c": false}` | INVALID_INPUT |
| 未確認 | missing-b | `{"a": true, "c": false}` | INVALID_INPUT |
| 未確認 | null-b | `{"a": true, "b": null, "c": false}` | INVALID_INPUT |
| 未確認 | string-b | `{"a": true, "b": "true", "c": false}` | INVALID_INPUT |
| 未確認 | number-b | `{"a": true, "b": 1, "c": false}` | INVALID_INPUT |
| 未確認 | missing-c | `{"a": true, "b": true}` | INVALID_INPUT |
| 未確認 | null-c | `{"a": true, "b": true, "c": null}` | INVALID_INPUT |
| 未確認 | string-c | `{"a": true, "b": true, "c": "true"}` | INVALID_INPUT |
| 未確認 | number-c | `{"a": true, "b": true, "c": 1}` | INVALID_INPUT |
| 未確認 | unknown-field | `{"a": true, "b": true, "c": false, "extra": true}` | INVALID_INPUT |

## contact

[要求と入力契約](./contact-source.json) / [Oracle](./contact-oracle-draft.json)

| 確認 | ID | 入力 | Oracle期待値 |
| --- | --- | --- | --- |
| 未確認 | basic-missing | `{"tier": "basic"}` | false |
| 未確認 | basic-null | `{"tier": "basic", "email": null}` | false |
| 未確認 | basic-empty | `{"tier": "basic", "email": ""}` | false |
| 未確認 | basic-text | `{"tier": "basic", "email": "x"}` | false |
| 未確認 | premium-missing | `{"tier": "premium"}` | false |
| 未確認 | premium-null | `{"tier": "premium", "email": null}` | false |
| 未確認 | premium-empty | `{"tier": "premium", "email": ""}` | true |
| 未確認 | premium-text | `{"tier": "premium", "email": "x"}` | true |
| 未確認 | email-number | `{"email": 1, "tier": "premium"}` | INVALID_INPUT |
| 未確認 | email-boolean | `{"email": true, "tier": "premium"}` | INVALID_INPUT |
| 未確認 | missing-tier | `{"email": "x"}` | INVALID_INPUT |
| 未確認 | null-tier | `{"email": "x", "tier": null}` | INVALID_INPUT |
| 未確認 | number-tier | `{"email": "x", "tier": 1}` | INVALID_INPUT |
| 未確認 | unknown-tier | `{"email": "x", "tier": "vip"}` | INVALID_INPUT |
| 未確認 | unknown-field | `{"email": "x", "tier": "premium", "extra": true}` | INVALID_INPUT |

## boundary

[要求と入力契約](./boundary-source.json) / [Oracle](./boundary-oracle-draft.json)

| 確認 | ID | 入力 | Oracle期待値 |
| --- | --- | --- | --- |
| 未確認 | high | `{"level": "high"}` | true |
| 未確認 | medium | `{"level": "medium"}` | false |
| 未確認 | low | `{"level": "low"}` | false |
| 未確認 | outside-enum | `{"level": "critical"}` | INVALID_INPUT |
| 未確認 | missing | `{}` | INVALID_INPUT |
| 未確認 | null | `{"level": null}` | INVALID_INPUT |
| 未確認 | number | `{"level": 1}` | INVALID_INPUT |
| 未確認 | boolean | `{"level": true}` | INVALID_INPUT |
| 未確認 | unknown-field | `{"level": "high", "extra": true}` | INVALID_INPUT |

## unsupported

[要求と入力契約](./unsupported-source.json) / [Oracle](./unsupported-oracle-draft.json)

| 確認 | ID | 入力 | Oracle期待値 |
| --- | --- | --- | --- |
| 未確認 | matching | `{"email": "a@example.com"}` | true |
| 未確認 | other | `{"email": "a@other.com"}` | false |
| 未確認 | different-local | `{"email": "other@example.com"}` | true |
| 未確認 | empty | `{"email": ""}` | false |
| 未確認 | trailing-text | `{"email": "a@example.com.extra"}` | false |
| 未確認 | subdomain | `{"email": "a@sub.example.com"}` | false |
| 未確認 | empty-local | `{"email": "@example.com"}` | true |
| 未確認 | uppercase-domain | `{"email": "a@EXAMPLE.COM"}` | false |
| 未確認 | missing | `{}` | INVALID_INPUT |
| 未確認 | null | `{"email": null}` | INVALID_INPUT |
| 未確認 | number | `{"email": 1}` | INVALID_INPUT |
| 未確認 | unknown-field | `{"email": "a@example.com", "extra": true}` | INVALID_INPUT |

