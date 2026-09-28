# 論文根拠充足・第二弾 実装計画

作成：2026-09-27。状態：未着手。想定実装者：GPT-6 Sol（`gpt-6-sol`）、low effort。

文書レビュー反映：2026-09-27。第二弾ではOracle証跡の新形式を作らず、未検証の値を適格扱いしない。実装仕様が全体計画の概略と異なる場合、第二弾の範囲では本書を優先する。

関連：[第一弾の結果](./PAPER_EVIDENCE_RESULTS.md)、[全体計画](./PAPER_EVIDENCE_IMPLEMENTATION_PLAN.md)、[根拠一覧](./PAPER_EVIDENCE_PLAN.md)、[論文草稿](./PAPER_DRAFT.md)。

## 1．今回の目的と一回分の範囲

第一弾では、全体計画の第1〜8回に相当するinventory、再現、Oracle評価、study runner、集計、隔離snapshot再現まで実装されている。第二弾ではこれらを再実装しない。

**今回の一回分は、studyと保存runの検査、予定trialを基準にした集計、証拠適格性の判定、レビュー用資料の出力までとする。** 既存runnerの実行方式を作り直さず、追加live評価に進む前の結果検査を完成させる。対応する根拠項目はE08・E11と、E05のレビュー準備である。

今回追加するものは、共通validation module一つ、既存study/report/CLIへの接続、回帰test、レビュー用文書である。新しい評価の実行、dataset確定、研究者のreviewそのものは含まない。

## 2．実装確認から分かった開始点

| 箇所 | 現在の実装 | 第二弾で直す点 |
| --- | --- | --- |
| `src/paper-study.ts: parseStudy` | `as Study`と部分的な検査。state/provider等は広いstring | 列挙値、必須値、数値範囲、IDを明示検査する |
| `validateStudy` | readinessに`state`を使っていない。hash mapをJSON文字列で比較 | draftをlive適格としない。hash集合をkey順に依存せず照合する |
| `src/paper-report.ts: buildPaperReport` | `plannedTrials`が保存された`rows.length` | studyのtask×repetitionsを正本とする。trial欠落で分母を減らさない |
| 同上 | `evidenceEligible: run.mode === "live"` | live指定だけでは証拠へ昇格させない |
| 同上 | `oracleStatus`、calls、tokens等を保存runから採用 | 値の型・状態整合とdevelopment記録への対応を検証する |
| `resumeStudy` | 保存runを型castして読む | 新しい共通parserで状態とIDを検証してから既存再開処理へ進む |

これらはコードを読んで確認した不足である。各修正では先に現行の失敗を示す回帰testを追加し、再現結果を残す。第一弾の全体テスト成功だけでこの境界が検証済みとはみなさない。

現在の作業ツリーには第一弾の多数の未追跡ファイルがある。第二弾の実装者は既存成果として保持し、自分が作成したものと混同しない。自動commit、削除、checkoutのリセットは行わない。

## 3．変更ファイルと順序

| 順序 | ファイル | 実装内容 |
| --- | --- | --- |
| 1 | `src/paper-study-validation.ts`（新規） | Study／StudyRun parser、予定trial列挙、hash集合比較、適格性診断 |
| 2 | `src/paper-study.ts` | 既存parserを共通化、readyForLive条件補完、resumeでrun検査 |
| 3 | `src/paper-report.ts` | 予定trialから行生成、状態・元記録照合、適格性理由の出力 |
| 4 | `src/paper-cli.ts` | `review-study`追加。既存CLI引数は維持 |
| 5 | 対応test | 第7節の回帰試験 |
| 6 | `research/paper-v1/REVIEW_GUIDE.md`（新規）、結果・草稿 | review手順と実装結果の反映 |

新規moduleは型・parser・純粋な照合処理を中心とし、モデル接続や子process起動を持たせない。既存の`parseDevelopmentRun`、`parseDevelopmentConfig`、`parsePaperOracle`、`resolveContainedFile`を使う。巨大な汎用schema frameworkや依存追加は不要である。

