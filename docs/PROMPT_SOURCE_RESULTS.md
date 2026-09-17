# Prompt Source実装結果と現時点の評価

> 分類：本文の日付・基点revision・実行条件に対する結果記録です。過去の数値・未完了事項を現在の全経路へ一般化しません。現在の対応範囲は[ロードマップ](../PROJECT_STATUS_AND_ROADMAP.md)、利用方法は[例の一覧](../examples/README.md)を参照してください。

評価日：2026-09-14。対象は`wasm-compiler`の`9fffe3b`を基点とする追加実装。対応する[実装計画](./PROMPT_SOURCE_IMPLEMENTATION_PLAN.md)は段階C・D。検証ログはローカルの`artifacts/prompt-source/`へ保存する。

## 実装で確認できたこと

TS DSLを用意せず、自然言語の要求文・入力契約・利用者側の検証例からPrompt Sourceを作成し、ID単位で要求を更新する経路を実装した。意味解決後のIRは専用Lockへ保存する。LockからWasmを生成する経路はTS scanner・TS renderer・OpenAIクライアントを読み込まない。

自然言語モデルへの接続コードはあるが、この実装の検証はfixtureとadapterのmockによる。実モデルが要求を適切に整理・更新・解決する確率を測ったものではない。

| 対象 | 実装・観測 | 意味する範囲 |
| --- | --- | --- |
| Source作成・局所更新 | strict JSON、stable ID、allowed IDs、revisionによる競合検出 | モデルが変更できる構造的な範囲を狭められる |
| 検証例 | 正例・負例が必須。作成・更新・resolveのモデル入力に含めない | 同じモデルが期待結果を都合よく変更する経路を排除できる |
| 独立Lock | Source hash、IR本体/hash、protocol、resolver metadata、checksum | backendに依存しない意味解決結果の保存とstale検出ができる |
| 失敗時 | 未解決・IR不正・例不一致・競合で公開せず、旧Lockを維持 | 不完全な解決を通常buildへ流さない |
| オフラインbuild | 別プロセスで同一WasmとManifest。禁止importを設定したテストでTS/OpenAI/旧renderer不要を確認 | 固定した解決結果からの再現性を確認できた |
| 利用 | 158 bytes、6例成功、既存host APIで実行可能 | 新しいSource経路から従来と同じPredicateを利用できる |
| live adapter | strict schema、store:false、token上限、入力上限、timeout、retryなし | 接続の制御は実装済み。実モデルの成功率・費用は未測定 |

生成WasmのSHA-256は`1bf63427c8e5ffd161ddc724eac87558cf8768847976fb5214a431704eb3a22c`。初期TS DSL経路で得た同じPredicateのbytesと一致した。Sourceは[customer.prompt.json](../examples/prompt-active-customer/customer.prompt.json)、Lockは[customer.prompt.json.lock.json](../examples/prompt-active-customer/customer.prompt.json.lock.json)。意味解決はfixture由来であることをLockのprovider/modelに明記している。

## 再現手順

[利用例](../examples/prompt-active-customer/README.md)に、check、resolve、build、test、inspectと自然言語からのdraft/updateを掲載した。同梱Lockを使ったbuild/test/inspectのAPI callは0回。revisionはJSONのobject key順を正規化した内容hashなので、formatだけでは無効にならない。

`prompt inspect --manifest`は現在のSource/Lockと成果物の対応を確認する。`prompt test --manifest`はその検査に加え、Wasmのhost adapterを通した実行結果を例と照合する。構造検証・期待結果照合・自然言語意味の正しさは異なる検証であり、互いの代替にはならない。

## 品質チェック

Bun 1.3.14、macOSで検証した。新規境界の局所テスト15件と既存OpenAI adapter 12件は成功。別プロセス再現性、禁止依存、Source/Lock競合、不正IR、stale成果物に加え、null/不正protocol/不正usageを含む破損Lockを上書きしない検査を含む。

