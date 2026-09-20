# 要求に結び付くEffects実行監査の実装計画

作成日: 2026-09-20。状態: 実装済み。実装結果は[EFFECTS_REQUIREMENT_AUDIT_IMPLEMENTATION_RESULTS.md](./EFFECTS_REQUIREMENT_AUDIT_IMPLEMENTATION_RESULTS.md)。前段は[要求付きWasmパッケージの事後検査](./CAPABILITY_INSPECTION_IMPLEMENTATION_PLAN.md)、[Effects Bundleの事後検査](./EFFECTS_BUNDLE_INSPECTION_IMPLEMENTATION_PLAN.md)、[Effects実行証跡](./EFFECTS_EXECUTION_EVIDENCE_IMPLEMENTATION_PLAN.md)です。

## 目的

[メインコンセプト](../MAIN_CONCEPT.md)の中心である「何を頼んだか」「どの処理として固定したか」「何を許可したか」「実際に何が起きたか」を、`module-effects-v1`の一つの検査可能なchainとして結び付けます。

現在は次の三つが個別に成立しています。

- Capability v2 inspectionは、外部I/OのないPredicateについて要求、契約、TypeScript projection、Wasmを結び付ける。
- Effects bundle inspectionは、typed graph、TypeScript、Wasm、operation/effectを実行せずに照合する。
- Effects execution evidenceは、bundle identity、実grant、redacted transcript、結果、resource、cleanupを結び付ける。

一方、Effects実行では自然言語要求と機械可読な権限上限がbundle・grant・実行証跡へ固定されていません。後から要求文と実行reportを同じdirectoryへ置くだけでは、その要求が実行前に確認されたことや、grantが要求上限を超えていなかったことを示せません。

この計画では、利用者または上位hostが実行前に固定した要求契約を導入し、そのhashを実行前intent、最終report、crash recovery、事後監査reportへ貫通させます。自然言語の意味が正しいことを自動判定する機能ではありません。機械的に確認できる権限上限と構造対応、宣言に留まる意味対応を区別して表示します。

## 到達点

利用者は、既存Effects bundleに対して要求契約付き実行を行えます。

```text
bun run llang module execute <module-build.json> \
  --grant <effects-grant.json> \
  --requirements <effects-requirements.json> \
  --out-dir <new-evidence-directory> \
  --json

bun run llang module audit-execution <module-build.json> \
  --requirements <effects-requirements.json> \
  --evidence <evidence-directory> \
  --out-dir <new-audit-directory> \
  --json
```

`module execute --requirements`は、最初の外部操作より前に次を確認します。

- 要求契約が対象bundle identityへ一致する。
- 要求契約に記載したoperation集合がbundle manifestと一致する。
- 実grantのoperation、file、HTTP、wall clock、deadline、resource limitが要求契約のauthority ceilingを超えない。
- requirement bindingが存在するnode、operation、authority ruleだけを参照する。
- 必須要求にbindingがなくても成功扱いにせず、実行前に拒否するか`manual`として明示されている。

要求契約付き実行では、契約hashを含むversion 2のintentとexecution reportを生成します。既存の要求契約なしversion 1実行は互換のため維持し、要求に結び付いた実行とは表示しません。

`audit-execution`はWasm、TypeScript、外部operationを実行しません。既存のbundle inspectionと実行証跡を再検査し、新しいdirectoryへ次を保存します。

```text
execution-audit.json
program.inspection.ts
effects-transcript.jsonl
effects-execution.json
```

監査成果物は要求本文、要求ID、機械検査できた項目、宣言対応だけの項目、bundle identity、projection hash、grant commitment、transcript/result/resource/cleanupを一つにまとめます。

## 信頼境界

要求契約は、生成されたprogram自身ではなく利用者または上位hostが与える入力です。program、bundle、credential、処理対象データから要求契約やauthority ceilingを書き換えられないようにします。

この実装が確認するものは次です。

- 同じ要求契約hashが実行前intentと最終・回収reportへ含まれること。
- 実行したbundleが要求契約に固定されたbundle identityと一致すること。
- 実grantが要求契約のauthority ceilingの部分集合であること。
- 要求IDとnode、operation、authority rule、期待terminal statusの参照が構造上有効であること。
- audit対象のreport、transcript、bundleがhashとidentityで対応すること。

