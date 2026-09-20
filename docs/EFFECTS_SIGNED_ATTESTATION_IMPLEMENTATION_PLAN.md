# Effects署名付きattestationとtrust policyの実装計画

作成日: 2026-09-20。状態: 実装済み。前段は[要求に結び付くEffects実行監査](./EFFECTS_REQUIREMENT_AUDIT_IMPLEMENTATION_PLAN.md)で、実装結果は[要求に結び付くEffects実行監査の結果](./EFFECTS_REQUIREMENT_AUDIT_IMPLEMENTATION_RESULTS.md)です。今回の結果は[実装結果](./EFFECTS_SIGNED_ATTESTATION_IMPLEMENTATION_RESULTS.md)に記録します。

## 目的

`module-effects-v1`では、要求契約、bundle identity、実grant、実行前intent、redacted transcript、実行report、事後auditを一つのhash chainとして照合できます。しかし、現在の成果物は`attestation: not-signed`であり、次を確認できません。

- 要求契約を、実行前にどの主体が承認したか。
- execution evidenceを、どのhostが発行したか。
- audit reportを、どの監査者が発行したか。
- その署名鍵を、検証者がどの役割として信頼しているか。

この計画では、既存chainへEd25519のdetached signatureとstrictなtrust policyを追加します。要求承認者、実行host、監査者を別のroleとして扱い、検証者が独立して渡したpolicyだけをtrust rootにします。

署名は自然言語要求の正しさ、bindingの意味的同値性、外部serviceの正しさ、host OSの健全性を証明しません。署名が示すのは、特定の鍵を持つ主体が、明示されたbytesとcommitmentを署名したことだけです。

## 到達点

署名付き経路は次の順で実行します。

```text
bun run llang module attestation-keygen \
  --out-dir <new-key-directory> --json

bun run llang module approve-requirements <module-build.json> \
  --requirements <effects-requirements.json> \
  --signing-key <requester-private-key.pem> \
  --out <new-requirement-approval.json> --json

bun run llang module execute <module-build.json> \
  --grant <effects-grant.json> \
  --requirements <effects-requirements.json> \
  --approval <requirement-approval.json> \
  --trust-policy <effects-trust-policy.json> \
  --host-signing-key <host-private-key.pem> \
  --out-dir <new-evidence-directory> --json

bun run llang module audit-execution <module-build.json> \
  --requirements <effects-requirements.json> \
  --evidence <evidence-directory> \
  --trust-policy <effects-trust-policy.json> \
  --require-attestation \
  --out-dir <new-audit-directory> --json

bun run llang module attest-audit <module-build.json> \
  --requirements <effects-requirements.json> \
  --audit <audit-directory> \
  --trust-policy <effects-trust-policy.json> \
  --signing-key <auditor-private-key.pem> \
  --out-dir <new-attestation-package> --json

bun run llang module verify-attestation <module-build.json> \
  --requirements <effects-requirements.json> \
  --package <attestation-package> \
  --trust-policy <effects-trust-policy.json> --json
```

`verify-attestation`はWasm、TypeScript projection、adapter、network、credential、外部APIを実行しません。bundleの静的inspection、要求契約、実行証跡、監査report、三つの署名、trust policyだけを再検査します。

署名付き経路はversion 3のintent/reportを使います。既存の要求なしversion 1、要求付きunsigned version 2、既存CLIは互換のまま維持します。version 2を署名済みと推測したり、欠けた署名をversion 3として補完したりしません。

## なぜ三段階の署名にするか

最終audit reportだけへ署名すると、監査者が後から見たchainを承認したことは示せますが、要求が実行前に正当な依頼者から承認されていたことは示せません。execution reportだけへ署名しても、そのhostがどの要求に基づいて実行したかを信頼済みrequesterへ結び付けられません。

そのため、次の三つを分離します。

