# 論文根拠充足の実装計画

作成：2026-09-27。状態：実装結果は[結果記録](./PAPER_EVIDENCE_RESULTS.md)を参照。追加live評価と人間reviewは未実施。

想定実装者：GPT-6 Sol（`gpt-6-sol`）、reasoning effort：`low`。実装時に後続回の設計を推測しなくて済むよう、作業順・参照先・完了判定を本書で指定する。この指定は実装担当モデルについてであり、論文評価で呼び出す生成モデルの変更を意味しない。

対象：[論文ドラフト](./PAPER_DRAFT.md)／[根拠充足一覧](./PAPER_EVIDENCE_PLAN.md)。E番号は根拠充足一覧の項目を指す。

## 1．目的と実装単位

限定Predicateを対象に、要求からLLM生成IR、Wasm実行、保存入力からの再構築までの根拠を、論文に引用できる形へ整える。

**一回の依頼では、下表の一回分だけを実装・検証・結果記録まで完了する。** ファイル数や所要時間の約束ではなく、独立にレビューできる一つの成果を単位とする。次回の機能を先回りして実装しない。通常は一回分を一つの変更セットとして扱える構成とする。

全体を8回の実装・文書整備と、別枠の評価実施に分ける。第1〜4回で現在の1課題の証拠を整え、第5〜7回で追加課題を扱う基盤を作り、第8回で再現手順と論文を完成させる。第4回は関連研究と仕様説明を扱う文書作業である。

| 回 | 一回で完成させるもの | 対応項目 | 前提 | 完了時に可能になること |
| --- | --- | --- | --- | --- |
| 1 | 証跡inventoryと保存手順 | E01・E02 | 既存ローカル記録 | 過去の証拠と不足が特定できる |
| 2 | 既存1課題のオフライン再現runner | E07・E10の基礎 | 第1回 | 保存応答→実行→再build比較を一コマンドで検証できる |
| 3 | 独立Oracleと拒否・改変検出の評価 | E05・E06 | 第2回 | 正解と検証器の検出能力を分けて説明できる |
| 4 | IR仕様・役割分担・関連研究の整理 | E03・E04・E09 | 第1回。最終照合は第3回後 | 論文の貢献と対象範囲を確定できる |
| 5 | 追加課題と評価protocolのdraft | E08の準備 | 第3・4回 | 課題・Oracle・評価条件をレビューできる |
| 6 | 複数課題runnerと記録・再開 | E08の実装 | 第2・5回 | fixtureで全評価経路と失敗処理を検証できる |
| 7 | 生データからの集計・本文表生成 | E11 | 第3・6回 | 成功・失敗・欠測を含む表を再生成できる |
| 評価 | レビュー済み課題によるlive実行 | E08の実測 | 第5〜7回、実行条件の確定 | 新しい生成実績を得る。コード実装とは別 |
| 8 | クリーン再現・配布用構成・論文反映 | E10・残るE項目 | 第1〜7回。新結果掲載には評価完了 | 第三者が手順を追える成果物と本文が揃う |

第4回は第2〜3回と別の順番で進めてもよいが、同時作業を必須としない。新しいlive評価を実施しない場合、第8回は既存1課題の範囲で完了させ、E08を未実施として残す。

## 2．共通の境界

- 既存のcompiler、ABI、profile、Binaryen版、最適化設定を変更しない。検証で製品不具合が見つかった場合は失敗を保存し、修正を別の変更単位へ分ける。
- 既存の`replayDevelopment`、`buildPromptWasm`、Wasm実行器などを再利用する。論文用に別のコンパイラや汎用評価基盤を作らない。
- 既存のlive記録、fixture、凍結済みbenchmarkを上書きしない。新しい出力先を使い、原本と派生物を区別する。
- 未確認のモデル指定、commit、人物によるreview、承認、第三者再現を作り足さない。不明値は`unknown`または`null`と理由で表す。
- IRのbodyだけでなく入力契約とbuild条件を再現入力に含める。package hashとWasm hashを別フィールドにする。
- 人間の理解容易性、性能優位、攻撃比較、上位LLMの要求生成、他方式との比較は今回の実装範囲外。E12・E13は別計画とする。
- 新しい実モデル評価とdataset確定は[研究評価の実行条件](../RESEARCH_EVALUATION_PREREQUISITES.md)の該当条件に従う。Effects比較研究専用の条件を本Predicate研究へ一律に転用しない。

