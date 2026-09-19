# Effects実行証跡の実装計画

作成日: 2026-09-20。状態: 実装済み。前段は[Effects Bundleの事後検査](./EFFECTS_BUNDLE_INSPECTION_IMPLEMENTATION_PLAN.md)です。

## 目的

検査済みの`module-effects-v1` bundleを実際のhost grantの下で実行し、どのbundleを、どの権限と予算で、どの外部操作まで実行し、どの結果・失敗・取消・cleanupへ到達したかを、credentialやpayload本文を残さず事後確認できるようにします。

前段の`llang module inspect`は、同梱JSONCからTypeScriptとWasmを再生成し、bundle内部の整合を実行せずに確認します。しかし、次の事実は静的検査からは分かりません。

- hostが実際に与えたoperation、file root、HTTP origin、method、header、wall clockのgrant。
- dispatchされたrequestと、完了・失敗・timeout・取消の順序。
- taskの並行実行、stream chunk、deadline、予算消費、cleanupの実績。
- 外部操作後に応答を観測できなかった`outcome: unknown`。
- 実行したWasmが、検査したbundleのWasmそのものだったか。

この計画では、静的inspectionを実行前preflightとして必須化し、検査済みbundle identity、grant commitment、redacted transcript、result hash、resource ledgerを一つの実行証跡へ結び付けます。

## 到達点

CLI利用者は次を実行できます。

```text
bun run llang module execute <module-build.json> \
  --grant <effects-grant.json> \
  --out-dir <new-evidence-directory> \
  --json

bun run llang module recover-execution <evidence-directory> --json
```

`module execute`はversion 5、profile `module-effects-v1`、ABI `llang-effects-session-v1`、typed `--target all` bundleだけを受け付けます。静的inspectionを通過した同梱Wasm bytesを実行し、source graphからWasmを作り直した別bytesへ差し替えません。

CLIの初期対応は組込みfile、HTTP、clock operationです。任意の`host` operationは、同じrecording APIへembedding hostが型付きexecutorを登録して実行します。CLIが未知のhost operationを黙ってmockしたり、成功値を捏造したりはしません。

出力directoryには次を保存します。

```text
execution.lock                 # 実行中だけ存在する所有lock
execution-intent.json
effects-transcript.jsonl
effects-execution.json
```

`execution-intent.json`は最初の外部操作より前に耐久化します。`effects-transcript.jsonl`はrequest、response、stream、cancel、cleanupを順次追記します。`effects-execution.json`は完了時に最後に公開し、bundle identity、grant commitment、transcript hash、result hash、最終statusを固定します。

プロセス停止などで最終reportがない場合、`recover-execution`はintentとtranscriptを読み、未応答requestを`unknown`として回収reportを作ります。外部操作を再実行・再送・再開しません。

## 完了状態の定義

実行結果とCLI終了値を分離します。

| 状態 | 意味 | 終了値 |
| --- | --- | ---: |
| `completed` | Wasmが`DONE`となりresult hashを確定 | 0 |
| `failed` | operation失敗、Wasm fault、resource limit、cleanup失敗を記録 | 1 |
| `cancelled` | caller取消またはdeadlineを記録 | 1 |
| `incomplete` | crash回収時に未応答・未完了がある | 1 |
| operational error | bundle、grant、出力、証跡自体が不正で安全に開始・回収できない | 2 |

`failed`、`cancelled`、`incomplete`でも、証跡の整合が確認できれば有効なreportを返します。実行前preflightで失敗した場合は、外部操作を行わず成功証跡も作りません。

## 脅威モデルと保証境界

対象とする脅威は次です。

- manifestやartifactの改変、bundleの実行中差し替え。
- bundleと異なるWasmの実行、operation indexや型の取り違え。
- grant外のpath、origin、method、header、wall clock、operationへのdispatch。
- task/stream中の重複応答、古い世代、遅延応答、予算超過。
- transcriptへのpayload、credential、完全なfile pathやURL pathの混入。
- 証跡出力directory・journal・最終reportのsymlink化、置換、改変。
- 外部操作後、response記録前のprocess停止。