依存方向は`paper-study-validation → capability-development（既存config parser）`、`paper-study → paper-study-validation`、`paper-report → paper-study / paper-study-validation`とする。validation moduleからstudy/reportをimportしない。既存の`StudyRun`型のimport互換は`paper-study.ts`からのtype再exportで維持する。レビュー資料の生成・保存関数は`paper-study.ts`に置き、CLIは引数検査と呼出しに限定する。

## 4．実装仕様

### 4.1．StudyとStudyRunの検査

既存のversion 1 artifactを維持する。既存の正当なdraft・fixtureが読めることを回帰条件とする。不正なrecordを正当化するためにparserを緩めない。

- Studyの`state`は`draft | frozen`、`review`は`unreviewed | reviewed`、`approval`は`not-granted | granted`とする。task／Oracleのreviewも既存正当値に限定する。
- 今回のstudyで受理するproviderは`null | "codex-sdk"`に固定する。現行draftはnull、確認済みの接続例はcodex-sdkである。既存development CLIには環境変数で選ぶ直接API経路もあるが、study側のprovider名と接続先の対応が未定義なので今回のlive readiness対象に加えない。既存の直接API機能自体は変更しない。
- providerがcodex-sdkなら、設定検査時にも`agent: "codex-sdk"`を渡す。既存configが要求する`gpt-5.6-terra`との組合せを検査する。実装担当モデルのGPT-6 Solを実験モデルへ転記しない。環境から別providerを推測しない。
- task IDは非空かつパス要素として安全なASCII英数字・`_`・`-`に限定する。`..`、separator、絶対pathを拒否する。source等の入力pathは既存draftが使用する`../../examples/`を壊さない。IDと入力pathの制約を混同しない。
- 必須field、文字列配列、整数、正値、null許可を検査する。`maxCalls`等の実行条件は既存config parserに合わせる。`budget`の単位は現行のstudy全体の呼出し数であり、金額に読み替えない。
- draftでは未設定nullを許すが、live readinessでは全条件の設定を要求する。数値0、空文字、欠損、未知enumを設定済みとして扱わない。
- `frozenHashes`は必要keyの過不足と各digestを比較する。オブジェクトのkey順だけが違う場合は同じ集合として受理する。
- `state: frozen`、review、approval、未解決事項なし、実行条件、全入力hash照合のすべてが揃って初めて`readyForLive: true`とする。
- StudyRunはversion、mode、status、trial状態、非負整数のcalls/tokens、hash、nullable path等を検査する。studyから導出したID集合にないtrial、重複trial、taskIdの食い違いを拒否する。

parserは配列をobjectとして受け入れず、必須fieldの型・列挙値・範囲を明示検査する。Study／StudyTask／StudyRun／Trialの許可field集合は現行の型宣言を基準に固定し、未知fieldを拒否する。optionalは現行の`fixture`、`frozenHashes`のみを維持する。diagnostic用fieldは保存入力へ追加せずreport側へ出す。

`parsePaperOracle`にはexpected.value/codeの厳密な型検査がないため、今回のstudy検査で追加検査する。valueならboolean、errorなら`INVALID_INPUT`、case IDは非空string、inputは非nullのplain JSON objectとする。Oracle実行器の改造は不要である。

予定IDの照合はparserとは別の純粋関数にする。reportは欠落を許して可視化し、resumeは欠落・矛盾があればモデル接続より前に拒否する。`run.status: complete`なのにpendingがある場合もresumeで拒否する。既存testはこの区別に合わせる。

文書上のreviewやapprovalは実在の人の記録が必要である。チェック用fixtureで文字列を変更する試験は許すが、実datasetに同じ操作をしてreview済みにはしない。

### 4.2．予定trialからの集計

`study.tasks × repetitions`を期待されるtrial集合とする。IDは現行runnerと同じ`${task.id}-${index + 1}`で生成する。