## 3．予定する配置と最小データ契約

以下の新規パス・CLI名は**実装予定**であり、現在実行可能なコマンドではない。新規ファイルの既定配置はこの表に固定する。既存ファイルがすでに同じ責務を持つと判明した場合だけ、重複箇所を記録して再利用する。ファイル名やarchitectureの再設計を作業開始条件にしない。

| 配置案 | 用途 |
| --- | --- |
| `src/paper-evidence.ts`、`src/paper-evidence.test.ts` | inventory、環境、結果の最小schemaと検査 |
| `src/paper-reproduce.ts`、対応test | 保存応答の再生、再build、byte比較 |
| `src/paper-evaluate.ts`、対応test | 独立Oracleとnegative評価 |
| `src/paper-study.ts`、対応test | 追加課題のprotocolとrun管理 |
| `src/paper-report.ts`、対応test | 生データからの集計 |
| `src/paper-cli.ts` | 薄いCLI。各回で必要なsubcommandのみ追加 |
| `research/paper-v1/` | 仕様、draft課題、Oracle、protocol、公開可能な証跡index |
| `artifacts/paper-v1/<run-id>/` | 上書きしない実行出力、ログ、派生artifact |
| `docs/PAPER_EVIDENCE_RESULTS.md` | 各回の実装結果と、研究証拠が揃った範囲の記録 |

共通recordはversion、記録種別、task/run ID、入力hash、出力hash、証拠の由来、対象commit、環境、状態、診断、関連ファイルを持つ。第1回で必要なinventory部分だけを定義し、将来の全schemaを先行実装しない。

`origin`は少なくとも過去live記録、保存応答replay、fixture、新規liveを区別する。`status`は工程完了と評価合格を分ける。日時・elapsed timeなど実行ごとに変わる値を含むreport全体のbyte一致は求めず、Wasm本体と決定的な結果部分を明示して比較する。

CLIの終了値は0＝要求した検査の合格、1＝検証不一致・期待違反、2＝入力不正・環境障害・未完了とする。正常なnegative testで期待した拒否が起きた場合は合格である。単なるコマンド終了code 0を論文上の生成成功とは数えない。

## 4．第1回：証跡inventoryと保存

### 到達点

既存のaccess live記録と2026-09-27再検証について、必要ファイル・hash・由来・不足を機械的に確認できる。

### 実装範囲

1. 元記録と再検証のファイル一覧を読み取り、サイズ・SHA-256・役割をinventoryへ保存する。
2. source、Lock、run、manifest、suite、Wasm、reportの既存validatorを再利用して対応を確認する。ファイルhashの一致だけをlive実行の証明としない。
3. 原本を変更せず、新規directoryへ明示的な対象ファイルだけをコピーする。上書きと入力root外参照を拒否する。
4. 元live環境と今回観測した環境を分離する。元commitを特定できなければ理由付きunknownとする。環境変数や認証情報は収集しない。
5. 保存・配布対象の確認項目を記録する。生記録を自動でGit登録したり外部公開したりしない。redactionが必要な派生物は原本との区別と再生可否を記録する。

変更中心：`paper-evidence`、`paper-cli`の`inventory`、証跡indexと結果文書。再生runnerはまだ追加しない。

### 検証・完了条件

- [ ] 正常な小規模fixtureをinventory化でき、移動後も相対パスで検証できる。
- [ ] 欠損、1 byte改変、関連hash不一致、root外参照、出力先の再利用を検出する。
- [ ] 実記録についてinventoryを生成し、不足とunknownを一覧化する。
- [ ] 生データの保全先と、Git管理可能なindexを区別して結果文書へ記載する。

検証コマンド案：`bun test src/paper-evidence.test.ts`。完成した`inventory`で実記録も確認する。欠損がある場合は検証器の実装完了と証拠保全の未完了を別々に報告し、欠損ファイルを生成して補わない。

## 5．第2回：1課題のオフライン再現runner

### 到達点

inventoryが示す保存記録から、APIを呼ばずに再生・実行・二回の再build・過去Wasmとのbyte比較まで実行できる。

### 実装範囲

