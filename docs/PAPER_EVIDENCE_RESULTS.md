# 論文根拠の実装・検証結果

2026-09-27。実装対象は`predicate-i32-v1`。作業時のHEADは`4b5073d4d8f3810719cd5b9f0d13aaeeb499f972`、Bunは1.4.2、観測環境はmacOS arm64である。元live実行時のcommit・OSは記録から確定できず、unknownとして保持した。今回の追加live API呼出しは0件。

| 回 | 実装・記録 | 検証結果 | 研究証拠の残条件 |
| --- | --- | --- | --- |
| 1 | [`paper-evidence.ts`](../src/paper-evidence.ts)、`artifacts/paper-v1/inventory-access-complete/`、[元記録index](../research/paper-v1/bundle-index.json)、[2026-09-27再検証index](../research/paper-v1/audit-index.json) | 元記録の各ファイルを相対path・サイズ・SHA-256と関連hashで確認。再検証33ファイルも保全し、summaryの4 Wasm参照を元記録と再検証側のhash・サイズへ照合。観測環境にBun、OS、architecture、依存Lock hash、compiler/backend/options、作業ツリー状態を記録 | 元live環境と配布条件はunknown。生記録はローカルのみ |
| 2 | [`paper-reproduce.ts`](../src/paper-reproduce.ts)、`artifacts/paper-v1/reproduce-access-final/` | 保存応答replayはpass、`match: true`、API呼出し0。元・replay・build A/Bの4 Wasmが147 byteで直接一致 | 他OS・第三者環境は未確認 |
| 3 | [`paper-evaluate.ts`](../src/paper-evaluate.ts)、[access Oracle](../research/paper-v1/access-oracle.json)、`artifacts/paper-v1/evaluate-access-final/` | Oracle 8件pass。未知fieldは`INVALID_IR`、型不一致は`UNSUPPORTED_TYPE`、Lock改変は`INVALID_PROMPT`、契約・Wasm改変は`ARTIFACT_MISMATCH`。合法誤IRは`enabled=true, suspended=true`でOracleが検出 | Oracleの独立した人間reviewは未了 |
| 4 | [方式](./PAPER_METHOD.md)、[関連研究](./PAPER_RELATED_WORK.md)、[草稿](./PAPER_DRAFT.md) | IRとWasmCoreの対応、生成指示、役割分担、一次資料の比較を記録 | 過去の課題作成者と記録外介入はunknown |
| 5 | [study draft](../research/paper-v1/study-draft.json)、[`paper-study.ts`](../src/paper-study.ts)、`artifacts/paper-v1/study-validation-final/` | 4課題のdraftに診断0。AND/OR/NOT、enum/presence、カテゴリ境界、表現不能なsuffix要求を含む | review、モデル・予算・反復条件の確定、実行承認は未了。`readyForLive: false` |
| 6 | [`paper-study.ts`](../src/paper-study.ts)、`artifacts/paper-v1/study-fixture-final/` | fixtureで4 trialを保存。pass 3、unresolved 1。初回pass 1、修正後pass 2。uncertain再送防止と入力変更拒否をtest | 実モデルの追加評価は未実施 |
| 7 | [`paper-report.ts`](../src/paper-report.ts)、`artifacts/paper-v1/study-report-final/`、`artifacts/paper-v1/access-report-table/` | fixtureの予定4、完了4、Oracle pass 3、Oracle未実行1をJSON/CSV/Markdownへ再生成。過去access 1課題の表も生成 | fixture数値は論文の実モデル成功率に使わない |
| 8 | [再現手順](../research/paper-v1/README.md)、[隔離snapshot実行記録](../research/paper-v1/clean-reproduction.json)、bundle index、草稿改訂 | 一時Git snapshotのクリーンcloneへ固定依存を導入し、保存証跡コピーから再生・Oracle・fixture表を一巡。replayと評価はpass | 配布可能な原本、第三者による実行、review済み追加live結果は未確認 |

## 検出層の解釈

