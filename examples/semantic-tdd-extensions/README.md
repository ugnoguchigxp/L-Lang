# Semantic TDD拡張の限定初版

Best-of-Nの選択と、明示した期待式を使うbounded property検査のオフライン例です。既存の単一候補buildはそのまま利用できます。

リポジトリルートで、未使用の出力先を指定します。親directoryは事前に作成してください。

```sh
mkdir -p artifacts/semantic-tdd-extensions
bun run semantic:extensions:demo artifacts/semantic-tdd-extensions/run-new
```

例は専用workspaceにsource、fixture、両lock、生成物を作ります。不完全な候補1件と適格候補2件から`candidate-2`を選び、`tdd-test`と`tdd-replay`を実行します。続いて正常なIRのproperty検査、意図的に欠陥を入れたIRの反例検出・縮小、それぞれの保存reportの再生を確認します。API keyは空にして実行し、生成APIは呼びません。元のリポジトリの両lockと生成物を更新しません。

## 作成したworkspaceで個別に確認する

```sh
cd artifacts/semantic-tdd-extensions/run-new
bun run ../../../src/semantic-cli.ts tdd-test semantic.ts --json
bun run ../../../src/semantic-property-cli.ts replay property-pass.json
bun run ../../../src/semantic-property-cli.ts replay property-fail.json
```

最後のコマンドは再生が成功したうえで、保存された検査結果が`failed`なので終了値1を返します。形式不正・改変・設定不正は終了値2です。reportを再生してもsourceやlockを変更しません。

## Best-of-N

通常の`semantic tdd-build`へ`--best-of-n <config.json>`を追加すると有効になります。fixture候補を別々に渡す場合は`--candidate-fixtures <list.json>`も指定します。listのpathはlistファイルからの相対pathです。候補数とlist件数は一致させます。単一の`--fixture`との併用は拒否します。`--fixture`だけを併用した場合は、同じfixtureを候補数分使用します。

`best-of-n.json`は候補数3、並列数1、出力token上限、合計token予算、呼出しtimeout、費用予算と申告価格を固定します。liveの場合は既存のOpenAI/Azure接続を使います。価格は利用するmodel/providerの条件に合わせて指定してください。要求snapshotは2 MiB以内に制限します。usage不明、timeout、予算超過は採用を止めます。`apiCalls`はresolverを呼んだattempt数で、送達が不明な場合も含みます。usage不明時のtoken・費用欄は観測できた応答の合計であり、実費0を意味しません。合計tokenと費用は応答後に検査するので、provider請求の絶対上限ではありません。Test Planが未freezeの場合のsynthesis呼出しは候補予算と別で、従来の`testApiCalls`に計上します。

HardとMutationを通過した候補を、Mutation score降順、IR node数・深さ昇順、IR hash辞書順で選びます。IRが同じ場合だけcandidate IDを使います。選択したIRを既存compilerで検査し、source例・型検査・Project回帰が通ってから採用します。最終検査で失敗しても次順位へfallbackしません。

Selection Report v2は入力snapshot、設定、全候補・応答・usage・失敗段階、hash、順位の根拠を保存します。全候補不適格の場合も`.semantic/tdd-selection/selection-<id>/selection.json`に記録を残します。artifactとimplementation lockへの変更は0ですが、Test Planのfreezeとaudit出力は行い得ます。

`tdd-test`、`tdd-replay`と、対応するv2記録を持つnodeの`semantic verify`は保存候補を再評価します。旧v1記録も読みます。v2を保存したlockは旧compilerでは読めないので、旧版へ戻す場合は旧lockとartifactを組にして戻します。明示指定したbuildは候補を再生成し、指定なしのcache hitとreplayは新規API呼出し0です。

## Property Test

`semantic:property check <source> --config <property.json> --out <new-report.json>`は、凍結Test Planと現在の採用IRを読みます。`--candidate <expression.json>`を加えると、指定IRを診断できます。期待式は`property.json`へ明示し、candidateから自動生成しません。検査前に期待式をsource例と凍結Test Planへ照合します。

v1はboolean、scalar literal union、nullable/optional、深さ3までのobjectに対応します。v2では長さ0〜16の配列と、単一のobject/arrayを含むnullable/optional unionを追加しました。v2設定には`maxArrayLength`と`timeoutMs`が必要です。string/numberには有限domainを指定し、配列要素のpathは`["noise", "*"]`のように書きます。undefinedを許すobject fieldは省略で表します。複数のcontainerが競合するunion、必須undefinedのrootやarray要素、循環型、巨大union、任意callbackを拒否します。seed、件数、生成node、縮小step、時間に上限を持ちます。期待式の等値比較に使う値は有限domainに含めてください。

