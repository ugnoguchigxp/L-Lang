# JSONC主言語・linter実装計画

2026-09-17。P0〜P6実装済み。[主言語仕様](./LLANG_JSONC_SPEC.md)を規範とする。本書はJSONCの実装計画兼完了記録であり、未実装だったMarkdown Source案からのコード移行は存在しない。

## 1. 完了する利用フロー

SAAAの固定依頼と契約を受け、Codex/piが `*.llang.jsonc` を編集し、lintの診断で修正し、独立テストに合格したWasmを提出する。Sourceからbuildまで決定的であり、新経路はPrompt Source JSONとResolution Lockを必要としない。

現在実装済みのlint/format/buildと、P4で追加予定のtest CLI：

```sh
bun run llang lint customer.llang.jsonc --json
bun run llang format customer.llang.jsonc --check
bun run llang format customer.llang.jsonc --write
bun run llang build customer.llang.jsonc --out-dir artifacts/customer
bun run llang test customer.llang.jsonc --suite tests.json
```

lintはread-only。formatは--check/--writeのどちらか必須。lint/test終了値は0=成功、1=診断error/テスト不一致、2=I/O等の実行失敗。warningは既定では成功、`--warnings-as-errors`で失敗扱い。JSON reportはversion/ok/diagnostics/truncatedを持ち、stdoutは一つのJSON、進捗や障害補足はstderr。buildは構造検証済み成果物を作るが、受け入れ合格を宣言しない。

## 2. 実装構成

| 新規候補 | 責務 |
| --- | --- |
| src/llang-jsonc.ts | bounded UTF-8読み取り、scanner/CST、重複キー、source map |
| src/llang-program.ts | Program型、schema、canonical化、programHash |
| src/llang-diagnostics.ts | code・range・JSON Pointer・hint・打ち切り |
| src/llang-check.ts | schema・型・profile・loweringの共通検査 |
| src/llang-format.ts | コメント保持format、revision CAS、atomic write |
| src/llang-build.ts | 検証済みProgram→既存emitter→新manifest |
| src/llang-cli.ts | lint/format/build/test/migrateのI/O |
| schemas/llang-program-v1.schema.json | エディタ・型付きadapter向け公開schema |

位置情報はJSON.parse後に復元せず、CSTから値とパスを同時に得る。syntax error後は依存する意味検査を止め、架空の連鎖エラーを出さない。上限はparser呼出前・走査中に検査し、任意に深い入力を再帰AST構築へ流さない。schemaと手書き検証の受理範囲は共通fixtureで一致させる。JSON Schemaだけで型・profile適合を完了扱いにしない。

`ir.ts`、`wasm-contract.ts`、`wasm-core.ts`の既存意味を再利用する。位置付き診断に必要なstructured errorを追加する際は、旧APIのcode/messageを互換wrapperで維持する。任意の例外messageを正規表現で解析してpathを推定する設計は避ける。

## 3. JSON linterの実装順

### L0：bounded parserと位置

コメント、末尾カンマ、CRLF、Unicode escape、文字列内コメント記号を受理。単一引用符、裸キー、不完全入力、fence、trailing garbage、重複キー、不正UTF-8/BOM/surrogate、深すぎる入力を拒否。escape後に同じキーになる場合も検査する。__proto__等のキーを含む入力でprototype mutationを起こさない。

### L1：構造・型・profile診断

必須/未知field、非対応version、empty all/any、存在しないproperty、null可否、enum値、string equality、nested path、present可否を仕様codeで返す。独立したfieldの複数診断を上限内で集める。許可値をhintへ返す。IRのdepth/node/conditions上限と契約上限はcompilerと共通。

### L2：format・局所編集

format前後でparseした値が等しいこと、コメント内容が保持されること、二度目のformatが無変更になることを検査。構文不正/重複キーはformatしない。write直前にsourceHashを再照合し、symlink拒否・一時ファイル・atomic renameを使用する。現行と同様に協調writerのmutexとCASを使い、任意の外部writerまで完全排他できるとはしない。

初期linterのfixはformatに限定する。専用の構造patch CLIは初期必須にしない。必要になればexpected revisionとJSON Pointerで部分更新し、常にlintと同じ検証を通す。エージェントの通常ファイル編集を妨げない。

## 4. buildと成果物

既存 `emitWasm(body, contract)` を使い、検証済みsnapshotからmanifestまで生成する。保存前にSource変更を検査し、失敗で既存成果物を半更新しない。toolchain/optionsが同じ場合、旧経路と同じIR・契約から同じWasm bytesを得るgolden testを置く。

既存manifest v1はprovenance keyをstrictに限定しているため、programHash等を黙って追加しない。JSONC経路用Build Manifest v2を定義する。version/profile/export/contract/compiler/backend/options/irHash/programHash/sourceHash/wasmHash/fileを必須とし、hash・path・signature・import等の既存チェックを継承する。パッケージ内のsource file名はCapability Manifestのroleで結ぶ。runtime内部にv1/v2共通の検証済みArtifactViewを置き、旧manifestを読み続ける。

コメント・description・key順変更でprogramHashとWasm bytesは不変、sourceHashは変わる。ABIやIRが同じでもcompiler/optionsが違う場合の再現性は別に判定する。hashは署名や意味の正しさの証明ではない。

## 5. 独立suiteとCapability

現行suiteはPromptSource全体のcontentHashと要求IDに依存し、現行packageはsource/lock/build/wasm/testsの5roleを固定している。新経路で旧形式を偽装しない。

