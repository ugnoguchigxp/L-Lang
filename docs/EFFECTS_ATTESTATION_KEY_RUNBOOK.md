# Effects attestation鍵運用runbook

更新: 2026-09-20。対象は[署名付きattestation実装](./EFFECTS_SIGNED_ATTESTATION_IMPLEMENTATION_PLAN.md)。

## 原則

- requirement approver、execution host、auditorは別鍵にする。秘密鍵をrepository、evidence、audit、package、backup logへ入れない。
- `attestation-keygen`が作る`private-key.pem`はPOSIXでmode 0600。Windowsでは所有者だけが読めるACLを運用側で設定し、ACLを検査できていない状態をPOSIX相当と表示しない。
- current policyは検証者が安全な別経路で選ぶ。package内の発行時policyをcurrent trust rootにしない。
- policy更新はrevisionを単調増加させ、同じpolicy IDを維持する。古いrevisionへのrollbackを許可しない。

## rotation

1. 新鍵を生成し、秘密鍵のbackupと復旧試験を完了する。
2. revisionを上げ、旧鍵と新鍵を同じroleへ一時的に登録する。`distinctRoleKeys`を有効にしたまま他roleと共有しない。
3. 発行側を新鍵へ切り替え、signed execution、audit、package verificationを一往復する。
4. 利用者へのcurrent policy配布を確認してから、次revisionで旧鍵をroleから外す。
5. 過去判断を再現する必要があれば当時のpolicy bytesを履歴として保持する。ただし現在もtrustedという意味には使わない。

## revocationと紛失

漏えい、紛失、誤配布が疑われた鍵は新revisionの`revokedKeyIds`へ入れ、全roleから外す。新しいcurrent policyではその鍵の過去署名もtrustedにしない。必要なら未失効時点のpolicyでhistorical verificationを別表示する。秘密鍵を失ったhostは既存reportへの`recovery-after-report`署名を作れないため、別host鍵へ勝手に置き換えず未署名のversion 3証跡として隔離する。

## backupと廃棄

秘密鍵backupは暗号化し、role別にアクセス制御し、復旧時にもfile permission／ACLを再設定する。backupの所在と復旧試験日は署名packageとは別の運用台帳へ記録する。廃棄はpolicyからの除外・revocationを先に配布し、保持期間を満たしたbackupを組織の媒体廃棄手順で処理する。L-LangはHSM、KMS、timestamp authority、online key status、secure deletionを提供しない。
