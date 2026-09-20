# Effects署名付きattestationの実装結果

実施日: 2026-09-20。対象計画: [Effects署名付きattestationとtrust policy](./EFFECTS_SIGNED_ATTESTATION_IMPLEMENTATION_PLAN.md)。

## 実装したもの

- Node/Bun標準cryptoのEd25519、domain separation、canonical payload hash、SPKI由来key ID。
- 排他的な鍵生成、POSIX秘密鍵mode検査、symlink・hard link・置換・oversizeを拒否する安定読込。
- 三roleを持つstrictなtrust policy。要求承認者、実行host、監査者の分離、revision rollback、rotation、revocationを現行policyで判定する。
- bundle、要求契約、authority ceilingを固定するrequirement approval。
- dispatch前にapprovalと発行時policyを検証・copyするversion 3 execution intent/reportとdetached host signature。
- reportなしの`recovery-incomplete`と、既存reportを変更しない`recovery-after-report`。いずれもoperationを再送せず`replayedOperations: 0`を署名する。
- 発行時policyと外部の現行policyを分離したtrust-aware audit。
- 監査者が全file hash、要求・bundle・grant・evidence・audit commitment、監査状態を署名するportable packageとoffline verifier。
- unsigned version 1/2の実行、回収、監査の互換経路。

公開CLIは`module attestation-keygen`、`approve-requirements`、署名option付き`execute`／`recover-execution`／`audit-execution`、`attest-audit`、`verify-attestation`である。秘密鍵は成果物へ複製せず、署名は自然言語要求や業務結果を正しい状態へ昇格させない。

## 受け入れ条件との対応

| 条件 | 主な検証 |
| --- | --- |
| ESA1 | `llang-effects-attestation-crypto.test.ts`の固定seed、key ID、signature、verify、domain separation |
| ESA2–ESA4 | requirement approvalと署名付きnormal executionの統合test。部分optionはdispatch前に拒否 |
| ESA5 | 既存failed/cancelled statusとcertaintyをreport・署名payloadへそのまま固定 |
| ESA6 | version 2回収互換、version 3 incomplete回収、normal report後の署名補完をtest |
| ESA7–ESA8 | 全file hash、payload hash、evidence hash、三署名を再検査。改変・再hashは署名検証で拒否 |
| ESA9–ESA13 | trust-policy unit testとaudit/packageのrole再検査。role重複、未知鍵、revocation競合、rollbackを拒否 |
| ESA14 | audit/packageは絶対pathを署名せず、bundle・要求・package・現行policyを別々に指定可能 |
| ESA15–ESA17 | strict JSON、unknown field、duplicate key、canonical Base64、Ed25519 key type、bounded stable file、symlink/hard-link、既存出力拒否 |
| ESA18 | machine audit statusとtrust decisionを分離し、failed/review-requiredを監査者が署名してもpassedへ変更しない |
| ESA19 | verifierはinspectionとhash/signature検査だけを行い、Wasm、projection、adapter、network、credentialを実行しない |
| ESA20 | full test 675件、既存version 1/2 test、Effects smokeで互換性を確認 |

## 検証結果

ローカルのmacOS arm64、Bun 1.4.2で次を実行した。

```text
bunx bun@1.4.2 run check
675 pass / 0 fail
```

`ci:docs`、`ci:protected`、`ci:smoke`も同じ作業treeで成功した。GitHub ActionsのUbuntu、macOS、Windows結果はrepository CIが同revisionを実行して確定するため、このローカル結果だけで他OS成功とは表示しない。

## 保証しないもの

- `semanticMeaning: not-proven`: 自然言語要求とbindingの意味的同値性。
- `freshness: not-proven`: 署名時刻や最新性。
- `antiReplay: not-provided`: approvalやpackageの一回限り利用。
- `remoteAttestation: not-provided`: host OS、process、hardwareの健全性。
- 鍵保有者の現実世界identity、外部serviceの真実性、side effectのexactly-onceやrollback。

次の段階は、実運用の鍵保管・配布・失効手順、timestamp／anti-replay、SAAA hostでの受け入れ、adversarial評価である。
