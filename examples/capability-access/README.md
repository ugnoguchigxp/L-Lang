# Coding Agentが提出する受付判定能力

有効かつ利用停止中でない利用者を許可する。Sourceの2例と、独立した[test suite](./tests.json)の4ケースを実際のWasmで確認する。Sourceにはない停止中のケースをsuiteに含め、条件の欠落を検出できるようにしている。

実装の正本は[Prompt Source](./access.prompt.json)と保存済みLock。テスト検証コードはJSONで宣言し、共通runnerが実行する。ここでのfixtureは意味解決の回答を代用するデータであり、実モデルの精度を測定する例ではない。

リポジトリのルートで実行する。候補ディレクトリとreportは新規の名前を指定する。既存のものは上書きしない。

```sh
bun run capability package examples/capability-access/access.prompt.json --tests examples/capability-access/tests.json --metadata examples/capability-access/metadata.json --out-dir artifacts/access-v1
bun run capability inspect artifacts/access-v1/capability.json --json
bun run capability verify artifacts/access-v1/capability.json --report artifacts/access-v1-report.json
```

正常な結果は`status: "pass"`、`passed: 6`、`acceptance: "not-run"`、`apiCalls: 0`となる。終了コードは0=部品検証合格、1=期待値不一致、2=入力・整合性・実行エラー。inspectは実行せず、検証済みとは表示しない。

候補フォルダを丸ごと別の場所へコピーして、同じverifyコマンドで再検証できる。元Sourceや元suiteのパスは不要。reportは候補フォルダの外に置く。

## 条件の欠落を検出する

次の手順は故障注入用である。元のSource/Lockは変更せず、別の作業コピーに停止条件を欠いたLockを作る。Node/Bunで作業コピーを作るので、OS固有のcopyコマンドは不要。

```sh
bun -e 'await Bun.write("artifacts/access-bad-source/access.prompt.json", Bun.file("examples/capability-access/access.prompt.json"))'
bun run prompt resolve artifacts/access-bad-source/access.prompt.json --fixture examples/capability-access/missing-condition.fixture.json
bun run capability package artifacts/access-bad-source/access.prompt.json --tests examples/capability-access/tests.json --metadata examples/capability-access/metadata.json --out-dir artifacts/access-bad
bun run capability verify artifacts/access-bad/capability.json --report artifacts/access-bad-report.json
```

Sourceの2例は合格するが、suiteの`stopped`が失敗し、終了コード1になる。正しい保存済みLockから新しい候補をpackageすれば同じsuiteで合格する。固定suiteでの製造・最大1回修正は[製造例](../capability-development/README.md)を参照。SAAAからの受け入れ失敗を使う修正adapterは別の未完了項目。

## エージェントへ渡すもの

- `capability.json`を含む候補フォルダ全体。
- `packageHash`と対応する検証report。
- 今回はSAAAの受け入れを実行していないこと。

reportの構造・整合性は`parseCapabilityReport`、候補の再検証は`verifyCapability`で確認できる。reportが正しい形式でも発行者の真正性は保証されない。受け入れ側は候補を再検証し、後続のSAAA受け入れを別に行う。

verifyはデータとして宣言したテストだけを処理し、モデル・Binaryen・TS scannerを読み込まない。ゲスト実行には10秒のWorkerタイムアウトを設ける。Workerはホスト全体のメモリ隔離や、任意の外部提供Wasmに対する完全なセキュリティ境界を保証するものではない。本段階は既存の制限コンパイラが生成した、ローカルの候補を対象とする。
