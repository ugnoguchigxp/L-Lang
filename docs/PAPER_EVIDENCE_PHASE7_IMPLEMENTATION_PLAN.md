# 論文根拠充足・第七弾 実装計画

作成：2026-09-29。状態：実装済み（結果は[実装結果](./PAPER_EVIDENCE_RESULTS.md)を参照）。想定実装者：GPT-6 Sol（`gpt-6-sol`）、low effort。

関連：[第六弾](./PAPER_EVIDENCE_PHASE6_IMPLEMENTATION_PLAN.md)、[実装結果](./PAPER_EVIDENCE_RESULTS.md)、[根拠一覧](./PAPER_EVIDENCE_PLAN.md)、[レビュー手順](../research/paper-v1/REVIEW_GUIDE.md)。本書は第七弾の追加仕様を定める。

## 1．今回の一回分

**課題・Oracleを確認した人の判断を、対象studyと入力hashに結び付けて保存し、未確認・差戻し・入力変更をオフラインで検出する。** 対応項目はE05・E08。

現在のreview-studyは資料を作り、study/task/Oracleにはreviewの文字列があるが、誰が何を確認したかを検査する形式はない。第六弾のbundle検証はbyte保存と記録間の整合を扱い、独立レビューを代替しない。今回は実際のレビュー作業へ渡す記入用ファイルと、その記録の検査を一つの変更として実装する。

第六弾の結果文書は対象80 pass、coverage 922 pass、全体check等の通過を報告している。本計画作成では再実行していない。実装開始時にbaselineを取る。

### 範囲外

- 人間の判断・担当者・独立性・確認日時をAIが推測して埋めること。
- 課題・Oracleの変更、新しいdataset・モデル・反復数・予算の決定。
- study/task/Oracleのreviewフラグ、state、frozenHashes、approvalの自動更新。
- live実行、runnerの承認条件変更、入力snapshotやbundleへの新record組込み。
- evidenceEligibleのtrue化、署名・本人確認・外部timestamp。
- compiler・ABI・研究用run schemaの変更、lock回復、公開・外部送信。

この回の完成物はレビューの記録と照合を支える道具である。独立レビューそのものは人が実施して記入した後に別途確認する。レビュー記録が整っても、モデル・予算・実行承認や研究証拠全体の完成を意味しない。

## 2．変更箇所と実装順序

| 箇所 | 変更 |
| --- | --- |
| 新規 `src/paper-study-review.ts` とtest | 記録template、strict parser、対象hash・担当者申告・判断の照合 |
| `src/paper-study.ts` | saveStudyReviewが同じloaded inputsから記入用templateも保存 |
| `src/paper-cli.ts` とtest | verify-study-reviewを追加。既存review-studyの引数は維持 |
| `research/paper-v1/REVIEW_GUIDE.md` | 記入手順、対象変更時の再確認、現在の証跡説明を更新 |
| 結果文書・再現README | 実装と実際の独立レビューの状態を分離して追記 |

依存方向はstudy/CLI → study-review → study-inputs・study-validation・既存hash。study-reviewからstudy/reportをimportしない。入力はloadStudyInputsで一度読み、validateLoadedStudyと同じ値から対象hashを作る。資料生成後に元入力を再読込みしない。

実装順序はbaseline→record型とparser→template→純粋な照合→CLI→未記入・差戻し・変更試験→Gate。新しい汎用承認システムやユーザー管理は作らない。

## 3．記録の形式

review-studyの出力に`review-record.template.json`を追加する。既存review.json/review.mdの形式と戻り値は維持し、Markdown末尾へ記入先と検査方法を追記する。出力先は従来どおり未使用directory、追加ファイルもwxで保存する。

templateは入力内容とhashのみ埋め、全判断をpending、担当者・日時・参照をnullにする。ユーザーはtemplateを別名のreview-record.jsonへコピーして記入する。生成器は記入済みファイルを上書きしない。

### 固定field