未知fieldと型不一致はIR→WasmCoreのloweringで拒否される。Lockはchecksum・IR hash、契約はWasm custom sectionとの対応、Wasmはmanifest hashで拒否される。`INVALID_INPUT`はhostが契約に基づいて返す。これらをWasm単体の自然言語意味保証とは扱わない。

## 証跡と保全範囲

`artifacts/paper-v1/`はGit管理外の生記録・派生物である。Git管理可能な[`bundle-index.json`](../research/paper-v1/bundle-index.json)と[`audit-index.json`](../research/paper-v1/audit-index.json)にはファイル名、サイズ、hashを置く。原本へのredactionは未適用で、公開やGit登録は行っていない。出力先の実行記録には絶対pathが含まれ得るので、配布版の確認は別に要する。

## 検証コマンド

作業前の`bun test src/capability-development.test.ts src/capability-package.test.ts src/prompt-source.test.ts`は61 pass、0 fail。実装後の`bun test src/paper-evidence.test.ts src/paper-reproduce.test.ts src/paper-evaluate.test.ts src/paper-study.test.ts src/paper-report.test.ts src/paper-cli.test.ts`は13 pass、0 fail。`bun run check`は一度、編集中の型エラーで失敗したが、修正後の再実行は841 pass、0 fail。`bun run coverage`は838 pass、0 failで、全体関数92.78%、行91.77%となり閾値を通過した。`bun run ci:docs`、`bun run ci:protected`、`bun run ci:smoke`、`git diff --check`も成功した。

CLIの実データ確認はすべて`bun run src/paper-cli.ts`を入口とし、次の順で実行した。表中のpathはリポジトリルートからの相対pathで、各出力先は実行前に存在しないことを確認した。

| 回 | subcommandと入力 | 出力先 | 終了値 |
| --- | --- | --- | --- |
| 1 | `inventory --input artifacts/codex-terra/access-live` | `artifacts/paper-v1/inventory-access-complete` | 0 |
| 2 | `reproduce --inventory artifacts/paper-v1/inventory-access-final/inventory.json` | `artifacts/paper-v1/reproduce-access-final` | 0 |
| 3 | `evaluate --inventory artifacts/paper-v1/inventory-access-final/inventory.json --oracle research/paper-v1/access-oracle.json` | `artifacts/paper-v1/evaluate-access-final` | 0 |
| 5 | `validate-study --study research/paper-v1/study-draft.json` | `artifacts/paper-v1/study-validation-final` | 0。`readyForLive: false` |
| 6 | `run-study --study research/paper-v1/study-draft.json --mode fixture` | `artifacts/paper-v1/study-fixture-final` | 0 |
| 7 | `report --run-dir artifacts/paper-v1/study-fixture-final` | `artifacts/paper-v1/study-report-final` | 0 |
| 7 | `report --run-dir artifacts/paper-v1/access-report-run` | `artifacts/paper-v1/access-report-table` | 0 |

次の研究作業の開始点は、draft課題とOracleの独立review、モデル・反復・呼出し予算の確定、対象hashのfreeze、明示的なlive実行承認である。これらが揃うまでは新規live結果を論文へ加えない。

## 根拠項目の状態

E01・E02はinventory実装とローカル保全を完了したが、元環境・配布条件は未確定。E03・E04・E06・E09は実装・文書対応を完了。E05はOracleコードと事例検証を完了したが、人間reviewは未了。E07はローカル作業環境と隔離snapshotでbyte一致を確認したが他OSは未確認。E08はdraftとfixture経路のみ完了し、新規live実測は未実施。E10は隔離snapshotからのローカル再現を確認したが配布・第三者再現は未完了。E11はfixture集計基盤を完了し、新規liveの表は未実施。E12・E13は本論文の主張範囲外。

## 第二弾：study/run検査、予定trial集計、レビュー資料（2026-09-27）