この段階で保証しないものは次です。

- OSやremote serviceが返した内容の真実性。
- HTTP先やhost extensionの業務的な正当性。
- 実行host、時刻、利用者の暗号学的な本人性。
- evidence hashだけによる第三者向け真正性・否認防止。
- 外部serviceで完了した副作用のrollback。
- process kill、kernel panic、disk故障後の完全な記録保証。

reportは`attestation: "not-signed"`と`retention: "caller-managed"`を明示します。署名鍵、trust store、remote attestation、保存期限の自動執行は後続計画へ分離します。

## 実装内容

### 1. 実行grant文書

`effects-grant-v1`を新設します。`EffectsGrant`のSetをJSONへ直書きするのではなく、strict parserでcanonicalな実行入力へ変換します。

```json
{
  "format": "llang-effects-grant",
  "version": 1,
  "bundleIdentityHash": "<sha256>",
  "operations": ["file.read@1", "file.write@1"],
  "file": {
    "adapterRoot": "./sandbox",
    "logicalRoots": ["input", "output"],
    "read": true,
    "write": true,
    "replace": false
  },
  "http": null,
  "wallClock": false,
  "deadlineMs": 30000,
  "limits": {}
}
```

要件は次です。

- 未知field、重複operation、未知operation、非canonical順序、不正値を拒否する。
- `bundleIdentityHash`を静的inspectionの値と一致させ、別bundleへのgrant流用を拒否する。
- `adapterRoot`はgrant file基準で解決し、存在する実directoryへcanonicalizeする。symlink rootは拒否する。
- `logicalRoots`はbundle request内の相対pathへ適用し、実filesystem rootとは分離する。
- HTTPはorigin、method、program指定可能header、network policyを列挙する。redirectとproxyは初期版では無効とする。
- `limits`は既定値以下への減額だけを許し、compiler/ABI hard limitを増額しない。
- grant file bytesのhashとcanonical grant hashを保持する。

HTTP credential値はgrant JSONへ書きません。CLIでcredentialを使う場合は、origin・header名と環境変数名の対応だけを別のhost-only mappingから読み、値は開始直前に環境から取得して`HttpAdapter`へ渡します。evidenceには値、環境変数名、値hashを残さず、`credentialInjection: "host-provided-not-recorded"`と注入header名だけを残します。

### 2. 検査済みbundle execution snapshot

`src/llang-effects-bundle-inspection.ts`の処理を共有可能な内部snapshot APIへ分離します。

snapshotは次を一度に固定します。

- strict readerで検証済みmanifestとartifact bytes。
- flattened JSONCから再構築したchecked graph。
- `bundleIdentityHash`。
- bundled TypeScript/Wasmとの再生成一致。
- bundled Wasm bytesとmanifest states。

実行runtimeはbundled `wasm/program.wasm`とmanifestのstate契約を使用します。`runTypedEffectsGraph`のように実行直前にWasmを再emitして、そのbytesを実行してはなりません。

既存source graph用runtimeはテスト・開発用に維持し、共通coreを次の形へ分離します。

```text
runTypedEffectsSnapshot({
  graph,
  wasmBytes,
  states,
  grant,
  recorder,
  execute,
  openStream,
  ...
})
```

開始直前にbundleを再読してidentityを確認します。開始後はsnapshot bytesだけを使い、bundle pathを再参照して実行内容を変えません。最終reportには開始前identityと終了時の再読結果を分けて記録し、終了時にbundleが変わっていればexecution自体を捏造せず`bundleChangedAfterStart: true`として失敗扱いにします。

### 3. typed runtimeとEffectsSessionの統合

typed runtimeへversion付きrecording境界を追加します。linear runtimeの`EffectsSession`が持つrequest ID、generation、deadline、late response排除、grant再検査を再利用しますが、既存linear transcript契約を破壊しません。

typed executionでは次を記録します。

