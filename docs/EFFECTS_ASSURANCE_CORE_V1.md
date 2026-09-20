# Effects assurance core v1

更新: 2026-09-20。

Effects assurance core v1は、要求、trust/data boundary、bundle、grant、実行証跡、三roleの署名、監査、決定的summaryを一つの検証chainへ結び付けるopt-in profileです。

## 入力とartifact

- `llang-effects-requirements` version 1
- `llang-effects-trust-boundary` version 1
- requirement approval payload version 2
- execution intent／report version 4
- execution attestation payload version 2
- audit attestation payload version 2
- `attestation-summary.json`／`.md`

version 1〜3の実行証跡は互換のまま残りますが、trust/data分離を評価済みとは表示しません。

## 検査するもの

- boundaryとrequirements、approval、program hashのbinding。
- checked Effects IRに現れる全operationのsource／sink coverage。
- operation requestがcompiler検査済みの固定値であり、runtime responseからauthority-bearing valueを作らないこと。
- 保守的なnode順序に基づくsource-to-sink候補がallowlist内であること。
- transcriptで観測したoperationとsource／sink commitment。
- boundary、static provenance、observed flowがexecution／audit署名へ含まれること。
- summaryが署名packageの検証済みbytesだけから決定的に生成されること。

現行Effects IRのoperation requestはcompile時に固定されます。解析器は任意のTypeScript、Wasm、program内部memoryを動的taint追跡しません。将来、responseから次のrequestを動的構築するIRを追加する場合は、対応するprovenance規則なしにcore v1として受理しません。

## 検査しないもの

- 自然言語要求とcontractの意味的同値性。
- 外部dataの真実性や無害性。
- 許可済みflowの業務上の妥当性。
- host OS、adapter、外部serviceの健全性。
- freshness、one-time approval、remote attestation。
- 人間の理解向上や通常TypeScriptに対する優位性。

## 評価用fixture

`llang-effects-adversarial-protocol` version 1は、L-LangとTypeScript armで同じinput、grant、Oracle、host profile、budgetを固定します。checked-in fixtureはharness回帰用であり、`evidenceEligible: false`、`humanEvaluation: not-run`、`liveEvaluation: not-run`です。

独立dataset、実モデル、人間参加者を使う評価は[研究評価の実行条件](../RESEARCH_EVALUATION_PREREQUISITES.md)に従い、別途承認して実行します。