対象HEADは`4b5073d4d8f3810719cd5b9f0d13aaeeb499f972`。第一弾の未追跡ファイルを保持し、commit・checkoutリセット・原本変更は行っていない。新規live API呼出しは0件。第二弾では[`paper-study-validation.ts`](../src/paper-study-validation.ts)を追加し、Study/StudyRunの固定field・型・列挙値、task ID、数値範囲、予定trial集合、hash集合を検査する。既存の[`paper-study.ts`](../src/paper-study.ts)、[`paper-report.ts`](../src/paper-report.ts)、[`paper-cli.ts`](../src/paper-cli.ts)へ接続した。`review-study`の確認項目は[レビュー手順](../research/paper-v1/REVIEW_GUIDE.md)に記した。

修正前の回帰確認では、draftのままreview等を埋めると`readyForLive: true`になること、trialを1件削るとreportが欠測を表示できないことの2件が失敗した。修正後はP2-01〜22の条件を対応するテストで確認した。予定trialはstudyの4課題×1反復を正本とし、保存runの欠落trialを`missing`行として表示する。重複・未知ID、入力hash不一致、改変済みdevelopment、危険なpathは拒否する。安全なdevelopment欠損は`incompleteEvidenceTrials`へ分け、calls/tokensはnullにする。Oracleの未実行と、自己申告値があっても候補証跡を確認できない状態は別々に表示する。`eligibilityReasons`は辞書順・重複なしで保存し、現行study runには常に`study-evidence-verifier-pending`を残す。`recordIntegrity: verified`は保存記録間の照合に限られ、Oracleの意味や外部的真正性を保証しない。

| CLI確認 | 出力先 | 結果 |
| --- | --- | --- |
| `validate-study` | `artifacts/paper-v2/validation-new/` | 終了値0、診断0、`readyForLive: false` |
| `run-study --mode fixture` | `artifacts/paper-v2/fixture-new/` | 終了値0、予定4・pass 3・unresolved 1、生成API呼出し0 |
| `report` | `artifacts/paper-v2/report-final/` | 終了値0、初回pass 1・修正後pass 2・Oracle pass 3・not-run 1、`evidenceEligible: false` |
| `review-study` | `artifacts/paper-v2/review-complete/` | 終了値0、4課題の要求・契約・Oracle期待値・hashを出力。review・承認は未設定 |

第二弾の対象テスト`bun test src/paper-study-validation.test.ts src/paper-study.test.ts src/paper-report.test.ts src/paper-cli.test.ts`は23 pass、0 fail。`bun run check`は854 pass、0 fail。`bun run coverage`は856 pass、0 failで全体の関数92.77%、行91.67%となり閾値を通過した。`bun run ci:docs`、`bun run ci:protected`、`bun run ci:smoke`、`git diff --check`も成功した。

残条件は、課題とOracleの独立review、実験モデル・provider・呼出し予算等の確定、入力freeze、明示的なlive承認、およびOracle case別採点記録と対象artifactの照合である。追加live評価は未実施で、草稿の研究結果へfixture値を昇格させていない。実行中の入力差し替え対策、Oracle証跡の保存、同時resume排他は今回の範囲外として残す。

## 第二弾のコードレビュー追補（2026-09-27）

保存済み候補をreport・resumeで読む際、候補のpackage hash・IR hash・source hash・metadata hashをdevelopmentの最終attemptとstudyの入力hashへ照合するようにした。候補pathのシンボリックリンクも拒否する。開発記録の保存後にOracle評価が中断された`uncertain` trialは、部分記録として表示し、suite成功や完了件数へ加えない。レビュー用MarkdownではHTML特殊文字と改行をescapeし、CSVでは式として解釈され得るセルを文字列扱いにした。対応する回帰試験を追加し、P2-01〜22の条件も再確認した。

最終の対象テストは26 pass、0 fail。`bun run check`の再実行は860 pass、0 fail。最初の再実行中にeffects統合試験が`EFFECTS_BENCHMARK_UNCERTAIN_REQUIRES_REVIEW`で1件失敗したが、同試験を単独で16 pass、0 failと確認し、重い試験を並行させずに全体Gateを再実行して上記の結果を得た。`artifacts/paper-v2/report-reviewed/`と`artifacts/paper-v2/review-reviewed/`はレビュー後のコードで新しい出力先へ生成した。追加live API呼出しは0件で、研究review・承認は未了のままである。