- 通常awaitは1 request/response。
- taskは内部`task.join`を外部operationとして記録せず、各childを独立requestとして記録する。
- task childは同じsession、異なるtask IDを持ち、完了順とjoin結果順を分ける。
- streamはopen request、各chunkのhash/bytes/eof、close/cancelを記録する。
- file writeはopen/write/commitまたはabortのcleanup結果を記録する。
- deadline、caller cancel、resource limit、Wasm faultを別原因で記録する。
- 古いgeneration、重複応答、取消後のlate responseはprogramへresumeせず、観測事実だけ記録する。

operation executorの例外を一律`internal`へ潰さず、host境界で次のcanonical outcomeへ分類します。

```text
ok
not-found
permission
connection
timeout
cancelled
invalid-response
resource-limit
internal
```

副作用を開始した可能性があり完了を観測できないtimeout、cancel、connection loss、crashは`certainty: "unknown"`とします。開始前拒否や確認済み失敗は`certainty: "known"`です。冪等性宣言があっても、このコマンドは自動retryしません。

### 4. redacted transcript

新しいtranscriptはversion 1のJSON Linesとし、1行1eventをstrict JSONで記録します。

各eventは少なくとも次を持ちます。

| field | 内容 |
| --- | --- |
| `sequence` | recorderが直列化した単調増加番号 |
| `kind` | intent/request/response/stream-chunk/cancel/cleanup/terminal |
| `requestId` | session/task/generation/sequenceからなるID |
| `state` | Wasm continuation state index |
| `operation` | operation IDとversion。内部joinは別表示 |
| `target` | fileは`file:<redacted>`、HTTPはoriginのみ |
| `payloadHash` | canonical wire payloadのhash。本文は含めない |
| `bytes` | 送受信・chunk byte数 |
| `outcome` | canonical error code、certainty |
| `previousHash` / `eventHash` | 順序付きhash chain |

request header値、credential値、HTTP path/query、fileの実root、payload本文、response本文、完全なError message、stack、絶対pathを禁止します。operation requestに秘密が含まれる可能性を考慮し、payloadは型付きwire bytesのhashとbyte数だけを記録します。

同じlogical eventからは同じevent bodyを作りますが、並行taskの実完了順や実時間は実行事実なのでrun間の同一hashを要求しません。

`eventHash`は、固定したgenesis hashを起点に、直前の`eventHash`と、`previousHash`・`eventHash`を除くcanonical event bodyから計算します。これによりeventの削除、追加、並べ替え、内容変更を検出します。

### 5. 耐久journalとcrash回収

証跡directoryは実行前に排他的に作成し、次の順で公開します。

1. bundle、grant、credential mapping、出力先、adapter rootのpreflightを完了する。
2. random owner tokenとprocess情報を持つ`execution.lock`を排他的に作成する。
3. `execution-intent.json`を排他的・原子的に作成し、file handleを`sync`する。
4. 空の`effects-transcript.jsonl`を排他的に作成し、固定したfile identityで開く。
5. requestをadapterへ渡す前にrequest eventをappendし、必要な耐久化を行う。
6. response、cancel、cleanup、terminal eventを単一writer queueでappendする。
7. transcriptを閉じてhash、行数、最終eventを再読検査する。
8. `effects-execution.json`を最後に排他的・原子的に公開し、所有lockだけを解除する。

output directory、intent、transcript、最終reportはdevice/inodeと通常file判定を追跡します。symlink、hard-link差し替え、truncate、追加書込み、directory置換を検出した場合、成功reportを返しません。

preflight中に失敗し、外部操作が0件なら、自分が作成してidentityが変わっていない空の出力だけをcleanupできます。intent公開後、または外部operationをdispatchした後は、失敗してもintentとjournalを再帰削除しません。証跡publicationの失敗を、実行がなかったことのように見せないためです。

evidence outputはbundle内部だけでなく、file adapter rootと相互に包含関係がある場所も拒否します。これにより実行対象programがfile operationで自分のintent/transcript/reportを書き換える経路を閉じます。

crash回収は次の制約を守ります。