1. reportの`tasks`と`plannedTrials`をstudyから計算する。
2. 保存runにないtrialは、集計上の`missing`行として出力する。run.jsonに補完書込みはしない。
3. 保存runが`complete`なのにtrialが欠落していれば診断を出し、研究適格性をfalseにする。表は欠測を可視化できるよう生成する。
4. 重複や未知trialは曖昧な集計になるため入力不正として終了値2で拒否する。
5. `pending`、`uncertain`、欠落を未完了として数える。`fail`、`unresolved`、`error`、`stopped`は終端観測として数えるが、成功には数えない。
6. `firstPass`／`repairedPass`はdevelopment記録のattemptに基づく。`oraclePass`は別列のままとし、生成suite成功と同一視しない。
7. developmentを持つtrialのsource・metadata hash、status、logicalCalls、usedTokensを元記録と照合する。本文に出す値をrunの自己申告だけから採らない。
8. `oracleStatus: pass/fail`は候補が存在しdevelopmentがpassの場合だけ許可する。`not-run`をfalse（失敗）に変換しない。

同じデータをreportとresumeで読む場合の扱いを次に固定する。

| 状態 | report | resume |
| --- | --- | --- |
| trial自体が欠落 | missing行を作る、適格性false | 入力不正で拒否。trialを勝手に追加しない |
| trial重複・未知ID・型不正・hash対応の矛盾 | 終了値2で拒否 | 終了値2で拒否 |
| developmentへの安全な相対pathはあるがファイルがない | 状態は保持し、成功フラグはfalse、記録不足を診断 | モデル接続前に拒否 |
| developmentが存在するが不正JSON・checksum不一致 | 終了値2で拒否 | 終了値2で拒否 |
| pending／uncertain | 未完了として表示。uncertainの部分記録は成功へ昇格しない | uncertainは既存どおり停止 |
| runがcompleteだがpending／uncertain／欠落あり | run状態矛盾を診断、適格性false | 拒否 |
| approvalがない・不正・別study | 表は出すが適格性false | liveは拒否 |

developmentがないpending／uncertain／dispatch前stoppedは現行runnerが生成し得る。calls/tokensは0、oracleStatusはnot-runを要求する。developmentがないpass/fail/unresolved/errorは記録不足とし、成功を推定しない。安全なpathの不存在とpath escapeを区別し、escape・symlinkによるroot外参照は拒否する。

`completedTrials`は終端状態の数、`missingTrials`は`plannedTrials - completedTrials`とする。recordが欠けた終端trialは`missingTrials`へ二重計上せず、追加の`incompleteEvidenceTrials`で数える。`recordedTrialCount`も出力する。これにより試行の欠測と証跡の欠損を分ける。

developmentが見つからない行のcalls/tokensは検証済み値ではないためreportではnullとする。0を捏造しない。CSVにはnullを空欄で出力し、既存の正常行の数値は維持する。すべてのtrialについてsourceHash・metadataHash・oracleHashをstudyの現行hashと照合する。出力行順はstudyのtask順、反復index順とする。

既存の`oracleStatus`に検証可能なcase-level recordが保存されていない問題は、次の段階で扱う。今回のreportはその不足を適格性理由として明示し、集計値を独立に再採点した値と表示しない。新しいOracle再実行基盤を今回へ追加しない。

### 4.3．証拠適格性の判定

summaryに`eligibilityReasons: string[]`と`recordIntegrity: "verified" | "incomplete"`を追加する。既存の`evidenceEligible`を削除せず、以下の条件をすべて満たす場合に限ってtrueにする。

- fixtureではない。
- studyがreview・freeze・実行条件を満たす。
- 元runのstudy hash・対象入力hashが現行の確認対象と対応する。
- approvalファイルが存在し、保存approval hashと一致する。既存のstudyHash、scope、reviewer、recordを照合する。
- 予定trialが揃い、pending／uncertain／欠落がない。
- developmentとtrialの対応が検証できる。
- Oracle採点を実施したtrialについて、採点結果と対象artifact／Oracleを検証できる証跡がある。