## 第三弾：Oracle case別証跡と非実行照合（2026-09-27）

対象HEADは`4b5073d4d8f3810719cd5b9f0d13aaeeb499f972`。第二弾までの未追跡成果を保持して作業し、commit・入力Oracle・draft review状態・既存live記録は変更していない。新規live API呼出しは0件。

[`paper-oracle-evidence.ts`](../src/paper-oracle-evidence.ts)を追加し、全caseの期待値・実測値・状態、採点対象のcandidate、Wasm bytes、入力契約、Oracle、保存development JSON全体へのhash対応を`<trial-id>/oracle-evidence.json`に記録した。通常の不一致では後続caseも採点し、未知の実行例外では後続caseを未実行として明示する。完成sidecarは一時ファイルをsyncしてから非置換公開し、読戻し検査後にrunのOracle statusを確定する。採点前checkpoint、失敗診断、uncertain時の再送・再採点防止を追加した。reportとresumeは共通の非実行検証関数を使い、Wasmを再実行しない。

新しいstudy用summaryはversion 2である。`oraclePass`・`oracleFail`はsidecarと保存対象の照合が完了した件数、`oracleStatus`はrun内の値である。第二弾までのsidecarなしrunでは自己申告の`oracleStatus: pass`を`oraclePass: null`、`oracleUnverified: true`と表示する。実行例外は`oracleExecutionError`で区別する。`completedTrials`は生成工程の終端件数であり、Oracle採点の完了件数ではない。case記録のchecksumは外部的な実行時刻や記録者の真正性を証明しない。

| CLI確認 | 出力先 | 結果 |
| --- | --- | --- |
| `run-study --study research/paper-v1/study-draft.json --mode fixture` | `artifacts/paper-v3/fixture-new/` | 終了値0。予定4、生成pass 3、unresolved 1。Oracle sidecarはpassの3 trialに保存し、case行数はlogic 4、contact 3、boundary 4 |
| `report --run-dir artifacts/paper-v3/fixture-new` | `artifacts/paper-v3/report-new/` | 終了値0。照合済みOracle pass 3、fail 0、実行例外0、not-run 1、未検証0。`oracle-evidence-not-recorded`なし、`recordIntegrity: verified`、`evidenceEligible: false` |
| `report --run-dir artifacts/paper-v2/fixture-new` | `artifacts/paper-v3/report-old/` | 終了値0。旧runは変更せず、Oracle自己申告pass 3を未検証3、照合済みpass 0として表示 |

P3-01〜30の条件は[`paper-oracle-evidence.test.ts`](../src/paper-oracle-evidence.test.ts)と既存study/reportテストで確認した。新規対象を含む5ファイルのテストは39 pass、0 fail。最終コードに対する全体`bun run check`は873 pass、0 fail。`bun run coverage`は873 pass、0 fail、全体関数92.81%、行91.71%で閾値を通過した。coverageの後、旧runの自己申告採点で候補ファイルが欠損した場合に`oracle-evidence-incomplete`を付ける分岐とテストを追加し、対象テスト39 pass、最終`bun run check`873 passを再確認した。`ci:docs`、`ci:protected`、`ci:smoke`、`git diff --check`も成功した。

残条件はstudy入力snapshotとtrialごとの固定入力照合、同時resume排他、課題とOracleの独立review、モデル・予算・反復条件とlive承認の確定である。これらは第三弾に含めず、現行の`study-evidence-verifier-pending`と`evidenceEligible: false`を維持した。

## 第三弾のコードレビュー追補（2026-09-28）

