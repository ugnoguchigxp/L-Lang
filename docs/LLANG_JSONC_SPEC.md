# L-Lang主言語仕様：JSONC Predicate v1

2026-09-17。採用し、P0〜P6を実装した主言語仕様。parser、lint、format、直接Wasm build、独立suite、Capability Package v2、製造・修正・replay、旧Prompt Source移行を含む。[実装計画・完了記録](./LLANG_JSONC_IMPLEMENTATION_PLAN.md)を参照する。

今後のソース形式・コンパイル責務について本書を正本とする。旧Prompt Source、TS DSL、Hybrid importerの実装・再現経路は移行期間中に残す。旧「自然言語Markdownを正本とし解釈JSONをLockにする」提案は採用しない。

## 1. 言語の役割

SAAAが目的・要求・受け入れ条件をCoding Agentへ渡し、CodexやpiがJSONCプログラムを作成・修正する。L-Langはそのプログラムを決定的に検証・コンパイルする。lint/build/testはLLMもAPI認証情報も必要としない。

自然言語の依頼は要求仕様、JSONCは実装ソース、Wasmは生成物である。コメントやdescriptionは実行命令ではない。JSONCだけを変更して要求仕様や受け入れ条件を変更したことにはならない。

ソース拡張子は `.llang.jsonc`。一ファイル一Predicate。JSONCソースに実行IRを直接記述するため、別の解決済みIRファイル・Resolution Lock・canonical JSONの保存を必須にしない。依存解決がない本profileでは新しい言語Lockを作らない。既存の `bun.lock` はツールチェーン依存として別の役割を持つ。

## 2. 字句・構文

RFC 8259のJSON構文に、`//` 行コメント、`/* ... */` 非入れ子コメント、object/arrayの末尾カンマを追加する。この三点をL-LangのJSONC方言として固定する。

- UTF-8、BOMなし、rootはobject一つ。LF/CRLFを受理する。
- キーと文字列は二重引用符。単一引用符、引用符なしキー、JavaScript式、undefined、NaN、Infinity、16進数を拒否する。
- 通常のJSON数値構文はparse可能。ただし値は有限で、各fieldのschemaに適合する必要がある。本profileには数値入力・数値演算はない。
- コメントは空白扱い。文字列中の `//` 等はコメントにしない。Markdown fenceや応答前後の説明文をソースとして受理しない。
- 同じobject内の重複キーはエラー。Unicode escapeをdecodeしたキーで重複判定し、後勝ちにしない。未知fieldもエラー。
- trailing garbage、途切れた入力、不正UTF-8、unpaired surrogateはエラー。文字列のUnicode正規化は行わない。
- 構文回復で得た部分ASTは診断専用であり、コンパイルできない。

入力上限はUTF-8で1 MiB、JSON構造depth 64、bodyのIR node数256・depth32・all/anyの子数64。コメントも入力サイズに含む。parse前にbyte上限、構築中にdepth上限を検査する。診断は最大32件、メッセージは各2,000文字。上限超過時は打ち切りを明示する。

## 3. プログラムの構造

| field | 必須 | 意味 |
| --- | --- | --- |
| language | はい | 固定値 `l-lang` |
| version | はい | 整数1。本仕様の版 |
| id | はい | `^[A-Za-z][A-Za-z0-9_-]{0,63}$` |
| profile | はい | 固定値 `predicate-i32-v1` |
| description | いいえ | 1〜4,096文字の説明。意味解決には使わない |
| contract | はい | 現行WasmContract v1の入力契約 |
| body | はい | 以下に定義するPredicate式 |

戻り値はboolean、exportはevaluateで固定。requirements、examples、hash、checksum、モデル情報、テスト合格記録をソースの必須項目にしない。テストは独立した受け入れ資産として扱う。

例：そのまま新parserの受理fixtureに使う仕様例。

```jsonc
{
  "language": "l-lang",
  "version": 1,
  "id": "enabled-user",
  "profile": "predicate-i32-v1",
  "description": "有効で停止されていない利用者を判定する。",
  "contract": {
    "version": 1,
    "fields": [
      {
        "name": "enabled",
        "kind": "boolean",
        "values": [],
        "nullable": false,
        "undefinable": false,
        "optional": false,
      },
      {
        "name": "suspended",
        "kind": "boolean",
        "values": [],
        "nullable": false,
        "undefinable": false,
        "optional": false,
      },
    ],
  },
  "body": {
    "kind": "all",
    "conditions": [
      { "kind": "equals", "property": ["enabled"], "value": true },
      // 停止されている利用者は許可しない。
      { "kind": "equals", "property": ["suspended"], "value": false },
    ],
  },
}
```

