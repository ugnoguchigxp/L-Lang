# 初期Wasm PoC実装計画

> 分類：実装時の設計・作業記録。本文の予定表現やチェックリストは当時の計画です。完了範囲は対応する結果文書、現在の実行方法は[例の一覧](../examples/README.md)、実行環境・CI対象OSは[品質Gate](../QUALITY_GATES.md)を参照してください。

- 作成日：2026-09-14
- ブランチ：`wasm-compiler`
- 状態：P0〜P6の機能実装済み。検証結果・計画との差分・残る環境上の制限は[実装結果](./WASM_POC_RESULTS.md)を参照する。
- 上位文書：[Wasmコンパイラの将来コンセプト](./WASM_COMPILER_CONCEPT.md)
- 対象：コンセプトの段階A「意味とbaseline」と段階B「Wasm利用の縦断」

## 1. 今回の完了像

既存の`semantic.lock`から現在のSourceと一致するPredicate IRを取得し、TypeScriptの判定コードを生成せずにWasmへ変換する。保存したWasmとManifestを別プロセスで読み込み、Customerオブジェクトを渡してbooleanの判定結果を受け取れる状態まで作る。

対象例は[active-customer](../examples/active-customer/semantic.ts)とする。同じemitterで別の対応Predicateも生成し、特定のフィールド名や期待結果を埋め込んだデモにしない。

初期縦断の実現確度は高いと評価している。最初に確認する仮説は、ABI変換が意味を保持すること、現行の再生成・整合性検査を維持して接続できること、生成物を単独で再利用できることである。性能上の優位性やPrompt Sourceの更新精度は、このPoCの成功から推定しない。

## 2. 対象範囲

### 今回実装するもの

- 既存IRのequalityを含む意味の確認と必要な不一致修正
- 現在のSource・型・文脈に一致するLock entryの読み取り
- 制限した型と操作の検証、小さなTyped Core表現、ABI記述
- Binaryen.jsを使うin-process Wasm生成
- WasmとManifestの保存、整合性検証、ホストAPIからの呼び出し
- CLI、利用例、独立した期待結果による検証、性能の探索測定

### 後続に残すもの

PromptSource API、LLMによる新たな意味解決、Lock形式の全面更新、汎用SSA、任意文字列比較、数値演算、nested record、配列、ownership checker、region、I/O、AOT、Native、LRU cache、ブラウザ対応、npm公開は含めない。TSバックエンドの廃止や既存CLIの意味変更もしない。

初期Sourceは現行TS DSLを利用する。正式なPrompt Sourceへの移行は後続計画とし、このPoCでは実行形式を分離する。

## 3. 先に固定する仕様

### 3.1 型と操作

入力はトップレベルのdata recordに限定する。フィールド型はboolean、文字列literalからなるclosed enum、およびそれら・stringのnullable/optionalな形を扱う。一般stringは存在・null検査にだけ使い、内容の比較を拒否する。number、array、nested object、関数、getterを持つ入力は初期の受理範囲外とする。

`all`、`any`、`not`、`equals`、`present`を扱う。`equals`はboolean、closed enumのliteral、nullに限定する。型に適合しない比較、空の条件列、未知の操作、不正path、既存のサイズ・深さ上限を超えるIRは拒否する。

初期IRにおけるequalityはTS生成器のstrict equalityを基準とし、既存evaluatorとの符号付きゼロの不一致を修正する方向で進める。全evaluator・同値判定・正規化の利用箇所を先に調査し、既存の契約と矛盾する場合は仕様を整理してから変更する。NaNリテラルは現行parserの拒否を維持する。

`present`はnullでもundefinedでもないことを意味する。空文字はpresentである。`all`と`any`は左から短絡評価する。未対応のnested pathを暗黙に安全なアクセスへ変換しない。

### 3.2 ABI v1案

Manifestに入力契約、フィールドと引数slotの対応、tag値、export名、戻り値を記録する。slotはフィールド名の決定的な順序で配置し、enum値もlocaleに依存しない順序でtag化する。重複slotや矛盾するtagを拒否する。

- boolean：i32の0/1。
- closed enum：宣言されたliteralを0始まりのi32 tagへ変換する。
- nullable/optional：必要に応じて状態tagを使う。undefinedまたは許可された欠損を0、nullを1、presentを2とする。契約が許さない状態は拒否する。
- nullableなboolean/enumの値比較：状態slotに加えvalue slotを用意し、presentの場合だけ値を比較する。欠損時のvalue slotは0に固定する。
- string：状態slotだけを渡す。後から内容の比較が必要になった場合はこのABIの対応範囲を拡張せず、別版を設計する。
- 戻り値：i32の0/1。ホストAPIはbooleanへ変換し、それ以外の値を拒否する。