- intentとtranscriptのhash chainを検査し、壊れた末尾を成功扱いしない。
- liveな所有processまたは一致するowner tokenがある間は回収を拒否し、通常実行と同時にfinalizeしない。
- stale lockの所有者、作成時刻、回収時刻をrecovery reportへ残す。
- requestがありresponseのないoperationを`unknown`とする。
- file temporaryやHTTP requestを推測で再開・再送・commitしない。
- recovery reportの`recovered`、`incompleteReason`、pending request一覧を明示する。
- すでに最終reportがあるdirectoryを上書きしない。

### 6. grant commitmentと公開summary

evidenceは実grantを次の二層で表します。

- `grantCommitmentHash`: credential値を除くcanonical private grant全体のhash。元grantを持つ検証者が一致を確認できる。
- `grantSummary`: operation、logical file権限、HTTP origin/method/header、wall clock、limitsの公開可能な構造。

`adapterRoot`の絶対pathとcredential mappingの環境変数名はsummaryへ含めません。grant commitmentは署名ではなく、単独でgrant発行主体を証明しません。

実行開始時と各dispatch時の両方でgrantを検査します。manifestに宣言されていてもgrantにないoperationは開始前に可能な範囲で拒否し、target依存のfile/HTTP権限はdispatch時にも再検査します。

### 7. resource evidence

`ResourceLedger`へread-only snapshotを追加し、limits、累計消費、現在値、peakを取得できるようにします。

最低限、次を記録します。

- hostRequests、tasks、sentBytes、receivedBytes、fuelの累計。
- concurrentIo、concurrentTasks、openResources、streamsのpeakと終了時現在値。
- Wasm memory pages、wire/chunk上限。
- deadline、開始から終了までのmonotonic duration。

終了時にrelease対象の現在値が0でなければcleanup failureです。値を0へ書き換えて成功扱いせず、未解放資源をreportへ残します。

### 8. 実行report契約

`effects-execution.json`は少なくとも次を含みます。

| 区分 | 内容 |
| --- | --- |
| 識別 | format/version、executionId、bundleIdentityHash、entry、ABI |
| bundle | manifest/artifact hash、inspection versionと結果 |
| grant | grant source hash、commitment hash、redacted summary |
| runtime | bundled Wasm hash、state contract、host runtime version |
| transcript | format/version、path、events、bytes、first/final hash |
| result | completed/failed/cancelled/incomplete、result type/hash、error code、certainty |
| resource | limits、used、peak、unreleased |
| cleanup | attempted、completed、failures、unknown outcomes |
| credential | accessed/not-needed、values:not-recorded |
| provenance | OS、arch、Bun、compiler/Binaryen/TypeScript versions |
| authenticity | evidenceHash、attestation:not-signed、retention:caller-managed |
| 制約 | host/service真正性、業務妥当性、rollbackを証明しない旨 |

result本文は初期版では保存せず、canonical typed valueのhash、type、encoded byte数だけを記録します。CLI JSONへもcredential、payload、response本文を出しません。

`evidenceHash`は最終report自身のhash fieldを除くcanonical reportと、intent hash、transcript hashから導出します。外部systemはこのhashを別の信頼経路へ保存できますが、この計画では署名済みとは表示しません。

### 9. CLIとembedding API

`module execute`で許可するoptionを固定します。

```text
--grant <effects-grant.json>
--out-dir <new-directory>
--credential-env <host-only-mapping.json>  # optional
```

未知option、重複、値欠損、余分な位置引数を終了2で拒否します。実行前のCLI errorはJSON stderrへ一つだけ出し、外部操作を開始しません。

embedding APIは、custom host operation executor、clock、stream、credential providerをin-memoryで注入できます。ただしrecorderを迂回するraw executorは公開しません。operation dispatchは必ずgrant、ledger、journalの順序を通ります。

CLIのHTTPは`HttpAdapter`のpublic network policyを明示grantした場合だけ有効にします。loopback/private addressは既存の明示address grantなしには許可しません。credential mapping fileはregular file・非symlink・size上限・strict JSONを要求します。

### 10. Binaryen・ABI境界

