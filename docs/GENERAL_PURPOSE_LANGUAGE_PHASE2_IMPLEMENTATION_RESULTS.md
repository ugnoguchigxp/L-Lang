# 汎用言語化・第二弾 実装結果

実施日：2026-09-17。`module-value-v1`、source version 3、build/suite
version 2、`llang-value-memory-v1` ABI を実装した。

## 実装範囲

- boolean、検査付き i32、Unicode string
- 非再帰 record、tagged union、型付き引数・戻り値
- immutable local、block、if、網羅的 match、早期 return 相当の frontend
- TypeScript、JSONC、再生成 JSONC、参照評価、Wasm の共通意味
- 固定 16-page memory、呼出し単位 instance、inline layout、UTF-8 wire codec
- manifest version 2、suite version 2、portable Wasm verify
- 旧 `module-bool-v1`、manifest/suite version 1、stateless Wasm の互換維持

仕様は [Value module仕様](./LLANG_MODULE_VALUE_SPEC.md)、縦断例は
[`examples/module-order-line/`](../examples/module-order-line/) を参照する。

## 再現情報

| 項目 | 値 |
| --- | --- |
| 基準 HEAD | `0a40782f1a6a3d9b3456053e0575387fa8e4eb6c` |
| OS | Darwin 25.6.0 arm64 |
| 実行 Bun | 1.3.14 |
| packageManager 指定 | Bun 1.4.2 |
| Binaryen | 132.0.0 |
| TypeScript | 5.9.3 |
| `package.json` SHA-256 | `ec595e7a8ac73db3f4f9da1406e87d746a2fc0939b337606e854cfddf19b5605` |
| `bun.lock` SHA-256 | `0c8d7fef0f38ddf07847a530413bc8e922881a0574127a6d9ca9be67bc36d847` |

開始時点からワークツリーは Phase 1 を含む多数の未コミット変更を持っていた。
それらを保持し、Phase 2 は別 profile・別 reader・別 ABI として追加した。

## 縦断結果

全 TypeScript、全 JSONC、JSONC→TS→JSONC、TS→JSONC→TS の4構成が同じ
意味 hash と結果になった。

| hash / artifact | 値 |
| --- | --- |
| programHash | `925671d110eb459d91171da30361a578046a4e2bc5959eec34be1a66e6e6e97b` |
| interfaceHash | `42956753b1b66c9e0353ab16938859abce4785927a5b4dbfd2fa2ad91306041d` |
| layoutHash | `5d26d3e112cc6eb02573b086d07a174e700f4fc371d04254c6ae43bd71a5555e` |
| Wasm hash | `6cc5c5bd2869ae4f4e99de2b7e2489d2750d2f1850b6211fb73a82a0b0ef971f` |
| Wasm bytes | 1,504 |

成功値、業務 error variant、算術 overflow、invalid input を4 backendで照合した。
生成 bundle は原 source と compiler を使わず、manifest、Wasm、固定 suite だけで
portable verify に成功した。

## 品質ゲート

| Gate | 結果 |
| --- | --- |
| `bun install --frozen-lockfile` | pass、変更なし |
| `bun audit` | pass、脆弱性0件 |
| `bun run format:check` | pass |
| `bun run lint` | pass（既存方針どおり warning は表示） |
| `bun run typecheck` | pass |
| `bun test --timeout 30000` | 516 pass、0 fail、3,810 assertions |
| `bun run coverage` | pass、functions 94.22%、lines 91.73% |
| `bun run ci:docs` | pass |
| `bun run ci:protected` | pass |
| `bun run ci:smoke` | pass |
| `git diff --check` | pass |

新 module の局所試験は9件、旧新 module の合同局所試験は14件すべて成功した。
module smoke は旧3構成・5 portable casesに加え、新4構成・4 portable casesを実行する。

## 環境差

ローカルホストにある Bun は 1.3.14 で、`package.json` が固定する 1.4.2 とは異なる。
また、この記録は macOS ローカル実行であり、Ubuntu/Windows job をローカル成功として
記録していない。lockfile、依存版、全 gate は上記ローカル環境で検証済みである。