1. 第1回のinventoryを検証したうえで既存`replayDevelopment`を呼ぶ。
2. 採用済みIRと契約を使い、別プロセス・別directoryで二回buildする。
3. 元Wasm、replay Wasm、build A/Bをhashと直接byte比較し、packageの一致とは別に記録する。
4. command、終了値、stdout/stderr、環境、参照した入力hashを保存する。ネットワーク生成adapterを使わない経路とする。
5. timeout・中断・入力欠損を工程別に記録する。入力と他runのdirectoryは削除しない。

変更中心：`paper-reproduce`とCLI `reproduce`。多課題run、live、統計集計、クリーンcheckout自動作成は含めない。

### 検証・完了条件

- [ ] API不要のfixtureで再生と比較を実行できる。
- [ ] byte不一致、失敗process、timeoutを成功として扱わない。
- [ ] access記録で10件pass、replay一致、4つの147-byte Wasm一致を再確認する。
- [ ] 新しい出力先で繰り返せ、元の証跡は不変である。

検証コマンド案：`bun test src/paper-reproduce.test.ts src/capability-development.test.ts src/prompt-source.test.ts`。実記録の`reproduce`結果を保存する。元artifactと一致しない場合、期待hashを更新して通過させない。

## 6．第3回：独立Oracleと拒否・改変検出

### 到達点

accessの期待値をモデル生成suiteと別に採点し、検証器が具体的な不正や意味誤りを検出できることを示す。

### 実装範囲

1. 要求から定めたboolean全4組合せと不正入力のOracleを作成し、作成・reviewの状態を記録する。未reviewを独立review済みにしない。
2. 既存Wasm runtimeを使って独立Oracleを実行し、Source例・生成suiteと別の結果を出す。
3. 未知field、型不一致、合法だが意味の誤ったIR、Lock改変、契約差し替え、Wasm改変について、期待する検出段階を固定する。
4. 原本のコピーにだけ変異を入れる。意味誤りの検出とhash改変の検出を混同しないため、合法な誤IRは正規のbuild経路を通してOracleで評価する。
5. 既存testで十分な範囲は再利用し、論文用の対応表にまとめる。

変更中心：`paper-evaluate`、Oracleデータ、CLI `evaluate`、検出段階表。新しい言語機能は追加しない。

### 検証・完了条件

- [ ] baselineは全Oracleに合格する。
- [ ] 意味を変えた合法IRをOracleが検出し、その反例入力を保存する。
- [ ] 各不正入力・改変について実際の検出層を記録する。host拒否をWasm単体の保証としない。
- [ ] review未完了の場合でも評価コードは完成させ、研究用Oracleの確定だけを未完了として残す。

検証コマンド案：`bun test src/paper-evaluate.test.ts src/wasm-core.test.ts src/wasm-artifact.test.ts src/capability-package.test.ts`。実例の評価・negative reportを保存する。

## 7．第4回：IR定義・人間の役割・関連研究

### 到達点

コードに即した方式説明と一次文献の比較から、本文の貢献・前提・限界が具体的になる。

### 作業範囲

1. Predicate IRの文法、型制約、短絡評価、失敗、入力契約、WasmCoreへのloweringを対応表としてまとめる。
2. 正確な生成指示・schema・Source情報・修正時に開示される情報をコードと保存記録から抽出する。
3. 事前実装、課題作成、LLM生成、採用、手修正の役割を分離する。確認できない過去の介入はunknownとする。
4. LLM→DSL/IR、Wasm compiler、再現可能build、provenanceの一次文献を調査し、主張・共通点・差分・引用箇所を記録する。
5. 草稿の第1〜4章・関連研究・限界を更新する。新規性が弱ければ貢献文を狭め、実装量を新規性に読み替えない。

成果物案：`docs/PAPER_METHOD.md`、`docs/PAPER_RELATED_WORK.md`と草稿更新。無関係な全profile仕様の再記述や形式証明基盤の導入は含めない。

### 完了条件

- [ ] 主要な意味規則と生成制約に実装参照が付く。
- [ ] 引用先の内容を確認し、実際に支持する範囲だけを記述する。
- [ ] 少なくとも上記4領域を調査し、適切な先行研究が見つからない場合も検索範囲と未確認を記録する。
- [ ] 新規性、実現可能性、再現性の主張が区別される。

文書のみの検証は`bun run ci:docs`と差分確認とする。文書変更のために新しい実行testを作らない。

