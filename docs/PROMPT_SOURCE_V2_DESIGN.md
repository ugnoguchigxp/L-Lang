# 自然言語Sourceと単一Resolution Lockへの改修案

> **2026-09-17：本案は不採用・後継仕様へ置換。** ユーザーとの検討により、主言語はエージェントが編集する実行可能なJSONCソースとする。[JSONC主言語仕様](./LLANG_JSONC_SPEC.md)と[実装計画](./LLANG_JSONC_IMPLEMENTATION_PLAN.md)を優先する。以下は設計検討の履歴であり、Markdown Sourceや単一Resolution Lockを実装する指示ではない。

2026-09-17。状態：設計案、未実装。現行Prompt系、Capability製造・検証・実行、評価runnerを読み合わせた提案。

## 判断

改修できる。自然言語Sourceを要求の正本とし、LLMによる構造化要求とPredicate IRを一つのJSON Lockへ保存する。現行の構造化Sourceを単に改名するだけでは、原要求の欠落とテスト生成の依存関係は改善しない。

利用者の編集対象は一つのSourceとする。初期版は `customer.prompt.md`、生成物は `customer.prompt.md.lock.json` と既存Wasm artifact。契約・利用者所有の例はSource内に含め、別のSource JSONを作らない。既存artifactのmanifest、能力パッケージの独立suite・検証reportは実行・検証に必要な成果物として継続する。この改修だけで物理ファイル総数が三つになるとは主張しない。

## 現行実装から分かった制約

| 箇所 | 現状 | 改修への意味 |
| --- | --- | --- |
| `src/prompt-cli.ts` | draftがrequestを読み、meaningをSourceへ保存 | draftによる言い換えをSource作成から外す |
| `src/prompt-source.ts` | Source全体のcanonical hash、ID指定patch、CAS | 原文のhashと原文の更新へ切り替える |
| `src/prompt-resolution.ts` | Source hashとIRをLockへ保存、失敗時旧Lock保持 | 構造化要求も同じ公開単位へ入れる |
| `src/prompt-wasm.ts` | Source契約とLock IRを使ってemit | 解決済みsnapshotを受け取る境界へ整理 |
| `src/capability-tests.ts` | suiteがSource revisionと要求IDに依存 | IDを原文側へ置き、suiteを原文revisionに結び付ける |
| `src/capability-test-agent.ts` | テストも実装も構造化Sourceを読む | テストは原文から独立生成し、解釈結果を見せない |
| `src/capability-development.ts` | 固定Source、先行tests、最大2実装候補、replay | Source snapshotを原文へ変更、呼出予算とreplay形式を更新 |
| `src/capability-package.ts` | sourceをJSON parse、5役割を固定、全hashを照合 | v2 sourceをテキストとして検証し、Lockと結合 |
| `src/capability-host.ts` / `src/capability-mutation.ts` | snapshot.sourceの契約・例・要求を参照 | メモリ上の検証済みviewで吸収。hostでLLMを呼ばない |
| `src/prompt-evaluation.ts` | JSON Sourceのpatch精度を評価 | 原文更新・構造化時の欠落を測る新datasetが必要 |

既存のlowering、Binaryen emitter、Wasm runtimeは再利用できる。新しい汎用言語・所有権・型統合を同時に実装する必要はない。

## Source形式の提案

初期版は限定Markdown。自然言語の目的、安定IDを持つ要求、未解決条件、および一つの機械可読な契約・例ブロックを同じファイルに保存する。JSONを全面禁止するのでなく、要求をLLM生成JSONへ置き換えることをやめる。

概形（契約と例は省略、実行可能なサンプルではない）：

~~~~markdown
# 連絡可能な有効顧客

## Intent
連絡可能な有効顧客を判定する。

## Requirements
### active [must]
statusがactiveであること。

### not-deleted [must]
deletedAtがnullであること。

### has-email [must]
emailがnullでもundefinedでもないこと。空文字列は存在する値として扱う。

## Unresolved when
入力契約のフィールドだけでは要求を表現できない場合。

## Contract and examples
```llang-inputs
{ "version": 2, "id": "active-customer", "profile": "predicate-i32-v1",
  "contract": "ここには現行WasmContractを記述",
  "examples": "ここには利用者所有の正例・負例を記述" }
```
~~~~

