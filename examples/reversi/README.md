# 月夜のリバーシ — JSON Semantic IR → Wasm

[自然言語の要求](./semantic-request.json)を[保存済みの型付きJSON IR](./reversi.semantic.llang.jsonc)に固定し、型検査・Wasm生成・成果物検証を経て、ブラウザで直接実行するリバーシです。TS形式のゲーム実装はありません。

```text
semantic-request.json（要求と操作契約）
  ↓ 要求を実装として固定
reversi.semantic.llang.jsonc（正本のJSON IR）
  ↓ 型検査・native Wasm生成
 dist/wasm/program.wasm + module-build.json
  ↓ ブラウザで直接実行
Wasmの返した表示モデル → 最小限のDOM接続 → HTML/CSS
```

IRはコメントなしのJSONです。既存の`module-collection-v1`の構文で、配列、レコード、型付き関数、ループを表します。booleanだけを返す旧Predicate IRとは別の既存profileであり、旧Predicateの制約を広げた実装ではありません。ビルドはこのJSONだけを入力にし、TSのゲームソースからIRを生成し直す経路は使いません。

## 起動・再ビルド

```sh
bun run reversi:build
bun run reversi:demo
```

[http://127.0.0.1:4174](http://127.0.0.1:4174)を開きます。`PORT=4175 bun run reversi:demo`でポートを変えられます。ローカルの配信サーバーと既存依存関係が必要ですが、APIキーは不要です。成果物が保存されていればビルドせず起動できます。

ビルド対象は**Wasmのみ**です。TypeScriptやJavaScriptへのコード生成、ブラウザ用TSのコンパイルはありません。HTML・CSS・素のJavaScript接続コードはそのままコピーします。ソースを変更したら再ビルドし、サーバーを再起動・画面を再読み込みしてください。

```text
dist/
├── wasm/program.wasm        # 保存するnative Wasm成果物
├── module-build.json        # 型契約、IRのhash、Wasmのhash、ツールチェーン
├── semantic-ir.json         # ビルドに使ったJSON IRの同一コピー
├── semantic-request.json
└── browser/
    ├── index.html
    ├── style.css
    ├── bridge.js
    └── wasm-runtime.js
```

`dist/`もリポジトリに残す成果物です。ビルドコマンドはこの出力専用フォルダーを置き換えます。サーバーはWasm・保存したIRのhashを検証し、不整合時は起動を停止します。ブラウザもWasmのhashを確認します。

## Wasmが担当する処理

JSON IRには次の処理を定義しています。

- 初期盤面、合法手、8方向の反転、無効手の拒否。
- 位置評価によるAI選択。角を優先、空き角の隣接を避け、同点なら最小位置。
- 手番、パス、自動進行で次に実行する操作、終局、勝敗。
- 対局状態、人間の手の直前の履歴、Undo、再開始。
- 石数、置けるセル、直前の手の表示フラグ、操作ボタンの可否、状態文。

[bridge.js](./bridge.js)はクリックをWasmへ渡し、返されたセルと文言をDOMに描きます。Wasmが返す`pendingAction`をタイマーで呼び出すだけで、AI選択やパス判断、履歴管理は持ちません。Undo・再開始時には古いタイマーを取り消します。[wasm-runtime.js](./wasm-runtime.js)は汎用ABIの符号化・復号とWebAssembly呼び出しだけを担当します。

対局状態はWasmが返す値です。接続側はそれを次の呼び出しへ変更せず渡します。既存の純粋評価ABIに合わせ、評価ごとに新しいWasmインスタンスを使います。状態をインスタンス内部へ永続保存する新しいABIは追加していません。

[server.ts](./server.ts)は保存済みファイルの配信だけです。対局API・サーバー側のゲーム実行・起動時コンパイル・実行時LLM呼び出しはありません。盤面を置いた後の処理にネットワーク通信は不要です。DOMとの接続に少量のJavaScriptが残るため、HTML/CSSとWasmの3種類だけで構成するアプリではありません。

## JSON IRの操作契約

`evaluate`の入力は`{ state, action }`、出力は次の対局状態と表示モデルです。

| action | 操作 |
| --- | --- |
| `-4` | 初期化・再開始 |
| `-3` | 直前の人間手より前に戻す。後続のAI・パスも取り消す |
| `-2` | 白のAIが選択した合法手を置く |
| `-1` | 置けない場合だけパス。合法手があれば変更しない |
| `0..63` | 黒が指定した位置へ置く |
| `-99` | 状態確認。自動処理が不要であることも示す |

`pendingAction`は`-2`または`-1`で自動処理を指示し、`-99`で停止します。手番違い・無効手は状態と履歴を変更しません。壊れた基本状態（盤面の長さ・石の値・手番・履歴数）を入力すると初期状態へ戻します。

## 検証

```sh
bun run reversi:test
bun run typecheck
```

独立したルール判定との8方向・盤端・終局までの照合、実際のブラウザ用Wasm接続と標準ランタイムの出力一致、履歴・Undo・パス・勝敗、Wasmのみのビルド、成果物破損検出、静的配信を検証します。開発の経緯・モデル使用量は[開発記録](./DEVELOPMENT_REPORT.md)にあります。
