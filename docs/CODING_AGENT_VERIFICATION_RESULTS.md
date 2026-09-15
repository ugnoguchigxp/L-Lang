# Coding Agent側の製造・検証・修正：実装結果

2026-09-15。基点`da72a47`（wasm-compiler）。[実装計画](./CODING_AGENT_VERIFICATION_IMPLEMENTATION_PLAN.md)のV1〜V5を実装した。SAAA、模擬SAAA、レジストリ、配備機能は追加していない。

## 追加機能

- 要求と入力契約から独立したJSON suiteを製造するadapter。実装IR・既存例を生成入力へ渡さず、既存例や同じ入力の別ケースとの期待値矛盾を検査する。
- テスト製造・初回実装・修正の依頼、応答、失敗を記録するdevelop経路。Source、metadata、suiteは固定し、試行ごとに新しいLockと能力パッケージを作る。
- 最大1回の修正、最大3回の論理呼び出し、token・時間上限と停止記録。usage不明、予算不足、不正応答、同一IR、入力改変で停止する。
- 条件削除、否定、AND/OR交換、boolean/enum比較値変更の変異検査。32変異・4096観測状態に制限し、Sourceによる検出、suiteによる検出、未検出、同値、未判定、エラーを分ける。
- 保存済み応答からのoffline replay。成功・不合格・未解決runについて、suite hashと候補hash、試行結果を元記録と照合する。
- 新規のdevelop、mutation-check、replay-development CLI。既存verifyのモデル・コンパイラ不要の経路は維持する。

主なコードは[製造と修正](../src/capability-development.ts)、[テスト製造adapter](../src/capability-test-agent.ts)、[変異検査](../src/capability-mutation.ts)、[CLI](../src/capability-development-cli.ts)。[操作例](../examples/capability-development/README.md)に再実行手順をまとめた。

## 観測した結果

| 課題 | 初回候補 | 修正後 | 再検証 |
| --- | --- | --- | --- |
| 受付判定 | 停止条件の欠落を追加suiteが検出 | 固定suiteで合格 | 同じ候補hashを再現 |
| premium区分とメール存在 | 会員区分の欠落を追加suiteが検出 | 空文字・null・undefined・欠損を含む固定suiteで合格 | 同じ候補hashを再現 |
| AND・OR・NOT | 否定の誤りを追加suiteが検出 | 固定suiteで合格 | 同じ候補hashを再現 |

受付判定の修正版に対する変異検査では、7変異をSource例、1変異を追加suiteで検出し、非同値の未検出は0だった。別の試験では弱いsuiteを用意し、部品テストを通っても非同値の変異を見逃すことをreportできた。重複条件の削除による同値変異と、列挙上限による未判定も区別した。

これらは開発fixtureによる実行結果であり、実モデルの正解率や修正成功率ではない。外部の有料API呼び出しは0回。live接続はローカルの模擬Responsesサーバーで、3呼び出しの製造・修正と保存応答からの再検証を確認した。模擬サーバーへの呼び出しはlive形式の記録ではapiCallsに数えるが、外部providerへの実行ではない。

## 検証と証拠

対象試験は28件・156 assertionsで成功。成功経路のほか、未解決、拒否、不正応答、矛盾suite、同一IR、2回目の不合格、予算不足、usage不明・超過、通信中断、途中run、snapshot改変、replayの候補不一致、symlink、変異の見逃しと同値を含む。

ローカルの実行記録は`artifacts/capability-development/`へ保存する。access/contact/logic各run、access-replay、access-mutations.json、各テスト・品質Gateのログが対象。artifactsはGit管理外であり、他環境では操作例とfixtureから再生成する。全回帰と3 OS CIの最終結果は対象commitとともに作業報告へ記載する。

## 残る検証

任意の自然言語の正しさは保証しない。テスト製造と実装製造を分離しても同じ誤解を共有する可能性があり、変異検査もその問題を完全には解決しない。実モデルによる生成品質と費用は未評価。

実行記録のhashは整合性の検査であり、署名ではない。一般的なCoding Agentプロセスの起動・管理、複数回の汎用修正loop、型や演算の拡張も含めていない。SAAA導入へは自動移行せず、今回の結果と次に必要な処理を確認してから判断する。