| field | 内容 |
| --- | --- |
| version | 1 |
| format | llang-paper-study-review |
| studyId | 対象study.id |
| studyHash | parse済みstudy全体のcontentHash |
| inputHashes | validateLoadedStudyが返す全hash集合。fixture参照があればfixtureも含む |
| tasks | study.tasks順のtask record。欠落・重複・未知ID・順序変更を拒否 |

各task recordのfieldは`taskId, sourceAuthors, oracleAuthors, reviewer, independent, reviewedAt, recordReference, checks, findings`に固定する。

- sourceAuthors/oracleAuthors：null、または1件以上の識別子string配列。trim後空、重複は禁止。templateはnull。人物を区別できるプロジェクト内の識別子を使い、個人情報を必要以上に集めない。
- reviewer：nullまたは非空識別子string。
- independent：nullまたはboolean。「担当実装・課題作成・Oracle作成から独立して確認した」というreviewerの申告。
- reviewedAt：nullまたは正規のUTC日時`YYYY-MM-DDTHH:mm:ss.sssZ`。DateのparseとtoISOStringの一致で検査し、実在しない日時を拒否する。実際の確認後に記入する。
- recordReference：nullまたは非空string。実際のreviewメモ・議事記録等の参照。文字列として保存し、URL取得やpath読込みはしない。
- checks：下記5 fieldを全て持ち、それぞれpending/pass/fail。
- findings：`{ check, note }`の配列。checkは下記項目名、noteは非空string。未記入templateは空配列。

checksの固定項目：

| key | 人が確認する対象 |
| --- | --- |
| requirements | 自然言語要求とOracle期待値の対応 |
| expressibility | 現行predicate-i32-v1で表現できる範囲 |
| unresolved | 表現不能・解決不能をどの条件で未解決とするか |
| inputBoundaries | 入力契約、境界値、不正入力の期待 |
| taskOverlap | 既存例との重複と課題の由来の説明 |

expressibilityのpassは「必ず表現できる」ではなく「表現可能／不能の分類が妥当」を意味する。unsupported課題の正当なunresolved期待をfailと混同しない。taskOverlapも重複の不存在を要求せず、既存例由来の説明が適切かを判断する。判定不能な項目はpendingのまま残す。

record全体に判断の総合statusやchecksumは持たせない。人が編集する際にchecksumの手計算を要求せず、総合statusは検査時に導出する。検査出力にはrecord全体のcontentHashを付け、後からどの記録を確認したかを識別する。これは署名ではない。

全階層の未知field・必須field欠落・型不正・enum不正を拒否する。stringはtrimした値と元値が一致することを要求し、暗黙の正規化をしない。識別子の比較は大文字小文字を区別する。別名で同一人物を装うことは検出できないので、IDの一貫した記入を手順書で求める。

## 4．対象との照合と判断

新CLI：

```text
verify-study-review --study <study.json> --record <review-record.json>
```

read-onlyでstdoutに結果JSONを返す。ファイル作成、入力書換え、API接続、モデル初期化、Wasm compile/instantiate/evaluateは行わない。

1. recordを一度読みstrict parseする。
2. studyと全入力を一度読み、既存validationを適用する。
3. validation.diagnosticsがあれば入力不正として拒否する。missingConditionsは通常draftにもあるため、これだけではレビュー記録の照合を失敗にしない。
4. studyId・studyHash・inputHashesのキー集合と値、taskのID・順序・件数を完全照合する。fixtureを使わないreviewでも、参照fixtureの変更を黙って許容しない。
5. 担当者と判断の記入状態からtask statusを導出する。
6. 全taskからoverall statusを導出し、recordHashを含めて返す。

### task statusの優先順位

- `changes-requested`：checksにfailが一つ以上、またはindependent=false、またはreviewerがsourceAuthors/oracleAuthorsのいずれかに含まれる。
- `pending`：上記がなく、checksにpending、担当者等の必須記入がnull、またはindependentがnull。
- `accepted`：全checksがpass、全記入が揃い、independent=true、reviewerと両author集合が重複しない。