次は確認しません。

- 自然言語の要求本文が利用者の真意を正しく表すこと。
- nodeへのrequirement bindingが要求の意味を本当に実装すること。
- 出力値や外部serviceの応答が業務的に正しいこと。
- 要求契約、bundle、実行host、audit reportの発行主体の真正性。
- `evidenceHash`だけによる改ざん防止、否認防止、第三者向け証明。

要求本文と機械可読なauthority ceilingを区別し、authority ceilingにない権限を要求本文から推測して追加しません。外部データ、HTTP response、file本文、credentialを要求として再解釈しません。

## 要求契約

### 形式

新しいstrict JSON document `llang-effects-requirements` version 1を追加します。未知field、重複key、非正規な順序、絶対path、秘密値を拒否します。

```json
{
  "format": "llang-effects-requirements",
  "version": 1,
  "id": "invoice-summary",
  "revision": 1,
  "body": "指定された請求書を集計し、結果を一つのファイルへ保存する",
  "bundleIdentityHash": "...",
  "requirements": [],
  "bindings": [],
  "authorityCeiling": {},
  "expectedTerminalStatuses": ["completed"]
}
```

要求項目は少なくとも次を持ちます。

| field | 内容 |
| --- | --- |
| id | 契約内で一意な安定ID |
| level | `must`、`must-not`、`should` |
| statement | 人間向け要求。実行コードや権限として評価しない |
| verification | `authority`、`structure`、`outcome`、`manual` |

`manual`は未検証を意味し、合格済みという意味ではありません。`must`または`must-not`を`manual`にする場合、実行は許可できますが、監査statusを`review-required`とします。完全自動判定が必要なhostはpolicyとして`manual`を拒否できます。

### Binding

bindingはrequirement IDを次の既存対象へ結び付けます。

- checked graphのnode index。
- `operation@version`。
- authority ceilingのfile、HTTP、clock、deadline、resource rule。
- 許容するterminal status。

bindingは意味一致の自己申告です。監査器は参照先の存在、型、operation/effect、grantとの対応を確認しますが、自然言語statementとnodeの意味一致を証明済みとは表示しません。

`verification: authority`は機械可読なauthority ruleを必須とします。`verification: structure`はnodeまたはoperation bindingを必須とします。`verification: outcome`はterminal status bindingを必須とします。bindingのない`must`、存在しないnode、bundleにないoperation、重複binding、余分なrequirement IDは拒否します。

### Authority ceiling

authority ceilingはgrantと同じ種類の情報を持ちますが、実行権限ではなく上限です。

- operation集合。
- file logical root、read、write、replace。
- HTTP origin、method、request header、public/private address方針。
- wall clock。
- deadline上限。
- host request、task、stream、memory、fuel、送受信bytes等のresource上限。

実grantはceilingの部分集合でなければなりません。file rootは文字列一致だけでなくsegment境界を含む包含関係で比較します。HTTP originは正規化済みoriginの完全一致、method/header/addressは集合包含、boolean capabilityは`false`から`true`への拡大禁止、数値limitはgrant値がceiling以下であることを要求します。

要求契約はcredential値、credential環境変数名、adapter rootの絶対path、payload本文を持てません。

## 実行前の結合

`src/llang-effects-requirement-contract.ts`を追加し、要求契約をstable regular fileとして読みます。bundle、grant、credential mappingと同じくsymlink、複数hard link、読取中のinode・size変更を拒否します。

要求契約付き実行は次の順でpreflightします。

1. Effects bundleを既存inspection APIで検証し、bundle identityを固定する。
2. 要求契約をstrict parseし、bundle identityとoperation集合を照合する。
3. requirementとbindingをchecked graphに対して検証する。
4. grantを読み、bundle identityとoperation集合を照合する。
5. grantがauthority ceilingの部分集合であることを検証する。
6. credential mappingを検証する。
7. 新しいevidence directoryを作成し、要求契約hashを含むintentを外部dispatch前に耐久化する。

preflight失敗時は外部operationを一度もdispatchせず、成功reportを作りません。要求契約を実行中に差し替えた場合は、終了時再検査で`requirements-changed`のfailed reportとします。

