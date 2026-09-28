# 課題とOracleのレビュー手順

`review-study`は[study draft](./study-draft.json)、各source、Oracleを読み、`review.json`と`review.md`を未使用の出力先に保存する。生成APIは呼ばず、入力も変更しない。資料の作成はreviewや承認を意味しない。

```sh
bun run src/paper-cli.ts review-study --study research/paper-v1/study-draft.json --out-dir artifacts/paper-v2/review-new
```

review者は課題ごとに、要求と期待値の一致、現行Predicate IRでの表現可能性、解決できない期待、入力契約の境界、既存課題との重複を確認する。`logic`と`contact`は既存例由来であり、未知課題やheld-out課題とは呼ばない。`boundary`と`unsupported`も現時点ではdraftである。レビュー結果と担当者は実際の確認後に別途記録する。

`readyForLive`がfalseの場合は`missingConditions`と`diagnostics`を読む。stateのfreeze、taskとOracleのreview、未解決事項、モデルとprovider、呼出し・token・時間の上限、study全体の呼出し予算、入力hashの固定、実行承認が必要である。fixtureの成績や`review.md`の作成をこれらの代用にしない。

第二弾のreportは予定trialを分母とし、欠落trialと開発記録の欠損を別々に表示する。`recordIntegrity: verified`は保存runと開発記録の対応を示す値であり、Oracleの意味や実行記録の外部的真正性を保証しない。現行runnerはOracleのcase別採点記録を保存していないため、`evidenceEligible`はfalseのままとし、理由に`study-evidence-verifier-pending`を残す。実モデルによる追加live評価は未実施である。
