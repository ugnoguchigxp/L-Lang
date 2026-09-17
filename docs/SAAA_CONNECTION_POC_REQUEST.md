# SAAA側への実装依頼：Wasm実行キットのRust接続PoC

> 分類：記載された基点に対する外部接続依頼・計画です。外部SAAAの現在の実装状態を保証するものではありません。提供済みR1キットは[操作例](../examples/saaa-host/README.md)を参照してください。キットはCapability v1向けで、JSONC Capability v2は現行`capability:host`の対象外です。

2026-09-16。L-Lang側の単発実行キットが実装・検証済みとなったため、SAAA側の接続実装をお願いします。前回の導入全体の検討から範囲を絞り、今回は**Rustホストから実Wasmを検証・呼び出しでき、異常時に停止できること**を完了条件とします。

## 今回お願いしたいこと

SAAAの開発用PoC入口から、L-LangのBun実行キットを子プロセスとして起動し、inspect・verify・invokeの3操作を実装してください。受付判定のfixture候補を使い、JSONの受け渡し、候補hashの一致、正常なfalseとエラーの区別、timeoutとcancelを自動試験してください。

この依頼はSAAA側の接続コードと試験を実装するためのものです。Coding Agentによる自動製造、通常会話へのtool公開、能力の本配備は後続とします。今回、piやCodexの製造ジョブを起動する必要はありません。

## 接続対象と提供済みの資材

| 項目 | 内容 |
| --- | --- |
| L-Langリポジトリ | `https://github.com/ugnoguchigxp/L-Lang.git`、ローカルは`/Users/y.noguchi/Code/L-Lang` |
| 対象branch・commit | `wasm-compiler`、`0124d704f822`（短縮表記`0124d70`）。プッシュ済み |
| SAAA側の調査基点 | `/Users/y.noguchi/Code/SAAA`、main、`68af784`。着手時に現在のcommitと差分を確認し、既存変更を保持してください |
| 実行環境 | 開発機のBun 1.3.14を明示指定。配布アプリへのBun同梱は未検証 |
| プロトコル | `llang-host-v1`。下記の実装済み仕様を使用 |
| 提供資材 | 候補Wasm一式、実行runtime、要求schema、応答外枠schema、期待値付きvectors、部品検証report、hash一覧 |
| 検証状況 | L-Lang全376テスト成功。別ディレクトリ・API認証なしでのキット実行も確認済み。Rust/SAAA接続は未検証 |

キットの生成物はGit管理外です。リポジトリ内に既にある前提で探すのではなく、対象commitから生成してください。元の作業ツリーを切り替えたくない場合は、以下のように新しいworktreeを作れます。同名のディレクトリがある場合は削除せず、新しい名前を使ってください。

```sh
git -C /Users/y.noguchi/Code/L-Lang worktree add --detach /Users/y.noguchi/Code/L-Lang-saaa-poc-0124d70 0124d70
cd /Users/y.noguchi/Code/L-Lang-saaa-poc-0124d70
bun install --frozen-lockfile
mkdir -p artifacts
bun run capability:host-kit artifacts/saaa-host-kit
```

生成後、キットのフォルダ全体をSAAAの試験用保管先へコピーしてください。実行時にはBunだけを使用し、APIキー、Codex、コンパイラ、node_modulesは不要です。キット内の`kit.json`からpackageHashとファイルhash一覧を読み、信頼する生成元から渡されたこととコピー後の整合性を確認します。hash一覧単体は署名ではありません。

まず手動で確認する場合は、コピーしたキットのディレクトリで実行できます。

```sh
bun runtime/capability-host-cli.ts candidate/capability.json < request.json
```

同梱request.jsonは停止中の利用者の入力です。期待する結果はエラーではなく、`status: "ok"`と`result.value: false`です。

## Rust側の実装要件

### 起動とプロセス管理

- 実行ファイルは設定済みBunの絶対パス、argvは管理下のruntimeとcandidate/capability.jsonの絶対パスにします。shellを介さず起動し、ユーザー入力やmetadataからコマンドを組み立てないでください。
- 1プロセスにつき要求JSONを1個送信し、stdinを閉じます。stdoutとstderrは並行して読み取り、stdoutは1 MiB、stderrは64 KiBで打ち切り、超過時はプロセスを停止します。送信要求は64 KiBまでです。
- ホスト側の上限は初期値としてinspect・invokeを15秒、verifyを30秒にします。cancelまたはtimeout時は子プロセスを終了し、終了を回収してから完了を記録してください。
- 起動できない、非0終了、応答がない、不正JSON、JSONが複数ある場合はtransport errorです。終了コード0だけで成功とは判断しません。
- PoCは既定無効の開発用入口またはintegration testから起動します。一般の能力検索や通常会話のtool一覧へ追加しないでください。

既存の会話tool供給口は`src-tauri/src/providers/stream/dispatch.rs`ですが、今回は公開先ではありません。`recall_skill`は記憶検索なので、この実行口として流用しないでください。

### 実装済み要求契約

全操作で次の4項目が必須です。旧依頼書にあった論理契約案の`protocolVersion`ではなく、現在の実装の`protocol`を使用してください。

| 項目 | 値・制約 |
| --- | --- |
| protocol | `llang-host-v1` |
| requestId | 英数字・ハイフン・アンダースコア、1〜128文字。要求との相関確認に使う |
| operation | `inspect`、`verify`、`invoke` |
| packageHash | kit.jsonの値など、信頼する提出記録から取得した64文字の小文字hex。Rust独自の計算規則を追加しない |