case採点で`INVALID_INPUT`を任意の例外の`code`属性だけで認定していたため、Wasm runtimeの`WasmError`に限って通常の入力拒否とするよう修正した。sidecarに関連するdevelopmentが欠損していても、sidecarとrun checkpointの矛盾は先に拒否する。共通の証跡検証関数は、受け取ったdevelopment値が保存JSONの厳密なparse結果と一致し、source/metadata hashがtrialに対応することを自ら確認するようにした。sidecarの一時ファイルはmode `0600`で作成し、書込み・sync・closeの失敗時にも自分の一時ファイルの削除を試みる。reportがWasmをcompile・instantiateしないことも回帰試験で直接確認した。

レビュー追加後の対象テストは41 pass、0 fail。全体`bun run check`は875 pass、0 fail。`ci:docs`、`ci:protected`、`ci:smoke`、`git diff --check`も成功した。対象の実装ファイルと新規テストはlint警告0件。研究入力、旧run、既存のlive記録は変更していない。

## 第四弾：study入力snapshot（2026-09-28）

新規study runをversion 2とし、`<run-dir>/inputs.json`へ検査済みのstudy、task別source・metadata・Oracle・参照fixture、live承認を保存する。schema、checksum、`run.json`の`inputSnapshotHash`、予定trialの入力hashを照合する。fixture実行では開始前に全fixtureを形式検査し、各pending trialの直前にsnapshotを再検査して、保持したobjectをdevelopmentとOracle採点へ渡す。検査失敗は固定理由とともにuncertainへ保存し、自動再送しない。v2のreportとfixture再開は元入力を移動した後も保存snapshotで動作する。live再開は元承認pathも再照合する。v1のreport・resumeは元path参照のままである。

CLIでは`artifacts/paper-v4/validation-new/`に診断0・`readyForLive: false`、`review-new/`に4課題のreview資料、`fixture-new/`にversion 2 runとsnapshotを保存した。新規fixtureは生成pass 3・unresolved 1、照合済みOracle pass 3・not-run 1。`report-new/`はsummary version 2、`recordIntegrity: verified`、`evidenceEligible: false`、`study-evidence-verifier-pending`を確認した。既存v1 runの`artifacts/paper-v3/fixture-new/`から`artifacts/paper-v4/report-old/`へのreportも成功した。新規live実行は行っていない。

対象8ファイルのテストは公開後cleanup失敗試験を含め58 pass、0 fail。`ci:docs`、`ci:protected`、`ci:smoke`、`git diff --check`は通過した。全体`bun run check`は既存effects再開試験の`EFFECTS_BENCHMARK_UNCERTAIN_REQUIRES_REVIEW`で1件失敗し、同試験は単独でも再現した。`bun run coverage`は879 pass、3 failで、effects再開試験に加えてsemantic closureとsemantic verify CLI統合試験が時間制限等で失敗した。これら2つの全体Gateは未通過であり、coverage閾値の成功は主張しない。追加したstudy対象テストの失敗はない。

残条件は独立review、モデル・予算・反復条件の確定、live承認と実測、同時resume排他、第三者による証拠の再現・配布である。保存snapshotは同時刻取得や書込み権限を持つ別processへの完全な不変性を保証しない。

## 第四弾のコードレビュー追補（2026-09-28）

初期run保存直後にsnapshotが変わると、trial直前のuncertain checkpointを経ずに停止する窓を修正した。開始時とresume開始時に検査したstudyをrunnerへ渡し、各pending trialの直前にsnapshotを再読込みして検査する。初回trialでも失敗時には`input snapshot verification failed before dispatch`を保存し、development呼出しは0件とする回帰試験を追加した。live runのtrialにfixture hashを混入させた場合もsnapshot/run照合で拒否する。承認の保存値でreportを作り、変更後の元承認ではresumeを拒否するlive provider double試験を加えた。新設テストの型を明確にし、対象ファイルのlint警告をなくした。

レビュー後の対象8ファイルは60 pass、0 fail。typecheckと対象ファイルのlintは通過した。全体check・coverageの既存統合試験失敗は上記のとおり未解消であり、通過とは記載しない。