| role | 署名時点 | 署名対象 | 示すもの |
| --- | --- | --- | --- |
| `requirement-approver` | dispatch前 | 要求契約、authority ceiling、bundle identity | この鍵の主体がこの要求と上限を承認した |
| `execution-host` | 最終reportまたは回収report公開前 | approval、intent、transcript、execution report | この鍵の主体がこの実行証跡を発行した |
| `auditor` | 非実行audit後 | 要求、bundle、evidence、audit report、policy commitment | この鍵の主体がこの監査成果物を発行した |

同じ鍵が複数roleを兼ねてよいかはtrust policyで決めます。既定例は`distinctRoleKeys: true`とし、requester、host、auditorの鍵を分離します。

## 保証境界

### 確認するもの

- Ed25519 signatureが、domain separation付きcanonical payloadに一致すること。
- key IDが公開鍵SPKI bytesから決定的に導出されること。
- requirement approvalが、実行前intentに固定された要求・bundle・authorityへ一致すること。
- execution attestationが、approval、intent、transcript、最終または回収reportへ一致すること。
- audit attestationが、audit reportとchain全体のcommitmentへ一致すること。
- 各key IDが、検証者のtrust policyで対応roleに許可されていること。
- revoked key、role不一致、署名欠損、policy commitment不一致をfail-closedで拒否すること。

### 確認しないもの

- 秘密鍵を保持した端末、process、OSが侵害されていないこと。
- 公開鍵の所有者が現実世界の誰であるか。identity proofingはpolicy作成者の責任です。
- 署名時刻の正確性、第三者timestamp、署名後の即時失効通知。
- 一つのapprovalが別の同一bundle・同一要求の実行へ再利用されていないこと。
- remote attestation、TPM、Secure Enclave、HSM、KMSによる鍵保護。
- 自然言語要求、業務結果、外部副作用の正しさ。

offline fileだけでは信頼できる署名時刻や全実行を横断する一回限り利用を証明できません。初期versionでは`issuedAt`やnonceをsecurity decisionへ使わず、anti-replay ledgerとtimestamp authorityは後続へ分離します。

## 暗号形式

### algorithmとkey ID

algorithmは`Ed25519`だけを受理します。RSA、ECDSA、algorithm negotiation、暗黙のdefaultは追加しません。Node/Bun標準`node:crypto`を使い、新しいruntime依存は追加しません。

公開鍵はDER encoded SubjectPublicKeyInfoをcanonical Base64で保持します。key IDは次で固定します。

```text
keyId = "ed25519:" + sha256(spkiDerBytes)
```

key IDを利用者が任意指定する経路は作りません。policy読込時と署名検証時に公開鍵から再計算します。

### 署名bytes

JSON文字列そのものではなく、strict parse済みpayloadの`stableJson`へdomain separationを付けたUTF-8 bytesを署名します。

```text
"L-Lang Effects Attestation\0" + artifact-kind + "\0" + version + "\0" + stableJson(payload)
```

署名envelopeは共通して次を持ちます。

```json
{
  "format": "llang-effects-signature",
  "version": 1,
  "artifactKind": "requirement-approval",
  "algorithm": "Ed25519",
  "keyId": "ed25519:...",
  "payload": {},
  "payloadHash": "...",
  "signature": "canonical-base64"
}
```

未知field、重複key、非canonical Base64、Ed25519以外の鍵、過大payload、NULを含む識別子を拒否します。署名検証前にpayloadのstrict shapeと全hash形式を検査します。

## 鍵生成と秘密鍵の扱い

`module attestation-keygen`は新しいdirectoryだけを作り、次を排他的に公開します。

```text
private-key.pem
public-key.json
```

- private keyはPKCS#8 PEM、public keyはSPKI DER Base64とkey IDを持つstrict JSON。
- POSIXではprivate keyを`0600`、directoryを`0700`で作成し、より広いpermissionの既存鍵を署名時に拒否する。
- WindowsではPOSIX modeを保証済みと表示せず、ACL管理を利用者責任として明示する。
- symlink、複数hard link、既存出力、読取中のinode・size変更を拒否する。
- private key path、PEM、環境変数名、署名入力の秘密値をreport、error、transcriptへ記録しない。
- private key bytesは`KeyObject`作成後にbest-effortでzero-fillするが、JS runtimeやOS内部の完全消去は保証しない。