version 2 intent/reportは少なくとも次を追加します。

| section | 内容 |
| --- | --- |
| requirements | id、revision、source hash、canonical commitment hash、bundle identity |
| authority | ceiling commitment、grant subset check、超過0件 |
| coverage | requirement総数、verification別件数、manual/review-required件数 |

要求本文全体はintent、transcript、execution reportへ複製しません。hashとIDだけを実行証跡へ保存し、本文は事後audit時に要求契約から読みます。これにより実行証跡への機密文混入を抑えます。

## Version 1互換とcrash recovery

要求契約なしの既存`module execute`はversion 1のまま維持します。`--requirements`を指定した実行だけversion 2とし、CLI出力で`requirements: bound`を明示します。

`recover-execution`はversion 1と2をstrictに分岐して読みます。version 2では要求契約hashを回収reportへ保持し、契約本文を必要とせずpending requestをunknownとして回収します。回収時も外部operation、Wasm、file commit、要求解釈を再実行しません。

versionを推測で補完したり、version 2の未知fieldをversion 1として受理したりしません。既存version 1 fixtureとCLI結果は回帰試験で固定します。

## 事後監査

`src/llang-effects-execution-audit.ts`を追加します。入力はbundle manifest、要求契約、evidence directoryです。

監査は次を再検査します。

1. bundleを再inspectionし、要求契約とexecution reportのbundle identityへ一致すること。
2. 要求契約のsource/commitment hashがexecution reportへ一致すること。
3. execution reportのevidence hash、intent hash、transcript hash chainを再計算できること。
4. reportのgrant summaryがauthority ceiling内であること。
5. transcriptのoperationがbundle、grant summary、requirement bindingの対応範囲内であること。
6. result、cleanup、resource、unknown outcome、terminal statusをrequirement別に整理すること。
7. bundle projectionを再生成し、同梱TypeScript/Wasmと一致すること。

監査statusは次に限定します。

| status | 意味 |
| --- | --- |
| `passed` | 全machine check成功、必須manual項目なし、terminal statusが許容内 |
| `review-required` | integrityとauthority checkは成功したがmanual requirementが残る |
| `failed` | hash、identity、authority、binding、terminal statusの機械検査に不一致 |
| operational error | 入力を安全に読めず監査reportを作れない |

`passed`でも自然言語要求の完全な充足や業務的正しさを意味しません。reportに`semanticMeaning: not-proven`、`publisherAuthenticity: not-proven`を固定表示します。

監査出力directoryはbundle、要求契約、evidence directoryの外部に新規作成します。検査済みbytesだけをcopyし、絶対path、credential、payload本文、HTTP path/queryを含めません。既存出力、差し替えられたfile、所有しないdirectoryを削除・上書きしません。

## 人間向け監査資料

`execution-audit.json`は次の順で読める構造にします。

1. 要求ID、revision、本文。
2. requirementごとのlevel、verification、binding、機械検査結果、未検証理由。
3. 検査済みTypeScript projectionとbundle identity。
4. 要求authority ceilingと実grantの差分。
5. 実際に観測したoperation、result、失敗、取消、unknown、cleanup、resource。
6. authenticity、retention、rollback、semantic meaningの制約。

要求本文はJSON dataとして保持し、TypeScriptのcomment、識別子、式へ挿入しません。`program.inspection.ts`は既存Effects inspectionと同じ決定的projectionを再利用し、要求から説明コードを新たに生成しません。

## CLIと終了値

`module execute`へ`--requirements`を追加し、未知・重複・値欠損を既存規則どおり拒否します。`module audit-execution`は`--requirements`と`--evidence`を必須とし、`--out-dir`なしではJSONだけを返します。

`audit-execution`の終了値は次とします。

- 0: `passed`または`review-required`の整合した監査reportを生成。statusはJSONで区別する。
- 1: 整合した入力から機械的不一致を示す`failed`監査reportを生成。
- 2: CLI誤用、unsupported version、不正file、出力失敗等のoperational error。

上位hostがmanual requirementを禁止する場合はreport statusを確認して配備・利用を止めます。CLI終了0だけを自動配備許可として使わないことを文書化します。