これは初期profile用の提案であり、一般Markdownの任意構造を推測して受理しない。必須section、重複section/ID、未知level、重複inputs block、本文外の未所属文章、不正UTF-8、サイズ上限を決定的に検査する。非対応記法は位置付きエラーにする。契約と例には既存parserを使う。新たなYAML依存や型構文は導入しない。

読み取りは原文bytesを一度captureする。hashは原文bytesのSHA-256とし、空白・改行変更もstaleとする。旧JSONのformat非依存hashからの明示的変更である。作成CLIは原文を保存し、必要なwrapperを追加しても要求本文を書き換えない。既存の自由文requestは最初は一つの `request [must]` blockとして保持できる。複数要求への分割はSource編集であり、解決の副作用にしない。

原文全体を一つのblockにすると要求単位の検証粒度は粗くなる。複数IDの記述は任意の精度改善とし、LLMによる自動分割を正本化の前提にしない。

## Lock v2

単一ファイルに以下を持つ。全fieldはstrict parse、上限検査、protocol version検査を行う。

| field | 所有・検査 |
| --- | --- |
| version / protocol | 新規v2。v1を暗黙解釈しない |
| sourceHash | captureしたSource bytesのhash。LLMに選択させない |
| interpretation | intent、要求ごとの解釈、unresolvedWhen。各要求は原文IDを参照 |
| interpretationHash | canonicalなinterpretationのhash |
| body / irHash | 既存PredicateExpressionとcanonical hash |
| stages | 要求構造化とIR解決それぞれのprovider/model/response ID/usage |
| diagnostics / checksum | bounded diagnosticsとLock全体の整合性 |

原文全文、契約、例をLockへ重複保存しない。契約と例はSourceから決定的に読み取る。メモリ上では `ResolvedPrompt { authored, interpretation, body, revision, lockHash }` を作り、既存消費側に必要なviewを渡す。これは保存ファイルではない。

要求IDの集合・levelはSourceが所有する。LLMは新規IDやlevel変更を返せない。一つの原文要求の解釈は複数条件を含めてよい。全IDの対応を機械検査するが、同一IDの文章内の条件欠落を証明できるわけではない。

## 解決・更新・再現

1. Source bytesと既存Lock bytesをcaptureして検査する。破損Lockをcache missにしない。
2. sourceHash/protocolが一致する有効LockならLLM呼出0回。構造化も再実行しない。
3. 新規解決では原文（検証例を除く）と契約からinterpretationを得る。続いて原文・契約・interpretationからIRを得る。後段にも原文を渡す。
4. ID/level対応、IR構文、lowering、利用者所有の例との一致を検証する。
5. 同じsource mutex内でSource/旧Lockを再照合し、一つの完成Lockをatomic publicationする。片方だけ成功したinterpretationを有効Lockとして残さない。
6. 未解決・拒否・不正出力・競合・例不一致では旧Lockを保持する。変更済みSourceに旧Lockを使うbuildは停止する。

二段階のLLM呼出は現行draft+resolveの責務をresolveへ移す。基本経路で呼出を一つにまとめる最適化は後続とし、両段階の失敗原因を先に検査できるようにする。成功した意味の固定はLockに依存するため、Lockを削除した再解決の同一性は保証しない。

updateはSourceの指定ID本文だけをrevision CASで変更する。変更対象外の原文bytes、契約、例を保持する。解釈JSONを直接patchしない。更新指示を解釈するモデル呼出と、Source更新後のresolveは別操作。自由文全体の一block更新はその全体が更新範囲であることを示す。

## 独立テストと能力製造

suite v2のsourceRevisionは原文hashとする。requirementIdsは原文IDを参照する。IR/interpretationのhashへ依存させない。これにより同じ原要求に対する解釈・IR修正で期待値を変更せず検査できる。

テスト生成には原文要求と契約を渡し、Source内の検証例、interpretation、IR、候補実行結果は渡さない。Sourceをそのまま全文送信するとexamplesが漏れるため、parserで得た原文sectionを使って入力を構成する。利用者例と生成suiteの矛盾チェックは維持する。

