# 初期Wasm PoC実装結果

- 評価日：2026-09-14
- ブランチ：`wasm-compiler`
- 基点commit：`c7ab9500624d54abd63302ba6b805f1609831cc9`
- 評価対象：上記commitに今回の未コミット変更を加えた作業ツリー
- コードsnapshot hash：`f1487db5ebd0e638f961ac8893eba2c424557cd03fa85b59a6bf90efe21ec97c`
- 計画：[初期Wasm PoC実装計画](./WASM_POC_IMPLEMENTATION_PLAN.md)
- 利用手順：[Wasm版active-customer](../examples/wasm-active-customer/README.md)

## 1. 結果

P0〜P6の機能実装を行い、現在のSourceと一致する既存LockからWasmを生成し、保存した成果物を別プロセスで読み込んで利用できた。実行時はLLM・Binaryen・TypeScript Compiler APIを必要としない。

active-customerのWasmはABI契約hashを含めて158バイト。JSON入力のCLI結果は`{"result":true}`、API利用例は`[true,false,false]`となった。別プロセスでの再生成bytesが一致し、Source・Lockは変更されなかった。

今回の結果は、限定Predicateについての実行形式分離を実証する。Prompt Sourceの継続更新、任意の自然言語の正しさ、一般的なownership、Wasmによる高速化を実証するものではない。

## 2. 実装した内容

| 工程 | 実施内容 | 確認した証拠 |
| --- | --- | --- |
| P0 | クリーンな基点checkoutでbaseline採取。evaluatorをstrict equalityへ統一 | 変更前270テスト成功。符号付きゼロの回帰例 |
| P1 | Source・型・テスト・prompt・contextに一致するLockを読み取り、IRを再検証 | 各hash変更、Source変更、欠落Lock、IR改変を拒否 |
| P2 | boolean・closed enum・nullish状態の契約と小さなCore/ABI | 12状態の独立truth table、異なるフィールドの式、未対応型・操作の拒否 |
| P3 | Binaryen 132.0.0でi32のみのWasmを直接生成 | Binaryen/Wasm validation、memory・table・global・startなし、決定的出力 |
| P4 | hash名のWasmとatomic更新するManifest、検証済みhost API | 破損・ABI不整合・import/export不一致・不正入力を拒否。書込失敗時に旧Manifestを維持 |
| P5 | `wasm build`、`wasm run`、利用例 | 別プロセス実行、instance再利用、compiler依存を禁止したruntimeテスト |
| P6 | 回帰・coverage・smoke・依存監査の代替確認、性能探索 | 下記の検証・計測記録 |

## 3. 計画からの具体化・差分

- 初期ABIはnull・undefined・presentの状態tagを使う。意味上の8状態だけでなく、emailのundefinedとnullを分けた12状態を検証した。
- 旧Lockは独立したIR hashを持たない。その整合性検査を落とさないため、TS rendererの内容をメモリ内でhash照合する。TSファイルの生成・コンパイル・実行をWasmへの変換に使っていない。
- 読み取り専用の新規readerは既存のscanner、Project Context、hash、Lock選択、context validatorを再利用する。既存TSコンパイラのpromotion処理を呼び出さず、既存コンパイラの大規模な再編成は行わなかった。
- Coreはlowering内部で生成し、emitterは外部から任意のCoreやslotを受け取らない。Predicateのstrict parseと契約から合法なslotだけを導く。汎用Core parserや借用検査器は追加していない。
- runtimeは入力契約を持つManifestとWasm内の契約hashを照合する。標準reflectionで確認するのはimport/exportと関数の引数数であり、任意の第三者Wasmの全命令・内部型を検証する汎用loaderではない。
- Binaryen依存の取得にはnpmを使用し、公開metadataの版・bin・integrityをBun lockへ反映した。`bun install --frozen-lockfile`で整合性を確認済み。既存依存の版は変更していない。

## 4. 検証結果

最終コードについて、全288テストをcoverage付きでも実行し、すべて成功した。

| 検査 | 結果 |
| --- | --- |
| クリーンbaseline | 270 pass / 0 fail |
| baseline coverage | functions 93.28%、lines 91.65% |
| 全体回帰（最終coverage run） | 288 pass / 0 fail。1,454 assertions |
| 最終Wasm局所テスト | 18 pass / 0 fail。136 assertions |
| 追加後coverage（最終） | functions 93.86%、lines 92.31%。閾値通過 |
| semantic-transaction coverage | functions 98.36%、lines 96.88%。閾値通過 |
| frozen install、format、lint、typecheck | 成功 |
| documentation links、offline CLI smoke、protected inputs | 成功 |
| `bun audit` | 本環境ではregistry応答待ちとなり、完了を確認できず中断 |
| 依存監査の代替確認 | npm auditで0件。さらにBun lockの全15 packageをnpm advisory APIへ照会し、応答は空object（0件） |
| Ubuntu・WindowsのCI | 今回の変更について未実行。remote pushは行っていない |

最初に作業ディレクトリで開始したbaseline検査は、その後のファイル追加がtypecheckに影響したため比較から除外した。baselineの正本は`git archive`で取り出したクリーンな基点checkoutのログである。

