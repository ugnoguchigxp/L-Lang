# Effects adversarial benchmark 実装引継ぎプロンプト

以下の「新しいセッションへ渡すプロンプト」を、そのまま新規Codexセッションへ貼り付けて使う。設計の正本は同じworkspace内の実装計画書であり、この文書の要約と食い違う場合は正本を優先する。ただし、正本を独断で変更して実装範囲を広げてはならない。

## 新しいセッションへ渡すプロンプト

```text
/Users/y.noguchi/Code/L-Lang で、Effects adversarial比較benchmarkを、設計・実装・検証・自己レビューまで最後まで実施してください。

最初に必ず行うこと:

1. workspaceのAGENTS.mdを全文読み、このprojectでまだ実行されていなければinitial_instructions MCPを一度だけ実行する。
2. `git status --short --branch`、`git log -1 --oneline`、`git diff --stat`を確認する。既存変更はユーザーの作業として保持し、reset、checkout、上書き、無関係な整形をしない。
3. 次の設計書を省略せず全文読む。これが実装範囲と受け入れ条件の正本である。
   `/Users/y.noguchi/Code/L-Lang/docs/EFFECTS_ADVERSARIAL_BENCHMARK_IMPLEMENTATION_PLAN.md`
4. 次も読み、既存の保証境界、互換性、研究実行条件を確認する。
   - `/Users/y.noguchi/Code/L-Lang/AGENTS.md`
   - `/Users/y.noguchi/Code/L-Lang/MAIN_CONCEPT.md`
   - `/Users/y.noguchi/Code/L-Lang/docs/EFFECTS_ASSURANCE_CORE_V1.md`
   - `/Users/y.noguchi/Code/L-Lang/docs/TRUST_DATA_SEPARATION_AND_EVALUATION_IMPLEMENTATION_PLAN.md`
   - `/Users/y.noguchi/Code/L-Lang/docs/TRUST_DATA_SEPARATION_AND_EVALUATION_RESULTS.md`
   - `/Users/y.noguchi/Code/L-Lang/RESEARCH_EVALUATION_PREREQUISITES.md`
   - `/Users/y.noguchi/Code/L-Lang/QUALITY_GATES.md`
   - `/Users/y.noguchi/Code/L-Lang/SECURITY.md`
5. package.json、関連source／test／fixtureを調査し、既存の命名、strict parser、canonical JSON、hash、path safety、test styleを再利用する。推測で並行実装を作らない。

現在の基準状態:

- Effects assurance core v1までの実装基準commitは `f52a0c7 Implement signed Effects assurance core`。
- そのcommit時点でBun 1.4.2による全testは678 passed、0 failedだった。
- 次期計画を作るための未commit文書変更が存在する可能性がある。少なくとも次は消さず、内容を確認して引き継ぐ。
  - `docs/EFFECTS_ADVERSARIAL_BENCHMARK_IMPLEMENTATION_PLAN.md`
  - `docs/EFFECTS_ADVERSARIAL_BENCHMARK_HANDOFF_PROMPT.md`
  - `docs/README.md`
  - `PROJECT_STATUS_AND_ROADMAP.md`
  - `RESEARCH_EVALUATION_PREREQUISITES.md`
- 実際のsession開始時のGit状態を正とし、上記と差があれば差分の由来を調査する。

達成目標:

- 設計書のPR-0〜PR-9を実装し、EAB1〜EAB40をtestまたは専用negative fixtureで検証する。
- `llang-effects-adversarial-study` version 1のstrict contractを実装する。
- public task／inputとhidden Oracleを分離し、freeze対象のexact file set、hash、review、path safetyをfail-closedで検査する。
- 同一のEffectsBenchmarkHost、grant、budget、input、fault scheduleで、実際のL-Lang armと品質Gate済みhand-written TypeScript armを実行する。
- deterministic runner、counterbalanced order、checkpoint、resume、uncertain、complete trial matrixを実装する。
- raw observationだけからOracle採点、統計解析、table、figure用CSV、Markdown reportを決定的に再生成する。
- portable result packageとpaper artifact bundleをclean directoryで再検証できるようにする。
- fixture、candidate、reviewedを混同せず、fixture／candidate／pilotは常に`evidenceEligible: false`にする。
- 既存Effects core、execution evidence v1〜v4、ABI、既存CLI／fixtureを後方互換に保つ。

論文証拠として必須の設計契約:

- このbenchmark単独で支持できるのは、固定された独立review済みdatasetと共通hostにおけるmechanism efficacyだけである。
- live model生成品質、人間の監査性、TypeScript一般への優位、実運用安全性は主張しない。
- claim-to-evidence matrix、RQ1〜RQ4、confirmatory hypothesis、estimand、unit of analysis、最小実用差を結果観測前に固定する。
- case数は便宜的な18〜128件などで決めない。precision／power analysisの入力、式、version、seed、結果で決める。
- pilotとconfirmatoryを分離し、pilotで観測したcaseをconfirmatory結果へ転用しない。
- primary二arm比較とablationを別集計にする。反復trialを独立case数として扱わない。
- effect size、95% confidence interval、事前指定検定、多重比較、missingness、worst-case sensitivity analysisを出す。
- null、逆効果、threshold未達、全failure、attrition、excluded、unknown、uncertainを隠さない。
- construct／internal／external／conclusion validityをreportへ記録する。
- rawから論文table／figure dataまで手作業の転記を入れない。
- environment、toolchain、dependency lock、commit、seed、総computeを記録する。
- 外部timestamp、独立dataset author、domain reviewer、第三者再現はsoftwareが捏造または自己認定してはならない。

実装順序:

1. PR-0: research contract、preregistration／analysis／sample-size templateとstrict validator。
2. PR-1: study、dataset、Oracle parser。
3. PR-2: review、freeze、一方向lifecycle。
4. PR-3: 共通host、観測schema、redaction、fault injection。
5. PR-4とPR-5: TypeScript baselineとL-Lang assured arm。片方だけを比較可能な成果として扱わない。
6. PR-6: runner、trial order、checkpoint、resume、crash／tamper handling。
7. PR-7: Oracle、九category mutation、paired metric、統計集計。
8. PR-8: CLI、portable result、report、docs、offline smoke。
9. PR-9: paper artifact、raw-to-table regeneration、environment capture、clean-directory reproduction。

実装中の原則:

- 小さな変更単位ごとに、まず関連test、次に広いGateを実行する。
- expected pathだけでなく、unknown field、duplicate key、oversize、path escape、symlink、hard link、Oracle漏洩、hash差替え、baseline bypass、log欠落、crash、並行runner、欠測、post-hoc変更をnegative testする。
- filesystem／network／credentialは共通hostの外から使わせない。fixture／verify／analyze／reproduceは外部network 0、API call 0、費用0とする。
- timestamp、person、review、independence、外部登録、第三者再現を架空値で埋めない。
- Bun workerをOS sandboxと表現しない。
- 新規依存は必要性を説明できる最小限にし、lockfileを更新した場合は理由と再現性を記録する。
- unrelated refactor、仕様外機能、公開、live API実行、人間参加実験、OSF登録、論文投稿を行わない。
- 別Codex task／threadへメッセージを送らない。
- commit／pushは、この実装依頼だけでは行わない。ユーザーが明示的に依頼した場合だけ行う。

CLIの最低要件:

- `validate | plan | fixture | freeze | run | analyze | verify | reproduce`
- `fixture`はcredentialなし・networkなしでend-to-endを通す。
- `freeze`はanalysis plan、sample-size plan、review、全file hashを固定する。
- `run`はfreezeとreviewを再検査し、新規output directoryだけを使う。
- `analyze`はraw observationからprimary、sensitivity、table、CSVを再生成する。
- `verify`はsourceを実行せずportable packageを検証する。
- `reproduce`はclean output directoryへ同じderived hashを生成する。

最終品質Gate:

```sh
bunx bun@1.4.2 run format
bunx bun@1.4.2 run check
bunx bun@1.4.2 run ci:docs
bunx bun@1.4.2 run ci:protected
bunx bun@1.4.2 run ci:smoke
bunx bun@1.4.2 run effects:benchmark plan benchmarks/effects-adversarial-v1/study.json
bunx bun@1.4.2 run effects:benchmark fixture benchmarks/effects-adversarial-v1/study.json --out-dir <fresh-temporary-directory>
bunx bun@1.4.2 run effects:benchmark analyze <fresh-temporary-directory>/result-package.json
bunx bun@1.4.2 run effects:benchmark reproduce <fresh-temporary-directory>/result-package.json --out-dir <second-fresh-temporary-directory>
git diff --check
```

temporary directoryの正確なpathは安全に新規作成し、成果物のhash一致、API call 0、network 0、全trial completenessを確認する。OS matrixは実際に実行したOSだけを成功と記録する。

レビューと完了判定:

1. 実装後に設計書を先頭から再読し、PR-0〜PR-9とEAB1〜EAB40の対応表を実装結果文書へ作る。
2. correctness、security、research validity、reproducibility、compatibilityの五観点で自己レビューする。
3. 発見した問題を修正し、関連testとfull Gateを再実行する。既知の改善点がなくなるまで繰り返す。
4. `git diff --check`、Git status、変更一覧、test結果、未実行事項を確認する。
5. independent dataset／review／external timestampが未提供なら、実装は完了でも研究結果は`not-run`、`evidenceEligible: false`と正直に記録する。
6. 最終報告では、実装したもの、検証結果、設計受け入れ条件の充足、未実証claim、外部Gate、変更fileを簡潔に示す。

停止してユーザー確認が必要なもの:

- live provider呼出、費用発生、外部networkを使う研究run。
- 人間参加者の募集・計測、実credential／実業務dataの使用。
- 外部サービスへのpreregistration、artifact公開、論文投稿。
- 言語仕様、ABI、既存署名chain、trust policyの互換性を壊す変更。
- 公平なbaselineまたは研究claimを materially 変える設計変更。

不明点は、repositoryと正本設計書から安全に解決できる限り自律的に進めてください。外部権限や研究claimの変更が必要な場合だけ停止し、何が不足し、どの選択で結果がどう変わるかを具体的に報告してください。
```

## この引継ぎで固定している品質境界

このpromptは実装を完遂するための指示であり、独立dataset author、domain reviewer、外部timestamp、第三者再現を代替しない。新しいsessionがfixtureを完成させても、これらが揃う前に論文用比較を「実施済み」「再現済み」と報告してはならない。