invokeだけは`input`、`undefinedFields`、`timeoutMs`も必須です。timeoutMsは1〜10000。今回の受付判定のundefinedFieldsは空配列です。明示的undefinedを扱う場合、input内の同じキーとの併記、重複指定を拒否します。inspect/verifyにはこれら3項目を付けません。

request.schema.jsonで構造を検査し、undefinedFieldsとinputの競合などの相互制約も検査してください。キットのvectors.jsonに実際に送信できる要求と期待値が入っています。

### 応答の判定

共通項目はprotocol、requestId、packageHash、elapsedMs、apiCalls、statusです。成功時はresult、失敗時はerrorが付きます。

- requestIdとprotocolを要求と照合します。成功応答ではpackageHashも要求と一致することを必須にします。不正要求や成果物を検査できないエラーではID/hashがnullになり得ますが、成功扱いはしません。
- inspectは契約やmetadataを返すだけです。verificationとacceptanceはnot-runであり、合格根拠にしません。
- verifyの外側のstatus:okは「reportを返せた」という意味です。**result.status:passを確認して初めて部品検証合格**とします。acceptanceはnot-runのまま保存します。
- invokeのresult.valueはbooleanです。falseも正常な結果として呼び出し元へ返してください。
- errorはinvalid-request、package-mismatch、invalid-input、timeout、execution-errorです。unknownな値やoperationに合わないresultはプロトコル違反として拒否してください。

response.schema.jsonは外枠の検査だけです。Rust側ではoperation別のresult型も定義・検査してください。verifyの内部形式はL-Langの`src/capability-package.ts`のCapabilityReportと`src/capability-report.ts`、inspectは`src/capability-host.ts`を正本として参照します。

## 必須試験と完了条件

| 試験 | 期待する結果 |
| --- | --- |
| 基本接続 | コピーしたキットからinspect・verify・invokeを実行できる。API認証なしで成功する |
| 受付4通り | enabled=true、suspended=falseだけtrue。それ以外は正常なfalse |
| 入力不正 | 同梱の文字列booleanの例をinvalid-inputとして扱い、falseへ変換しない |
| 部品検証と外側の応答 | status:okでもresult.status:fail/errorなら部品合格と記録しない |
| 候補不一致・改変 | 別のpackageHashや、コピーした候補の改変を拒否する。元キットは変更せず試験コピーを使う |
| 不正応答 | 未知protocol、相関ID/hashの不一致、型不正、複数JSON、空応答、過大出力を成功と扱わない |
| 環境・パス | Bun不在を明示し、空白を含む保管先でも実行できる |
| timeout・cancel | ハングする模擬子プロセスを終了・回収でき、残存プロセスがない。cancel受付だけを完了としない |
| 公開範囲 | 候補とPoC入口が通常会話の利用可能能力として公開されない |

vectors.jsonに含まれるのは受付4通りと型不正の5件です。その他の異常応答・ハング用資材はSAAA側のプロセス接続試験で追加してください。これらを実Wasmによる意味検証と混同せず、試験種別を結果へ記録します。

要求・結果には両リポジトリのcommit、キットのprovenance、Bun版、protocol、packageHash、requestId、操作、状態、所要時間を残してください。今回は合成データだけを使い、認証情報は記録しません。キットprovenanceがdirtyなら、その事実と試験対象のコードを記録し、対象commitだけで再現できると主張しないでください。

## 今回の対象外と後続作業

今回の合格表現は「SAAAのRustホストからL-LangのWasmキットへ接続できた」です。「SAAAが新しい能力を獲得した」「自動配備が完成した」とはまだ判定しません。

- SAAA独自の利用受け入れ、二段階の配備gate、レジストリ、切り戻し、実会話による能力選択は次の段階です。
- SAAAの受け入れ失敗を元suiteへ追加して修正するadapterはL-Lang側でも未実装です。今回の接続作業は、その完成を待つ必要がありません。
- Codex SDKのTerra・mediumによる製造はL-Lang単体で実証済みですが、今回のfixture接続試験では呼びません。SAAAの既存codex-sdk-v1 profileはLuna固定のため、後でTerraへ接続する際は設定・許可・reasoning伝達を別途検証します。
- 同一OSユーザーのCoding Agentに対する書き込み分離、ジョブ全体の実モデル予算、配布アプリでのBun実行は後続の必須検証です。保存先を分けただけで権限分離済みとは扱いません。

## 返してほしい成果物

Rust接続実装、operation別の型と検査、自動試験、開発機での再実行手順、結果報告をお願いします。結果報告には成功・失敗・未実施を分け、上記必須試験の結果と再現コマンド、修正が必要なL-Lang側の契約を記載してください。

接続に問題があれば、失敗した操作、機密情報を除いた要求・応答、終了コード、両commitとBun版を返してください。未確定の自動製造・配備機能のために、今回の単発接続まで保留する必要はありません。

## 参照資料

- [実行キットの操作手順](../examples/saaa-host/README.md)
- [要求schema](../examples/saaa-host/request.schema.json)・[応答外枠schema](../examples/saaa-host/response.schema.json)
- [ホストadapter](../src/capability-host.ts)・[CLI](../src/capability-host-cli.ts)・[既存の接続試験](../src/capability-host.test.ts)
- [Codex SDKとpiの比較・実測](./CODEX_SDK_PI_EVALUATION.md)
- [全体の導入依頼書](./SAAA_INTEGRATION_REQUEST.md)・[準備計画](./SAAA_POC_PREPARATION_PLAN.md)