test用固定鍵はproduction exampleと分離したfixtureに置き、実運用鍵として使用できないことを明記します。

## trust policy

検証者が独立して渡すstrict JSON `llang-effects-trust-policy` version 1を追加します。

```json
{
  "format": "llang-effects-trust-policy",
  "version": 1,
  "id": "local-effects-production",
  "revision": 1,
  "keys": [
    {
      "keyId": "ed25519:...",
      "algorithm": "Ed25519",
      "publicKeySpki": "..."
    }
  ],
  "roles": {
    "requirementApprovers": ["ed25519:..."],
    "executionHosts": ["ed25519:..."],
    "auditors": ["ed25519:..."]
  },
  "revokedKeyIds": [],
  "rules": {
    "distinctRoleKeys": true,
    "allowReviewRequired": false,
    "allowRecoveredExecution": true
  }
}
```

policyはstable regular fileとして読み、unknown field、重複key、非正規順序、重複key ID、公開鍵とkey IDの不一致、roleに存在しない鍵、role間重複違反、activeとrevokedの重複を拒否します。

trust policy自身をrepository内の別fileが自動的に信頼させる仕組みは作りません。呼出し元が安全な経路で現在の検証policyを選ぶことがroot of trustです。verification reportはpolicy ID、revision、source hash、canonical commitmentを記録し、別policyへの差し替えを可視化します。

signed executionでは、dispatch前に使用したpolicy bytesを`issuance-trust-policy.json`としてevidence directoryへcopyし、そのcommitmentをintentへ固定します。これは実行時にどのpolicyでrequesterとhostを許可したかを再現するための記録であり、packageへ同梱されたpolicyを現在のtrust rootへ昇格させるものではありません。

検証時は、同梱されたissuance policyと、呼出し元が`--trust-policy`で渡すcurrent policyを分けます。

- issuance policy: 実行前判定の再現、policy ID・revision・commitmentの照合に使う。
- current policy: 現時点のrole、revocation、許容statusを決める唯一のtrust root。

同じpolicy IDを要求し、current revisionがissuance revision未満ならrollbackとして拒否します。current revisionが新しければ、現在のkey/role/revocation rulesで署名を再評価します。

### rotationとrevocation

初期versionのrotationはpolicy revisionで表現します。

1. 移行中policyへ旧鍵と新鍵を同じroleで登録する。
2. 発行側を新鍵へ切り替える。
3. 次のpolicy revisionで旧鍵をroleから外すか`revokedKeyIds`へ入れる。

現在policyでrevokedになった鍵の署名は、過去の署名時刻を主張しても拒否します。過去時点の判断を再現する場合は、当時のpolicy bytesを別途保存して検証します。これはcurrent trustとhistorical trustが同じであることを意味しません。

## requirement approval

`llang-effects-requirement-approval` version 1のpayloadは少なくとも次を固定します。

- requirements ID、revision、source hash、canonical commitment。
- authority ceiling commitment。
- bundle identity、entry、profile、ABI、bundled Wasm hash。
- requirement coverageと許容terminal status。
- approvalのsemantic meaningは`not-proven`。

`approve-requirements`はbundleを静的inspectionし、要求契約のidentityとbindingを再検査してから署名します。Wasm、projection、adapter、networkは実行しません。要求本文を署名envelopeへ複製せず、commitmentだけを署名します。

署名鍵がtrust policyに含まれるかは承認作成時の必須条件にしません。署名作成と、ある検証者がその鍵を信頼するかは分離します。

## signed execution evidence version 3

`module execute`で`--approval`、`--host-signing-key`、`--trust-policy`の一部だけを指定した場合はCLI誤用として終了2にします。三つを指定したsigned modeでは、dispatch前に次を行います。

