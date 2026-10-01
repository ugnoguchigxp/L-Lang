# Semantic TDD Phase 6〜7・残実装の完了計画

作成日：2026-10-01。状態：実装項目と結果記録を完了。repository check・coverageは成功。既存Effectsに由来する全体verifyの失敗1件、独立live評価・既定採用のGateは未完了。ユーザーの「計画上最後まで」という指示に基づき、[限定初版計画](./SEMANTIC_TDD_EXTENSIONS_V1_IMPLEMENTATION_PLAN.md)に残っていた上位計画の実装項目を補う。

## 完了対象

- [x] Property config v2に配列長と時間の上限を追加。旧config/report v1は同じ生成versionで再生する。
- [x] 深さ3、長さ16までのbounded arrayと、単一のobject/arrayを含むnullable/optional unionを生成・縮小する。要素domainにはpathの`*`を使う。
- [x] 遅延shrinkerで候補の一括膨張を避け、node・step・時間の上限で停止する。source example subprocessにもtimeoutを設定する。
- [x] `semantic verify --property-report`で保存結果をAPIなしに再生し、現在の採用IR・schema・凍結Test Planとの一致を検査する。
- [x] 新しい合成入力を結果観測前にfreezeし、単発とBest-of-N、反例再現を比較する。既存の観測済みfixtureを新規評価データへ流用しない。
- [x] 合成制御実験／live実測／APIなしreplayを分離した評価runnerを追加する。liveは明示model・価格・全実行共通のtoken／費用予算を必須とする。部分失敗・予算停止でも受領した候補記録を保存する。
- [x] 最終unit／integration／CLI、repository check、coverage、docs、protectedの検証結果を保存する。
- [x] 文書の現在地、上位計画の実装完了と独立評価の状態を同期する。

## 評価と採用の条件

合成制御実験は選択・失敗処理・反例の検証であり、実モデルの生成品質改善の証明ではない。直接APIでの評価にはユーザー指定のmodelと費用上限が必要。追加のユーザー指示でCodex SDKのLuna経路を接続し、観測済み合成課題の実評価を完了した。[実評価結果](./SEMANTIC_TDD_CODEX_LIVE_EVALUATION_RESULTS.md)を参照する。第三者blindな独立評価は引き続き未完了。実費の絶対上限は応答後accountingでは保証しない。

第三者が作成したblindな未観測課題、Private Pilot価値Gate、Public Alpha package/CLI Gateはコード実装だけで完了にできない。これらの証拠が揃うまで既定経路や自動Hard Gateへ昇格しない。Paper v1の範囲・完了条件は維持する。

一般的なobject union、任意collection predicate、無制限generator、retry、自然言語からの期待式自動確定は追加しない。新規依存、既存JSONC/Wasm ABI、保護済みbenchmark入力は変更しない。

## 検証

関連testを先に実行し、その後`bun run check`、`bun run coverage`、`bun run ci:docs`、`bun run ci:protected`、`bun run verify`を実行する。失敗時は原因を保存して修正し、閾値や凍結入力を都合よく変更しない。最終coverage開始後は対象sourceを固定する。

[実装・評価結果](./SEMANTIC_TDD_EXTENSIONS_COMPLETION_RESULTS.md)