active-customerでは`status`のenum slot、`deletedAt`と`email`の状態slotを使う。`deletedAt`はnull/present、`email`はundefined/null/presentを区別するため、生のABI状態は2×2×3＝12通りになる。コンセプトにある二つのbooleanへ集約した意味上の8状態に加え、undefinedとnullを区別する12状態も全列挙する。

host adapterが行うのは型検証と表現変換までとする。`status`・`deletedAt`・`email`の条件を組み合わせた適格性判定はWasm側で実行する。

保証の入口は検証済みホストAPIとする。生のexportを直接呼び出した際の不正i32値の拒否は初期保証に含めない。host APIは入力を同期的に検証・変換し、利用対象は通常のdata recordとする。敵対的なProxy等のJavaScriptコードを隔離する仕組みは提供しない。

### 3.3 成果物と整合性

出力ディレクトリは`artifacts/wasm/active-customer/`を例とする。次の二つを配布単位とする。

- `<wasm-sha256>.wasm`：生成したimmutableなバイナリ
- `manifest.json`：schema版、profile、Concept・Predicate識別情報、Source・型・文脈・IRのhash、ABI、compiler/backend版と設定、Wasm hashと相対ファイル名

compiler版は既存packageの`0.0.0`だけで代用せず、Wasmコンパイラの明示的な版を設ける。初期版は開発版として記録し、意味・出力を変える修正では更新する。評価記録には対象commitと作業ツリー状態を別途残す。

Wasmを検証してからhash名で保存し、Manifestを最後にatomic replaceする。二ファイルを同時更新したとみなさず、読み手はManifestが指定するhash名だけを使う。途中失敗では既存Manifestを維持する。初期段階で自動cacheは作らず、生成物の削除・再生成手順を利用例に記載する。

ビルド時はSourceとの一致を確認する。利用時はSourceなしでManifest版、ABI、Wasm hash、import/export契約を確認できる構成にする。hashは配布者の真正性を保証しないため、初期loaderの対象は本コンパイラで生成した信頼済み成果物とする。任意の第三者Wasmを安全に受け入れる汎用loaderにはしない。

## 4. 実装順序と変更単位

各工程の局所検証が通ってから次へ進む。下記は実装時のコミット分割候補であり、現時点では未着手である。

### P0：baselineと意味の確定

1. Bun・OS・commit・作業ツリー状態を記録する。
2. [品質Gate](../QUALITY_GATES.md)を実行し、既存CIの失敗を現在の環境でも再現できるか調べる。過去の失敗が今も同じとは仮定しない。
3. `equals`、`present`、短絡評価、nullish入力に関する既存実装を調査する。
4. `-0`と`0`の回帰例を先に追加し、必要な意味の統一を行う。凍結済みbenchmark入力やOracleを結果に合わせて編集しない。
5. active-customerともう一つの異なるフィールド名のPredicateについて、実装出力から作らない期待結果を定義する。

主な対象：`src/generator.ts`、`src/cross-schema-benchmark.ts`、必要に応じて他のevaluatorと関連テスト。調査で不要と分かった変更は行わない。

完了条件：初期仕様と期待結果が固定され、baseline失敗と今回修正する問題を区別して記録できる。

### P1：Lockからの読み取り専用接続

新規候補`src/semantic-resolution-reader.ts`に、現在のSource・型・Project Contextからhashを計算し、一致するentryを取得してIRを再検証する処理を切り出す。

既存の`scanSemanticSource`、`buildProjectContext`、`predicateSemanticHashes`、`findReplayEntry`、`parsePredicateExpression`、`validatePredicateContext`を利用する。単に最新entryを選んだり、sourceHashだけを比較したりしない。既存のreplayが行う追加の整合性確認も調査し、Wasm経路で欠落させない。

既存TSコンパイラと共有できる読み取り部分だけを抽出する。`compileSemanticSource({ mode: "replay" })`をWasmの前処理として呼ばない。TS生成・promotion・Lock更新が付随するためである。

完了条件：一致するIRを返し、未解決・stale・壊れたIRは区別して失敗する。resolverを受け取らず、ネットワークを呼ばず、Source・Lock・生成済みTSを変更しない。既存replayの関連テストが通る。

### P2：制限型・Core表現・ABI planner

新規候補`src/wasm-contract.ts`と`src/wasm-core.ts`で、初期型のstrict parser、IRから型付き操作への変換、ABI slot計画を実装する。

既存`TypeSchema`を入力として利用し、未対応型を`any`へ逃がさない。Coreはbool定数、slot読出し、i32比較、not、短絡分岐で足りる範囲に留める。操作とslotの型・数・範囲を検証し、メモリ・副作用・call・再帰を表現できない構造にする。

