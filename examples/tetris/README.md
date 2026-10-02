# 月夜のテトリス

Luna coding agent が、親エージェントの段階的なプロンプトを受けて作成した日本語テトリスです。ゲームルールとテストは JSON SemanticIR を正本として直接 Wasm にコンパイルします。TypeScript や JavaScript にゲームの意思決定ロジックはありません。

## ビルドと検証

リポジトリルートから実行します。

    bun run examples/templates/wasm-grid-app/build.ts examples/tetris
    bun run examples/templates/wasm-grid-app/test.ts examples/tetris
    bun run tetris:demo

ブラウザーで http://127.0.0.1:4175/ を開きます。

共有の build.ts、test.ts、server.ts とブラウザ部品は examples/templates/wasm-grid-app から提供され、アプリや dist にはコピーされません。生成物は game Wasm、通常のケーステスト Wasm、sequence property Wasm、それぞれのmanifestと provenanceです。

game.semantic.llang.jsonc がゲーム状態・判断・表示データを、tests.semantic.llang.jsonc がnative Wasm上のテストを、app.json がtransport設定とケース名を、style.css が画面を定義します。外部State JSONは純粋なABI transportであり、判断規則はすべてWasm内で実行されます。現在の検証は40ケース×3シードと11段階のlock-conservation sequenceで、合計131 checksです。

## 操作と範囲

左右移動、ソフト／ハードドロップ、時計回り・反時計回り回転、停止／再開、リセットに対応します。回転は簡易kickで、完全なSRS、hold、T-spin、対戦機能は対象外です。ゲーム終了判定は表示されるspawn位置で行い、リセットseedは12345固定で再現可能です。

## 正本と測定記録

- [生成元プロンプト](prompt.md)
- [ゲーム SemanticIR](game.semantic.llang.jsonc) / [テスト SemanticIR](tests.semantic.llang.jsonc)
- [保存済みゲーム Wasm](dist/wasm/program.wasm)
- [開発・検証・トークン測定レポート](DEVELOPMENT_REPORT.md) / [測定値 JSON](token-usage.json)
- [共通テンプレート](../templates/wasm-grid-app/README.md)