最後の条件を満たさない現行のstudy runは、値の集計は可能でも`evidenceEligible: false`とし、`oracle-evidence-not-recorded`を理由に残す。**第二弾の成功条件は適格性をtrueにすることではなく、証拠不足を正しく表示することである。** failやunresolvedがあること自体を不適格理由にしてはならない。負の結果も証拠となる。

この第二弾では、study run全体について`study-evidence-verifier-pending`を必ず理由に含め、`evidenceEligible`をfalseに保つ。Oracleを一度も実行しなかった全失敗runでも、条件が空集合になったことを理由にtrueへ昇格させない。将来のcase-level証跡や実行snapshotを推測して受け入れるコードは追加しない。上のtrue条件は後続で解除を検討するための要件であり、今回はその実装を含まない。

`recordIntegrity`は研究適格性と別の値である。study/run/developmentの対応がすべて検証できればverified、欠落や未完了があればincompleteとする。verifiedはOracleの意味や実測の真正性を証明しない。Oracle自己申告値の限界は`eligibilityReasons`へ出す。

理由codeを以下に固定する。該当するものをすべて集め、辞書順・重複なしで出力する。

`fixture-only`、`study-not-ready`、`approval-unavailable`、`approval-mismatch`、`missing-trials`、`unfinished-trials`、`run-status-inconsistent`、`development-evidence-missing`、`oracle-evidence-not-recorded`、`study-evidence-verifier-pending`。

study hashや参照データのhashが不一致なら、別の入力の表を出さず入力不正として拒否する。draft/review不足などの実行準備不足と、入力identityの破損を混同しない。

適格性は「正しい科学的結論が保証された」という意味ではない。review者の実在性や保存recordの外部的真正性を、この実装が保証するとは記載しない。

履歴access用の`saveAccessReport`は別経路として維持し、`past-live-replay`を新規liveに昇格しない。既存のfalseと限界を保持する。

### 4.4．レビュー用資料の出力

次のCLIを追加する。

```sh
bun run src/paper-cli.ts review-study --study research/paper-v1/study-draft.json --out-dir artifacts/paper-v2/review-new
```

出力は`review.json`と`review.md`。書込み先は未作成directoryに限定する。入力study・source・Oracleを編集しない。

資料に含めるもの：

- studyとtaskのhash、task ID、既存例由来／新draftの区分。
- 要求、入力契約、対象機能、Oracle case数と期待値。
- 未解決事項、未review、model/provider/予算の未設定一覧。
- 今回確認した4課題のうち、既存例に由来するものを未知・held-out課題と呼ばない注意。
- review者が確認する「要求と期待値の一致」「表現可能性」「未解決期待」「入力境界」「既存課題との重複」の欄。
- `readyForLive`と不足理由。review資料を作ったこと自体をreview完了としない。

実在するreview者名、承認、モデル・予算値を実装者が埋めない。draftをそのままreview可能な形へ出力するところまでを完成させる。

`review.json`はversion、studyId、studyHash、taskごとの要求・契約・Oracle・hash、diagnostics、missingConditions、readyForLiveを持つ。JSONの列挙順とMarkdownのtask順は入力study順に固定し、現在時刻など不要な変動値を含めない。要求文の`|`や改行はMarkdownを壊さない形でescapeする。レビュー用資料にOracleを含めるが、この出力をモデル生成入力へ渡す経路は追加しない。

CLI終了値：構造と参照が正しく資料を出せた場合は0（未reviewでも0）、課題内容の診断がある場合は資料を残して1、不正JSON・schema・読取り失敗は2。`report`は欠測・適格性falseを表現できた場合0、入力不正なら2。診断とコマンド失敗を区別する。

## 5．互換性と制限

