# L-Lang quality gates

最終更新: 2026-09-18

この文書をリポジトリ品質Gateの正本とする。テスト件数やcoverage実測値は変更のたびに変わるためREADMEへ複製せず、各CI runの出力を最新の結果として扱う。

## 固定された実行環境

- Bun 1.4.2（`package.json`の`packageManager`とCIで固定）
- TypeScript 5.9.3
- Biome 2.5.13
- CI: Ubuntu、macOS、Windows。品質・coverage jobはUbuntu

## 必須Gate

```bash
bun install --frozen-lockfile
bun audit
bun run format:check
bun run lint
bun run ci:docs
bun run typecheck
bun test
bun run coverage
bun run ci:smoke
bun run ci:protected
git diff --check
```

Effects adversarial benchmarkを変更した場合は、上記に加えてfresh directoryを二つ作り、`effects:benchmark plan`、`fixture`、`analyze`、`verify`、`reproduce`を実行する。fixtureは72 trialがcomplete、`evidenceEligible: false`、API call 0、network 0であること、元runとreproduceのtable／figure CSVがbyte一致することを確認する。reviewed runや外部登録は通常のcorrectness Gateに含めない。

`module-value-v1`のWasm emitter、ABI、runtimeを変更した場合は、`src/llang-module-value.test.ts`と`src/llang-module-value-memory.test.ts`を実行し、`bun run value:memory:matrix`後に生成文書の一致を確認する。direct testはraw exportのstatusとtrapを区別し、malformed range、UTF-8、selected union、allocator、output capacityのmutationを検出する。host runtimeだけの成功でdirect ABIを合格にしない。

`bun run coverage`はリポジトリ全体でfunctions 90%以上・lines 90%以上、`src/semantic-transaction.ts`でfunctions 95%以上・lines 95%以上を要求する。閾値と解析ロジックの正本は[`src/run-coverage.ts`](./src/run-coverage.ts)である。

`bun run ci:smoke`はAPI keyを空にした状態でread-onlyの`semantic explain`とroot `semantic verify`に加え、JSONC、module、effectsの各smokeを一時ディレクトリで実行する。JSONC smokeはlint・format・build・test・package・移動後verify・mutation-check・fixture修正/replay、module smokeは各profileのbuild/portable実行、effects smokeはversion 5 bundleとtyped replayを確認する。`ci:docs`はリンクに加え、CLI一覧・指定ツール版・smoke登録を照合する。coverage runnerは出力を逐次転送し、同じBun実行ファイルで全テストを動かす。`bun run ci:protected`はSchema Evolutionのfreeze manifestをstrictに検証し、記録済みhashを照合する。各Benchmark固有のrunnerも、実行前にそれぞれのmanifest、freeze、Oracle、hidden caseを検証する。

## 依存とCIの保守

GitHub Actionsはcommit SHAで固定し、DependabotがBun依存とActionsの更新候補を週次で作成する。依存更新はこの文書の全Gateを通過した場合だけ取り込む。

## 記録方法

releaseや評価報告で件数・coverageを記載する場合は、同一commitのCI URLまたは保存済みevidenceを併記する。READMEとロードマップには変動する数値を手作業で複製しない。


## 文書だけを変更した場合

現在の説明・過去の計画・凍結済み証跡を区別する。文書リンクは`bun run ci:docs`、空白は`git diff --check`で検査し、追加・修正した現行コマンド例を認証なしで実行する。リンク検査はMarkdown内のローカルパスの存在確認であり、見出しfragment・コード例・外部URLの検査を代替しない。

CLIや環境の契約変更時は[CLIリファレンス](./docs/LLANG_CLI_REFERENCE.md)、両README、該当例、品質文書を同時に確認する。

correctness Gateは短時間で再現できる回帰検査である。SAAA soak、実運用TLS、長期の性能・memory評価は代表workloadと観測期間を別途固定し、通常CIの成功から推定しない。

文書確認の直近記録と全ファイルの分類は[文書メンテナンス記録](./docs/MAINTENANCE_STATUS.md)を参照する。文書確認の成功を全体テスト・coverage・remote CIの成功として報告しない。
