# L-Lang architecture

更新日：2026-09-21。対象snapshot：`381ccf9adb281d6339444941120a5aca4ae7e5ad`。

## 全体像

L-Langは、入力syntaxそのものではなく、検査済みの意味表現と、それに結び付く成果物・権限・検証を中心に構成する。Semantic Coreは単一の共通IRの名称ではなく、用途別profileが担う意味契約の総称である。

```text
要求・型・source
        |
        v
Frontend / resolution
  Prompt | Semantic TS | restricted TS | JSONC | Hybrid import
        |
        v
profile別 checked representation
  Predicate | Bool | Value | Collection | Effects
        |
        +-------------------+
        |                   |
        v                   v
静的検証・suite       deterministic backends
                    TypeScript | JSONC | Wasm
                            |
                            v
                     Runtime / Host
                input validation | grant | budget
                effects | cancellation | cleanup
                            |
                            v
                 replay / inspection / evidence
```

Frontendはsyntaxを受理し、必要なら要求を解決して、profile固有のchecked representationへ変換する。Backendはchecked representationから成果物を生成する。Runtimeは成果物の入力契約と実行時の権限・資源を適用する。Verificationは一か所ではなく、parse、型検査、suite、artifact検査、実行時検査、replay、実行後監査に分かれる。

## 実装されている経路

| 経路 | 入力と解決 | checked representation | 主な出力・実行 | 検証境界 |
| --- | --- | --- | --- | --- |
| Semantic TypeScript | Concept、project type、Semantic TestをLLMまたはfixtureで解決し、lockへ固定 | Predicate系の解決IRと生成契約 | 通常のTypeScript、lock、replay | 候補のparse・型文脈・Semantic Test・project test。Wasm module系とは別経路 |
| Predicate JSONC | `.llang.jsonc` sourceをstrict parse・semantic check | `CheckedLlangProgram` / `predicate-i32-v1` | Wasm build、package、portable verify、検査用TS projection | source／program／artifact hash、suite、mutation、runtime input contract |
| Prompt Source | 要求と契約を解決し、Resolution Lockへ固定 | `PredicateExpression`とWasm contract | Predicate Wasm、manifest、fixture test | 独立exampleをresolverへ渡さず、lockとsourceのCAS・hashを検査 |
| Hybrid | 既存TSの限定predicateとcanonical typeを静的import | Hybrid resolution内の`PredicateExpression` | Wasm、schema、specification、artifact | 通常importと隔離importの一致、source再読込、semantic hash、artifact verify |
| Bool module | restricted TSまたはJSONC graphをload | `CheckedModuleProgram` / `module-bool-v1` | generated TS、normalized JSONC、Wasm | TS／JSONC graphの意味合流、reference・TS・JSONC・Wasm suite |
| Value module | restricted TSまたはJSONC graphをload | `CheckedValueProgram` / `module-value-v1` | generated TS、normalized JSONC、Wasm | 型・評価順・fault・ABI、4経路suite、portable verify |
| Collection module | restricted TSまたはJSONC graphをload | `CheckedCollectionProgram` / `module-collection-v1` | generated TS、normalized JSONC、native Wasm | lowering hash、資源・memory境界、4経路suite、portable verify |
| Effects module | restricted TSまたはJSONC。単一source互換形式またはtyped graph | checked effects program／graph / `module-effects-v1` | generated TS、flattened JSONC、continuation Wasm | operation契約、request replay、grant・ledger、bundle inspection、evidence・audit |

同じmodule profileのrestricted TSとJSONCは、profile固有loaderの後で同じchecked programまたはgraphに合流する。TSとJSONCを同一graph内で混在できるprofileもある。Backendはchecked representationを入力とし、元sourceのsyntaxを実行意味の分岐条件にしない。source path、raw hash、module inventoryはprovenanceとして残るため、別syntaxから同じ意味へ到達しても`sourceSetHash`等が一致するとは限らない。

Predicate、Prompt、Hybrid、Semantic TypeScriptは、すべてがmodule profileへ変換される構造ではない。現行のPredicate IRとWasm emitterを共有する部分はあるが、要求解決、lock、artifact、受け入れ条件は経路ごとに異なる。この独立性は現在のarchitectureとして記録し、統合の要否は互換性と利用価値を別途評価して決める。

## 層ごとの責務

### LanguageとSemantic Core

profileは、受理する値・型・式・制御、評価順、失敗、資源、外部操作を定める。詳細は[Semantic Core v1契約](./LLANG_SEMANTIC_CORE_V1.md)と各profile仕様を参照する。profile名の`v1`とsource／artifactのversion番号は別の契約である。

### Frontends

restricted TS frontendは任意のTypeScriptを実行・解決しない。profileごとに許されたAST shape、明示import、型注釈を読む。JSONC frontendはstrict／bounded parserとprofile schemaを使用する。PromptとSemantic TypeScriptのLLM処理はsemantic proposalを作る段階であり、生成結果は検査前にはtrusted codeではない。

### CompilerとBackends

compilerはchecked representationから決定的なartifactを生成する。module系のJSONC targetは正規化されたsourceを再生成し、再読込してprogram／interface等のhashを検査する。TypeScript targetはprofileの意味を実行または検査できる自己完結した表現を生成する。Wasm targetはprofile固有ABIとruntime contractを持つ。

生成TypeScriptの役割は経路で異なる。module系では実行targetである。Predicate inspection等では人間向けprojectionであり、Wasmと同じ配備targetとは限らない。この違いを「TypeScript backend」という一語で隠さない。

### RuntimeとHost

pure profileのruntimeはinput codec、artifact shape、resource faultを適用する。EffectsではWasm continuationとhost sessionが責務を分担する。programのoperation／effect宣言は必要条件であり、権限ではない。registryとのsignature照合、runtime grant、target allowlist、共有resource ledgerをdispatch時にも適用する。

Wasm memoryはhostに対するaccess controlではない。compiler、verifier、runtime、Wasm engine、host adapter、registryはそれぞれ信頼前提を持つ。外部serviceの応答、host OSの完全性、自然言語要求の正しさはWasm artifactの検証だけでは確立しない。

### Verification

| 段階 | 主な検査 |
| --- | --- |
| 生成・load前 | bounded parse、known field、path containment、source snapshot、profile、型・effect検査 |
| artifact生成時 | round-trip hash、deterministic output、ABI／layout、artifact hash、source差替え検出 |
| portable verify | manifest、artifact bytes、suite/interface、Wasm shape、timeout。sourceやcompilerを必要としない経路がある |
| 実行時 | input wire、operation signature、grant、予算、request sequence、response type、取消・cleanup |
| 実行後 | transcript／evidence hash、requirement・grantとの対応、署名・trust policy、replay／audit |

hash、suite、replay、署名は異なる性質を検査する。どれも単独で自然言語要求や業務上の正しさを証明しない。

## 標準経路と実験経路

`src/`のprofile compilerとCLIを標準経路とする。examples内の世界時計、JSON sort等の専用compiler、LLVM backendは限定実験であり、標準CLIの対応範囲へ数えない。LLVM kernelはCollectionの限定subsetを比較する実験artifactで、製品ABIやportable verifierには統合されていない。

入力・出力の利用者向け対応は[経路ガイド](./guides/language-routes.md)、版の対応は[Version契約](./LLANG_VERSIONING.md)、cross-targetで比較する意味は[Observable Semantics](./LLANG_OBSERVABLE_SEMANTICS.md)を参照する。