- 第一弾の固定JSON、元live応答、凍結hash、Wasm、既存出力directoryを変更しない。
- 既存testの「draftでもstate以外を埋めればready」という期待は、今回の回帰修正として`state: frozen`を明示したfixtureへ更新する。実データは変更しない。
- 旧reportの不十分な適格性判定とのbyte互換は要求しない。旧artifactは残し、新出力へ生成する。
- 列追加・適格性の厳格化をREADMEと結果文書へ記録する。既存CSVの列名は維持し、必要な列を追加する。
- 実モデル呼出し、task追加、Wasm compiler変更、依存更新、他OS試験、外部公開は含めない。
- 実行中の入力差し替え対策、Oracle case-level証跡の保存、同時resume排他は次の実装候補であり、今回すべてをまとめない。現時点で本番live準備完了とは宣言しない。

## 6．Sol・low effort用の作業順

1. 本書と第一弾結果を読む。`git status --short`、`bun --version`を記録する。
2. `paper-study.ts`、`paper-report.ts`、`paper-cli.ts`と各testを読む。provider確認のために`capability-development-cli.ts`とconfig parserの該当箇所だけを読む。
3. 第7節のうち欠落分母、mode-only適格性、draft readinessの回帰testを先に追加する。修正前の結果を記録する。
4. 共通parser・予定trial列挙を実装する。
5. study validationとresumeへ接続する。runの欠落を再開で自動生成しない。reportでのみ欠測として可視化する。
6. reportを修正する。予定表、development照合、適格性理由の順に実装する。
7. review-studyと文書を追加する。
8. targeted test、fixture run、report、review資料を確認する。新規liveは呼ばない。
9. 品質Gateを実行し、結果文書に第二弾の節を追記する。第一弾の数値を現在の値で上書きしない。
10. 本書の完了条件を確認して終了する。次の実装候補へ自動で進まない。

## 7．必須の回帰test

| ID | 入力・操作 | 期待結果 |
| --- | --- | --- |
| P2-01 | 正常draft | 検査可能、readyForLive false |
| P2-02 | draftのままreview等を埋める | readyForLive false、state理由あり |
| P2-03 | 未知provider、空文字、欠損、負数、非整数 | 診断または入力拒否。live呼出し0 |
| P2-04 | 同じhash mapを異なるkey順にする | 同じ集合として受理 |
| P2-05 | hash mapの不足・追加key・値変更 | freeze不一致 |
| P2-06 | 正常4課題fixtureのtrialを1件削除 | plannedTrials 4、missingTrials 1、適格性false |
| P2-07 | trialを重複／未知IDに変更 | 入力不正で拒否 |
| P2-08 | task IDに`../`等を混入 | 出力pathを作る前に拒否 |
| P2-09 | calls/tokens/source hashをdevelopmentと不一致にする | 対応不一致で拒否 |
| P2-10 | pendingやfailへoracleStatus passを付ける | 矛盾として拒否 |
| P2-11 | fixture runのmodeだけliveにする | 適格性false。承認・設定等の不足理由あり |
| P2-12 | approval欠損／hash不一致／別study | 適格性false。モデル接続なし |
| P2-13 | 承認等は揃うがOracleの検証可能な記録なし | 適格性false、oracle-evidence-not-recorded |
| P2-14 | 全失敗、全未完了、unresolved、stopped | 分母維持。失敗を欠落や成功に丸めない |
| P2-15 | review-studyを実行 | 入力不変、未review・未設定が表示される |
| P2-16 | 旧access reportと正常fixture report | 既存の由来・結果を保持。追加診断だけを反映 |
| P2-17 | 安全な参照先のdevelopment欠損／改変／path escape | 欠損は表＋不足診断、改変・escapeは拒否 |
| P2-18 | run.status completeだがpendingあり | reportは矛盾診断、resumeは呼出し前に拒否 |
| P2-19 | Oracle expectedの型不正／未知error code | study検査で拒否、実行しない |
| P2-20 | 全終端でOracle未実行、その他条件は満たす | study-evidence-verifier-pendingによりfalse。負の結果の表は保存 |
| P2-21 | runのoracleHashだけ変更 | reportは入力不正として拒否 |
| P2-22 | 同じstudyからreview資料を2回生成 | JSON・Markdown一致、特殊文字でも表が壊れない |