1. bundle、requirements、grant、credential mappingを既存どおり検査する。
2. issuance trust policyのstrict shape、approver role、host key roleを検証する。
3. approval署名の暗号的整合性をpolicy内の公開鍵で検証する。
4. approval payloadを要求契約、bundle、authority ceilingへ照合する。
5. 検証済みapprovalとissuance policyをevidence directoryへcopyする。
6. approval hash、approver key ID、issuance policy commitmentを含むversion 3 intentを耐久化する。
7. その後にだけ外部operationをdispatchする。

signed evidence directoryは少なくとも次を持ちます。

```text
requirements-approval.json
issuance-trust-policy.json
execution-intent.json
effects-transcript.jsonl
effects-execution.json
execution-attestation.json
```

完了時はversion 3 execution reportと`execution-attestation.json`を作ります。署名payloadは次を含みます。

- execution ID、normal/recovered phase。
- requirement approval file hash、payload hash、approver key ID。
- intent file hash。
- bundle、requirements、grant commitment。
- transcript file hash、final hash、event count。
- execution report hashと既存evidence hash。
- result status、certainty、cleanup、resource summaryのcommitment。

execution reportを最終公開した後で署名だけ失敗すると、unsignedなversion 3 directoryが残ります。その状態を成功としません。version 3の`recover-execution --trust-policy --host-signing-key`は、既存reportを上書きせず厳密に再検査し、`phase: recovery-after-report`のattestationだけを補完できます。秘密鍵なしで署名を捏造したり、version 2へdowngradeしたりしません。

### crash recovery

version 3 recoveryは既存の非replay原則を維持します。

- requestを再送しない。
- Wasmを再開しない。
- file commitを再試行しない。
- pending requestを`unknown`にする。
- requirement approval hashを保持する。
- `--trust-policy`と`--host-signing-key`を明示した回収者がrecovery phaseを署名する。

最終reportがないcrashでは`phase: recovery-incomplete`、`status: incomplete`、`replayedOperations: 0`を署名対象へ固定します。最終reportだけがありattestationがないcrashでは、reportを変更せず`phase: recovery-after-report`として署名します。どちらも「元processが正常終了した」ことを示しません。policyの`allowRecoveredExecution: false`なら、暗号署名が正しくてもtrusted statusを拒否します。version 1/2の「既存reportがあれば回収拒否」という契約は変更しません。

## 署名検証付きaudit

`audit-execution --trust-policy --require-attestation`は既存のmachine auditに先立ち、または同じsingle-snapshot内で次を検査します。

1. issuance policyのstrict shape、intent commitment、実行時role判定。
2. current trust policyのstrict shapeと、同一ID・revision rollback検査。
3. requirement approval署名と、current policyの`requirement-approver` role。
4. version 3 intent/reportとapprovalの一致。
5. execution attestation署名と、current policyの`execution-host` role。
6. 既存のbundle、requirements、grant、transcript、result、resource、cleanup監査。
7. distinct role、revocation、review-required、recovered executionに関するcurrent policy rule。

署名が正しくても既存auditが`failed`なら成功へ昇格させません。`review-required`をpolicyが禁止する場合は、暗号検査成功とは別にtrust decisionを`rejected`にします。

audit reportへ次を追加します。

```text
trust.policy.id
trust.policy.revision
trust.policy.commitmentHash
trust.issuancePolicy.revision
trust.issuancePolicy.commitmentHash
trust.requirementApprover
trust.executionHost
trust.signatureChecks
trust.decision = trusted | rejected | not-evaluated
```

既存のunsigned auditは`trust.decision: not-evaluated`相当であり、trustedとは表示しません。

signed modeの`audit-execution --out-dir`は既存のprojection、transcript、execution report、audit reportに加え、検証済みの`requirements-approval.json`、`issuance-trust-policy.json`、`execution-intent.json`、`execution-attestation.json`を同じ新規audit directoryへcopyします。`attest-audit`はこの自己完結したaudit directoryを実行証跡入力として再検査でき、元のevidence directoryへ暗黙に戻りません。

## audit attestationと最終package