## 8．第5回：追加課題と評価protocolのdraft

### 到達点

課題・期待値・集計方法・実行条件を、モデル結果を見る前にレビューできる。

### 実装・作業範囲

1. `predicate-i32-v1`に範囲を固定し、AND/OR/NOT、enum、presence、境界、未解決を扱う課題候補を作る。既存accessは過去観測済みの別区分にする。
2. 課題ごとの要求、契約、期待動作、対象機能、作成由来、既存例との類似・重複を保存する。
3. model-visible入力と採点専用Oracleを分離する。修正に用いるsuiteと最終Oracleの役割を明記し、Oracleを修正入力に渡さない。
4. 件数、反復、model/provider、生成設定、修正上限、token・時間・費用の扱い、停止条件、除外規則、分母をprotocolへ記述する。
5. schemaとvalidatorを追加する。件数や予算が未確定でもdraftとして検査可能にし、実行可能とは扱わない。

変更中心：`paper-study`のprotocol検査と`research/paper-v1/`のdraft課題。live runnerは次回。統計的な優位性は目的に追加しない。必要課題数は成立範囲とレビューに基づき決め、恣意的な成功率目標を置かない。

### 検証・完了条件

- [ ] ID重複、欠損契約、未知profile、期待値不整合、model-visible側へのOracle混入を検出する。
- [ ] 要求とOracleの曖昧さを未解決事項として表示できる。
- [ ] 条件の確定版には対象ファイルのhash一覧が付き、変更時にreview状態が無効になる。
- [ ] 未review・未確定・未承認の状態を明示し、実測結果は生成しない。

検証コマンド案：`bun test src/paper-study.test.ts`とCLI `validate-study`。dataset確定は実装完了と別に扱う。

## 9．第6回：複数課題runnerと記録・再開

### 到達点

既存製造adapterを使い、全試行を残す複数課題runnerをfixtureで検証できる。

### 実装範囲

1. 第5回protocolのtask/trialを列挙し、既存`developCapability`を呼ぶ薄いrunnerを追加する。モデル接続は既存adapterを再利用する。
2. fixtureとliveを明示的に分離し、通常testはfixtureだけで実行する。liveは確定protocolと対象hashに結び付く明示的な実行承認を要する。
3. 応答、各段階の結果、初回／修正後、usage、latency、介入、停止理由をtrial単位で保存する。
4. task間のcheckpointと再開を実装する。完了trialを再呼出ししない。送信後・保存前の中断はuncertainとし、勝手に再送せず別trialとして再実行を判断できるようにする。
5. 既存adapterの上限の限界を保持し、SDKがhard capを保証しない値を厳密な課金上限と表示しない。

変更中心：study runnerとCLI `run-study`。新provider、並列実行、汎用ジョブ基盤は追加しない。製品側の記録形式に不足があれば、まず外側のrecordで補い、製品変更が必要なら別単位に分ける。

### 検証・完了条件

- [ ] fixtureで成功、修正後成功、未解決、不正応答、運用失敗、予算停止を保存する。
- [ ] 中断・再開、完了trialの重複防止、uncertain停止、入力変更の拒否を検証する。
- [ ] fixture testでlive adapterが呼ばれたら失敗する。
- [ ] 全trialの状態が確定または未完了として記録され、欠けた試行が成功扱いされない。

検証コマンド案：`bun test src/paper-study.test.ts src/capability-development.test.ts src/codex-development-agent.test.ts`。この回の完了は新しい実モデル生成を実証したことを意味しない。

## 10．第7回：集計と本文表生成

### 到達点

生データから本文に使う表を機械的に再生成できる。

### 実装範囲

1. protocolの予定trialと実記録を突合し、初回成功、修正後成功、未解決、各段階の失敗、運用失敗、未完了、介入を集計する。
2. 生成suiteでの合格と採点専用Oracleでの合格を別列にする。
3. 課題数・試行数・実行例数を別に数え、欠測と除外理由を表示する。古いaccess事例と新規評価、fixtureを混ぜない。
4. 再buildの一致、入力hash、環境と証跡IDを表へ結び付け、JSON・CSV・Markdownを生成する。
5. 報告から元trialへ戻れるようにする。反復を独立課題として扱う推測統計を加えない。

変更中心：`paper-report`、CLI `report`、表テンプレート。論文の数値はこの出力から引用する。