Binaryenは現行の`132.0.0`を維持します。新しい最適化pass、feature、memory layout、export、state loweringを追加しません。

実行対象は静的inspectionでbyte一致を確認したbundled Wasmです。`module.validate()`や`WebAssembly.validate()`だけを正当性の根拠にせず、reader、再生成比較、contract/state比較をpreflightに含めます。

実行証跡のためにWasm custom sectionやABIを変更しません。記録はhost境界で行い、`start/resume/cancel/dispose`の意味を維持します。emitterを変更しないことをWasm byte回帰テストで確認します。

## 検証と受け入れ条件

| ID | 検証 | 合格条件 |
| --- | --- | --- |
| EEE1 | inspect済みall-target bundleをexecute | bundled Wasm hash、bundle identity、result hash、transcript hashが一致 |
| EEE2 | sourceを削除してbundleを移動 | 同じgrantで実行でき、絶対bundle pathをevidenceへ含めない |
| EEE3 | grantのoperation不足 | 最初の外部操作前に拒否し、成功reportを作らない |
| EEE4 | file root/read/write/replace境界 | grant内だけ成功し、traversal・symlink・置換raceを拒否 |
| EEE5 | HTTP origin/method/header/address境界 | 各境界をdispatchと接続時に再検査し、redirect/retryしない |
| EEE6 | credential付きHTTP | hostが注入し、secret、値hash、env名がintent/transcript/report/errorに現れない |
| EEE7 | await成功・既知失敗 | request/response順、payload hash、result/errorが対応 |
| EEE8 | timeout・cancel・late response | generationを進め、resumeせず、certaintyを正しく記録 |
| EEE9 | task並行実行 | child requestと完了順を記録し、内部joinを外部grantとしない |
| EEE10 | stream複数chunk・early close | chunk hash/bytes/eof、上限、close/cancelを記録 |
| EEE11 | file write成功・失敗 | commitまたはabortを記録し、partial outputとcleanup結果を隠さない |
| EEE12 | resource limit | 実行を停止し、used/peak/unreleasedと原因を記録 |
| EEE13 | request後response前のcrash fixture | recoveryがpendingをunknownとし、外部操作を再実行しない |
| EEE14 | bundle・grant・出力の差し替え | fail-closed。所有しないfileを削除・上書きしない |
| EEE15 | evidence directoryとfile adapter rootの重なり | 開始前に拒否し、programからevidenceへ到達できない |
| EEE16 | CLI誤用・旧bundle・linear compatibility bundle | 終了2、外部操作0、既存inspect/verifyの契約不変 |
| EEE17 | hostile payload・Error・header・`__proto__` | データとして処理し、log injection、prototype汚染、secret漏えいなし |
| EEE18 | Binaryen/ABI回帰 | Binaryen 132、Wasm bytes、contract/state、既存runtime結果が不変 |

テストでは実networkを外部internetへ接続せず、loopback serverと固定DNS resolverを使います。credential leakageはsecret markerを全出力bytesから検索して確認します。crashはchild processをrequest記録後に停止するfixtureで再現し、recoveryが再dispatchしないことをcounterで確認します。

## 主な変更先

- 新規: `src/llang-effects-execution-grant.ts`
- 新規: `src/llang-effects-execution-evidence.ts`
- 新規: `src/llang-effects-transcript-writer.ts`
- 新規: `src/llang-effects-execution-recovery.ts`
- 新規: 対応する`.test.ts`とcrash fixture
- 更新: `src/llang-effects-bundle-inspection.ts`（共有snapshot/identity）
- 更新: `src/llang-effects-typed-runtime.ts`（bundled Wasm実行core、recorder統合）
- 更新: `src/llang-effects-session.ts`（typed request/task/stream記録用の共有境界）
- 更新: `src/llang-effects-contract.ts`（ledger snapshot/peak）
- 更新: `src/llang-io-file-adapter.ts`、`src/llang-io-http-adapter.ts`（cleanup/outcome観測）
- 更新: `src/llang-cli.ts`、CLI test
- 更新: `src/llang-effects-smoke.ts`
- 更新: `docs/LLANG_CLI_REFERENCE.md`、`docs/LLANG_MODULE_EFFECTS_SPEC.md`
- 更新: `examples/module-io-pipeline/README.md`

