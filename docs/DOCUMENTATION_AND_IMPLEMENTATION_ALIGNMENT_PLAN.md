# TypeScript・JSONCの文書整理・仕様実装整合計画

作成日：2026-09-17。状態：文書整備に続きI1〜I6とCI拡充を実装。実行結果・残る環境確認は[改善記録](./IMPROVEMENTS_RESULTS_20260917.md)を参照。以下の作業表は着手時の差分と完了条件を保持する。確認範囲と証跡は[文書確認記録](./MAINTENANCE_STATUS.md)を参照。

## 1. 目的と完了状態

初めて読む利用者が、TypeScriptとJSONCそれぞれの役割、入力と出力の対応、実行方法、保証の限界を理解し、目的に応じた経路をAPI認証なしで検証できる状態にする。同時に、仕様が約束する実行報告と実装を一致させる。

TypeScriptとJSONCは併存し、出力もTypeScript・JSONC・Wasmを区別する。形式の併存を整理不足とは扱わず、入力・変換工程・出力が分かりにくい点を整理する。JSONC出力の現行経路はdevelopによる生成とmigrateによる変換であり、任意のTypeScriptとの相互変換を実装済みとはしない。単体コンパイラのlint/buildに要求ファイルやSAAAを必須化しない。

JSONC経路の基準は[JSONC言語仕様](./LLANG_JSONC_SPEC.md)、TypeScript経路の利用案内は[Semantic TypeScriptガイド](./guides/semantic-typescript.md)。[従来の実装計画・完了記録](./LLANG_JSONC_IMPLEMENTATION_PLAN.md)は履歴として残し、本計画を追加の整合作業の管理先とする。「P0〜P6完了」を、本計画の完了や実利用価値の実証と同義にしない。

## 2. 対象と前提

### 対象

- 日本語・英語README、ロードマップ、品質・貢献・セキュリティ文書、JSONC仕様・操作例の整合。
- `llang test`の追跡情報、検証対象snapshot、CLIヘルプ・終了値・出力契約。
- JSONC経路のオフラインsmoke、文書と実コマンドの継続的な照合。
- 固定環境での品質検証と、既存経路の互換性確認。

### 対象外

- 数値演算、collection、module、effect、新Wasm ABI、汎用コード生成。
- SAAAへの登録・配備、実サービスへの公開、npm公開、認証方式の変更。
- 既存経路の削除、lock・manifest・既存凍結benchmarkの書き換え。
- 大規模なコード再編成、モデル・providerの切替、実モデル評価の実行。

### 作業開始時の注意

調査基点はcommit `0a40782`に未コミット変更を加えた作業ツリー。Capability・development周辺は別途分割編集中だった。実装開始時に責務の移動先と差分を再確認し、既存の変更を上書きしない。本書のファイル名は調査時点のもので、分割後は同じ公開関数の所在へ読み替える。

前回評価ではJSONC主要48テストが成功。全体coverageは約8分超で中断し、途中453件成功・失敗表示0件だったが、全体合格とcoverage値は未確認。ローカルBun 1.3.14と指定1.4.2の差、同時実行負荷もあった。この結果を既存不具合やCI失敗の確定証拠にはしない。

## 3. 正本と文書構成

| 情報 | 正本・配置方針 |
| --- | --- |
| 言語の受理範囲・実行意味・hash | `docs/LLANG_JSONC_SPEC.md`。公開schema・実装・適合テストを対応付ける |
| CLIの引数・出力・終了値 | `docs/LLANG_CLI_REFERENCE.md`（作成済み）。ヘルプと契約テストで照合する |
| 最短の導入 | `README.md` / `README.en.md`。同じ経路分類・非目標・実証範囲を説明する |
| 再実行できる例 | `examples/jsonc-enabled-user/README.md`と同ディレクトリの入力 |
| 現在地・未完了事項 | `PROJECT_STATUS_AND_ROADMAP.md`。各経路、実装済みと未実証を分ける |
| 実行環境・品質Gate | 実行値は`package.json`、`bun.lock`、CI workflow、`src/run-coverage.ts`。`QUALITY_GATES.md`はこれらに一致させる |
| 信頼境界 | `SECURITY.md`。各経路の違いを明記する |
| 経路ごとの使い方 | `docs/guides/semantic-typescript.md`と英語版、`docs/guides/language-routes.md`。TypeScriptをlegacy扱いしない |
| 評価結果 | 日付・対象revision・条件・証跡を持つ結果文書。旧結果を新JSONC経路の実績へ読み替えない |