### 検証・完了条件

- [ ] 手計算可能な成功・失敗・欠測混在fixtureで分母と内訳が一致する。
- [ ] 全失敗・0完了・未実行のデータでも誤った成功率を表示しない。
- [ ] 同じ保存入力から同じ決定的な表を再生成できる。
- [ ] fixtureの表には研究結果でないことが表示される。

検証コマンド案：`bun test src/paper-report.test.ts`と保存runの`report`。既存1課題の表も生成し、手作業の本文と照合する。

## 11．別枠：レビューと追加live評価

第5〜7回の実装完了後、課題・Oracle・モデル設定・予算・停止条件を具体的にレビューし、研究評価の前提に従ってdatasetと実行条件を確定する。未承認のままfixtureをliveへ切り替えない。

実行時は全応答と全失敗を保存する。実行途中でprotocolや期待値を変更したくなった場合、元runを保存したまま新versionを用意する。成功するまで同じ条件の結果を差し替えない。一般的な成功率の結論に足りない場合も、その限界を結果として記述する。

この段階は実験であり、製品機能を追加する回ではない。評価後のバグ修正が必要なら、観測結果の保存と修正後の再評価を別run・別commitで扱う。

## 12．第8回：クリーン再現と論文反映

### 到達点

元のローカル`artifacts/`に依存せず、入手可能な証跡から論文の結果を再現できる構成を用意する。

### 作業範囲

1. 配布対象の保存応答・IR・契約・Wasm・環境・checksumsを明示し、原本と派生公開版の対応を固定する。外部公開操作は別とし、まずローカルでreview可能なbundleを完成させる。
2. 必要な依存の導入と、評価実行そのもののAPI不要・オフライン性を区別して手順を書く。
3. クリーンcheckoutと固定依存で、保存応答再生、独立Oracle、再build比較、表生成を一巡する。作業checkoutや他者の変更を消してクリーン状態を作らない。
4. 原本が再配布できない場合は制約を明記し、fixture代替を過去liveの再現と呼ばない。
5. E一覧と本文を更新し、未実施の主張は範囲を狭めるか限界に残す。第三者が実行していない場合は「著者によるクリーン環境再現」と記載する。

成果物：再現README、bundle index、クリーン実行記録、本文表、草稿改訂、最終の根拠対応表。

### 完了条件

- [ ] 非公開の絶対パスや元workspaceを参照せずに再現できる。
- [ ] 全数値から元runと入力へたどれる。
- [ ] 再生成表と本文の値が一致する。
- [ ] 未確認の環境、review、第三者再現を完了扱いしていない。
- [ ] E項目の実装完了と研究上の証拠完成が区別される。

## 13．各回の検証と引継ぎ

各回の開始時に作業ツリー、指定Bun、依存、対象証跡の存在を確認する。コード変更前には対象testの現状を採取する。指定の新規ファイル名は計画上の案なので、実装時に採用した名前へ検証コマンドも更新する。

### コードを変更した回

対象testに加え、[品質Gate](../QUALITY_GATES.md)の適用範囲に従う。基本の検証コマンドは以下とする。

```sh
bun run check
bun run coverage
bun run ci:docs
bun run ci:protected
bun run ci:smoke
git diff --check
```

対象testと全体Gateの重複実行は、修正・失敗・未解決の懸念がある場合に限る。Bunや依存を勝手に更新して通過させない。新CLIの存在はhelp、終了値、出力例の実行で確認する。

### 文書だけを変更した回

`bun run ci:docs`と`git diff --check`を実施し、引用・数値・主張を元証跡へ照合する。意味のないtestや全体coverageの再実行は追加しない。

### 毎回残す結果

`docs/PAPER_EVIDENCE_RESULTS.md`に、回番号、対象commitと作業差分、変更ファイル、実行コマンド・終了値、証跡の保存先、完了した条件、残った条件、次回の開始点を追記する。大きな生ログはartifact側に置く。

実装が正しく不一致を検出した場合は、検証基盤の完成と研究結果の不一致を分けて報告する。失敗を隠すためにOracle、元hash、過去応答、既存fixtureを書き換えない。

## 14．次回の依頼単位

最初の依頼は「この計画の第1回を実装し、検証結果を記録する」とする。完了後に第2回へ進む。各回で必要な範囲の詳細化は行うが、未実装の後続回全体を同時に着手しない。

