# Tetris 開発・検証記録

2026-10-02。Luna（gpt-5.6-luna、Codex SDK 0.154.0）でゲームとテストの JSON SemanticIR を作成し、既存の collection module compiler で直接 Wasm を生成した。TypeScript のゲームソースや TypeScript 出力は作成していない。

## 生成経路と担当

[prompt.md](prompt.md) → Luna → [game.semantic.llang.jsonc](game.semantic.llang.jsonc) と [tests.semantic.llang.jsonc](tests.semantic.llang.jsonc) → 共通ビルダー → [ゲーム Wasm](dist/wasm/program.wasm)、[ケーステスト Wasm](dist/tests/wasm/program.wasm)、[遷移プロパティ Wasm](dist/tests/sequence/wasm/program.wasm)。テスト IR はゲームを import して操作結果と独立した期待値を検証する。

[共通テンプレート](../templates/wasm-grid-app/README.md) の build.ts、server.ts、test.ts、index.html、browser.js、timer.js、wasm-runtime.js はアプリと dist にコピーしない。サーバーは静的配信のみ。ブラウザーは入力、状態の ABI transport、表示、タイマーを担当し、衝突、回転、キュー、消去、得点、終了判定は Wasm が担当する。manifest と provenance でソースとバイナリーの対応を検証する。

親エージェントが共通テンプレート、段階的な指示、期待値のフィクスチャ、独立レビューと検証を担当した。Luna がゲーム・テスト IR、設定、CSS、アプリ説明を作成した。初回の広い指示では未完成の関数と不十分なテストが残ったため、実装を小さく分けて修正した。一回の生成で完成した結果ではない。各指示は generation/ に保存している。

## トークン測定

全17回の SDK 応答を記録した。最初の2回は reasoning low、残り15回は medium。実モデルは全回 gpt-5.6-luna。未完成・失敗・修正・画面調整をすべて含む。SDK の累積 usage と CLI の total_token_usage は全17回で一致した。累積値を足さず、各回の差分と最終累積値を [token-usage.json](token-usage.json) に保存した。

|項目|トークン数|
|---|---:|
|入力合計|22,252,754|
|うちキャッシュ入力|21,839,872|
|キャッシュを除く入力|412,882|
|出力|95,519|
|うち reasoning 出力|18,477|
|入力＋出力合計|22,348,273|
|キャッシュを除く入力＋出力|508,401|

キャッシュ入力は入力合計の内数、reasoning は出力の内数。SDK 実行時間の合計は 2,369,718 ms（約39.5分）。金額換算はしていない。親エージェントのテンプレート作業、指示、レビュー、検証のトークンは計測できておらず、この数字には含まれない。したがって開発全体の総トークン数ではない。

継続スレッドと修正でキャッシュ入力が大きく積み上がった。今回の結果から「トークン効率が良い」とは結論できない。過去のリバーシとは機能、生成経路、検証範囲が異なり、統制された比較ではない。

## 検証

- Test SemanticIR の40ケースを3シードで実行：120 checks。
- 実ゲームの連続ハードドロップを遷移プロパティ Wasm で検証：11 checks、終了まで到達。固定セル数の保存則、値域、カウンター、キューなどを検査。
- 合計131 checks が成功。長いシーケンスは既定の fuel と arena に収まるように、各遷移を別の Wasm 呼び出しで検証する。
- 親の独立監査177 checks が成功。7種×4回転、壁、ゴースト、1～4行消去と得点、操作、停止、終了、連続遷移を確認。
- 共通テンプレートと既存リバーシの統合テスト60件が成功。形状と2行消去得点の意図的な誤変更は Test SemanticIR が検出した。ABI codec、静的配信、古いソース・破損バイナリー拒否、失敗時の既存成果物保護、再ビルド再現性も検証。
- 型検査と文書リンク・契約検査を実行。リポジトリ全体の全テスト再実行は対象外。
- ブラウザーで表示と移動・回転・ドロップ・停止／再開を確認。

## 実装範囲

10×20、7種、再現可能な7-bag、左右移動、両方向回転と簡易水平 kick、ソフト・ハードドロップ、自然落下、ゴースト、次ピース、得点・ライン・レベル、停止・再開・リセット・ゲーム終了。リセット seed は12345固定。完全な SRS、hold、T-spin、対戦は含まない。spawn は表示領域内で判定する。
