# Semantic Core安定化・第五段階 実施結果

実施日：2026-09-22。対象：[第五段階 実装計画](./SEMANTIC_CORE_STABILIZATION_PHASE5_IMPLEMENTATION_PLAN.md)。

## 実装結果

`module-effects-v1`の逐次`await`へ、決定的generated trace differential testingを追加した。同じ生成programと固定grant／host scriptを、独立oracle、checked graph reference、generated TypeScript、flattened JSONC round-trip、native typed Wasmの5 laneで実行し、request／response列とterminal outcomeを比較する。

generatorはseed `20260924`とcase indexだけから次の6系統を生成する。

- `scalar-chain`：i32、boolean、string。
- `wide-number-chain`：i64、finite f64、decimal。
- `bytes-chain`：空値や任意octet列を含むtagged bytes。
- `record-chain`：field順を意味に含めない浅いrecord。
- `list-chain`：順序と重複を保持するList。
- `mixed-chain`：中間nodeと最終nodeで異なる型を使う逐次operation。

各programは2〜4個の`host` operationと8 scenarioを持つ。5件は成功、1件は先頭host failure、1件は途中または末尾host failure、1件は途中または末尾grant拒否である。通常testは24 program／192 scenario、`bun run effects:trace:differential`は64 program／512 scenarioを実行する。固定24件と明示64件は、それぞれ24／64種類のsemantic projectionとWasm hashを持つ。

## traceと比較境界

traceは次をstrictに保持する。

- request／responseの連番、operation ID、version、canonical typed value。
- grant拒否時の対象operationとhost dispatch不実施。
- host failure位置と、それ以降を実行しないこと。
- completed、host failure、permission deniedのterminal outcome。
- 成功時の最終response value。

i64、bytes、decimalはtagged JSON表現を保持し、JavaScript numberやUTF-8 stringへcoerceしない。List順を保持し、record property順には依存しない。疎なarray、追加field、symbol、accessor、循環値、非finite number、terminal後のevent、未知event shapeを受理しない。

独立oracleはimportを持たず、compiler、loader、IR、emitter、runtime、ABI codecへ依存しない。checked graph referenceはWasm emitter、`TypedEffectsRuntime`、`runTypedEffectsGraph`を呼ばず、checked nodeを直接逐次評価する。境界はsource検査で固定した。

generated TypeScriptは実際の`program.generated.ts`を空の環境変数、標準入力なし、5秒timeoutのchild processで実行する。native Wasmは製品の`emitTypedEffectsWasm`と`TypedEffectsRuntime`を使い、yield requestへ同じ決定的host adapterを適用する。host failureはWasm fault 6との対応を明示し、未知faultを同じ結果へ丸めない。

## JSONCとhash

flattened JSONCは再読込後に次を照合する。

- interface hash。
- result type、operation requirement、node、canonical requestを含むdifferential専用semantic projection。
- typed continuationのlowered hash。

Effectsの`programHash`はsource inventoryを含むため、original sourceとflattened JSONCで一致を要求していない。この既存version/hash契約は変更していない。

固定24件の証拠は次のとおり。

| 証拠                    | SHA-256 digest                                                     |
| ----------------------- | ------------------------------------------------------------------ |
| generated case          | `667eb5b43bc2582ee0cdcf8b365976fae6bdb394cbee95b8b719a8e9702f805b` |
| source set hash配列     | `6a5403ea7ee15b1e8d93d1bd4241eb66f2d724b32d5619e1edeb827db1a2f8d0` |
| interface hash配列      | `1f9172dd364ffa9dd375442c295317e3c77398d50fa707642d549deacdcf980b` |
| semantic projection配列 | `39d62b1d323c0d949e394a54f2da6bd5a1c8a534c1f36e00e18abd9373f0a121` |
| lowered hash配列        | `832e07960db34a9c3bf276c1f7821ce9341cfd5948edbe86f02cd67dac046af6` |
| Wasm hash配列           | `7f76b0dd34639e22e0d8bee539556ed453ecebfd06ca4982dc61d5472b52d101` |

## CLIと再現

```sh
bun run effects:trace:differential

bun run src/llang-effects-trace-differential-cli.ts \
  --seed 20260924 --start-case <caseIndex> --cases 1 \
  --scenario-index <scenarioIndex> \
  --failure-out artifacts/effects-trace-differential-failure.json
```

CLIは`--seed`、`--start-case`、`--cases`、`--scenario-index`、`--failure-out`だけを受理する。一致は終了code 0、semantic mismatchは1、runner／artifact書き込み等の運用失敗は2である。failure artifactはatomic writeし、source、model、全scenario、単一再生条件を保持する。比較まで到達したsemantic mismatchにはさらにflattened JSONC、hash、lane outcomeを、runner errorにはstageを記録し、artifact書き込み失敗も`artifact-write`として報告する。

## mutation検出

固定試験は次の誤りを検出する。

- 5 laneの欠落。
- requestの反転、重複、途中欠落。
- grantの無視と拒否対象のdispatch。
- host failure後の継続。
- 最初のresponseを最終resultとして返す誤り。
- i64／bytes／decimalのtag消失。
- trace／List順の消失とrecord property順依存。
- 疎なarray、accessor、symbol、非finite number等の過剰受理。

## 互換性

source version 5、build／suite version 5、profile `module-effects-v1`、ABI `llang-effects-session-v1`、`typed-wire-v1`、512-page memory、公開export、fault code、resource既定値、Binaryen 132.0.0、最適化設定は変更していない。製品emitter／runtimeの修正は発生しなかった。

## 検証結果

| 検証                                       | 結果                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| 固定corpus                                 | 24 program／192 scenario、5 lane一致、24種類のsemantic projection／Wasm hash、全digest一致      |
| 明示corpus                                 | 64 program／512 scenario、5 lane一致、64種類のsemantic projection／Wasm hash                    |
| 新規differential試験                       | 11 test、64 expectation、0 fail                                                                 |
| Effects graph／state machine／Wasm／memory | 34 test、215 expectation、0 fail                                                                |
| install／audit                             | frozen lockfileに変更なし、109 packageに既知脆弱性なし                                          |
| format／lint／typecheck                    | 成功。新規差分テスト群の診断0。全体lintは既存warning 87件、終了code 0                           |
| full test                                  | 154 file、828 test、16,356 expectation、0 fail                                                  |
| coverage                                   | 154 file、828 test、16,356 expectation、0 fail。functions 92.72%、lines 91.66%、既定閾値を通過   |
| smoke／protected／docs                     | semantic、L-Lang、module、effects smoke、protected input、24 command／3 versionの文書契約が成功 |
| `git diff --check`                         | 成功                                                                                            |

## 保証範囲

固定seedの有限corpusについて、compile-time fixedな逐次`await`のrequest／response順、typed value、grant拒否、host failure停止、最終resultが、独立oracleと5経路で一致したことを確認する。

task、stream、取消、deadline、cleanup、resource counter、file／HTTP adapter、実network、execution evidence、malformed wire、linear i32互換形式は対象外である。従って、本結果は並行Effects全体の同値性、任意hostの正しさ、外部副作用のexactly-once、一般的な意味保存の形式証明を示さない。

次の候補は、同じtrace schemaを使い、host completion scheduleをcase入力として固定したtask比較である。stream、取消、resource比較は、それぞれchunk／cleanup、発生点／論理時計、共通counter単位を先に固定してから扱う。