`attest-audit`は既存audit directoryを上書きせず、新しいpackage directoryへ検査済みbytesをcopyして最後に`audit-attestation.json`を公開します。

```text
program.inspection.ts
requirements-approval.json
issuance-trust-policy.json
execution-intent.json
effects-transcript.jsonl
effects-execution.json
execution-attestation.json
execution-audit.json
audit-attestation.json
```

auditor payloadは各file hash、要求・bundle・grant・evidence・audit commitment、issuance/current trust policy commitment、audit status、trust decisionを固定します。署名は`passed`を意味しません。`failed`または`review-required`のauditも、状態を変えずに署名できます。

`attest-audit`は署名前にcurrent policyを再読込し、指定private keyから導出したkey IDが`auditor` roleとして現在も許可され、revokedでないことを要求します。role不一致の鍵で「署名自体は作れる」経路を公開CLIへ残しません。

`verify-attestation`はpackageをstrictに読み、bundleとrequirementsを再inspectionし、全file hash、全署名、全role、policy rule、既存semantic auditを再実行します。packageに含まれるpolicyや公開鍵を自動的にtrust rootとして採用しません。

## statusと終了値

暗号検査、machine audit、policy decisionを一つのbooleanへ潰しません。

| 項目 | 値 |
| --- | --- |
| `signatureStatus` | `valid`、`invalid`、`missing` |
| `auditStatus` | `passed`、`review-required`、`failed` |
| `trustDecision` | `trusted`、`rejected`、`not-evaluated` |

CLI終了値は次とします。

- 0: 入力を安全に検査でき、必要な署名がvalid、auditがpolicyで許容され、trust decisionが`trusted`。
- 1: 整合した入力からinvalid signature、untrusted role、revocation、audit failure、policy rejectionを判定。
- 2: CLI誤用、不正JSON、unsupported version/algorithm、危険なfile、I/O・出力失敗。

invalid signatureをparser errorとして隠さず、malformed signatureとの違いをreportへ残します。ただし秘密鍵path、PEM、credential、payload本文、絶対pathはdiagnosticへ出しません。

## file境界と競合

既存のstable file、single snapshot、排他的directory公開を再利用します。

- private/public key、policy、approval、evidence、audit、packageのsymlinkを拒否する。
- private keyとpolicyは複数hard linkを拒否する。
- 入力同士または出力との包含・重なりを拒否する。
- 署名直前と公開後に対象fileのdevice、inode、size、hashを再検査する。
- directoryが差し替えられた場合、所有していないreplacementを削除しない。
- signature fileを最後にlinkし、途中packageを完成済みとして見せない。

署名対象を読んだ後の差し替え、署名後で公開前の差し替え、検証中のpolicy差し替えを個別に故障注入します。

## 実装単位

### PR-1: 暗号primitive、鍵形式、keygen

- `src/llang-effects-attestation-crypto.ts`を追加。
- Ed25519 key import/export、key ID、domain-separated sign/verify。
- canonical Base64、strict signature envelope、固定test vector。
- exclusive key directory、permission、stable key read。

### PR-2: trust policyとrequirement approval

- `src/llang-effects-trust-policy.ts`を追加。
- strict policy parser、role、revocation、distinct-role検査。
- `src/llang-effects-requirement-approval.ts`を追加。
- `attestation-keygen`と`approve-requirements` CLI。

### PR-3: version 3 signed executionとrecovery

- approval preflightとversion 3 intent/report。
- execution host attestationの最終公開。
- normal、failed、cancelled、crash recoveryの署名。
- v1/v2互換とdowngrade拒否。

### PR-4: trust-aware audit

- 既存auditへ署名・role・policy decisionを統合。
- unsigned、invalid、revoked、role mismatchを区別。
- machine audit statusを署名で上書きしない。
- verifier境界でWasm、adapter、network、credential access 0を固定。

### PR-5: audit attestationとportable verification

- `attest-audit`の新規package公開。
- `verify-attestation`によるfull-chain offline verification。
- relocation、source削除、policy差し替え、package差し替え試験。

