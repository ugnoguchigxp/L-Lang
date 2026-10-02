# 共通Wasmグリッドアプリ・テンプレート

アプリ固有のJSON SemanticIRを既存のcollectionコンパイラで直接Wasmへ変換する。ブラウザは保存したWasmを実行し、返された状態と表示データを描画する。ゲームロジックのTypeScript生成は行わない。

- `build.ts`: ゲームIRとテストIRをそれぞれWasmへビルド。失敗時には前のdistを維持する。
- `test.ts`: テストIR由来のWasmをケースごと・seedごとに新しいインスタンスで実行する。
- `server.ts`: アプリ固有のファイルと共通ブラウザ部品を静的に配信する。起動時にビルド時のソースハッシュを確認する。
- `index.html` / `template.css` / `browser.js`: 共通の外枠、操作、タイマー、描画。
- `wasm-runtime.js`: collection native ABIの汎用入出力。リバーシで検証した実装を共通部品として利用。
- `timer.js`: Wasmが返す間隔で時間イベントを送る。入力のたびに落下期限を延ばさず、停止・再開時の古いタイマーを破棄する。
- `luna.ts`: 明示的な生成依頼をCodex SDKのLunaへ送り、イベントと使用量を記録する開発用部品。実行には既存のCodexログインが必要。

```sh
bun run examples/templates/wasm-grid-app/build.ts examples/tetris
bun run examples/templates/wasm-grid-app/test.ts examples/tetris
bun run examples/templates/wasm-grid-app/server.ts examples/tetris
```

アプリ側は`prompt.md`、`app.json`、`style.css`、`game.semantic.llang.jsonc`、`tests.semantic.llang.jsonc`を持つ。共通部品をアプリ内やdistへ複製しない。distはゲーム・テストのWasmと各ビルドmanifest、ソースハッシュ記録だけを含む。このためdist単体の静的サイト配布には共通テンプレートとアプリ固有の設定・CSSも必要になる。

現行の表示契約は盤面・4×4等のプレビュー、スコア・ライン・レベル・ステータスを持つグリッドゲーム用。全アプリを扱う汎用UIライブラリではない。既存リバーシは従来の独立した外枠を維持している。

テストIRは実装IRと同じ表現形式を使うが、期待条件は自然言語要件から記述する。型検証・Wasmの構造検証だけではゲームの正しさは証明できないため、具体的な盤面と期待値、長い操作列、意図的な不具合を入れた検査を併用する。

長い操作列は`tests.sequence`で指定する。テストIRの`checkTransition({before,after})`を別のWasm成果物へビルドし、ゲームWasmの1手ごとに新しいテストWasmインスタンスで検査する。返却値は`{id,passed,complete}`。資源制限は変更せず、前後の状態と検査結果を共通ランナーが受け渡す。セル数の保存や終了条件の判定はテストIRが行う。

Luna生成は隔離した作業ディレクトリで行う。`luna.ts workspace prompt.md recordDir phase low|medium [--resume]`で呼び出し、同じ記録先の`--resume`はその生成セッションだけを再開する。別の既存チャットには送信しない。例:

```sh
bun run examples/templates/wasm-grid-app/luna.ts .semantic/tetris-luna-work examples/tetris/generation/generate-prompt.txt artifacts/tetris-reproduction generate low
```

作業ディレクトリには事前に要件をコピーし、必要な`src`・`docs`・`node_modules`・共通テンプレートを参照できるようにする。生成後にレビューして正本IRをアプリへ保存し、上のビルド・テストを実行する。モデルによる生成は非決定的であり、一度の呼び出しで完成する保証はない。既存IRからのWasmビルドは決定的。

SDKの使用量だけを各ターンの消費とみなさない。この環境では再開時も累積値だったため、セッション記録の`total_token_usage`と照合し、段階別は隣接する累積値の差で算出する。生ログの保存先は`artifacts`を推奨する。未取得の値をゼロとして扱わない。
