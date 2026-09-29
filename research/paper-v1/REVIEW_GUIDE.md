# 課題とOracleのレビュー手順

`review-study`は[study draft](./study-draft.json)、各source、Oracleを読み、`review.json`、`review.md`、未記入の`review-record.template.json`を未使用の出力先に保存する。生成APIは呼ばず、入力も変更しない。資料の作成はreviewや承認を意味しない。

```sh
bun run src/paper-cli.ts review-study --study research/paper-v1/study-draft.json --out-dir artifacts/paper-v2/review-new
```

review者は課題ごとに、要求と期待値の一致、現行Predicate IRでの表現可能性、解決できない期待、入力契約の境界、既存課題との重複を確認する。`logic`と`contact`は既存例由来であり、未知課題やheld-out課題とは呼ばない。`boundary`と`unsupported`も現時点ではdraftである。レビュー結果と担当者は実際の確認後に別途記録する。

実際に確認した後、templateを別名の`review-record.json`へコピーし、課題ごとにsourceとOracleの作成者ID、reviewer ID、独立性の申告、UTC日時、確認メモの参照、5項目の判定を記入する。識別子は同じ人に同じ表記を使う。判定`fail`には該当項目のfindingを1件以上書く。`expressibility: pass`は表現可能／不能の分類が妥当という意味で、unsupported課題を必ず表現できるという意味ではない。`taskOverlap: pass`は既存例由来の説明が妥当という意味で、重複がないとの主張ではない。判断できない項目は`pending`のまま残す。

```sh
cp artifacts/paper-v7/review-new/review-record.template.json artifacts/paper-v7/review-new/review-record.json
bun run src/paper-cli.ts verify-study-review --study research/paper-v1/study-draft.json --record artifacts/paper-v7/review-new/review-record.json
```

検査は未記入なら`pending`・終了値1、差戻しなら`changes-requested`・終了値1、必要事項が全て肯定的なら`accepted`・終了値0、形式不正や対象変更なら終了値2を返す。現時点の研究用templateは未記入のまま保存している。recordHashは読んだ記録の識別用hashであり、署名や本人確認ではない。対象のstudy、reviewフラグ、モデル・予算、入力source・metadata・Oracle・fixture、pathを変更すると古い記録は不一致になる。古い記録を保持し、新しい資料を生成して変更点を人が確認する。hashだけを差し替えて受理を維持しない。

`readyForLive`がfalseの場合は`missingConditions`と`diagnostics`を読む。stateのfreeze、taskとOracleのreview、未解決事項、モデルとprovider、呼出し・token・時間の上限、study全体の呼出し予算、入力hashの固定、実行承認が必要である。fixtureの成績や`review.md`の作成をこれらの代用にしない。

reportは予定trialを分母とし、欠落trialと開発記録の欠損を別々に表示する。第三弾以降、pass trialのOracle case別採点記録を保存している。第六弾のbundle検証は保存ファイルのbyte一致と既存記録間の対応を確認する。これらはOracleの意味、独立レビュー、実行記録の外部的真正性を保証しない。review recordの検査結果も現行runnerのlive承認条件には組み込んでいない。`evidenceEligible`はfalseのままで、理由に`study-evidence-verifier-pending`を残す。実モデルによる追加live評価は未実施である。
