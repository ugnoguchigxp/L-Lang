# 関連研究と本稿の主張範囲

2026-09-27に以下の一次資料を確認した。比較の対象は方式と根拠の範囲であり、性能や成功率の優位性を主張しない。

| 領域 | 一次資料が支持する内容 | 本稿との関係 |
| --- | --- | --- |
| 自然言語からDSL | [Program Synthesis using Natural Language](https://arxiv.org/abs/1509.00413)は自然言語入力から対象DSLの式を作る枠組みを扱う。[HYSYNTH](https://arxiv.org/abs/2405.15880)はLLMの補完を使ってDSLプログラム合成を導く | 自然言語から制限された中間表現を得ること自体を新規性としない。本稿は採用IRの保存とWasm実行までの具体的な接続を対象にする |
| Wasmの意味と検証 | [WebAssembly Core Specification](https://www.w3.org/TR/wasm-core/)はWasmのbinary、validation、executionを規定する | Wasmの構造的有効性と自然言語要求への適合を区別する。独立Oracleは後者の有限例を扱う |
| 再現可能build | [Reproducible Buildsの定義](https://reproducible-builds.org/docs/definition/)は固定したsource・環境・手順からartifactがbit単位で一致することを基準にする | 本稿の4-way byte一致は確認した入力とローカル環境の範囲に限る。異OS・第三者再現へ広げない |
| provenance | [SLSA Provenance v1.1](https://slsa.dev/spec/v1.1/provenance)はbuildDefinitionとrunDetailsにより成果物の作成過程を記述する | 本稿のLock、manifest、inventoryは関連hashを追跡するローカル記録であり、署名付きattestationやSLSA適合を主張しない |

以上から、論文の貢献は「LLM→IR」や「決定的コンパイル」の単独発明ではなく、限定Predicateについて、要求と契約、生成時の検査、採用Lock、Wasm、保存応答再生、独立Oracle、byte比較を一つの追跡可能な実装で示した点に狭める。1課題の観測から一般的な生成品質を推定しない。
