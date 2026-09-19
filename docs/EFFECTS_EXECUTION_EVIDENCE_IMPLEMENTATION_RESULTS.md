# Effects実行証跡の実装結果

実施日: 2026-09-20。対象計画は[Effects実行証跡の実装計画](./EFFECTS_EXECUTION_EVIDENCE_IMPLEMENTATION_PLAN.md)です。

## 実装範囲

- `module execute`と`module recover-execution`を追加した。
- typed version-5 all-target bundleを静的検査し、同梱Wasm bytesを実行するsnapshot APIを追加した。
- bundle identityに結び付くstrict grant、file/HTTP/clock組込み実行、embedding host executorを追加した。
- 外部dispatch前のrequest記録、単一writer、event hash chain、terminal eventを実装した。
- intent、transcript、最終reportの順序付き公開と、owner lockを使うcrash回収を実装した。
- payload本文、response本文、credential値と環境変数名、HTTP path/query、実file root、完全なerrorを証跡から除外した。
- task child、stream chunk、取消・timeout、cleanup action（close/commit/abort/cancel）、resource used/peak/unreleasedを記録した。
- grant、credential mapping、intent、lock、transcript、reportはfile descriptorに固定して読み、symlink、hard link、inode・size差し替えを拒否する。実行終了時にはbundleとgrantを再検証する。
- `ResourceLedger`のsnapshot/peak、HTTP adapterの全body cleanup、`clock.wall@1`を追加した。

既存のmanifest version、`llang-effects-session-v1` ABI、typed wire layout、Wasm emitter、Binaryen設定は変更していない。Binaryenは`132.0.0`のままで、実行証跡のための最適化passやcustom sectionも追加していない。

## 証跡成果物

実行中は`execution.lock`を保持し、次を出力する。

```text
execution-intent.json
effects-transcript.jsonl
effects-execution.json
```

最終reportはbundle、grant commitmentと公開summary、bundled Wasm、transcript、result、resource、cleanup、credential非記録状態、provenanceを結び付ける。`attestation: "not-signed"`と`retention: "caller-managed"`を明示する。

crash回収はlive PIDのownerを拒否し、stale lockとhash chainを検査する。requestだけが記録されたoperationは`unknown`とし、外部operation、Wasm、file commitを再実行しない。

## 受け入れ条件との対応

| ID | 実装・検証 |
| --- | --- |
| EEE1–EEE3 | bundled Wasm実行、source削除後のbundle移動、identity-bound grant、operation不足・余分なoperationのdispatch前拒否 |
| EEE4–EEE6 | file logical rootとadapter root分離、HTTP network policy、credential非記録のloopback検証 |
| EEE7–EEE8 | request/response、canonical outcome、deadline、cancel、unknown certainty |
| EEE9–EEE11 | task child ID、stream chunk/EOF/cancel、file/HTTP closeとwrite commit/abortの明示記録 |
| EEE12 | dispatch前のresource limit停止と、limits、used、peak、unreleased、原因を持つresource evidence |
| EEE13 | request記録後に子processをSIGKILLするfixture。pendingをunknownとし、dispatch counterが1のままであることを検証 |
| EEE14–EEE15 | 実行中のbundle・grant・出力directory変更をfail-closedにし、第三者fileを削除しないこと、bundle/file rootと出力先の重複拒否、file identity検査 |
| EEE16–EEE17 | strict CLI、旧profile拒否、prototype/secret/log本文を残さない境界 |
| EEE18 | emitterとABIを変更せず、既存Effects testとWasm回帰を実行 |

## 検証

ローカルのmacOS arm64では、指定Bun `1.4.2`による`bun run check`が651 test、0 failureで完了した。`ci:docs`、`ci:protected`、`ci:smoke`、`git diff --check`も成功した。remote CIのUbuntu、macOS、Windows結果は未確認であり、push後のCIで別途確認する。

署名鍵、trust store、remote attestation、外部副作用のrollback、exactly-once、証跡のremote保存・暗号化・自動削除は実装していない。これらをunsigned evidenceの保証として扱わない。