## 実装単位

### PR-1: 要求契約とauthority包含判定

- strict schema、canonical commitment、stable file read。
- bundle identity、operation、binding検証。
- file/HTTP/clock/deadline/resource ceilingとgrantの包含判定。
- hostile key、`__proto__`、Unicode、重複key、path traversalの拒否。

### PR-2: 要求契約付きexecution evidence v2

- `module execute --requirements`。
- version 2 intent/reportと終了時再検査。
- requirement/authority/coverage summary。
- version 1互換試験。

### PR-3: version 2 crash recovery

- v1/v2 strict dispatch。
- contract hashを保持する非replay recovery。
- live owner、PID reuse、lock/intent/transcript/output差し替えのfail-closed試験。

### PR-4: 事後監査APIと成果物公開

- bundle、requirements、evidenceのsingle snapshot audit。
- transcript operationとbindingの対応集計。
- `passed`、`review-required`、`failed`のreport。
- projection/report/evidenceの排他的・順序付き公開。

### PR-5: CLI、example、smoke、文書

- `module audit-execution`とhelp/JSON error。
- `examples/module-io-pipeline`へ要求契約付き実行例を追加。
- CLI reference、Effects仕様、roadmap、docs indexを更新。
- effects smokeで要求契約→実行→auditを一往復する。

PRは依存順に分けられますが、一部だけを公開機能として完了扱いにしません。v2 schemaを導入した後に回収不能な中間状態を作らないよう、PR-2とPR-3は同じreleaseで有効化します。

## 受け入れ条件

| ID | 検証 | 合格条件 |
| --- | --- | --- |
| ERA1 | 要求契約付きall-target bundleを実行・監査 | requirement、bundle、grant、intent、transcript、resultのhash chainが一致 |
| ERA2 | source削除後にbundle、requirements、evidenceを移動 | 同じaudit結果になり、絶対pathを含まない |
| ERA3 | bundle identity、operation集合、requirement IDの不一致 | dispatch前に拒否し、成功reportを残さない |
| ERA4 | grantがfile root/read/write/replace ceilingを超過 | dispatch 0で拒否 |
| ERA5 | grantがHTTP origin/method/header/address ceilingを超過 | connection 0で拒否 |
| ERA6 | wall clock、deadline、resource limitの超過 | dispatch前に拒否し、縮小grantは許可 |
| ERA7 | `must`/`must-not`のbinding欠損・余分な参照 | strictに拒否。`manual`だけreview-requiredとして保持 |
| ERA8 | 実行中のrequirements、grant、bundle差し替え | failed reportまたはoperational error。成功扱いしない |
| ERA9 | version 1要求なし実行 | 既存report、CLI、recoveryの互換を維持 |
| ERA10 | version 2のrequest後response前crash | requirement hashを保持し、pendingはunknown、再dispatch 0 |
| ERA11 | transcriptへbinding外operationを故障注入 | hashを再計算してもsemantic auditがfailed |
| ERA12 | completed/failed/cancelled/incomplete | terminal status policyと観測statusを正しく照合 |
| ERA13 | file write commit/abort、stream cancel、cleanup失敗 | requirement別の観測へ隠さず表示 |
| ERA14 | hostile requirement本文、Error、header、`__proto__` | code/log injection、prototype汚染、secret漏えいなし |
| ERA15 | requirements/evidence/audit出力のsymlink・hard link・置換 | fail-closed。所有しないfileを削除・上書きしない |
| ERA16 | audit境界 | Wasm実行、projection import/eval、network、credential access、API呼出0 |
| ERA17 | CLI誤用・旧bundle・linear compatibility bundle | 終了2、外部操作0、既存inspect/verify契約不変 |
| ERA18 | Binaryen/ABI回帰 | Binaryen 132、Wasm bytes、typed wire、session ABI、既存runtime結果が不変 |

ERA11では通常writerが生成できない不整合をtest fixtureで作り、hash chainだけでなくoperation/binding照合が必要であることを確認します。これは署名攻撃耐性の証明ではありません。

## 品質Gate

対象testに続き、指定Bun版で次を実行します。

```sh
bunx bun@1.4.2 run check
bunx bun@1.4.2 run ci:docs
bunx bun@1.4.2 run ci:protected
bunx bun@1.4.2 run ci:smoke
```