一覧・利用ガイド・CLIリファレンスは作成済み。仕様とコードが違う場合、現行実装へ文書を無条件に合わせない。安全性・追跡性の約束は実装を修正し、歴史的説明や未提供の導線は現状を明記する。

## 4. 作業一覧

優先度P0は正しさ・再現性、P1は導入と継続検証、P2は本計画後の製品検証。実施済み範囲は第10節に記録する。実施結果は末尾の追補を参照。実装者は結果・対象revision・検証ログを記録してから完了にする。

| ID | 優先度・分類 | 現状と作業 | 完了条件・検証 |
| --- | --- | --- | --- |
| A0 | P0・基準固定 | 指定Bun・依存・作業snapshotを固定し、編集中の分割を取り込んだ基準を採取する | revision、未コミット差分hash、Bun/TS/Biome/Binaryen版、局所・全体Gate結果を保存。未完了を成功と記録しない |
| I1 | P0・確定差分 | `runLlangSuite`の報告へ要求・suite・source・program・artifactのhashを追加する | 下記報告契約と`verify`で同一入力の値が一致。合格・不合格とも追跡可能 |
| I2 | P0・要検証 | suite検証前のSource読込と`buildLlangProgram`の再読込が同じ対象を扱うことを保証する | 差し替えを制御したテストで、別契約・別Programを検証済みとして実行・報告しない |
| I3 | P0・契約整理 | 仕様とCLIの終了値・stdout/stderr・error/failの区別を表にして不足を修正する | 全10コマンドで成功・不一致・入力/I/Oエラーの契約テストが通る。既存自動化への影響を記録 |
| I4 | P1・使い勝手 | `llang --help`、`llang help`、各サブコマンドの`--help`を実装する | ファイルなし・APIなしで終了0。必須引数、例、終了値、`mutation-check`を表示。不正引数は終了2 |
| I5 | P0・要検証 | formatの「mutexとCAS」説明と実装の再読込＋atomic renameを照合する | 協調writerの競合を再現し、必要なロック範囲を実装・検査。一般の外部writerまで完全排他するとは記載しない |
| I6 | P1・確定差分 | 汎用host/host-kitはCapability v1のみ。JSONC v2対応は未実装 | v1互換を維持し、v2 inspect/verify/invoke・改変・timeout・移動後実行を検証する。対応まで文書で非互換を明示 |
| D1 | 完了・文書 | 両READMEを入出力経路の一覧へ再構成し、TypeScript詳細を利用ガイドへ整理する | 同じ最小例が動き、入出力形式・LLMを使う工程・制限が両言語で一致。既存例へのリンクを維持 |
| D2 | 完了・文書 | ロードマップと旧公開計画の位置付けを整理する | TypeScript、JSONC、Prompt Source、Hybrid、用途別デモの区別と未完了Gateが分かる。過去計画は削除せず適用範囲を冒頭表示 |
| D3 | 完了・文書 | 品質文書・Contributingの版とCI対象OSを修正する | 調査時のBun 1.4.2、TS 5.9.3、Biome 2.5.13、Ubuntu/Windowsと一致。実装時に設定を再読し、macOS CI成功とは記載しない |
| D4 | 完了・文書 | JSONC実装計画の古い例・予定表現・ファイル一覧を訂正する | `test`例に`--request`を追加。「P4追加予定」や未作成モジュールを現在実装と混同しない |
| D5 | 完了・文書 | `develop`のsuite受取とテスト生成の説明を分ける | v2 CLIは既存の固定suiteを受け取り、最大2回の実装agent呼出し（初回＋修正）であることを明記。旧テスト製造工程と混同しない |
| D6 | 完了・文書 | SECURITYと貢献手順を各経路に対応させる | hash≠署名、テスト合格≠要求の完全証明、部品検証≠SAAA受け入れ、コンパイラとagentの権限境界を説明 |
| Q1 | P1・継続検証 | JSONCのoffline smokeを追加し、既存semantic smokeを残す | lint→format check→build→test→package→verify→mutation-checkが一時ディレクトリで成功。入力不変・API呼出0・終了時cleanupを確認 |
| Q2 | P1・継続検証 | 現行ドキュメントのコマンドとツール版を継続検査する | 主要例の引数誤り、ヘルプのコマンド欠落、現行版の不一致を検出。過去結果の版表記は対象外 |
| Q3 | P1・検証改善 | coverage runnerが終了まで出力を保持するため、進行と中断理由を観測可能にする | 出力を逐次表示しつつ集計。子プロセス失敗を伝播し、既存90%/95%閾値・解析を維持。中断を成功扱いしない |
| Q4 | P0・最終Gate | 固定環境で全体検証とUbuntu/Windows CI結果を揃える | 同一最終revisionでGate成功。各経路の回帰なし。未実行OS・監査未完了・CI未実行は別記する |