### PR-6: example、smoke、仕様、運用文書

- `examples/module-io-pipeline`へ三roleのlocal fixture例を追加。
- effects smokeでkeygen fixture、approval、signed execution、audit、final verifyを一往復。
- CLI reference、Effects仕様、roadmap、docs index、SECURITYを更新。
- key rotation、revocation、鍵紛失、Windows ACL、backupのrunbookを追加。

PRは依存順に分けられますが、version 3を発行して検証・回収できない中間状態は公開しません。PR-3〜PR-5は同じreleaseで有効化します。

## 受け入れ条件

| ID | 検証 | 合格条件 |
| --- | --- | --- |
| ESA1 | Ed25519固定vector | key ID、payload hash、signature、verifyがBunの対象OSで一致 |
| ESA2 | requirement approval | 要求、authority、bundleの全commitmentが一致した場合だけ作成・受理 |
| ESA3 | signed option不足 | approval、host key、policyの一部だけならdispatch 0、終了2、version 3証跡なし |
| ESA4 | signed normal execution | approvalをintentへ固定し、host signature付きcompleted reportを公開 |
| ESA5 | failed/cancelled execution | statusとcertaintyを変えずに署名し、成功へ昇格しない |
| ESA6 | signed crash recovery | pendingはunknown、replay 0、report有無に応じた二つのrecovery phaseを署名 |
| ESA7 | artifact別tamper | approval、intent、transcript、report、auditの各1 byte変更でverify失敗 |
| ESA8 | hash再計算を伴う改変 | 秘密鍵なしの再hashではsignature検証を通過しない |
| ESA9 | wrong role | 有効署名でもrole未許可ならtrust decisionはrejected |
| ESA10 | distinct role | policyが分離を要求すると同じ鍵のrole兼務を拒否 |
| ESA11 | rotation | issuance policyを保持しつつ、旧新併存current policyでは双方を受理し、次revisionで除外した旧鍵を拒否 |
| ESA12 | revocation | revoked keyの署名はpayloadと署名が正しくても拒否 |
| ESA13 | policy replacement | issuance policy変更、current policy rollback、commitment違い、package内policyの自己信頼を拒否 |
| ESA14 | relocation | source削除後にbundle、requirements、package、policyを移動してverify成功 |
| ESA15 | hostile input | unknown field、duplicate key、bad Base64、wrong key type、oversizeをfail-closed |
| ESA16 | secret非漏えい | private key、path、PEM、credential、payload、HTTP path/queryを成果物・errorへ含めない |
| ESA17 | file attack | key/policy/packageのsymlink、hard link、置換、既存出力を安全に拒否 |
| ESA18 | audit/policy分離 | `review-required`や`failed`を署名で`passed`または`trusted`へ変えない |
| ESA19 | offline verifier | Wasm実行、projection eval、adapter、network、credential、API呼出0 |
| ESA20 | compatibility | unsigned v1/v2、ABI、Binaryen、Wasm bytes、既存smokeの結果不変 |

署名時刻、one-time approval、remote key statusはこの受け入れ条件に含めません。それらを検証していないのにfreshnessやanti-replayを合格表示しないこと自体を回帰試験で固定します。

## test構成

- `src/llang-effects-attestation-crypto.test.ts`: 固定vector、鍵形式、Base64、domain separation。
- `src/llang-effects-trust-policy.test.ts`: role、rotation、revocation、policy strictness。
- `src/llang-effects-execution-audit.test.ts`: approval binding、normal/failure/cancel、recovery、tamper、full chain、package、relocation、policy decision、境界0回。
- 既存`llang-effects-execution-evidence.test.ts`: v1/v2互換。

private key fixtureはtestから外部へexportせず、exampleとproduction runbookでは毎回新しい鍵を生成します。暗号primitiveの正しさを独自実装で再現せず、標準APIの固定vectorと負例で境界を検査します。

## 品質Gate

対象testの後、Bun 1.4.2で次を実行します。