contractは既存 `parseContract` と同じ受理範囲とする。fieldsは1〜64、name順、重複なし。各fieldはname/kind/values/nullable/undefinable/optionalを必須とし、kindはboolean/enum/string。enumのvaluesは1〜256個、辞書順、重複なし。他kindのvaluesは空配列。field名等の細部上限も現行WasmContractを継承し、公開schemaと適合テストに転記する。省略時の暗黙推定は導入しない。

## 4. 実行意味

| kind | 必須field | 意味 |
| --- | --- | --- |
| all | conditions | 1件以上の式がすべてtrue |
| any | conditions | 1件以上の式の少なくとも一つがtrue |
| not | condition | booleanの否定 |
| equals | property, value | 契約に適合した値の比較 |
| present | property | nullでもundefinedでも欠損でもない |

propertyは既存IRとの互換性のため文字列配列で表すが、このprofileでは長さ1のみ受理する。未宣言field、数値比較、一般stringとの等価比較、ネストpathを拒否する。equalsのvalueはboolean、宣言済みenum literal、nullable fieldに対するnullだけ。暗黙の型変換はない。

presentはnullable/undefinable/optionalのいずれかを持つfieldにだけ許可する。空文字列はpresent。null、明示undefined、欠損の入力許可はそれぞれ契約で検査する。常時値を持つfieldへのpresentは現行loweringと同じくエラー。

bodyは純粋・決定的。IO、時計、乱数、import、memory、可変状態、ループ、再帰、関数呼出はない。全入力に対する一般的安全性の主張ではなく、契約に適合した入力と現行runtimeの範囲で評価する。未対応操作を自然言語やLLMへfallbackしない。

## 5. lintとformat

`llang lint` はJSONC用の字句・構文検査に加え、L-Lang schema、型、profile適合、lowering可能性を検査する。buildと同じ検証関数を使い、lintを通った未対応IRがbuildで初めて発覚する二重仕様を作らない。lint成功は要求充足・テスト合格を意味しない。

診断はcode/severity/message/file/range/path/related/hintを持つ。rangeは1始まりline/column、end exclusive、columnはUTF-16単位。pathはRFC 6901 JSON Pointer。未知fieldはそのキー、欠落fieldは親object、重複キーは後のキーを主位置・先のキーをrelatedにする。返却順は位置・codeで安定化する。

| code群 | 対象 | 自動修正 |
| --- | --- | --- |
| LLJ001 | JSONC構文、不正文字列、trailing garbage | しない |
| LLJ002 | 重複キー | しない |
| LLJ003 | encoding・byte/depth上限 | しない |
| LLS001 | 欠落/未知field、version、schema型不一致 | しない |
| LLT001 | 未宣言field、literal型・enum不一致 | しない |
| LLP001 | profile外操作・上限、lowering不可 | しない |
| LLW001 | 完全に同一の条件式の重複 | warningのみ |

例：`LLT001 /body/value: statusの値 "actve" は未宣言です。許可値: "active", "suspended"`。修正候補はhintに留め、自動でenumを変更しない。

formatは構文と重複キー検査を通った入力に限り、文字列・コメント・値・配列順・object key順・末尾カンマの有無を保持して空白/改行を整える。2 spaces/LF/末尾改行を標準とする。format --checkは非書込。初期版に広域 `lint --fix` やjsonrepairを導入しない。構文推測による括弧・引用符補完、条件削除、all/any置換、default補充は禁止する。

## 6. 保存と再現性

エージェントが保守するプログラムはJSONC一つ。ツールがhashやmanifestを生成する。コメントを取り除いたJSONを別途trackedファイルに保存しない。