## 5. 実装修正の具体契約

### I1・I2：単体testの証跡と実行対象

対象は`src/llang-capability-runtime.ts`の`runLlangSuite`、`src/llang-build.ts`、関連CLI・テスト。既存`version: 2`、requirements、coverage、resultsを維持し、次を追加する。既存利用側にstrictなキー検査があるかA0で確認する。

| field | 定義 |
| --- | --- |
| requestRevision | 実際に検証した固定requestの既存`requestRevision`関数による値 |
| suiteHash | parse・検証済みsuiteの既存`contentHash`による値。ファイルbytes hashと混同しない |
| sourceHash | 実際にコンパイルしたJSONC bytesのhash |
| programHash | 実際にコンパイルした検証済みProgramのcanonical hash |
| artifactHash | 実際に評価したWasm bytesのhash。`verify`と同じ意味 |

hashは報告時に元パスを再読して作らず、実行に使ったsnapshot・manifestから得る。現状は契約確認後にbuildで再読するため、最低限build manifestのsourceHash/programHash/contractが最初に検証したsnapshotと一致することを、Wasm実行前に確認する。snapshotから直接buildする小さな内部APIを使う方が単純なら、その方法を選ぶ。共通コンパイラ全体の再設計はしない。

同じ入力の`test`と`verify`、コメントだけの変更、意味変更、期待値不一致、要求網羅不足、Source差し替えを検査する。コメント変更はsourceHashだけに影響し、programHashとartifactHashは同一となる。読み取り失敗などで未実行の場合、架空のhashや合格を出さない。

### I3・I4：CLI契約

新リファレンスにはlint、format、build、test、package、verify、mutation-check、migrate、develop、replay-developmentの引数・出力例・副作用・認証要否を記載する。

- 0：成功。helpとwarningのみのlintも成功。ただしwarnings-as-errorsを除く。
- 1：検証不一致、要求未網羅、format --checkの差分等。各コマンドの具体条件を明記する。
- 2：引数不正、I/O失敗、実行障害。`test`の内部実行エラーと期待値不一致を分ける必要があるか、既存`verify`契約と照合して確定する。
- 機械可読モードではstdoutに一つのJSON。診断エラーとI/OエラーのJSON対応範囲を明示し、仕様が要求するのに実装が欠ける範囲を修正する。全コマンドへの新しい`--json`オプションを無差別に導入しない。
- 既存の正常系引数形式と出力フィールドを維持する。変更する終了値・エラー形式はリファレンスに移行注意を記載し、呼出側を検証する。

### I5：formatの競合

現在の`format --write`は再読してからatomic writeするが、その間の協調ロックは同関数から確認できない。atomic renameだけをCASと呼ばない。既存のロック実装を調べ、適切なら利用して読み取り・比較・書き込みを保護する。既存機構が適合しなければ、Source単位の小さな協調ロックを検討する。

同じSourceへの二つのformat、途中編集、書込失敗、ロック解放を決定的な同期点で検証する。時間待ちに依存する不安定な競合テストを増やさない。任意の外部エディタを含む完全な排他や、複数ファイルの同時可視性は保証しない。

### D5：独立suiteの責任範囲

今回の整合ではv2にテスト生成機能を新設しない。現行v2が固定suiteを入力に要求する事実、suiteの作成責任、実装修正で期待値を変えないことを明記する。独立生成の自動化が必要なら、別項目として入力分離・freeze・予算・証跡を設計する。旧経路に存在する機能をv2実装済みと表示しない。

