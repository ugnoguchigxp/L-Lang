# Prompt Source接続・再現可能な運用の実装計画

> 2026-09-15更新：今後の拡張順序と検証の責務分担は[エージェント能力拡張コンセプト](./AGENT_CAPABILITY_IMPLEMENTATION_CONCEPT.md)を基準とする。本書の実装履歴は保持し、人間の都度レビューや研究評価の完了を後続開発の前提にはしない。

2026-09-14。基点は`9fffe3b`（`wasm-compiler`）。[初期PoC](./WASM_POC_IMPLEMENTATION_PLAN.md)のP0〜P6に続き、[コンセプト](./WASM_COMPILER_CONCEPT.md)の段階C・Dを実装する。結果と未検証事項は[実装結果](./PROMPT_SOURCE_RESULTS.md)を参照する。

## 対象と完了条件

自然言語の要求をPrompt Sourceへ整理し、要求IDを指定した局所更新を行い、Predicate IRへ意味解決する。確定したIRは独立Lockへ保存する。以後はTS DSL・TS renderer・LLMなしでWasmをbuild/test/inspectできることを完了条件とする。

実行対象は既存の`predicate-i32-v1`を維持する。boolean、closed enum、null/undefined/存在判定を持つflat recordからbooleanを返す。guestにはmemory、imports、可変状態を持たせない。任意の自然言語プログラム、一般的な文字列演算、ownership checkerは対象に含めない。

## 実装順序と受け入れ条件

| 単位 | 実装 | 受け入れ条件 | 状態 |
| --- | --- | --- | --- |
| C0 | baselineと既存CIの確認 | 既存18 Wasmテスト成功、CI失敗理由を保存 | 完了 |
| C1 | strictなJSON Source、ID付き要求、入力契約、検証例 | 不明フィールド、重複ID、不正例、未対応profileを拒否 | 完了 |
| C2 | create/read/updateのAgent用APIとCLI | Source作成は既存を上書きしない。指定外の要求・型・例を局所更新しない | 完了 |
| C3 | 自然言語からの作成・更新、意味解決adapter | fixtureと明示的なlive model接続を用意。拒否・未解決・不正出力を保存しない | 完了（live精度評価は別） |
| D1 | Source revision、独立Resolution Lock、IR hash | Source変更でstale、整合性不一致で停止、再利用時API 0回 | 完了 |
| D2 | 競合制御・失敗時の保存規則 | 更新競合と解決中のSource/Lock変更を拒否。未解決で旧Lockを維持 | 完了 |
| D3 | TS DSL不要のbuild/test/inspect | 別プロセスで同一bytes。Source/Lockとの対応を検査し、期待結果をWasm実行で照合 | 完了 |
| D4 | CLI例・品質Gate・評価文書 | 既存回帰を確認し、fixtureの証拠とlive未評価を区別する | 完了（他OS再CIは未実施） |

## Sourceと更新の契約

Sourceは`version/kind/id/intent/requirements/unresolvedWhen/profile/contract/examples`を持つ。要求は`id/level/text`。`must-not`は禁止動作を記述し、`should`も意味解決器が勝手に無視してよい要求にはしない。未解決条件と要求の矛盾・曖昧さはresolverが未解決として返す。ただし、自然言語の矛盾を機械的に網羅検出する保証はない。

例は利用者側で用意した正例・負例を必須とする。入力にJSONで表せないundefinedが必要なときは`undefinedFields`にフィールド名を列挙する。欠損とは区別する。Source生成・局所更新・意味解決のモデル入力には検証例を含めない。

局所更新は`changes: [{id, replacement}]`のみを受け付ける。削除は`replacement:null`、追加は未使用IDへのreplacement。呼出側が`allowedIds`と読み取り時のrevisionを指定する。型・例・intentの変更はこのAPIの範囲外であり、Sourceを明示的に編集して再検証する。モデルに自由なファイル書込やパス選択は与えない。

JSONのobject key順を正規化してrevisionを求める。要求・例の配列順は保持する。改行やインデントだけではstaleにしない。履歴はGitで管理し、SourceとLockの差分をレビューする。

## Lockと再現性

`<source>.lock.json`はSource hash、IR本体、IR hash、protocol、provider/model/response ID/token usage、diagnostics、全体checksumを保持する。emitterの版と生成設定はBuild Manifest側に置く。Lockは再構築可能なcacheではなく、レビュー・保存対象の意味解決結果であり、自動失効やLRU削除はしない。

意味解決は一度だけ呼び出し、IRの構文、入力契約へのlowering、独立例との一致を確認してから公開する。未解決や検証失敗では旧Lockを維持する。通常buildはstaleをエラーにし、モデルを暗黙には呼ばない。現行protocolの有効なLockはモデル指定や認証情報がなくても再利用できる。

書込みはSourceごとの`.write-lock`で排他し、更新時のrevisionと、意味解決開始前のSource/Lockを比較する。ファイル公開はatomic更新、Source初回作成は完成した一時ファイルからの排他的linkとする。クラッシュで残る`.write-lock`は自動削除しない。書込みプロセスが終了していることを確認し、Source/Lockを調べてから手動回復する。他ツールからの同時直接編集は協調排他の保証範囲外。

checksumは事故による不整合の検出であり、署名や意味の証明ではない。hashを再計算できる攻撃者の偽造防止機構ではない。testで照合する有限例も、全自然言語要求の充足証明にはならない。

## 実装・検証方法

`src/prompt-source.ts`、`prompt-resolution.ts`、`prompt-agent.ts`、`prompt-wasm.ts`、`prompt-cli.ts`へ責務を分ける。意味解決結果のpure parserは`elaboration-result.ts`へ分離し、既存OpenAI APIのexportを維持する。通常buildの依存グラフにOpenAIクライアント、TS scanner、TS rendererを入れない。

既存のOpenAI/Azure Responses API接続を再利用し、Structured Outputsのstrict schema、`store:false`、明示的なmodelとoutput token上限を使う。入力128 KiB、output上限256〜16384 token、既存接続の120秒timeout、自動retryなし。live callの実行にはprovider/model/予算と独立データを決める必要がある。今回はfixtureとadapterのmockを使い、live精度や費用は評価しない。

新規テストはSource/Lock/成果物の不整合、要求範囲外更新、同時書込み、解決中の変更、未解決、不正IR、モデルに検証例を渡さないこと、別プロセス再現性を含める。既存の全品質Gateも実行する。

## 段階Eへの判断

memory profile、QBE、MLIR/LLVM、AOTを追加する根拠となる実利用上の不足は、現時点では確認できていない。段階C・Dの後に自動着手はしない。まず独立した要求変更課題で、手書き/直接コード保守・既存TS DSL・Prompt Sourceの成功率、意図しない変更、修正時間、費用を比較する。backend追加は、その結果で用途と必要性を具体化してから計画する。

## 継続実装（2026-09-15）

成果物検証の読み取り競合を修正し、要求変更・未解決課題のfixture評価runnerを追加した。[継続実装の結果](./PROMPT_SOURCE_EVALUATION_RESULTS.md)と[実モデル評価の不足条件](../benchmarks/prompt-source/BLOCKER.md)を参照。