failの各項目にはそのcheckに対応するfindingを1件以上必要とする。独立性不成立は機械的reasonで説明し、架空のfindingを追加しない。passのfindingは補足として許容し、自由文を機械解釈して合否を覆さない。failなのにfindingがない記録は「理由記入不足」としてoverall pendingへ丸めず、record不正で終了値2にする。

overallはchanges-requestedを優先し、なければpendingが一つでもあればpending、全task acceptedならaccepted。順序はstudy順で固定する。taskごとのreason codeは重複なし・辞書順にする。

固定reason codeは`checks-failed, checks-pending, authors-missing, reviewer-missing, independence-unconfirmed, independence-declined, reviewer-is-author, reviewed-at-missing, reference-missing`。対応する条件が成立したものを全て列挙する。authors-missingは片方でもnull、independence-unconfirmedはnull、reviewer-is-authorは比較可能なauthor集合に一致した場合とする。

### 出力と終了値

固定fieldは`version: 1, format: llang-paper-study-review-verification, studyId, studyHash, recordHash, status, tasks, evidenceEligible: false`。tasksの各行は`taskId, status, reasons`。

- accepted：終了値0。
- pending/changes-requested：正常な検査結果としてJSONを返し終了値1。
- schema不正、対象hash不一致、入力欠損/不正：throw。CLI entry pointが終了値2にする。

acceptedは「入力に対応した、必要項目が揃う肯定的なレビュー記録」である。独立性の本人確認や判断内容の正しさを機械的に証明した意味ではない。出力をreadyForLiveや研究適格性に転用しない。

## 5．hashとレビュー運用

この回はstudyの全体hashをそのまま使い、reviewフラグ等を除いた別の意味hashは導入しない。review/state/frozenHashes/モデル/予算等を変更してもstudyHashは変わるので、前の記録の検査は不一致になる。Oracle.reviewの変更もinputHashesが変わる。pathだけの変更も対象変更として扱う。

入力を変えた場合、古いreview-recordを保持したうえで新しいreview-studyを実行し、変更点を確認して新しい記録を作る。hashだけを自動差し替えしてacceptedを維持しない。review済みフラグを書いたこと自体をレビューの証拠とは扱わない。最終freeze・承認との接続は今回の対象外であり、runnerはまだこの記録を必須入力としていないことを明記する。

実装時には実データのtemplateを作るところまでに留める。accepted/changes-requestedの試験はtest用の架空識別子・一時directoryで行い、実際の研究review記録として保存・報告しない。

REVIEW_GUIDEには、現在の「case別採点記録がない」という古い説明を修正する。第三弾のcase証跡、第六弾のbundle照合は実装済みだが、Oracleの独立レビューや新規live実測は別の残条件であることを示す。過去の第二弾の結果自体を書き換えない。

## 6．必須test

| ID | ケース | 期待結果 |
| --- | --- | --- |
| P7-01 | 現行4課題のreview-study | 既存2資料とtemplate。全担当者null、checks pending、findings空 |
| P7-02 | 未記入templateをverify | pending、終了値1、eligible false |
| P7-03 | test用accepted record | 全項目・対象一致でaccepted、終了値0 |
| P7-04 | 一つのcheck failとfinding | changes-requested、終了値1。ほかのpendingより優先 |
| P7-05 | failにfindingなし | 記録不正で終了値2 |
| P7-06 | independent false／reviewerがauthor | changes-requested。author本人の確認を独立reviewとしない |
| P7-07 | 著者の片方、reviewer、日時、参照がnull | pendingと対応reason。全check passだけで受理しない |
| P7-08 | source/metadata/Oracle/fixtureの変更 | inputHashes不一致で拒否 |
| P7-09 | モデル・予算・reviewフラグ・path等の変更 | studyHashまたはinputHashes不一致で拒否 |
| P7-10 | taskの欠落・追加・重複・順序変更 | 対象不一致で拒否 |
| P7-11 | 未知field・enum不正・空/重複ID・日時不正 | strict parseで拒否 |
| P7-12 | unsupportedと既存例由来task | 妥当な不能判定/由来確認をpassとして扱える |
| P7-13 | source等が欠損、study不正 | 終了値2、元入力不変 |
| P7-14 | validationのmissingConditionsのみ | draftのレビュー検査が可能。readyForLiveは変えない |
| P7-15 | 読込み後の元入力変更hook | 1回の読込みに基づく整合した出力。後のverifyでは変更拒否 |
| P7-16 | 参照stringにURL・path | fetch/readしない。ネットワーク・Wasm実行0 |
| P7-17 | 同じ記録の検査2回 | recordHash/status/reasons一致。判断statusを保存値から信用しない |
| P7-18 | 既存CLI・runner・report・bundle | 既存契約とeligible false維持。研究入力のreview状態不変 |