## 6. 実施順序と分割

| 段階 | 含む項目 | 依存・出口 |
| --- | --- | --- |
| M0 基準と差分表 | A0、D3、I3の契約棚卸し | 分割中コードを確認し、正本・現行挙動・検証条件を固定 |
| M1 正しさと証跡 | I1、I2、I5 | M0後。報告と実際の実行対象が一致し、競合の保証範囲を検証 |
| M2 CLI利用契約 | I3の修正、I4、I6、Q1 | M1後。ヘルプ、終了値、出力、最小例を実行可能にする |
| M3 文書再整備 | D1、D2、D4、D5、D6 | M0で構成を決め、M1/M2の最終挙動で確定。CLIリファレンス作成 |
| M4 継続検証と完了 | Q2、Q3、Q4 | M2/M3後。最終revisionの証跡を揃える |

各段階を独立してレビューできる変更単位とする。文書構成の下書きは先行できるが、未実装の機能を現在形で公開しない。利用者価値のlive比較やリリース準備を、M4の完了条件へ混ぜない。

## 7. 検証計画

### 局所検証

I1/I2/I5とCLI変更では、既存の`llang-capability.test.ts`、`llang-cli.test.ts`、`llang-jsonc.test.ts`、`llang-program.test.ts`を拡張する。development分割が完了していれば、その専用テストも対象に含める。Q1は保存済み例を実際のCLIから実行し、関数単体の検査だけで代用しない。

```sh
bun test src/llang-jsonc.test.ts src/llang-program.test.ts src/llang-cli.test.ts src/llang-capability.test.ts --timeout 30000
bun run ci:docs
```

文書だけの変更ではリンクと例の実行を確認し、文章をそのまま比較する脆いテストは追加しない。Q2は全Markdownを汎用実行する仕組みにせず、現行の最小例・CLI一覧・版情報に対象を限定する。過去evidenceや凍結fixtureを書き換えない。

### 最終検証

指定Bun・同一依存・同一snapshotで次を実行する。重いテストとcoverageを同時実行しない。coverageも全テストを実行するため、同一内容を重ねて実行する必要がない場面ではcoverageを全体回帰として記録してよい。

```sh
bun install --frozen-lockfile
bun audit
bun run format:check
bun run lint
bun run typecheck
bun run coverage
bun run ci:docs
bun run ci:protected
bun run ci:smoke
git diff --check
```

Q1で追加するJSONC smokeも実行する（スクリプト名案：`ci:llang-smoke`）。fixture・smoke・通常テストはAPI認証なしで通す。依存監査はネットワーク照会であり、オフラインsmokeとは区別する。監査が完了しなければ未確認として残す。

Ubuntu/Windowsで既存・JSONC両smokeと回帰を確認する。ローカルmacOSの成功をmacOS CI成功と表示しない。CI未実行の時点ではM4を完了にしない。

結果にはrevision、作業ツリーの状態、環境、コマンド、終了値、件数・coverage、ログ保存先、未完了理由を記録する。前後比較は同条件の実行に限る。coverage閾値は全体functions/lines 90%、semantic-transaction 95%を維持する。

## 8. 後続項目と別判断が必要な変更

| 項目 | 着手条件・判断内容 |
| --- | --- |
| P2：開発者価値の比較 | 新JSONC経路と通常のTypeScript実装を同じ要求・独立受け入れ条件で比較。初回成功率、総時間、修正回数、費用、変更追従時間を測る。dataset・モデル・予算・参加条件を実行前に固定する |
| 経路の廃止 | 本計画では提案しない。TypeScriptとJSONCの併存を維持する |
| v2でのテスト生成自動化 | 固定suiteを受け取る現在の境界を拡張するため、別設計にする |
| 破壊的なschema/API変更 | 追加フィールドを拒否する既存consumer等が見つかった場合、互換策を先に提示する。黙ってversionの意味を変えない |
| 公開・配備・有料live実行 | 今回の計画作成に含まない。対象・費用・運用責任を具体化した段階で扱う |

## 9. 実装まで含めた全体完了チェックリスト