- sourceHash = Source bytesのSHA-256。コメント変更・format変更も履歴として区別する。
- programHash = 検証・正規化したlanguage/version/profile/contract/bodyのcanonical hash。id/description/コメント/空白/object key順を含めない。配列順は保持する。
- 同じprogramHashと固定toolchain/optionsから同じWasm bytesを生成することを検査する。異なるtoolchainでの同一bytesは保証しない。
- manifestには両hashとtoolchain/options/Wasm hashを記録する。コメントだけ変更しても旧manifestのsourceHashは一致しない。明示buildで新manifestを作り、Wasm bytesは同一にできる。

既存Wasm manifestと能力パッケージの検証情報は残る。ファイル総数を二つにする仕様ではない。新経路のbuildはSourceから直接行い、意味解決Lockを不要とする。既存成果物のchecksum検査や改変検出を緩めない。

## 7. 依頼・独立テスト・エージェント

SAAA所有の要求、固定入力契約、受け入れ条件は実装とは別の権限境界を持つ。実装のcontractを狭めて不都合な入力を除外する行為を防ぐため、能力製造では固定契約との一致を検証する。

独立suiteはimplementationのsourceHashへ固定せず、依頼revisionと固定契約へ結び付ける。実装を修正してもsuiteを変更しない。実行reportは依頼revision、suite hash、programHash、sourceHash、artifact hashをすべて記録する。単体lint/buildにはSAAA接続を要求しない。

request、suite、metadata、manifest、開発runはJSONCではなく標準JSONとし、コメント・末尾カンマ・重複キー・不正Unicode surrogateを拒否する。各ファイルは1 MiB以下のregular non-symlink fileに限定する。suiteの明示的なundefinedはinputへ直接書かず `undefinedFields` で表す。契約で許可された `_`・`$` 始まりのfield名も同じ規則で扱う。

要求IDを持つmust/must-not要求に対応ケースがなければ、ケース自体が成功してもtestとCapability verifyはfailとする。要求IDのない依頼だけはcoverageを `not-evaluated` として実行結果と区別する。mutation checkは無効入力ケースをkill根拠にせず、有限入力領域で同値な変異をsurvivorから除外する。

エージェントはソースの局所編集→lint→test/buildを繰り返す。compilerがLLMを自動起動しない。公開schema、短い例、機械可読診断、終了codeを提供する。コメントを含む完全ファイルは作業ファイルとして直接提出でき、API型adapterはオブジェクトを受けてツールがserializeする。JSON文字列をJSONへ再埋め込みする方式を新しい標準にしない。

開発runは成功応答だけでなく失敗したAgent呼出しもrequest hash・error・予算消費とともにcheckpointへ残す。replayはrequest、suite、metadata、各call、各attemptのhashを再検査し、固定入力の差替えやsymlinkを拒否する。同一Programの再提出は追加修正として数えず停止する。

固定依頼はrequest v2（version/id/body/profile/contract/requirements）、suite v2はversion/requestRevision/contractHash/casesで表す。Capability Manifest v2のroleはrequest/source/build/wasm/testsで、lockは持たない。packageはJSONC原文をそのまま収録し、読取時に全file hash、依頼・Program・buildのcontract、sourceHash、programHash、Wasm hashを照合する。

標準CLIは次の通り。`develop` はfixtureまたは `--agent codex-sdk` を選び、実装と最大1回の修正だけを許す。pi等のファイル編集型Agentは同じlint/test/package CLIを使う。live実行の成功は実モデル評価を行った場合だけ別途報告する。

```sh
bun run llang test source.llang.jsonc --request request.json --suite tests.json
bun run llang package source.llang.jsonc --request request.json --suite tests.json --metadata metadata.json --out-dir candidate
bun run llang verify candidate/capability.json
bun run llang migrate legacy.prompt.json --out source.llang.jsonc
```

## 8. 適合性と将来拡張

この仕様は限定Predicate言語であり、汎用能力製造の完成を意味しない。Canonical Type統合、演算追加、module/dependency、effect、memoryは別profile/versionで設計する。将来の依存固定にLockが必要になっても、現在のSourceをLLM解釈JSONへ置き換える理由にはしない。

パーサー候補は[Microsoft jsonc-parser](https://github.com/microsoft/node-jsonc-parser)。コメントと末尾カンマを明示設定し、回復結果のerrorsを必ず検査する。位置情報を利用し、重複キー等は独自検査する。採用versionは実装開始時にAPI・license・Bun互換性を確認して固定する。