```sh
bunx bun@1.4.2 run check
bunx bun@1.4.2 run ci:docs
bunx bun@1.4.2 run ci:protected
bunx bun@1.4.2 run ci:smoke
```

GitHub ActionsのUbuntu、macOS、Windowsで、同じrevisionのEd25519 vector、permission分岐、改行、path、rename動作を確認します。POSIX permission検査をWindowsで成功したと誤表示せず、platform固有の保証をreportへ記録します。

既存のWasm emitter、Binaryen pass、typed wire、session ABI、operation registry、grant semanticsは変更しません。署名機能によってWasm bytesが変わらないことをgolden回帰で確認します。

## セキュリティレビュー項目

- algorithm confusionとkey type confusionがないか。
- domain separationがartifact kindとversionを跨いで再利用されないか。
- policy内の公開鍵とkey IDが一致するか。
- canonicalization差、Unicode、duplicate key、Base64別表現が署名解釈を分岐させないか。
- TOCTOU、symlink、hard link、directory replacementで別bytesを署名・公開しないか。
- private keyがdiagnostic、stack、JSON output、transcriptへ出ないか。
- valid signatureをsemantic correctnessや安全性証明と表示していないか。
- revoked key、wrong role、recovered execution、manual requirementがpolicyどおり扱われるか。
- package自身が同梱するkeyやpolicyをroot of trustへ昇格させていないか。

実装後は通常のコードレビューに加え、暗号境界だけを対象にした独立レビューを行います。

## 完了後も残るもの

- timestamp authorityと信頼できる署名時刻。
- approvalの一回限り利用を保証する共有ledger。
- HSM、KMS、TPM、Secure Enclave、remote attestation。
- certificate chain、組織identity proofing、OCSP等のremote revocation。
- remote evidence store、暗号化、retention・削除policyの自動執行。
- 鍵漏えい時の全package探索、再署名、事故対応automation。
- 自然言語要求とstructured contractの意味評価。
- prompt/data分離のadversarial評価、人間監査、通常TypeScript baseline比較。
- SAAAまたは同等hostでの実domain受け入れ・配備・切戻し。

署名付きattestationをremote attestation、秘密鍵保護、freshness、anti-replayまで完成した仕組みとは呼びません。

## コンセプト全体の現在地

現在は要求から実行監査までのidentity chainが成立していますが、発行主体は未認証です。本計画を完了すると、メインコンセプトの中核技術縦断は概ね85〜90%まで進む見込みです。

研究実証は署名だけでは大きく進みません。人間が監査資料を正しく読めるか、外部データの命令を阻止できるか、通常TypeScript方式より何が改善するかは別の実験が必要です。実運用・製品化も、鍵保護、remote storage、retention、SAAA統合なしでは限定的です。

本計画後の大きな作業単位は次です。

1. trustする要求と外部データを分離するadversarial評価。
2. TypeScript事後監査の人間評価と通常TypeScript baseline比較。
3. SAAAまたは同等hostでの受け入れ・配備・切戻し。
4. timestamp、anti-replay ledger、remote key管理、retentionを含む運用基盤。

## 完了報告で示すもの

- ESA1〜ESA20と対応test。
- requirement approver、execution host、auditorの異なるkey ID。
- requirement approvalからaudit attestationまでのhash/signature chain。
- tamper、再hash、wrong role、revocation、rotation、policy replacementの負例。
- normal、failed、cancelled、recovered executionの署名結果。
- unsigned v1/v2互換、Wasm bytes、ABI、Binaryen回帰。
- private key、credential、payload、絶対pathが成果物へ出ない検査。
- Bun、Node crypto、OS、実行コマンド、coverage、CI matrix。
- `semanticMeaning: not-proven`、`remoteAttestation: not-provided`、`freshness: not-proven`、`antiReplay: not-provided`という制約。

「署名者の現実世界identityを証明した」「hostが侵害されていない」「要求や業務結果が正しい」「署名時刻が正しい」「approvalを再利用できない」とは報告しません。