文書作業D1〜D6の完了は第11節を参照する。以下はI/Q項目も含むため、文書完了だけではチェックしない。

- [ ] A0〜Q4の全項目に結果と証跡がある。
- [x] 日本語・英語READMEから、認証なしで現行の最小例を再実行できる。
- [x] test報告のhashが検証・実行した入力と成果物を特定する。
- [x] CLIのhelp・引数・出力・終了値が仕様と一致する。
- [x] format・testの競合条件と保証範囲が実装・テスト・文書で一致する。
- [x] suiteの入力と生成、部品検証と外部受け入れ、fixtureとliveを混同していない。
- [x] 既存経路の例・lock・凍結証跡を維持し、回帰検証が成功する。
- [ ] 固定環境の全品質GateとUbuntu/Windows CIが同一最終revisionで成功する。
- [x] 未実証の性能・生産性・配布成熟度を実装完了によって証明済みにしていない。


## 10. 文書整備段階の記録（後続実装は第12節）

- README日英を入力・出力別の入口へ再構成し、TypeScriptとJSONCの併存を明記した（D1）。
- 詳細なTypeScript利用説明を`docs/guides/semantic-typescript.md`と英語版へ移し、相対リンクを修正した。TypeScriptの機能を廃止・非推奨にはしていない。
- `docs/guides/language-routes.md`、`docs/README.md`、`examples/README.md`を追加し、利用ガイド・仕様・計画・結果・実行例を分類した。
- ロードマップ冒頭に各経路の現在地を追加し、既存の詳細評価はTypeScript経路の記録として位置付けた（D2の入口整理）。
- 品質文書とContributingの実行環境、JSONC計画の必須引数とsuite受取の説明を訂正した（D3、D4/D5の確認済み説明差分）。
- SECURITYへJSONC経路の入力・生成・部品検証の境界を追加した（D6の説明整理）。

既存の仕様・結果・examplesは、lock・manifest・外部リンクへの影響を避けるため一括移動していない。新しいガイド用フォルダーと各一覧から分類して到達できる。srcやschemaの移動、CLI・compilerの変更は今回実施していない。

文書整備完了時点ではI1〜I6、Q1〜Q4が実装・継続検証の残作業だった。後続の実施状況は第12節と改善記録を参照。文書整理の成功を機能・全体品質Gateの成功とは扱わない。


## 11. 文書メンテナンスの完了（2026-09-17）

- [x] D1：日英READMEとTypeScript/JSONC各ガイド、経路表、実行例を整理。
- [x] D2：ロードマップを現在の経路別に更新し、過去の詳細をrecordsへ分離。全計画・設計・結果の適用範囲を分類。
- [x] D3：現行の環境・CI記載を設定と照合。過去の実測版・件数はそのまま保存。
- [x] D4：JSONC計画を実装記録へ整理し、仮のファイル名や完了の過大表現を修正。
- [x] D5：v1のテスト生成とv2の固定suite入力を区別し、v2の生成・修正・replay例を追加。
- [x] D6：経路別の信頼境界、report・署名・受け入れ・host互換性を説明。
- [x] CLI全10コマンドの現在の引数・出力・終了値と未実装機能を文書化。
- [x] ローカルリンク、fragment、現行script名、参照ファイル、凍結証跡の保持と代表的なオフライン経路を検査。

実行結果・対象文書は[メンテナンス記録](./MAINTENANCE_STATUS.md)に集約した。実装上の未完了を隠すための仕様緩和は行っていない。

## 12. 実装修正の追補（2026-09-17）

I1/I2はsnapshotコンパイルと5種類のhash、I3/I4はCLI契約とヘルプ、I5は協調ロック、I6はv1/v2 hostとキットを実装した。Q1はJSONC smoke、Q2はCLI一覧・版の文書照合、Q3はcoverage逐次出力を追加した。Q4のローカル結果と未実行OS/CIは[改善記録](./IMPROVEMENTS_RESULTS_20260917.md)で区別する。

利用者向けの6項目の改善では、上記に加え共通IRを使う4通りの入出力比較、要件変更から修正・配備・切戻しの例、compilerを含まない共通artifact検査・case実行・検証モジュールの分離を実施した。旧版の文書整備記録や凍結evidenceは書き換えていない。