## 15．Sol・low effort向けの実行手順

### 15.1．一回の作業の進め方

以下の順番を守る。依頼された回だけを実装する。

1. `git status --short`と`bun --version`を確認する。既存差分を記録し、他の作業を上書きしない。
2. 本書の共通境界、依頼された回、下表の参照先だけを先に読む。全profileや全結果文書を読み込まない。
3. `PAPER_EVIDENCE_RESULTS.md`が存在すれば前提回の結果を読む。存在しない前提を実装済みと仮定しない。
4. 変更予定ファイルと、この回の完了条件を短く列挙する。通常の内部実装の選択ごとに確認を求めない。
5. 既存の対象testを実行して開始時の状態を保存する。新規testの名前は当該回の指定を使う。
6. データ検査、処理本体、CLI接続の順に実装する。CLIへ業務ロジックを重複実装しない。
7. 下記の必須testを実行し、当該回の実データ検証を行う。元の期待値やhashを結果に合わせて変えない。
8. 第13節の品質Gateを実行する。失敗時は当該差分に起因するものを修正し、関係のない修正を広げない。
9. 結果文書を更新し、完了条件を一つずつ照合する。実行していない検証は「未実行」と書く。
10. 変更内容、検証結果、残項目、次の回を報告して終了する。後続回へ自動で進まない。

### 15.2．最初に読む既存実装

| 回 | 読むファイル・資料 | 使う責務 |
| --- | --- | --- |
| 1 | `src/capability-development.ts`、`src/capability-package.ts`、`src/prompt-resolution.ts`、`src/contained-path.ts` | 保存run・候補・Lockの検査とroot内path解決 |
| 2 | `src/capability-development.ts`の`replayDevelopment`、`src/prompt-wasm.ts`、`src/wasm-emitter.ts`、`docs/agent-context/binaryen/implementation.md` | 保存応答再生、build、固定backend条件 |
| 3 | `src/wasm-runtime.ts`、`src/wasm-core.ts`、`src/capability-tests.ts`、既存の対応test | 実行と拒否段階。Oracleの期待値は要求から別に定義 |
| 4 | `src/capability-test-agent.ts`、`src/codex-development-agent.ts`、`src/prompt-resolution.ts`、`src/wasm-core.ts`、草稿 | 指示・入力境界・構文・意味の記述 |
| 5 | `src/capability-development.ts`、`src/capability-test-agent.ts`、研究評価の実行条件、第3回Oracle形式 | 既存製造器が受け取れる課題と情報分離 |
| 6 | 第5回のprotocol、`src/capability-development.ts`、`src/codex-development-agent.ts` | 既存adapterの呼出しと上限・停止条件 |
| 7 | 第6回のrecord、第3回report、草稿の評価節 | 集計元と本文への対応 |
| 8 | 第1回inventory、第2回runner、第7回report、根拠充足一覧 | 再現パッケージと主張の最終照合 |

指定symbolが見つからない場合は`rg`で現行名を調べる。似た名前のAPIを推測して新しく作らない。既存moduleのprivate関数を無理に公開するより、すでに公開された上位APIを使う。

### 15.3．追加するCLIの固定ルール

共通入口は`bun run src/paper-cli.ts`とする。package.jsonのalias追加は必須にしない。各回では下記subcommandだけを追加する。オプションが不足している場合は明示的な診断を返し、ローカルartifactを暗黙に探索しない。

| 回 | subcommandと必須引数 | 出力先に必ず残すもの |
| --- | --- | --- |
| 1 | `inventory --input <saved-run-directory> --out-dir <new-directory>` | `inventory.json`、`environment.json`、検証診断、対象証跡のコピー |
| 2 | `reproduce --inventory <inventory.json> --out-dir <new-directory>` | `reproduction.json`、各工程ログ、replayとbuild A/B |
| 3 | `evaluate --inventory <inventory.json> --oracle <oracle.json> --out-dir <new-directory>` | `evaluation.json`、`negative-results.json`、変異の由来 |
| 5 | `validate-study --study <study.json> --out-dir <new-directory>` | `study-validation.json`、不足条件一覧。reviewや承認を書き込まない |
| 6 | `run-study --study <study.json> --mode fixture --out-dir <new-directory>` | `run.json`、trialごとの入力・応答・結果、checkpoint |
| 6 | `run-study --study <study.json> --mode live --approval <approval.json> --out-dir <new-directory>` | fixtureと同じ記録と実行承認の参照。実装testから呼ばない |
| 6 | `resume-study --run-dir <existing-directory>` | 元protocol・承認との一致確認、再開結果。uncertainは停止 |
| 7 | `report --run-dir <saved-run-directory> --out-dir <new-directory>` | `summary.json`、`table.csv`、`table.md` |

