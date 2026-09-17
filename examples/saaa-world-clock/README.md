# SAAA World Clock — runnable Wasm UI demo

このデモは、会話エージェントSAAAが「分散チーム向けの世界時計を作って」と依頼され、
表示意図と都市定義を契約へ整理した後、L-Langが決定的なWasm capabilityとUIを
組み立てる流れを示します。

```text
会話上の要求
  ↓ SAAAが構造化
request.json（意図・都市・IANA timezone・テーマ）
  ↓ deterministic compiler
capability.json + world-clock.wasm
  ↓ browser host adapter
動作する世界時計UI
```

## 起動

```bash
bun run world-clock:demo
```

ブラウザで <http://localhost:4173> を開きます。別portを使う場合:

```bash
WORLD_CLOCK_PORT=4180 bun run world-clock:demo
```

API key、LLM、外部API、CDNは不要です。`request.json`の都市、文言、accent colorを
変更して再起動すると、同じcompilerから別の時計capabilityが生成されます。

## SAAAが生成する範囲

[request.json](./request.json)はSAAAが会話から作るSourceの例です。
[request.schema.json](./request.schema.json)とruntime parserが、次を検証します。

- 表示意図、title、subtitle、accent color、locale
- 1〜12個の都市
- 一意で安全な都市ID
- 実行環境が認識できるIANA timezone
- unknown fieldを含まないversioned contract

デモでは会話モデルを呼ばず、レビュー済みのrequest fixtureを保存しています。
したがってUIは動的生成らしい入力を持ちますが、同じrequestとtoolchainからは常に同じ
manifest hashとWasm bytesが生成されます。

## Wasmの責務

Wasm ABIは`world-clock-i32-v1`です。

| Export | Input | Output |
| --- | --- | --- |
| `abi_version` | なし | ABI version `1` |
| `local_seconds` | UTC midnightからの秒、UTC offset分 | 現地midnightからの秒 |
| `day_delta` | UTC midnightからの秒、UTC offset分 | 前日`-1`、同日`0`、翌日`1` |

Wasmはimport、memory、table、globalを持たず、時刻計算だけを行います。ブラウザ側は
IANA timezoneと夏時間規則を`Intl.DateTimeFormat`で現在のUTC offsetへ変換し、その
offsetをWasmへ渡します。都市名、DOM、locale表示をWasmへ埋め込まないことで、
timezone databaseとUIの責務をhost adapterに残しています。

## ファイル

- [compiler.ts](./compiler.ts): request検証と決定的Wasm生成
- [server.ts](./server.ts): UI、manifest、Wasmを配信するローカルhost
- [app.ts](./app.ts): Wasmをinstantiateして時計カードを更新するbrowser adapter
- [index.html](./index.html): UI shell
- [styles.css](./styles.css): responsiveな時計dashboard
- [world-clock.test.ts](./world-clock.test.ts): ABI、時刻境界、配信、拒否ケース

## 検証

```bash
bun run world-clock:test
```

テストは、同一requestから同一manifest／Wasmが生成されること、Wasmにimportがないこと、
UTCの日付境界をまたぐ正負offset、ブラウザ向けendpoint、invalid timezoneや不正themeの
拒否を確認します。

## 非目標

これは新しい汎用TypeScript→Wasm profileではありません。既存の
`predicate-i32-v1`を時計へ流用せず、用途別ABIを小さく定義するデモです。timezone
database自体のWasm実装、予定表、会議予約、永続化、認証、公開deploymentは含みません。