- suite v2：version、requestRevision、contractHash、casesを持つ。caseの期待値とundefinedFieldsは既存方式を再利用する。requirementIdsはSAAA依頼にIDがあるときだけ依頼側のIDへ結び付ける。IDなし依頼はケース実行可能だが要求網羅を「未評価」とする。
- 固定依頼snapshotはSAAA所有の本文・契約・任意の要求IDを含み、requestRevisionはその版hash。製造中に変更できない。新しい言語Sourceではなく検証の入力証拠として扱う。
- Capability Manifest v2のrole：request/source/build/wasm/tests。lock roleを外す。移動先で自己完結した検証ができるようrequestも同梱する。共通snapshot viewにはraw Sourceとvalidated Programを保持する。
- 読み取り時に依頼revision、固定契約、suite、Program契約、各file hash、manifest linkを照合する。IRだけでなく契約を改変してテストを回避する候補を拒否する。
- test reportはrequestRevision/suiteHash/sourceHash/programHash/artifactHashを記録。未実行と合格を区別する。

`capability-package.ts`、`capability-tests.ts`、`capability-report.ts`、host、worker、mutation、host-kitと各CLIのv2対応が必要。path containment、symlink拒否、captureしたbytesのhash、manifest差替え検出、timeout、別プロセス検証を維持する。

## 6. Codex/pi製造フロー

固定依頼と契約→独立tests生成/freeze→Program作成→lint→build/test→最大1回の実装修正。テスト側には実装・候補実行結果を渡さず、実装側は固定期待値を変更できない。syntax修正も呼出・token・wall budgetに数え、無限retryしない。

旧 `capability-development.ts` のSource生成とresolveをProgram提出へ置き換える。既存のtests/implementation/repairの3段階を維持できる。新run protocolで固定依頼・suite・candidate・診断・replyとtoolchainを記録し、fixture replayで同じ結果を再現する。

ファイル編集型Agentは許可されたcandidate JSONCを提出し、ツールがpath/size/hashを検査する。構造化応答型AgentはProgram objectを返し、ツールがJSONC互換のJSONをserializeする。suiteJsonの二重エンコードはv2 adapterで廃止し、suite objectを返す。Provider schema制約に合わない場合の分岐はadapter内へ限定する。

初期実装でCodex SDKへの接続を更新する。piは共通CLIで作業可能な例とfixtureを用意し、専用adapterの実装・実モデル試験は別の完了項目として扱う。接続していないSAAA/piのlive成功を報告しない。

## 7. 非破壊移行

`llang migrate <legacy.prompt.json> --out <new.llang.jsonc>` は対応する有効な旧Lockを検査し、Sourceのid/profile/contractとLockのbodyを新Programへ統合する。LLMを呼ばず、旧要求や例は依頼・suiteの移行候補として明示的に出力する。旧テストの期待値を作り直さず保持し、新suite/依頼に結び直して再実行する。旧要求を原ユーザー発言と称さない。

旧Lockがない/破損/staleなら意味を推測して移行せず停止する。既存ファイルを上書きせず、新規出力のみ。v1 Source・Lock・suite・manifestと旧semantic/Hybrid replayは維持する。旧benchmarkやevidenceを新形式で書き換えず、v2 fixtureを追加する。

## 8. 実装単位とGate

| 単位 | 完了条件 |
| --- | --- |
| P0（完了） | dirty tree確認、既存局所test baseline、jsonc-parser 3.3.1（MIT）のAPI/Bun互換性を確認し依存を固定 |
| P1（完了） | Program/schema/parser、仕様例の受理、拒否・位置の境界tests。上限testの網羅はP4前に追加 |
| P2（完了） | linter/format/CLI、安定診断とJSON出力、compilerとの受理範囲一致 |
| P3（完了） | 直接Wasm buildとmanifest v2、APIなし、同一bytes、原子的公開・改変拒否 |
| P4（完了） | suite/package/report/host v2、固定契約・独立期待値・移動後検証。JSONC原文を保持し、lockなしの5 roleを検証 |
| P5（完了） | 製造・最大1回修正・replay、call/token/wall予算、失敗実装を修正するfixture。既存Codex SDK adapterをProgram応答にも共用し、piは共通CLIを使用 |
| P6（完了） | 有効な旧Source+Lockからの非破壊migration、旧経路回帰、README/仕様/例を更新 |

各単位の関連testsの後、完了Gateとしてformat:check、lint、typecheck、coverage、ci:docs、ci:protected、ci:smokeを実行する。旧prompt/capability/Hybrid/semanticの回帰を含める。既存failureはbaselineと比較し、新規failureを既存扱いしない。

live評価は実装完了と分け、同一モデル・予算・依頼で初回lint成功率、意味テスト合格率、修正回数、総token/time、対象外変更を記録する。JSONCがJSONより高精度という未測定の主張はしない。fixtureでは構文エラー修正、enum typo、all/any取り違え、固定契約変更の拒否、予算超過を検査する。

## 9. 対象外

今回の計画は言語と検証・製造経路の移行。数値演算、汎用関数、module system、Canonical Type全経路統合、新Wasm ABI、外部IO、SAAAへの実配備、manifestをWasmへ埋め込む配布形式変更は含めない。JSON5/YAMLの同時対応と広域jsonrepairも含めない。SourceをLLM生成の自然言語解釈へ戻すfallbackは設けない。