| Gate | 結果 | 保存ログ |
| --- | --- | --- |
| frozen install | 成功、依存変更なし | `install.log` |
| format / lint / typecheck | 成功 | `format-check.log` / `lint.log` / `typecheck.log` |
| 全体テスト・coverage | 303 pass / 0 fail、1,528 assertions、72 files、245.24秒 | `coverage.log` |
| 全体coverage | functions 94.14% / lines 92.34%、閾値を通過 | `coverage.log` |
| semantic-transaction coverage | functions 98.36% / lines 96.88%、閾値を通過 | `coverage.log` |
| docs / protected inputs / smoke | 成功。smokeはAPI keyを空にして実行 | `docs.log` / `protected.log` / `smoke.log` |
| CLIのbuild / test / inspect / run | 成功。158 bytes、6例一致、通常入力でtrue | `build.json` / `test.json` / `inspect.json` / `run.json` |
| `git diff --check` | 成功 | 最終差分で確認 |
| `bun audit` | registry応答待ちで中断。成功とは扱わない | `audit.log` |
| 監査の代替照会 | 同じBun Lockの全15 packageをnpm advisory APIに照会、0件（`{}`） | `lock-audit.json` |

ログはすべて`artifacts/prompt-source/`配下。最終の差分は`implementation.diff`として同じ場所へ保存する。liveモデルcallは実行していない。

前回commit `9fffe3b`の[CI run](https://github.com/ugnoguchigxp/L-Lang/actions/runs/34796333803)はmacOS成功、Ubuntu・Windows失敗だった。Ubuntuは既存`semantic-verify.test.ts`の3テストが20秒を超えた。Windowsはcheckout時のCRLF変換でformat検査が失敗した。今回、該当検証のtimeoutを60秒とし、`.gitattributes`でtextのLFを固定した。assertionやcoverage閾値は緩めていない。修正後の他OS実行は再CIが必要。

## 実現確度と所感

| 評価対象 | 現時点の所感 | 次に確かめること |
| --- | --- | --- |
| TS DSLなしのWasm縦断 | 初期subsetでは実装・検証済み。実現できそうという推測段階を越えた | 別の独立した入力契約・要求で利用する |
| 固定した意味の再現・追跡 | 高い。Lock再利用、bytes一致、競合・stale拒否を確認した | 他OS、クラッシュ回復の運用、複数人のGit workflow |
| Agentによる局所更新の範囲制御 | 高い。IDとrevisionで構造上の範囲外変更を防げる | 変更対象の文章が意味を正しく保持するか |
| 自然言語の意図どおりの解決 | 中程度の見込みを維持。fixtureは精度の根拠にはできない | 人手で固定した独立課題でlive評価、曖昧要求で未解決になるか |
| 実務で保守しやすくなるか | 未判定。APIとCLIがつながり、比較評価を始められる状態 | 直接コード保守・TS DSLと成功率、意図しない変更、時間、費用を比較 |
| Wasmの性能優位 | 前回と同じく未確認。今回のSource接続は実行速度改善を目的としていない | 実用途が決まった時点でadapter込みの計測 |
| ownership・memory・Native拡張 | 依然として研究課題。今の成功から一般化はできない | 現在のprofileで表せない必要な処理と性能条件を特定 |

所感として、限定した言語と明確な入力契約から始め、独立例とLockを通して段階的に広げる方針には手応えがある。Wasm生成自体より、要求の意味を崩さずに変更できるかが次の主要な不確実性となった。現時点で「任意の自然言語を安全にコンパイルできる」とは評価しない。

## 保証と未実施事項

- 現行profileはflat recordのboolean/enum/nullish判定のみ。guestにmemoryやGCはないが、ホストのJSON処理・配列生成等にはallocationがある。
- finite examplesは要求充足の証明ではない。requirement IDとIR nodeの意味的対応を自動証明する機構もない。
- checksumは整合性検出であり、署名ではない。既存runtime同様、信頼するcompilerが生成した成果物を対象とする。
- atomicな個別ファイル公開と協調排他を実装した。プロセス終了で残った`.write-lock`や`.create.tmp`は状態を確認して回復する。Git/direct editorからの同時書換えや任意の第三者writerまで排他するものではない。
- live実行、独立課題での精度・費用評価、他OSでの今回の再CIは未実施。
- memory profile、QBE、MLIR/LLVM、AOT、LRU cacheは追加しない。コンセプトの段階Eは実利用で不足を確認してからの条件付き計画であり、C・Dの実装成功だけで必要性を判断しない。

OpenAI接続は公式[Structured Outputsガイド](https://developers.openai.com/api/docs/guides/structured-outputs)に沿ってschemaを指定し、拒否・未完了は既存adapterでエラーとして扱う。schemaへの適合だけで意味の正しさは保証されないため、公開前のローカル検証を維持した。
