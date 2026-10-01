# Semantic TDD Phase 6〜7・残実装の結果

確認日：2026-10-01。ローカル作業ツリーの結果。[完了計画](./SEMANTIC_TDD_EXTENSIONS_COMPLETION_PLAN.md)。commit・push・実API評価は未実施。

## 追加した実装

Property config v2は`maxArrayLength`（0〜16）と`timeoutMs`（1〜120000）を必須とし、bounded array、単一のcontainerを含むnullable/optional unionを扱う。要素の有限domainは`["noise", "*"]`のように指定する。schema depthは3、生成nodeと縮小stepにも上限がある。engineとsource example subprocessそれぞれに時間上限を適用する。同期engineのtimeoutは各処理段階の協調的な検査であり、OSによる絶対的な停止時刻ではない。v1の生成versionを維持し、既存reportを読める。

`semantic verify --property-report <report.json>`は反例を含む結果、現在の実装と不一致のIR／schema／Test Plan、改変reportを拒否する。明示指定時だけ検査し、生成artifactと両lockを変更しない。buildの自動Hard Gateには導入しない。

[評価runner](../src/semantic-tdd-extension-evaluation.ts)はfixture/live/replayを分ける。候補選択後にheld-out labelを読み、resolverには渡さない。単発baselineは同じbatchの最初の候補である。liveには明示model、正の申告価格、全runに共通のtoken／費用予算が必要。資源停止の場合も受領した応答のauditを含む`resource-stopped` reportを保存する。評価はIR選択層を対象とし、生成コードのtransaction integrityは別のintegration testで確認する。

## 凍結した合成制御実験

新規の[入力とfreeze](../benchmarks/semantic-tdd-extensions-v1/freeze.json)を結果観測前に保存した。3種類のboolean条件について、mixed、correct-first、all-ineligible、partial-provider-failureの計12 workloadを用いる。held-outは新しい合成文字列を含む16入力/workload。propertyには配列noiseと有限domainを設定する。

初回freezeの価格0が設定parserに拒否されたため、シナリオの評価開始前に有効な申告価格へ修正して再freezeした。最初の入力一式を`artifacts/semantic-tdd-extensions/evaluation-initial-freeze-invalid-config/`へ残した。fixtureの実API call・token・費用は引き続き0である。

| 指標 | 結果 |
| --- | --- |
| workload | 12 |
| 単発のunresolved | 9 / 12 |
| Best-of-Nのunresolved | 3 / 12（全候補不適格を拒否） |
| 採用IRのheld-out検査 | 144入力、false acceptance 0、false rejection 0 |
| 採用IRのmutation kill rate | 全9採用で1.0 |
| 既知欠陥のproperty検出／反例再現 | 12 / 12 |
| 実API call／token／費用 | 0 / 0 / 0 |

workload名のmixed／all-ineligible等はfixtureの候補配置を示す。liveでは候補を実APIから得るため、この配置を強制せず、同じ3つのConceptを各4 batchで測定する。12種類の独立したConceptを評価するものではない。

これは事前に構成した欠陥候補を含む合成制御実験であり、単発に対する実モデルの品質優位性や一般化を主張しない。第三者のblindな独立評価も未実施である。

## 最終検証

| 検査 | 結果 |
| --- | --- |
| `bun run check` | format・lint・typecheck成功、13分割で965 pass / 0 fail |
| `bun run coverage` | 965 pass / 0 fail、172 test files。functions 92.98%、lines 91.95%。transaction functions 98.36%、lines 96.88%。既定閾値を通過 |
| 関連integration／評価runner | 11 pass / 0 fail。既存の60秒・30秒制限を維持 |
| `semantic verify --property-report`（CLI） | 保存済みv1結果を現在の採用IR・schema・凍結Test Planと照合して成功 |
| 新規合成評価とAPIなしreplay | 12 workloadで成功 |
| `bun run ci:docs`／`bun run ci:protected` | 成功 |
| `bun run verify` | 965 pass / 1 fail。既存Effects resume検査が`EFFECTS_BENCHMARK_UNCERTAIN_REQUIRES_REVIEW`で停止。新機能の失敗はなし |
| 上記Effects検査の単独再実行 | 1 pass / 0 fail、約26秒。全体verifyの失敗記録は成功へ置き換えない |

検証開始時に488ファイルのhashを保存し、全体test後に変更0を確認した。最終verify後にも照合し、変更0を確認した。log・source hash・候補audit・反例は`artifacts/semantic-tdd-extensions/`へ保存する。

最終照合前のrunはnullable container比較と複数node照合の修正のため中止し、`*-pre-review.log`として保持した。次の同時実行ではrepository checkのintegration test（60秒）と評価setup（30秒）がtimeoutした。時間制限を変えず、重複する型読み込みを削減し、複数nodeの検査を独立したtestへ分割した。失敗・中止したrunは`*-concurrent-attempt.log`に残し、最終runを順次実行する。

## 残る評価Gate

実API評価のmodel・費用上限をユーザーへ依頼済み。独立live評価、第三者blind課題、Private Pilot価値Gate、Public Alpha package/CLI Gateが揃うまで既定採用を行わない。機能の実装完了と研究・製品採用Gateの完了を区別する。Paper v1への新しい実測主張は追加していない。

最終verifyは既存JSONC CLIから全体testを一括実行する経路で、既存Effectsの実行結果が不確定として拒否された。原因を実行負荷と断定できる観測は残っていない。該当testはrepository check、coverage、単独再実行で成功しているが、全体verifyの成功は宣言しない。Effects実装、凍結予算、閾値には変更を加えていない。集計は`artifacts/semantic-tdd-extensions/completion-validation.json`に保存した。

## 追加コードレビュー（2026-10-01）

上記の実装完了時の検証とは別に、追加コードの失敗経路と保存結果の再生を再レビューした。評価入力は最初にhash照合した内容を保持し、source scannerの内容も凍結値と照合する。実行中のファイル変更が結果へ混入しない。単発baselineの予算判定は最初の応答だけを対象とし、後続候補の予算超過を引き継がない。

評価CLIは新規保存先をAPI実行前に確保する。候補選択の応答auditを各batch後に同期保存し、後処理で失敗した場合は`status: incomplete`と`selections`を残す。この中間auditは完成評価reportとは異なり、通常のreplayで受け入れない。完成時は通常のreportへ書き換える。`resource-stopped`の終了値は1、入力・実行エラーは2で、完成だけを0とする。再生時はlane、model、経過時間の不正値を拒否し、反例を検出していない結果を反例再現成功として数えない。

Property Testは非nullableなobjectへのnull比較を拒否し、保存reportをreplay読込と同じ2 MiB上限で検査する。source example子プロセスは時間超過時に強制停止する。旧v1の生成手順、Paper v1 scope、既定採用の条件は維持する。

今回の検証logは`artifacts/semantic-tdd-extensions/review-*.log`に保存する。実装完了時の965件の結果と今回の検証件数を混同しない。

追加レビュー後の`bun run check`は13分割、971 pass / 0 fail。対象4ファイルの32件、対象3ファイルのcoverage実行31件も0 fail。Best-of-N単体のfunctions／linesは100%／100%、Property engineは88.00%／93.52%、評価runnerは90.00%／76.35%。この対象coverageは全repositoryのcoverage Gateの再実行ではなく、CLI子プロセスの行網羅も親プロセスには合算されない。CLIの新規report保存とAPIなしreplayは別に12 workloadで成功し、合成制御実験の集計は変わらない。文書整合性、保護入力、差分の空白検査も成功した。今回の`check`では既存Effectsの16件も成功したが、過去の一括`verify`の失敗記録は維持する。