coverageとUbuntu、macOS、Windowsは既存CI matrixで確認し、ローカル結果とremote CIを区別します。新しいWasm emitter、Binaryen pass、ABI、source profileは追加しません。既存bundleのWasm bytesが変わらないことを回帰試験で確認します。

## 完了後も残るもの

この計画により、要求契約から実行監査までのidentity chainが成立します。ただし、次は後続です。

- 自然言語要求とstructured requirement contractの意味一致を独立に評価すること。
- TypeScript監査資料による人間の理解度、見落とし、調査時間の実測。
- 外部データに埋め込まれた命令と信頼する要求を分離するadversarial experiment。
- 通常のTypeScript、test、sandbox、logを組み合わせたbaselineとの比較。
- Ed25519等による要求契約、bundle、evidence、audit reportの署名とtrust policy。
- key rotation、timestamp authority、remote storage、暗号化、retention自動執行。
- SAAAの受け入れ・配備API、実domain、実利用者を使う評価。
- exactly-once、外部副作用rollback、分散transaction。

次の実装候補は、今回完成させるchain全体を署名対象にする「署名付き監査attestation」です。要求契約を結ぶ前にexecution reportだけを署名すると、発行主体は示せても「何を頼んだ実行か」が署名対象から欠けるため、この順序にします。

## コンセプト全体の現在地

以下は工数や納期ではなく、[メインコンセプト](../MAIN_CONCEPT.md)の主要な成立条件を重み付けした設計上の目安です。test件数やコード量から算出した進捗率ではありません。

| 観点 | 現在の目安 | 根拠と残り |
| --- | ---: | --- |
| 中核の技術縦断 | 70〜80% | 制限IR、projection、Wasm、bundle検査、grant付き実行、redacted evidenceは成立。要求からEffects実行までの一本化と発行主体の真正性が残る |
| メインコンセプトの研究実証 | 35〜45% | 機械的な整合・故障検出の基盤はあるが、要求解釈、人間の事後理解、攻撃耐性、通常TS baselineとの比較が未実測 |
| 実運用・製品化 | 20〜30% | CLIと局所hostはあるが、鍵・trust・retention、SAAA受け入れ配備、実domain、利用者評価、運用監視が残る |

この計画を完了すると、中核の技術縦断は80〜85%程度まで進む見込みです。ただし研究実証は45〜55%程度に留まります。残りの中心はコード追加よりも、独立した期待値、攻撃case、人間参加者、比較baselineを事前固定して実測する作業だからです。

メインコンセプトに対しては、この計画を含めて少なくとも次の五つの大きな作業単位が残っています。

1. 要求に結び付くEffects実行監査（本計画）。
2. 要求・bundle・evidence・audit全体の署名、key rotation、trust policy。
3. 信頼する要求と外部データを分離するadversarial評価。
4. TypeScript事後監査の人間評価と通常TypeScript方式との比較。
5. SAAAまたは同等hostでの受け入れ・配備・切戻しと実domain pilot。

暗号化、remote evidence store、retention自動執行、LSP、package ecosystem、広いinterop、exactly-onceや分散transactionまで製品要件に含める場合は、さらに複数の計画が必要です。これらはメインコンセプトの最小実証と、汎用言語・製品としての完成を分けて判断します。

## 完了報告で示すもの

- ERA1〜ERA18と対応test。
- requirement contract hashがintent、execution report、recovery、audit reportへ一致する例。
- authority ceilingより小さいgrantの成功と、超過grantのdispatch前拒否。
- requirement別のmachine checked、mapped-only、manual、observed outcome。
- credential、payload、絶対path、HTTP path/queryが監査成果物へ含まれない検査。
- v1互換、v2 crash recovery、差し替え、故障注入の結果。
- Binaryen、TypeScript、Bun、OS、実行コマンド、coverage、CI matrix。
- `semanticMeaning:not-proven`、`publisherAuthenticity:not-proven`、`attestation:not-signed`という制約。

「自然言語要求の意味を証明した」「外部副作用が正しい」「発行者の真正性を証明した」「コンセプト全体を実証した」とは報告しません。