製造順はテスト生成・freeze → interpretation → IR → 検証 → 最大1回の修正。修正候補はinterpretationとIRを一緒に差し替え可能とし、原文・契約・例・suiteを固定する。修正候補でもID対応と全検証を再実行する。修正でinterpretationを変えられないと、最初の解釈誤りを直せない。

新規解決の標準呼出数はtests/interpretation/IRの3回、修正を一つのinterpretation+IR応答にするなら最大4回。現行のmaxCalls既定3、token予約、stage enum、fixture、run protocol、replayを対応させる。live呼出は実装検証の必須条件にしない。通常prompt resolveはSource例の検査、capability developはさらに固定suiteの検査を行い、合格の範囲を区別する。

## Build・パッケージ・互換性

Wasm出力は既存emitWasm(body, contract)を維持する。同じIR・契約ならbytes一致を検証する。既存Build Manifest v1の構造を当面再利用できるが、v2経路のsourceHashは原文hash、conceptHashはinterpretationHash、fingerprintはLock checksum、promptHashはv2 protocol hashとする。Source版はprotocolとの組み合わせで判別し、共通の整合検査関数に集約する。既存IR hashのJSON.stringify方式とLockのcanonical方式は異なるため、取り違えず双方を照合する。

Capability Manifestはv2へ版を上げる。source roleは `source.prompt.md`、lock roleは `source.prompt.md.lock.json` にする。source/lock/build/wasm/testsの5役割、contained path、symlink拒否、snapshot・hash照合、atomic publicationを維持する。host/mutation側は同じ検証済みviewから契約・要求・例を読む。

CLIは同じpromptコマンド群でSource拡張子・明示versionを判別する。新規作成はv2を標準とする。checkは原文構文、resolveはLock生成、build/testは既存Lock使用、inspectは原文と解釈を区別して表示。v1の既存build/replay/verifyは維持し、v1 writerは移行期間だけlegacyとして残す。新機能はv2へ限定する。

旧Sourceからの移行は非破壊の新規出力とする。旧JSON内の要求をそのままMarkdownへ移し、「旧構造化Sourceから移行した文章」であると報告する。失われた元requestを復元したと称さない。基本移行はSourceのみを作成し、v2 Lockは明示的な再解決で作る。元requestを選ぶ場合、旧LLM解釈や旧Lockを自動的に適合済みとして移植しない。

古いsuiteのrevisionの機械的置換だけで再検証済みにしない。期待値を保持したsuite移行を行い、新Sourceとの対応・ケース・IDを検査し、その後Wasmで再検証する。保護されたbenchmark入力、旧evidence、run記録は上書きせずv2 fixtureを追加する。

## 実装単位と受け入れ条件

1. Source reader/writer、原文hash、ID指定更新。原文保持、不正構文、UTF-8、サイズ、CAS、symlink、対象外bytes不変を検査。
2. Lock v2とresolve。構造化段階失敗、IR段階失敗、原文ID欠落/level改変、古いLock、破損Lock、並行変更、完全Lockのみ公開を検査。
3. CLIとWasm接続。認証情報なしでvalid Lockを再利用し、別プロセス同一Wasm、source変更で停止、manifest取り替え検出を検査。
4. Capability suite/package/host。原文由来ID、改変・path・version拒否、移動後の自己完結した検証、hostのAPI呼出0回を検査。
5. 製造・修正・replay・mutation・評価runner。テスト生成入力から解釈/例/IRが除外され、期待値を固定したまま誤解釈を修正できるfixtureを追加。呼出・token上限も検査。
6. 移行CLI、v2例、文書更新。v1 replayの回帰、旧証拠を変更しないこと、明示的移行と再検証を確認。

各単位の境界テスト後、全体のformat/lint/typecheck、coverage、ci:docs、ci:protected、ci:smokeを実行する。既存コードを変更しない設計段階ではテスト全体を再実行しない。fixture成功を自然言語の理解精度の証拠にはしない。

初期改修ではCanonical Type IRの全経路統合、Wasm ABI拡張、単一バイナリへのmanifest埋め込み、archive形式、外部配備を含めない。まず要求の所有権をSourceへ戻し、JSONを一つの解釈Lockへ集約することを完了条件とする。