recordHashを持つ結果が示すのは、そのコマンドで読んだ入力と記録の関係である。複数ファイルの同時刻取得や実行中変更の完全防止は今回実装しない。

## 7．実行と完了条件

開始時baseline：

```sh
bun test src/paper-study.test.ts src/paper-study-inputs.test.ts src/paper-study-validation.test.ts src/paper-cli.test.ts
```

実装後は新規paper-study-review.test.tsを加え、report/bundleへの回帰も確認する。CLI一巡は新しい出力先で行う。

```sh
bun run src/paper-cli.ts review-study --study research/paper-v1/study-draft.json --out-dir artifacts/paper-v7/review-new
bun run src/paper-cli.ts verify-study-review --study research/paper-v1/study-draft.json --record artifacts/paper-v7/review-new/review-record.template.json
```

1本目は終了値0、2本目は未記入なので終了値1が期待値。これを失敗として実際のreview欄を埋めて通さない。新CLIのhelp/testを更新する。

品質Gateは順に実行する。

```sh
bun run check
bun run coverage
bun run ci:docs
bun run ci:protected
bun run ci:smoke
git diff --check
```

今回の回帰は修正して再検証する。別領域の既知失敗が再発した場合は切分けログと未通過Gateを明記する。既存の作業差分と未追跡成果を保持する。

- [x] P7-01〜18とCLI一巡、Gate結果を記録した。
- [x] 実際の研究用templateに担当者・判断を捏造していない。
- [x] 入力変更時の不一致、差戻し、未記入、記録不正を区別できる。
- [x] study/Oracle/承認/既存run・bundleを変更していない。
- [x] 結果文書へHEAD・未commit差分・検証・保存先・残条件を追記した。
- [x] REVIEW_GUIDEの古い証跡説明を修正し、人が次に何を記入するかを示した。

実装後は、このtemplateを使った実際の課題・Oracle reviewを次の研究作業とする。自動で第八弾の基盤拡張やlive実行へ進まない。モデル・反復・予算・freeze・承認の確定は[研究評価の実行条件](../RESEARCH_EVALUATION_PREREQUISITES.md)と併せて別途扱う。

## 8．実装者へ渡す依頼文

```text
docs/PAPER_EVIDENCE_PHASE7_IMPLEMENTATION_PLAN.md の第七弾だけを実装してください。
GPT-6 Sol / low effort向けに第2節の順で進めてください。
対象は課題・Oracleのレビュー記入用templateと対象hash付きの記録検査です。
既存review-studyに未記入templateを追加し、verify-study-reviewを実装してください。
P7-01〜18、CLI一巡、品質Gateを実施してください。
実際の研究入力の担当者・独立性・判断を推測して記入しないでください。
reviewフラグ、freeze、承認、runner条件、evidenceEligibleを自動更新しないでください。
新規live呼出し、公開、compiler変更は行わないでください。
結果をdocs/PAPER_EVIDENCE_RESULTS.mdへ追記し、実際の人によるレビューを残条件として終了してください。
```