このCLIは論文用の補助ツールで、既存CLIの引数・終了値・出力schemaを変更しない。第6回の承認ファイルは対象study hash、承認範囲、モデル・上限、承認者と実際の承認記録の参照を保持する。ファイルを作るだけで人の承認を得たことにはしない。ソフトウェアが承認者の実在性を証明するとは主張しない。

### 15.4．最小限のtest一覧

以下は省略しない。既存testが同じ振る舞いを検証していれば重複追加せず、そのtestを結果文書へ記録する。

| 回 | 必須test |
| --- | --- |
| 1 | 正常inventory、欠損、改変、関連hash不一致、path escape、既存出力先拒否、unknown環境の保持 |
| 2 | 正常再現、byte不一致、子process失敗、timeout、元入力不変、モデル接続なし |
| 3 | 全boolean組合せ、契約違反のhost拒否、合法誤IRの反例、Lock・契約・Wasmの改変検出 |
| 5 | 重複task、欠損契約、未知profile、Oracle混入、draftの実行不可、入力変更でreview無効 |
| 6 | 初回成功、修正後成功、未解決、不正応答、予算停止、運用失敗、再開時の重複呼出し防止、uncertain停止、承認対象不一致 |
| 7 | 成功と失敗の混在、欠測、0完了、全失敗、fixture隔離、課題数と試行数の区別、決定的な表出力 |
| 8 | コード追加時はその対象test。成果物についてクリーン環境で再現手順を一巡 |

### 15.5．判断を止める条件と、続行できる条件

| 状況 | 対応 |
| --- | --- |
| 過去のcommitや作成者が不明 | unknownと理由を保存し、他の作業を続行する |
| 配布条件や機密性が不明 | 元データを保持し、ローカルinventoryとコードを完成させる。外部公開はしない |
| 独立review・live承認が未提供 | validator・fixture・ドキュメントを完成させる。reviewやlive実行だけを未完了とする |
| 元artifactが欠損している | 欠損を記録し、fixtureでツールを検証する。実証結果を捏造せず、必要ファイルを具体的に報告する |
| 現行APIで必要処理を実装できる | そのAPIを使って続行する。不要な汎用化をしない |
| 製品仕様・ABI変更が必要と判明 | この回へ混ぜない。反例と最小再現を保存し、別の修正が必要と報告する |
| 指定外のprovider・モデルが必要 | 自動代替しない。指定条件で未実行と記録する |
| 環境起因か意味不一致か判断できない | observed errorとして保存する。成功・意味的失敗のどちらにも丸めない |

不確実性が一つあっても、依存しないコード・fixture検証・文書化は進める。人の回答が必要な箇所だけを具体的に残す。

## 16．各回に渡す依頼文

以下の`N`だけを対象の回番号に置き換える。実装担当の設定はGPT-6 Sol／low effortとする。

```text
docs/PAPER_EVIDENCE_IMPLEMENTATION_PLAN.md の第N回だけを実施してください。
共通境界、第N回、Sol・low effort向け手順に従ってください。
前提回の成果物と既存差分を確認し、指定されたファイル・APIを再利用してください。
この回の実装、必須test、品質Gate、結果記録まで完了してください。
後続回の機能、製品ABI変更、モデル・依存の更新、新しいlive評価は追加しないでください。
不明な過去情報はunknownとし、review・承認・実測を作り足さないでください。
docs/PAPER_EVIDENCE_RESULTS.md に完了条件ごとの結果と残項目を記録してください。
最後に変更内容、実行した検証、未完了の根拠、次回の開始点を報告してください。
```

第4回ではコード実装を強制せず、文献調査・仕様説明・本文修正を完了する。第8回では必要な再現手順の整備と論文反映を行う。追加live評価は第11節専用の依頼と条件確定を経て実施する。
