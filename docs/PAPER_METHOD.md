# 限定Predicateの方式と実装対応

対象は`predicate-i32-v1`である。[草稿](./PAPER_DRAFT.md)の第3・4章を読む際のコード対応表として使う。

| 段階 | 規則・入力 | 実装 |
| --- | --- | --- |
| 要求の固定 | intent、requirements、unresolvedWhen、profile、契約、Source例を持つJSON | [`prompt-source.ts`](../src/prompt-source.ts) |
| テスト生成 | 実装出力を見ずにsuiteを要求。schemaと厳密な期待値を検査 | [`capability-test-agent.ts`](../src/capability-test-agent.ts)、[`capability-tests.ts`](../src/capability-tests.ts) |
| IR生成 | `all`・`any`・`not`・`equals`・`present`のみ。修正時は失敗と前候補を開示 | [`capability-test-agent.ts`](../src/capability-test-agent.ts)、[`ir.ts`](../src/ir.ts) |
| 採用 | Source例と契約に照らし、IR本体・Source hash・応答情報をLockへ保存 | [`prompt-resolution.ts`](../src/prompt-resolution.ts) |
| lowering | 単一フィールド参照を契約のslotへ写像し、booleanと宣言enumの比較、nullとpresenceを制限 | [`wasm-core.ts`](../src/wasm-core.ts) |
| build | WasmCoreをBinaryenへ送り、`mvp-no-optimization`でmanifestとWasmを保存 | [`wasm-emitter.ts`](../src/wasm-emitter.ts)、[`prompt-wasm.ts`](../src/prompt-wasm.ts) |
| 実行 | 契約をhostでencodeし、Wasmの唯一のexportを呼ぶ。不正入力はhostで拒否 | [`wasm-contract.ts`](../src/wasm-contract.ts)、[`wasm-runtime.ts`](../src/wasm-runtime.ts) |

`all`は左から各条件を評価し、最初のfalseで停止する。`any`は最初のtrueで停止する。`not`は真理値を反転する。`equals`は契約で宣言した値との厳密な比較であり、文字列の任意比較や数値比較を一般化しない。`present`はnullとundefined以外をtrueとする。詳細なIR解釈は[`evaluatePromptIR`](../src/prompt-resolution.ts)、loweringは[`lowerPredicate`](../src/wasm-core.ts)を参照する。

未知fieldや不適切なliteralはloweringで拒否する。Lock、manifest、契約、Wasmのhashと関連は読み込み時に検査する。Wasm構造検証は自然言語要求との意味的一致を保証しない。独立Oracleによる有限例の検証結果は[`PAPER_EVIDENCE_RESULTS.md`](./PAPER_EVIDENCE_RESULTS.md)に分けて記す。

## 人間とモデルの役割

| 役割 | 確認できた内容 |
| --- | --- |
| 事前実装 | IR構文、生成指示、JSON schema、検査、compiler、hostはコードに固定 |
| 課題作成 | access要求と契約は固定JSON。作成過程、作成者、独立reviewはunknown |
| LLM | 保存`run.json`にはテスト生成と実装生成の2応答がある。初回実装候補がpass |
| 採用と手修正 | 記録上は修正呼出しなし。記録外の介入はunknown |

保存応答のsuiteは実装呼出しとは別だが、同じ要求とモデル系統を使う。研究用Oracleは別ファイルに固定し、モデル入力へ渡さない。現時点のOracleは未reviewである。