`bun audit`の未完了を成功とは扱わない。依存監査の代替照会は[公式に説明されているnpm advisory endpoint](https://bun.com/docs/pm/cli/audit)に、lock記載の版をそのまま送ったもので、脆弱性を無視するオプションは使っていない。監査結果は評価時点のものである。全OS・全コマンドの品質Gate完了という主張は留保する。

## 5. 性能の探索結果

環境：Bun 1.3.14、Apple M4、macOS arm64。入力はactive-customerの4種類。warmup 1,000回、各100,000回を7 sampleで測定し、実行順を交互にした。計測は探索用で、同時刻の他アプリの負荷やJITの影響を完全には排除していない。

| 項目 | 実測 |
| --- | --- |
| Binaryenの初回import | 183.99 ms |
| Source・型・Lock・contextの読出し/整合性検査 | 550.66 ms |
| IR→Wasm emit（lowering・validation込み） | 2.42 ms |
| Wasm compile | 0.107 ms |
| instantiate | 0.026 ms |
| host APIの初回呼出し | 0.190 ms |
| Wasm / Manifest | 158 / 1827 bytes |
| compilerを含む測定プロセスのRSS終値 | 1044.4 MiB |

| 100,000回の処理 | 中央値 | 最小〜最大 |
| --- | --- | --- |
| 既存TS関数の直接呼出し | 0.271 ms | 0.258〜0.714 ms |
| 同じ入力検証・ABI変換を加えたTS版 | 30.710 ms | 27.493〜34.251 ms |
| adapter込みWasm | 29.567 ms | 29.060〜34.968 ms |

WasmはTS直接呼出しより大幅に遅い。同じ入力検証を加えたTS版とは範囲が重なるため、速度の優劣は結論づけない。この用途では入力検証・変換の費用が大きい。

compilerを読み込まない独立プロセスでも、各方式を100,000回実行後にRSSを測った。3回の中央値はTS直接呼出しが33.6 MiB、Wasm host APIが83.8 MiBだった。これはGCタイミングを固定していないRSSの終値であり、peak・Wasm本体だけの使用量・一回あたりの確保量ではない。プロセス全体の省メモリ化は実証できていない。

小さいWasm成果物と、コンパイラ全体の低メモリ・低起動費用は別の性質である。次に性能へ手を入れる場合、まずSource/型読出し、emitter初期化、host adapterの費用を個別に調べる。Nativeバックエンド追加を先行させる根拠は今回の結果からは得られない。

## 6. 評価の更新と次の候補

限定PredicateのWasm生成・利用と、LLM不要の再生成は「実現見込みが高い」から「この範囲で実装・検証済み」へ更新する。新しい型・操作や別ホストにも自動的に一般化しない。

次の機能候補はコンセプト段階Cの最小Prompt Source接続である。今回のruntimeと独立に、要件の局所更新・保持・未解決判定を検証できる。一方、標準バックエンドへの切り替え前には、他OSのCIと利用者にとっての総作業時間を確認する。メモリprofileやQBE/MLIRは後続に残す。

## 7. 証跡と再実行

詳細ログはGit管理外の`artifacts/wasm-poc/`に保存した。この文書の表はその要約であり、ログは別cloneには含まれない。

| ファイル | 内容 |
| --- | --- |
| `environment.json`、`code-snapshot.json` | 環境、基点commit、変更コードのファイル別hash |
| `baseline-clean.log`、`baseline-extra.log` | クリーンcheckoutのcheck、coverage、smoke等 |
| `final-targeted.log`、`full-tests.log`、`coverage-final.log` | 局所・全体テスト、最終coverage |
| `install.log`、`format-check.log`、`lint.log`、`typecheck.log` | 基本品質検査 |
| `docs-check.log`、`smoke.log`、`protected.log` | 文書・CLI・保護入力 |
| `audit-request.json`、`lock-audit.json`、`npm-audit.json` | 代替依存監査の要求と結果 |
| `benchmark.json`、`runtime-memory.json` | 探索性能と独立プロセスのRSS |

```bash
bun install --frozen-lockfile
bun test src/wasm-core.test.ts src/wasm-artifact.test.ts src/wasm.integration.test.ts
bun run coverage
bun run wasm build examples/active-customer/semantic.ts --out-dir artifacts/wasm/active-customer
bun run wasm run artifacts/wasm/active-customer/manifest.json --input examples/wasm-active-customer/input.json
bun run src/wasm-benchmark.ts artifacts/wasm/active-customer/manifest.json
bun run src/wasm-runtime-benchmark.ts ts artifacts/wasm/active-customer/manifest.json
bun run src/wasm-runtime-benchmark.ts wasm artifacts/wasm/active-customer/manifest.json
```

再実行には有効なLockを使う。fixtureの準備と保証範囲は利用手順を参照する。全品質Gateの定義は[QUALITY_GATES.md](../QUALITY_GATES.md)を引き続き正とする。

## 追記：後続実装とCIの確定結果

初期PoCは`9fffe3b`としてcommit・push済み。[CI run](https://github.com/ugnoguchigxp/L-Lang/actions/runs/34796333803)はmacOS成功、Ubuntuは既存テストのtimeout、WindowsはCRLFによるformat失敗だった。後続で改行設定と該当timeoutを修正した。段階C・Dの実装と最新の検証状況は[Prompt Source実装結果](./PROMPT_SOURCE_RESULTS.md)を参照する。上記の未push・CI未実行という記述は初期検証時点の記録である。