完了条件：二つ以上のPredicateを同じ変換処理で扱え、未知型・未知操作・不正slotが拒否される。field順序やenum列挙順の非決定性がABIへ漏れない。

### P3：Direct Wasm emitter

新規候補`src/wasm-emitter.ts`でBinaryen.jsを使い、Coreから一つのexport関数を生成する。依存導入時にBun 1.3.14で利用可能な公開版を確認し、正確な版を`package.json`と`bun.lock`へ固定する。計画時点で未確認の版番号を指定しない。

初期設定は最適化passなし、i32のみ。`all`/`any`は条件分岐で短絡評価を維持する。BinaryenとWebAssemblyの両方で構造検証し、memory・table・global・import・startを生成しない。Binaryen Moduleの後始末を成功・失敗の両経路で行う。

APIの根拠は[Binaryen公式資料](https://github.com/WebAssembly/binaryen/wiki/binaryen.js-API)とする。Wikiの例だけに依存せず、固定する版の型定義・公式テストで実際の呼び出しを確認する。

完了条件：全対応操作の合成例が期待結果と一致し、別プロセスでの生成bytesが一致する。Binaryen初期化時間と最初の生成時間を記録する。

### P4：保存・Manifest・runtime

新規候補`src/wasm-artifact.ts`と`src/wasm-runtime.ts`を追加する。保存は既存atomic writeの設計を再利用し、binary対応が必要なら最小限に追加する。

runtimeはManifestをstrict parseし、サイズ上限、相対ファイル名、hash、対応ABI版、importなし・所定exportを確認してinstantiateする。Manifestのパスで任意のファイルを読まない。入力契約に従ってown data propertyを確認し、getterを実行して値を収集しない。引数変換後にexportを呼び、戻り値0/1を検証する。

API案：`loadWasmPredicate(manifestPath)`が`evaluate(input: unknown): boolean`を持つhandleを返す。内部instanceを使い回す。runtimeの依存graphにBinaryen・TypeScript Compiler API・LLM adapterを入れない。汎用型を装う型assertionで入力検証を省略しない。

WebAssemblyの標準reflectionだけでは全ての内部構造・関数型を取得できるとは限らない。実装時に確認可能な検査を明確にし、コンパイラ側の構造検査と信頼済み成果物という前提をruntimeの完全検証と混同しない。

完了条件：別プロセスで読み込める。破損・組み合わせ違い・未対応版・不正入力を拒否する。途中書込失敗後も旧成果物を読み込め、SourceとLockは変化しない。

### P5：CLIと利用例

新規候補`src/wasm-cli.ts`に独立したCLIを追加し、`package.json`へ`wasm` scriptを追加する。既存`semantic build`の既定動作を変更しない。

計画上の利用コマンド：

```bash
bun run wasm build examples/active-customer/semantic.ts --out-dir artifacts/wasm/active-customer
bun run wasm run artifacts/wasm/active-customer/manifest.json --input examples/wasm-active-customer/input.json
bun run examples/wasm-active-customer/run.ts artifacts/wasm/active-customer/manifest.json
```

`build`はLockが有効な場合だけ成功し、`run`はSourceやcompilerを読み込まない。CLIはsubcommandごとに必要な依存だけを読み込む。成功結果はJSON、診断はstderrと非0終了コードとする。最低限`LOCK_MISSING`、`LOCK_STALE`、`INVALID_IR`、`UNSUPPORTED_TYPE`、`INVALID_INPUT`、`ARTIFACT_MISMATCH`を識別できるようにする。

実装時の互換性補足：旧LockはIR単独のhashを持たず、生成TSのhashを整合性検査に使っている。この検査を維持するため、Wasm buildでもTS rendererの出力をメモリ内でhash照合する。TSのファイル出力・コンパイル・実行をloweringに使うことはなく、Wasm命令はIRから直接生成する。IR単独のLock形式への移行は今回の対象外とする。

`examples/wasm-active-customer/`にはJSON入力、runtime利用例、READMEを追加する。JSONではundefinedを表現できないため、undefinedのケースはAPIテストで確認する。

既存Lockが古い場合は、baselineで原因を記録する。live LLMを暗黙に呼んで整えず、テスト用workspaceに既存のfixture経路で準備したLockを使って縦断を検証する。利用例には有効なLockの準備方法も記載する。

完了条件：READMEの手順を別プロセスで実行でき、複数入力の結果が得られる。runtime単独実行にprovider credentialが不要である。

### P6：統合検証・測定・評価更新

専用テスト、既存回帰、全品質Gateを実行する。探索benchmark候補`src/wasm-benchmark.ts`でTS版と同じ入力を処理し、コンパイル・初期化・adapter込み実行を分けて測る。

baseline、結果、既知の制限、実行環境、対象commitを`docs/WASM_POC_RESULTS.md`へ記録する。この結果文書は実測時に作成し、計画段階で成功を埋めない。詳細ログは`artifacts/wasm-poc/`等へ保存し、Git管理外であることと再現コマンドを明記する。

完了条件：第6節のチェック項目を評価し、コンセプト第16節の確度と残る不確実性を更新する。未完了の品質GateがあればPoC動作確認と品質完了を区別する。

## 5. 検証計画

### 局所テスト

| 境界 | 主なテスト |
| --- | --- |
| 既存意味 | `-0`/`0`、null、present、短絡評価の回帰 |
| Resolution読出し | 正常Lock、Source・型・test・context変更、欠落、IR破損、読取前後の入力hash一致 |
| Core/ABI | 各対応操作、複数の型とPredicate、未対応型、未知キー、重複slot、不正path、上限違反 |
| 実行結果 | active-customerの意味上8状態・ABI12状態、独立truth table、異なるIRの合成例 |
| adapter | 空文字、null、undefined、必須property欠落、不正enum、誤った型、getter付き入力の拒否 |
| artifact/runtime | 改変bytes、別Manifest、版違い、不正パス、欠落export/import追加、繰り返し呼出し |
| 再現性・副作用 | 別プロセスのbytes一致、API未呼出し、Lock不変、失敗時の旧Manifest維持 |

テスト名候補は`src/semantic-resolution-reader.test.ts`、`src/wasm-*.test.ts`、`src/wasm.integration.test.ts`とする。テストでは一時workspaceを使用し、既存成果物・凍結入力・Lockを汚さない。

CLI/runtime経路はAPIキーを与えない別プロセスで確認し、resolverが実行されていないことをspyまたは依存境界の検証でも確認する。認証情報がないだけで通信が起きていないと推定しない。

### 全品質Gate

実装完了時に[品質Gate正本](../QUALITY_GATES.md)に従って以下を実行する。今回の文書作成では実行しない。

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

smokeは既存方針どおりAPIキーを空にして実行する。Ubuntu・macOS・WindowsのCI結果も確認する。baselineに失敗がある場合、原因・今回の変更との関係・未確認環境を記録し、失敗を除外した結果を全Gate成功と表現しない。fixture成功をliveモデル精度の証拠にしない。

### 性能の探索測定

同じ入力集合をTS関数とWasm host APIへ渡し、戻り値を消費して処理が省略されないようにする。Binaryen読込、IR lowering、Wasm compile、instantiate、初回実行、warm実行を分ける。単発と複数入力の繰り返しを測り、batch専用ABIは今回は追加しない。

反復回数・warmup・Bun版・CPU・OS・入力数を記録し、複数回の中央値とばらつき、RSS、Wasm/Manifestサイズを残す。初期の合格条件は計測可能であることとする。TSより速いことを必須にせず、実用上の性能閾値は探索後に用途とともに別途定める。

## 6. 完了チェックリスト

- [x] 現行意味とbaselineを記録し、対象となるequality不一致を解消した。
- [x] 対応範囲内の複数Predicateを同じlowering/emitterで処理できる。
- [x] 有効な既存Lockから、LLM・TSコード生成なしでWasmを生成できる。
- [x] active-customerの独立した期待結果と、adapterを含めて一致する。
- [x] 保存物を別プロセスで読み込み、同じinstanceから繰り返しboolean結果を得られる。
- [x] runtimeにcompiler・Binaryen・LLM依存を持ち込まない。
- [x] 不正入力・stale Lock・未対応IR・破損成果物を明確に拒否する。
- [x] 生成モジュールがmemory・GC・RC・外部importを必要としない。
- [x] 固定条件の別プロセスbuildでbytesが一致する。
- [x] 生成失敗時にSource・Lock・旧成果物を損なわない。
- [x] 局所テストと品質Gateの結果、CIの状態を記録した。
- [x] 利用手順、探索測定、制限、次の判断材料を記録した。

## 7. 最初の着手単位

実装開始時はP0だけを最初の単位として、baselineの採取、equality調査・回帰例、初期truth tableの固定を行う。その後P1の読み取り境界へ進む。大きなフォルダ再編やPromptSourceの実装からは始めない。

P3でWasmを生成・実行できた時点を中間確認とし、P5の保存物利用まで完成させて初期縦断を評価する。ここで問題が出た場合はABI・対象型・Lock接続を見直し、別バックエンドの追加で問題を迂回しない。

## 8. 後続計画

初期P0〜P6に続く段階C・Dは[Prompt Source実装計画](./PROMPT_SOURCE_IMPLEMENTATION_PLAN.md)へ分離した。実装・検証と現時点の所感は[Prompt Source実装結果](./PROMPT_SOURCE_RESULTS.md)を参照。
