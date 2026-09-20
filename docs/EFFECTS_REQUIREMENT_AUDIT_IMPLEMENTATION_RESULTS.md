# 要求に結び付くEffects実行監査の実装結果

実施日: 2026-09-20。対象計画は[要求に結び付くEffects実行監査](./EFFECTS_REQUIREMENT_AUDIT_IMPLEMENTATION_PLAN.md)です。

## 結果

`module-effects-v1`について、実行前の要求契約、bundle identity、実grant、version 2 intent、hash chain transcript、最終または回収reportを結ぶ経路を実装しました。`module audit-execution`はこれらを再検査し、`passed`、`review-required`、`failed`を返します。要求契約を指定しないversion 1実行は互換のままです。

要求契約はstrict JSONの`llang-effects-requirements` version 1です。要求IDをnode、operation、authority rule、terminal statusへ結び、grantのoperation、file、HTTP、wall clock、deadline、resource limitがauthority ceilingの部分集合であることをdispatch前に確認します。要求本文は実行証跡へ複製せず、ID、revision、source hash、canonical commitment、authority commitmentだけを固定します。

監査はWasmやTypeScriptを実行せず、adapter、credential、networkへアクセスしません。bundleを既存の静的inspectionで再構築し、要求契約、intent、report、transcript、grant summary、観測operation、terminal statusを照合します。監査成果物は新規directoryへ排他的に公開し、入力または出力の差し替えを検出します。

## 実装範囲

- `src/llang-effects-requirement-contract.ts`: strict parser、stable file snapshot、binding検証、authority包含判定。
- `src/llang-effects-execution-evidence.ts`: `--requirements` preflight、version 2 intent/report、終了時再検査。
- `src/llang-effects-execution-recovery.ts`: version 1/2 strict分岐と要求hashを保持する非replay回収。
- `src/llang-effects-execution-audit.ts`: 非実行監査、要求別結果、移動可能な監査成果物。
- `src/llang-cli.ts`: `module audit-execution`と`module execute --requirements`。
- `src/llang-effects-smoke.ts`: 要求契約、実行、監査の一往復。

## 受け入れ条件

| ID | 実装・検証結果 |
| --- | --- |
| ERA1 | 要求、bundle、grant、intent、transcript、resultのcommitment chainを正常実行と監査で確認 |
| ERA2 | source削除後にbundle、要求、evidenceを移動して`passed`。元絶対pathなし |
| ERA3 | strict shape、bundle identity、operation集合、binding参照をpreflightで拒否 |
| ERA4–ERA6 | file、HTTP、clock、deadline、resourceの各上限を同じ包含判定で検査。超過はdispatch前に拒否 |
| ERA7 | authority、structure、outcomeは対応binding必須。必須manualは`review-required` |
| ERA8 | 実行中のrequirements変更を`requirements-changed`のfailed reportに固定。既存bundle/grant変更検査も維持 |
| ERA9 | 要求なしversion 1実行、CLI、回収の既存試験を維持 |
| ERA10 | 実child process停止後のversion 2回収で要求hashを保持し、再dispatch 0 |
| ERA11 | transcriptと全hashを再計算したbinding外・grant外operation、response相関不一致をsemantic auditで`failed` |
| ERA12–ERA13 | terminal status、result、resource、cleanup、unknown outcomeを監査reportへ保持 |
| ERA14 | strict JSON、本文のdata扱い、payload・credential・絶対path非記録を維持 |
| ERA15 | stable regular file、inode/hash再検査、排他的出力、所有directoryだけのcleanup。要求契約をreplace可能なfile grant内へ置く構成もdispatch前に拒否 |
| ERA16 | 監査reportの`apiCalls: 0`。Wasm、projection、adapter、networkを実行しない |
| ERA17 | CLIの必須・未知optionを拒否し、要求付き監査はtyped version 5 all-target bundleだけを受理 |
| ERA18 | emitter、ABI、Binaryen設定を変更せず、既存Effects回帰とsmokeで同じ`llang-effects-session-v1`を確認 |

## 品質Gate

Bun 1.4.2、macOS arm64で次を実行し、すべて成功しました。

| Gate | 結果 |
| --- | --- |
| `bunx bun@1.4.2 run check` | format、lint、typecheck、668 tests / 0 failures、14,352 assertions。lintの既存warning 88件は非失敗 |
| `bunx bun@1.4.2 run ci:docs` | Markdown linkとdocumentation contract成功 |
| `bunx bun@1.4.2 run ci:protected` | protected benchmark inputs一致 |
| `bunx bun@1.4.2 run ci:smoke` | semantic、JSONC、module、Effects smoke成功 |

Effects対象試験は36件、118 assertionsが成功しました。全体Gateで既存Hybrid全シナリオ試験が5秒を超えることを二度再現したため、この統合試験だけtimeoutを15秒へ調整しました。処理内容や期待値は変更していません。

Ubuntu、Windowsとremote CIはこのローカル実装作業では未実行です。既存CI matrixで別途確認します。

## 保証しないこと

`passed`は、自然言語要求の意味が正しいこと、bindingが意味的に同値であること、外部serviceの応答や業務結果が正しいことを示しません。要求、bundle、host、evidence、auditの発行主体も認証しません。成果物は`not-signed`かつ`caller-managed`であり、exactly-once、rollback、分散transactionも提供しません。

次の実装候補は、要求契約からaudit reportまでを同じ署名対象にする[Effects署名付きattestationとtrust policy](./EFFECTS_SIGNED_ATTESTATION_IMPLEMENTATION_PLAN.md)です。自然言語要求の意味評価、人間の監査性能、外部データによる命令注入、通常TypeScript baselineとの比較は、署名機能とは分けて実測する必要があります。
