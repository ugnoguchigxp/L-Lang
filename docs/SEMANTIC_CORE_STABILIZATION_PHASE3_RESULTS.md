# Semantic Core安定化・第三段階 実施結果

実施日：2026-09-22。対象：[第三段階 実装計画](./SEMANTIC_CORE_STABILIZATION_PHASE3_IMPLEMENTATION_PLAN.md)。

## 実装結果

`module-value-v1`の決定的generated differential testingを、`block`、`variant`、exhaustive `match`へ拡張した。構造化programは独立oracle、reference evaluator、generated TypeScript、JSONC round-trip、Wasmの5 laneで評価し、i32 valueまたは安定fault codeを比較する。

構造化generatorは二つのprogram形状を生成する。内部構築型は`block`内でtagged unionを作ってmatchし、union input型はentry inputのtagged unionをmatchする。どちらも連続binding、payload scope、外側localの参照を含む。`Alpha.alphaValue`と`Beta.betaValue`を別名にして、tagとpayload bindingの取り違えを観測可能にした。固定corpusには正常算術、selected division、非選択caseのdivision by zeroとoverflowを含めた。

oracleはcompilerのchecker、evaluator、parser、emitterを使わず、独自の中立表現、environment stack、plain tagged value、BigInt checked arithmeticで評価する。block bindingは宣言順、matchはscrutineeを一度だけ評価して選択caseだけを実行し、payloadをcase用scopeへ導入する。

既存pure i32 differentialのlane実行部分は内部harnessへ抽出した。公開型と関数、seed `20260921`、case mapping、source、input、CLI契約は維持している。24 generated caseのdigestは`02475040087d4b32bd8a2bb6f031694b0a326ed1a59e1b3b570c060699b2a5ec`、program hash配列のdigestは`580b200027acbad3fd8c5d7593fb30ec46e000ecfe1fc0733c8fd457bb7c8412`で固定し、回帰検査する。

## CLIと再現

`bun run value:structured:differential`はseed `20260922`で64 program／512 inputを実行する。個別再現はseed、case index、input indexを指定する。

```sh
bun run src/llang-value-structured-differential-cli.ts \
  --seed 20260922 --start-case <caseIndex> --cases 1 \
  --input-index <inputIndex> \
  --failure-out artifacts/value-structured-differential-failure.json
```

CLIは重複、未知、欠損、uint32範囲外、複数caseとinput indexの併用を拒否する。一致は終了code 0、semantic mismatchは1、引数・runner・artifact書き込み等の運用失敗は2である。mismatch artifactはatomic writeし、source、oracle表現、選択tag、input、全lane outcome、replay引数を保持する。生成後にchecker、emitter、child process等が失敗した場合も、runner errorとしてcase、source、oracle表現、input集合を保存する。

## mutation検出

固定試験で次の誤りを検出する。

- 5 laneの欠落。
- 非選択match caseの先行評価。
- tagではなくcase配列の位置で分岐を選ぶ挙動。
- tagの入れ替え。
- 誤ったpayloadの使用。
- match caseでの外側local喪失。
- block bindingを独立に評価して前のbindingを失う挙動。
- outcome objectのproperty順への依存。

invalid source、non-exhaustive match、shadowing、malformed union inputはvalid generated corpusへ混ぜず、既存checker試験とdirect memory boundary試験で継続して検査する。

## 実装中に改善した点

最初の構造化generatorはinputだけを乱数化し、24 caseに対してprogram形状が6種類しかなかった。コードレビューで、各caseに決定的な`offsetDelta`を組み込み、意味を保ったままsource自体もseedとcase indexから変化させた。さらにshapeとmodeの選択を分離し、最初の12 caseで2 shape × 6 modeの全組み合わせを通すようにした。match case順も12 caseごとに反転し、tagではなく配列位置に依存する実装を検出する。

固定24 caseでは24種類、明示64 caseでは64種類のprogram hashを確認する。generated caseとprogram hash配列はそれぞれdigest `53b1d32eb49fea480c1ab543282b17c893d4e179a39a771422bacbc7a0e05e44`、`287009d622401c7cda79854e563f1dc8661feda63fe27e8404591214da3be176`で固定した。

compiler本体の意味論不具合は検出されなかった。共通harnessへの抽出後も、第二段階の固定corpusとprogram hash digestは一致した。

## 検証結果

| 検証 | 結果 |
| --- | --- |
| 第二段階baseline | 24 programの固定program hash digest一致、24／192と64／512の5 lane一致 |
| 構造化generator決定性 | seed、case index、input indexから独立再生成功 |
| 構文とtag coverage | block、連続binding、variant、if、match、Alpha／Beta、2 shape × 6 mode、両case順を確認 |
| 独立oracle／mutation | sequential binding、payload scope、outer local、selected caseだけの評価、tag選択、7種の誤りを検出 |
| 構造化固定corpus | 24 program／192 input成功。24種類のprogram hashと固定digest一致 |
| 構造化明示corpus | 64 program／512 input成功。64種類のprogram hash |
| Value固定／memory boundary | 29 test、198 expectation、0 fail |
| install／audit | frozen lockfileに変更なし、109 packageに既知脆弱性なし |
| format／lint／typecheck | 成功。変更対象のlint警告0。全体lintには既存警告87件があるが終了code 0 |
| documentation contracts | 成功。24 command、3 version、JSONC、module、effects smokeを検証 |
| full test | 152 file、806 test、0 fail |
| coverage | 806 test、0 fail。overall functions／lines 90%以上、`semantic-transaction.ts` functions／lines 95%以上の既定閾値を通過 |
| smoke | semantic、L-Lang、module、effectsの全smoke成功 |
| protected inputs | 成功 |
| `git diff --check` | 成功 |

## 保証範囲

固定seedの有限corpusについて、block binding順序、tagged unionの構築またはinput decode、payload scope、outer local参照、matchの選択caseだけの評価が、独立oracleと5実行経路で一致したことを確認する。

これは`module-value-v1`全programの同値性証明ではない。string payload、record／union output、call、import、recursion、物理fuel／allocation量、invalid source、malformed ABI input、Collection、Effectsは対象外である。source schema、language version、ABI、resource limitは変更していない。