既存manifest version、source/suite schema、Wasm ABI、operation signature、static inspection report、Capability inspect、pure module profileを変更しません。新規runtime依存は追加せず、Node/Bun標準APIと既存部品で実装します。

## 実施順序

1. 現行typed bundle、runtime、adapter、grant、ledger、Wasm bytesを基準fixtureとして固定する。
2. grant schema/parserとredacted public projection、commitment hashを実装する。
3. inspectionからverified execution snapshotを抽出し、bundled Wasmを使うruntime coreを作る。
4. transcript event schema、hash chain、単一writer queue、secret検査を実装する。
5. awaitとhost operationをEffectsSessionへ接続し、timeout/cancel/late responseを固定する。
6. task、stream、file/HTTP adapter、cleanup、ledger peakを順に統合する。
7. intentの事前耐久化、最終report公開、crash fixture、recoveryを実装する。
8. CLI、embedding API、出力先とadapter rootの隔離を接続する。
9. document、example、smokeを更新し、EEE1〜EEE18と全体回帰を実行する。

各段階で既存`runTypedEffectsGraph`、typed suite replay、`module inspect`、`module verify`を回帰確認します。task/streamを後回しにした途中状態を完成扱いしません。

## 品質Gate

局所検証は少なくとも次を含めます。

```sh
bun test src/llang-effects-execution-*.test.ts src/llang-effects-typed-runtime.test.ts src/llang-effects-session.test.ts src/llang-module-effects-graph.test.ts --timeout 30000
bun run ci:docs
git diff --check
```

最終検証は指定Bun 1.4.2で行います。

```sh
bunx bun@1.4.2 run check
bunx bun@1.4.2 run ci:docs
bunx bun@1.4.2 run ci:protected
bunx bun@1.4.2 run ci:smoke
```

coverage、Ubuntu、macOS、Windowsは既存CI matrixで確認します。ローカル結果とremote CIを区別して報告します。Binaryen `132.0.0`、TypeScript `5.9.3`、compiler `0.1.0-dev.1`をlockfileと実成果物で再確認します。

## 対象外と後続計画

今回の対象外は次です。

- 自然言語要求と実行結果の業務的な正しさの判定。
- 外部serviceが実際に副作用を確定したことの第三者証明。
- 自動retry、exactly-once、分散transaction、補償transaction。
- 実行後の副作用rollback。
- credential値、payload本文、response本文のevidence保存。
- Ed25519等の署名鍵管理、証明書、trust store、remote attestation。
- evidenceの暗号化、remote upload、保存期限の自動削除。
- 任意host extensionをCLI設定だけで動的loadする仕組み。
- 新しいWasm最適化、ABI、manifest/source/suite version。

後続候補は、`evidenceHash`を組織またはhost identityの署名へ結び付け、公開鍵のtrust policy、key rotation、timestamp authority、保存・削除policyを扱う「Effects署名付きattestation」です。unsigned evidenceを署名済み、監査済み、安全性証明済みとは表示しません。

## 完了報告で示すもの

- EEE1〜EEE18の結果と対応test。
- 成功、既知失敗、unknown、cancel、crash recoveryのevidence例。
- 実行したWasm bytesと静的inspection対象bytesの一致。
- grant commitment、redacted summary、transcript/result/resource hashの対応。
- credential markerが全成果物へ現れない検査。
- bundle/output差し替えとadapter root重複を拒否した証拠。
- Bun、TypeScript、Binaryen、OS、実行コマンド、coverage、CI matrix。
- `attestation:not-signed`、`retention:caller-managed`、外部副作用rollback不可という制約。

「外部操作が業務的に正しい」「副作用が必ず一度だけ起きた」「実行hostの本人性を証明した」「失敗した副作用を取り消した」とは報告しません。