反例の最小性は指定した縮小順序での局所的な最小性です。予算内で縮小を完了できなければ`shrinkComplete: false`を記録し、最小と扱いません。domainは公開可能な合成値にしてください。secretの自動検出・除去は行いません。

property検査はIR間の有限比較であり、生成TypeScriptとの新しい差分検査や、自然言語要求の完全充足を保証しません。既存buildのHard Gateには自動追加しません。liveの品質改善、独立held-out評価、既定機能への昇格は未実施です。

[実装計画](../../docs/SEMANTIC_TDD_EXTENSIONS_V1_IMPLEMENTATION_PLAN.md) · [Paper v1の範囲](../../docs/PAPER_V1_SCOPE.md)


## 保存結果の現在地を検査する

```sh
bun run semantic verify semantic-closure.json --property-report path/to/property-pass.json --json
```

reportをAPIなしで再生し、現在の採用IR・schema・凍結Test Planと照合します。別実装の診断report、失敗結果、改変は成功として扱いません。明示指定時だけ検査し、buildの既定Gateは維持します。

## 凍結入力による比較評価

```sh
bun run semantic:extensions:evaluate fixture benchmarks/semantic-tdd-extensions-v1/benchmark.json artifacts/new-evaluation.json
bun run semantic:extensions:evaluate replay benchmarks/semantic-tdd-extensions-v1/benchmark.json artifacts/new-evaluation.json
```

新規の合成制御実験12ケースを比較します。単発baselineは同じbatchの最初の候補です。hidden labelは選択後にだけ読み、候補生成やランキングには渡しません。入力のfreeze hashと保存した候補を再検証します。実モデルの品質改善の証拠とは区別してください。

実APIの評価を行う場合は`fixture`を`live`にし、出力pathの後へmodel名と予算configのpathを指定します。`OPENAI_API_KEY`と明示した正の申告価格が必要です。候補数は凍結条件と同じ3とし、token／費用予算は12ケース全体で共有します。資源停止のreportも保存します。`status: resource-stopped`は評価完了と扱わず、reportのstatusを確認してください。workload名はfixtureの配置を表し、liveでは同じ3つのConceptを各4 batchで測定します。再実行は新しい出力pathを使い、過去結果を上書きしません。

[残実装の完了計画](../../docs/SEMANTIC_TDD_EXTENSIONS_COMPLETION_PLAN.md) · [追加実装と評価結果](../../docs/SEMANTIC_TDD_EXTENSIONS_COMPLETION_RESULTS.md)

## Codex SDKのLunaで比較する

```sh
bun run semantic:extensions:evaluate codex benchmarks/semantic-tdd-extensions-v1/benchmark.json artifacts/new-codex-evaluation.json gpt-5.6-luna path/to/budget.json
bun run semantic:extensions:evaluate replay benchmarks/semantic-tdd-extensions-v1/benchmark.json artifacts/new-codex-evaluation.json
```

既存のChatGPTログインを使うSDK経路です。SDK子プロセスへAPI keyとAPI base URLの環境変数を渡しません。対応するLunaモデルを明示し、候補ごとに新しい会話と一時directoryを作ります。project instruction、MCP、plugin、shell、web、appの利用を無効にし、予期しないtool itemは拒否します。型・仕様・凍結Test Planと出力schemaだけを候補生成へ渡します。`gpt-6-luna`と`gpt-5.6-luna`を指定できますが、利用可否は接続先とアカウントに依存し、モデルのfallbackは行いません。

budgetの正の価格から計算する費用はAPI参考単価による比較値で、ChatGPTプランの請求額や消費枠ではありません。usageはSDKが報告するinput／output tokenを記録します。SDKにserver側の出力token指定がないため、`maxOutputTokensPerCall`は応答後の検査です。timeoutはSDK実行へ伝えます。資源停止は終了値1、エラーは2です。途中auditと完成reportを区別し、再実行は新しい保存先を使います。

[Sol 6.1 lowとLuna lowの比較](../../docs/SEMANTIC_TDD_CODEX_MODEL_COMPARISON_RESULTS.md)も記録した。adapterは`gpt-6.1-sol`を受け付けるが、旧SDK同梱runtimeでは接続先に拒否される場合がある。この評価では隔離したCLI 0.159.3をSDKの`codexPathOverride`で指定した。通常のCLI／SDK依存を自動更新したり、別モデルへfallbackしたりはしない。