P2-09等で元データを変更する場合はtest用コピーだけを使う。private情報や実承認をtestに使わない。適格性のtestは保存recordを読むreportに対して行い、`runStudy(..., "live", ...)`を使わない。resumeの拒否試験はモデル呼出しより前の検査を対象とし、必要なら狭いtest用依存注入で呼出し0を確認する。試験のために実接続を許可する設定を作らない。

## 8．検証コマンドと完了条件

最初と修正後に実行する対象test：

```sh
bun test src/paper-study.test.ts src/paper-report.test.ts src/paper-cli.test.ts
```

共通parserのtestを別ファイルにした場合は対象に追加する。新規出力先を指定して、以下も実行する。

```sh
bun run src/paper-cli.ts validate-study --study research/paper-v1/study-draft.json --out-dir artifacts/paper-v2/validation-new
bun run src/paper-cli.ts run-study --study research/paper-v1/study-draft.json --mode fixture --out-dir artifacts/paper-v2/fixture-new
bun run src/paper-cli.ts report --run-dir artifacts/paper-v2/fixture-new --out-dir artifacts/paper-v2/report-new
bun run src/paper-cli.ts review-study --study research/paper-v1/study-draft.json --out-dir artifacts/paper-v2/review-new
```

期待値：draftのreadyForLive false、fixtureは予定4 trial、生成経路pass 3・unresolved 1、Oracle pass 3・not-run 1。fixtureのevidenceEligible false。数値が違う場合は既存入力とコードの差を調査し、期待値だけを更新しない。

コード変更後のGate：

```sh
bun run check
bun run coverage
bun run ci:docs
bun run ci:protected
bun run ci:smoke
git diff --check
```

- [ ] P2-01〜22が対応するtestで確認できる。
- [ ] 分母がstudyを基準に固定される。
- [ ] modeだけで研究証拠へ昇格しない。
- [ ] 第一弾の成果物・既存差分を壊していない。
- [ ] review資料は具体的だが、reviewや承認を捏造していない。
- [ ] API呼出し0で検証を完了している。
- [ ] `docs/PAPER_EVIDENCE_RESULTS.md`に対象commit・差分・test結果・出力先・残条件を追記した。
- [ ] 草稿の「追加live未実施」「review未了」を維持した。

## 9．今回の次に残す作業

第二弾の完了後は、Oracle採点のcase-level記録とartifactへの結合、実行入力snapshot、再開の排他を一つずつ検討する。実装上の不足を閉じた後に、今回出力したreview資料を使って課題・Oracle・モデル・予算の決定を行う。

実モデル実行を始める前には[研究評価の実行条件](../RESEARCH_EVALUATION_PREREQUISITES.md)の該当要件を満たす。コード変更の依頼をlive実行の承認に読み替えない。未回答事項があっても今回のparser・report・review資料は完成できる。

## 10．実装者へ渡す依頼文

```text
docs/PAPER_EVIDENCE_PHASE2_IMPLEMENTATION_PLAN.md の第二弾を実装してください。
GPT-6 Sol / low effort向けの第6節の順序で進めてください。
第一弾は第1〜8回までの基盤が実装済みです。作り直さないでください。
今回はstudy/run検査、予定trial基準の集計、適格性理由、review-studyだけが対象です。
P2-01〜22を検証し、fixture経路と品質Gateを実行してください。
実datasetのreview・承認・モデル条件を勝手に確定せず、新しいlive呼出しをしないでください。
既存の未追跡ファイルも第一弾の成果として保持してください。
結果と残条件をdocs/PAPER_EVIDENCE_RESULTS.mdに追記して終了してください。
Oracle記録・snapshot・排他等の次の実装へ自動で進まないでください。
```
