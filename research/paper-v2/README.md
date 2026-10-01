# AIレビュー指摘を反映した評価入力 v2

初めて確認する場合は、[L-Langの実行から始める検証手順書](./VALIDATION_WALKTHROUGH.md)に沿って進めてください。

2026-09-29。[v1への指摘](../paper-v1/reviews/2026-09-29-ai/REVIEW.md)を反映した新しいdraft。v1の入力・run・bundleは変更していない。レビュー対象は[study](./study-draft.json)、[全case確認表](./REVIEW_WORKSHEET.md)、[記入用template](./human-review.template.json)。人間のreview、freeze、live承認は未了。

## 修正内容

- logic：全8真理値と不正入力13件、計21件。
- contact：email欠損/null/空文字列/非空文字列×tierの8件と不正入力7件、計15件。
- boundary：有効enum3件と不正入力6件、計9件。大小比較ではなくhighとのカテゴリ一致と明示。
- unsupported：suffixの正常入力8件と不正入力4件、計12件。文字列内容を扱えない現行profileではunresolvedが期待されることを明記。

合計57件。Oracleは要求と契約からAIが改訂したもので、独立した人間による正しさ確認ではない。logic/contactのsourceは既存例のコピー、boundary/unsupportedはv1をAIが改訂。元の作成者の同定は未了。fixtureは既存合成応答のコピーで、boundaryだけsuite内sourceRevisionを修正版source hashへ更新した。これは新しいLLM応答ではない。

## あなたが行うレビュー

1. **要求だけを読む。** 各sourceのintent/requirements/contractを読み、「何ならtrueか」「不正入力か」「そもそも表現不能か」を自分の言葉で書く。コード実装を正解の根拠にしない。
2. **確認表を照合する。** 全caseについて自分の判断とOracle期待値を比較する。特にcontactの空文字列=true、null/欠損=false、unsupportedの@example.com=trueを確認する。メール形式の検証という別要件を付け足さない。
3. **抜けと分類を確認する。** logicは8通り全て、contactは状態×tier、boundaryは数値比較を主張していないこと、unsupportedは生成unresolvedを期待することを確認する。不明なIR/ABIの判断はpendingとし、理解できる人に確認を依頼する。
4. **記録する。** human-review.template.jsonをhuman-review.jsonとしてコピーし、確認した項目だけpass、不一致はfailとfinding、分からないものはpendingにする。担当者・作成者・日時・確認メモは事実だけ記入する。元著者が不明ならnullのまま残す。
5. **検査する。** 下記コマンドで記入漏れと対象hashを確認する。acceptedは記録の整合を示すだけで、live実行承認ではない。

プロジェクト所有者であることだけで独立性の有無は決まらない。ただしあなたが今回の課題・期待値の作成や実装に関与しているなら、自己レビューとして記録しindependent=trueにしない。作成から独立した別の人による確認が必要である。この会話でAIの修正を依頼したことや、記録検査が通ることだけを独立性の根拠にしない。AIが作った入力であることも明記する。

JSONを直接編集するのが難しければ、この会話へ「課題名／確認項目／判断／理由」を返してよい。記録への転記は支援できるが、あなたの判断・氏名・日時・独立性を推測して埋めることはしない。

```sh
cp research/paper-v2/human-review.template.json research/paper-v2/human-review.json
bun run src/paper-cli.ts verify-study-review --study research/paper-v2/study-draft.json --record research/paper-v2/human-review.json
```

cpはhuman-review.jsonが未作成の場合だけ行う。未記入は終了値1が正常。研究入力を変更したら記録hashだけを差し替えず、資料を再生成して再確認する。

## 未解決の扱いと評価範囲

live実施前の課題別判断案は次のとおり。この案自体も人間のレビュー対象であり、外部preregistrationではない。

| 課題 | 期待する生成状態 | 意味Oracle |
| --- | --- | --- |
| logic/contact/boundary | pass | 全case一致を別に確認する |
| unsupported | unresolved | 未実行が想定どおり。Oracle passとは数えない |

unsupportedがpassした場合は「未解決検出に失敗」として記録し、意味Oracleも別に読む。error/stopped/uncertainは期待するunresolvedと同一視しない。unresolved検出はunsupportedの1課題分、生成成功は全4課題の内訳と、表現可能な3課題の内訳を両方示し、失敗を分母から事後除外しない。現行reportはこの課題別期待との比較を自動集計しないため、表に明示して確認する。

明示undefinedはJSON Oracleに含められない。contactの欠損と明示undefinedはhostのencodeInputで同じ存在状態になることを別途確認した。これは意味Oracleの57件には含めず、JSON入力範囲とhost契約確認を区別する。

## 検証記録

`python3 research/paper-v2/check-oracles.py`で生成物を読まずに57期待値を照合。logicの誤式a&&(b===c)はtruth-110で、contactのBoolean(email)による誤った存在判定はpremium-emptyで拒否する。

fixture初回はboundaryの旧sourceRevisionを拒否した。この記録はartifacts/paper-v2-revision/fixtureに保持。新版fixtureのsourceRevisionを更新後、fixture-finalは生成pass 3/unresolved 1、Oracle pass 3/not-run 1。表現可能3課題の45caseが採点対象で、unsupportedの12caseを実行成功に数えない。report-final/summary.jsonはevidenceEligible=false。review-finalのtemplateも全て未記入である。

検証は修正後に実施したオフライン確認であり、新しい実モデル成功率・第三者再現の証拠ではない。
