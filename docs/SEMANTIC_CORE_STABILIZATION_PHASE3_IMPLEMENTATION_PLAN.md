# Semantic Core安定化・第三段階 実装計画

作成日：2026-09-22。状態：完了。実施結果は[第三段階の結果](./SEMANTIC_CORE_STABILIZATION_PHASE3_RESULTS.md)を参照。

## 目的

[第二段階の結果](./SEMANTIC_CORE_STABILIZATION_PHASE2_RESULTS.md)で確立した決定的generated differential testingを、`module-value-v1`の`block`、`variant`、`match`へ拡張する。同じ生成programとinputを、独立oracle、reference evaluator、generated TypeScript、JSONC round-trip、Wasmで評価し、observable outcomeが一致することを確認する。

この段階では、構造化制御の意味論とscope境界を検証する。既存のpure i32 corpus、公開API、seedからcaseを導く規則、失敗artifactの再現性は維持する。言語仕様、source schema、ABI、実行制限は変更しない。

## この対象を選ぶ理由

第二段階は算術式と`if`を対象にしたが、`module-value-v1`には次の証拠の空白が残っている。

- `block`のbindingが宣言順に評価され、前のbindingを後のbindingから参照できること。
- `match`で選択されたcaseだけが評価されること。
- variantのpayload fieldが選択case内だけに導入されること。
- match caseから外側のlocalを参照できること。
- tagged unionのtagとpayloadがTypeScript、JSONC、Wasmの各経路で同じ意味を持つこと。

これらは既存の固定試験でも個別に確認しているが、組み合わせたprogramを独立oracleと複数backendで比較するgenerated differentialはない。Collectionは別の意味論とruntimeを必要とし、Effectsはhost環境、resource単位、並行順序の設計判断が先に必要なため、この段階には含めない。

## 前提と不変条件

- 正本の仕様は[Value Module仕様](./LLANG_MODULE_VALUE_SPEC.md)と[Observable Semantics](./LLANG_OBSERVABLE_SEMANTICS.md)とする。本計画は仕様変更の根拠にしない。
- 現行のexpression node、expression depth、local、type depth、type node、evaluation stepの各上限を使用する。generator専用の例外を設けない。
- 生成programはcheckerを通過するvalid programに限定する。checkerが拒否した場合はsemantic mismatchではなくgenerator defectとして扱う。
- observable outputはi32に固定する。tagged unionはinputまたは中間値として使い、record／unionをentry outputにしない。
- observable faultは`ARITHMETIC_OVERFLOW`と`DIVISION_BY_ZERO`に限定する。未知exception、process失敗、invalid artifactをsemantic faultへ変換しない。
- 第二段階のseed `20260921`、case mapping、program source、program hash、input、case数、既存CLI出力を変更しない。
- API credential、外部network、新しいruntime dependencyを必要としない。

## 対象subset

### 型

- i32。
- required i32 fieldを持つrecord。
- payloadを持つ2 variantのtagged union。variant数を2に固定し、両方のtagを固定corpusで選択する。
- entry outputはi32。

### 式

- 第二段階で扱ったliteral、param、field、unary minus、checked算術、比較、`if`。
- `block`と宣言順のbinding。後のbindingは前のbindingと外側scopeを参照できる。
- `variant`によるtagged unionの構築。
- exhaustiveな`match`。各caseはpayload fieldと外側scopeを参照できる。
- 選択されない`if` branchと`match` caseは評価しない。

### 生成programの形

生成器は少なくとも次の2系統を持つ。いずれも最終結果をi32にする。

1. **内部構築型**：record inputから`block`内で中間localを作り、条件に応じてvariantを構築し、その値を`match`する。constructor、binding順序、tag選択、payload scopeを一つのprogramで検証する。
2. **union input型**：entry inputにtagged union fieldを持たせ、その値を`match`する。source codecとWasm ABIを経由したtag／payload選択、および外側localのcaptureを検証する。

各系統には正常値に加え、非選択caseにoverflowまたはzero divisionを置くcaseを含める。正常終了したとき、非選択caseを先行評価していない証拠になる。逆に選択caseで同じfaultを発生させるinputも含め、faultを無視していないことを確認する。

## 独立oracle

第二段階のBigInt算術規則を再利用可能な小さいprimitiveとして残し、その上に構造化式用oracleを追加する。oracleはcompilerのchecker、reference evaluator、source parser、emitterを呼び出さない。

oracleが直接扱う表現は、literal、param、field、local、unary、binary、if、block、variant、matchとする。値はplainなi32、record、`{ tag, fields }`相当のtagged valueで表現する。

scopeは明示的なenvironment stackで実装し、次を独立に判定する。

- `block` bindingを宣言順に一度ずつ評価する。
- 後のbindingから、それ以前のbindingを参照できる。
- `match`はscrutineeを一度評価し、tagに対応する一つのcaseだけを評価する。
- payload fieldは選択case用の内側scopeへ導入する。
- case内ではpayload fieldに加えて外側localも参照できる。
- caseを抜けた後にpayload fieldを残さない。
- checked i32のoverflow、division by zero、truncation、remainderの規則を維持する。

独立性を保つため、checkerが受理した内部ASTをoracleへそのまま渡さない。generator自身の中立なcase modelから、oracle expressionとL-Lang sourceを別々に組み立てる。

## 実装構成

既存の`src/llang-value-differential.ts`を全面的に一般化しない。pure i32 generatorと公開APIを維持しながら、lane実行の機械的な部分だけを内部harnessへ抽出し、構造化generatorは別moduleに置く。

| 対象 | 内容 |
| --- | --- |
| `src/llang-value-differential-harness.ts` | source load、reference、generated TypeScript、JSONC round-trip、Wasmの実行、outcome正規化、5 lane必須検査。製品向け公開APIにはしない |
| `src/llang-value-differential.ts` | 既存pure i32 generator、oracle、公開型、seed／case mappingを維持。共通処理だけをharnessへ委譲 |
| `src/llang-value-structured-differential.ts` | 構造化case model、決定的generator、独立oracle、reproduction生成 |
| `src/llang-value-structured-differential-cli.ts` | seed／case range指定、machine-readable report、atomic failure artifact保存 |
| `src/llang-value-structured-differential.test.ts` | 決定性、scope、遅延評価、tag／payload、mutation検出、固定corpus、replay |
| `package.json` | `value:structured:differential` script |
| 文書 | 本計画、実施結果、文書一覧。実装完了時に品質Gateの対象を更新 |

harness抽出で既存挙動が変わる危険を抑えるため、着手前に第二段階の固定seedからsource、input、program hash、outcomeのbaselineを記録する。抽出後に同じ値であることを試験し、差分があれば構造化generatorの作業へ進まない。

## 決定性と再現

構造化corpusは第二段階と別のformatおよびseedを持つ。

- format：`llang-value-structured-differential-v1`
- fixed seed：`20260922`
- 通常test：24 program、各8 input、合計192 input
- 明示的corpus：64 program、各8 input、合計512 input

caseの乱数状態はuint32 seedとuint32 case indexから独立に導出する。前のcaseを実行せず、seedとcase indexだけから同じsource、oracle model、inputを再生成できるようにする。case rangeがuint32末尾を越える指定は拒否する。

失敗artifactには次を含める。

- format、seed、case index、input index。
- program系統、source、独立oracle expression、input、選択予定のtag。
- oracle、reference、generated TypeScript、JSONC round-trip、Wasmの全outcome。
- 単一caseを再生するCLI引数。
- runner errorの場合はsemantic faultと区別できる分類とmessage。

CLIの終了codeは、一致を0、semantic mismatchを1、引数・生成・runner・artifact書き込み等の運用失敗を2とする。failure artifactは一時fileからrenameするatomic writeとし、既存fileを途中状態で残さない。

## mutation試験

固定corpusが偶然通るだけでないことを、比較器とoracleの境界に意図的な誤りを注入して確認する。

- 5 laneの一つが欠けた結果を拒否する。
- 全match caseを先行評価する実装を検出する。
- tagではなくcase配列の位置で分岐を選ぶ実装を検出する。
- tagを別variantへ入れ替える実装を検出する。
- 選択tagと異なるpayloadを読む実装を検出する。
- match case内で外側localを失う実装を検出する。
- block bindingを独立評価し、前のbindingを見失う実装を検出する。
- outcome objectのproperty順に依存しない。

non-exhaustive match、重複case、shadowing、未知tag、malformed ABI inputはvalid generated corpusへ混ぜない。これらは既存checker／memory boundary試験の責務として維持する。

## 作業項目

### SC3-01：baselineの固定

- seed `20260921`の既存24 program／192 inputと64 program／512 inputを実行する。
- source、input、program hash、outcomeがharness抽出前後で一致する回帰試験を追加する。
- 既存CLIのoption、JSON field、終了code、failure artifact形式を変更しない。

完了条件：第二段階の固定corpusがbyte-levelのsourceとsemantic outcomeの両方で不変である。

### SC3-02：共通lane harnessの抽出

- sourceを一度検査し、5 laneを同一program／inputで実行する内部APIを抽出する。
- generated TypeScriptは空の環境変数と5秒timeoutを持つ子プロセスで実行する。
- unknown exception、process timeout、invalid resultをsemantic faultに丸めない。
- lane completenessと安定したoutcome比較を一か所に置く。

依存：SC3-01。完了条件：既存試験とbaselineが無変更で通過する。

### SC3-03：構造化case modelとgenerator

- 内部構築型とunion input型を決定的に生成する。
- 2 variant、payload、blockの連続binding、outer local captureを必須要素にする。
- 正常、active fault、inactive faultのinputを各caseへ含める。
- depth、node、local、type、evaluation step上限を余裕を持って下回る生成budgetを定数化する。

依存：SC3-02。完了条件：全固定caseがcheckerを通り、両系統、両tag、全必須構文がcorpusに現れる。

### SC3-04：独立構造化oracle

- environment stackとplain tagged valueを実装する。
- sequential binding、選択caseのみの評価、payload scope、outer local参照を実装する。
- compiler内部ASTやreference evaluatorに依存していないことをimport境界と試験で確認する。

依存：SC3-03と並行可能。完了条件：手書きboundary vectorとmutationでscope／評価順序の誤りを検出する。

### SC3-05：5 lane比較とreproduction

- 構造化oracleの期待値と5 laneを比較する。
- mismatch時に全情報を保持するreproductionを生成する。
- 一つのcaseとinputを指定して再生できるAPIを設ける。

依存：SC3-02〜SC3-04。完了条件：意図的なlane差分を検出し、保存した引数で同じ反例を再現できる。

### SC3-06：CLIと運用境界

- strictなoption parserを実装し、重複、未知、欠損、uint32範囲外を拒否する。
- success、mismatch、operational errorをmachine-readable JSONと終了codeで区別する。
- failure artifactをatomic writeする。

依存：SC3-05。完了条件：正常実行、単一case replay、不正引数、書き込み失敗の試験が通る。

### SC3-07：固定corpusと回帰試験

- 通常の`bun test`へ24 program／192 inputを組み込む。
- 明示scriptで64 program／512 inputを実行する。
- 既存block／match／union固定試験とmemory boundary試験も同時に実行する。
- mutation試験で各意味論上の誤りを確実に検出する。

依存：SC3-05、SC3-06。完了条件：固定seedの全laneがoracleと一致し、mutationが少なくとも一件の反例を返す。

### SC3-08：文書と品質Gate

- 実施結果に対象revision、corpus規模、検出した問題、全Gate結果、未保証範囲を記録する。
- Observable Semanticsと品質Gateは、実装事実が変わる箇所だけを更新する。
- format、lint、docs、typecheck、full test、coverage、smoke、protected input、diff checkを実行する。

依存：SC3-07。完了条件：すべての必須Gateが成功し、未実行または失敗を成功として記載していない。

## 実装順序

```text
SC3-01 baseline
  -> SC3-02 harness抽出
      -> SC3-03 generator ----+
      -> SC3-04 oracle -------+-> SC3-05 5 lane比較
                                      -> SC3-06 CLI
                                      -> SC3-07 corpus／回帰
                                          -> SC3-08 文書／全Gate
```

SC3-03とSC3-04は表現のinterfaceを先に固定した後なら並行できる。それ以外は前段の不変条件を確認してから進める。

## 受け入れ条件

- [x] 第二段階のseed、case mapping、source、input、program hash、outcome、公開API、CLI契約が変わらない。
- [x] 固定corpusに`block`、連続binding、`variant`、exhaustive `match`が含まれる。
- [x] 内部構築型とunion input型の両方を実行する。
- [x] 2 variantの両tagが選択され、payloadを結果計算に使用する。
- [x] 後のblock bindingから前のbindingを参照するcaseがある。
- [x] match caseから外側localとpayload fieldを同時に参照するcaseがある。
- [x] inactive caseのoverflow／zero divisionを評価せず、active caseの同じfaultは観測する。
- [x] 独立oracleがcompilerのchecker、reference evaluator、parser、emitterに依存しない。
- [x] oracle、reference、generated TypeScript、JSONC round-trip、Wasmの5 laneが一致する。
- [x] lane欠落、eager match、case位置依存、tag swap、payload誤読、scope喪失、binding順序違反のmutationを検出する。
- [x] 同じseed／case index／input indexから同じ反例を再現できる。
- [x] mismatch artifactがatomicに保存され、全lane outcomeとreplay引数を含む。
- [x] 通常testで24 program／192 input、明示scriptで64 program／512 inputを実行する。
- [x] API credential、外部network、新規dependencyを必要としない。
- [x] full quality gatesが成功し、coverage閾値を下げない。

## 非対象

- string演算、string payload、record／unionのentry output。
- function call、import、recursion、closure、Collection、Effects。
- invalid source、non-exhaustive match、重複case、shadowingの自動生成。
- malformed tagged union input、未知tag、範囲外pointer等のdirect Wasm negative vector。既存memory safety試験を維持する。
- backend間の物理fuel、命令数、memory allocation量の一致。
- 全programの形式的同値性証明、coverage-guided fuzzing、shrinker。
- source schema、language version、ABI、resource limitの変更。
- corpus数を増やすだけの探索。証拠の独立性とmutation検出を優先する。

## 失敗時の扱い

- checker拒否はgenerator defectとしてsourceとcase modelを保存し、semantic mismatchと区別する。
- lane mismatchが出たら、正規化対象を拡大して差分を消さない。まず単一caseで再現し、独立oracleと仕様を照合する。
- compiler defectを確認した場合は、手書きの最小固定回帰試験を追加してから修正する。generatorのseedだけに回帰を依存させない。
- generator／oracle defectを確認した場合も、発見した反例を固定試験へ昇格してから修正する。
- timeout、child process異常終了、artifact parse失敗、artifact書き込み失敗はrunner／operational errorとして終了code 2で報告する。
- 既存pure i32 baselineが変わった時点でharness抽出を中断し、構造化拡張と同じ変更で正当化しない。

## 検証コマンド

局所検証：

```sh
bun test src/llang-value-differential.test.ts --timeout 30000
bun test src/llang-value-structured-differential.test.ts --timeout 30000
bun run value:differential
bun run value:structured:differential
bun test src/llang-module-value*.test.ts --timeout 30000
bun test src/llang-value-wasm-memory*.test.ts --timeout 30000
```

単一case replay：

```sh
bun run src/llang-value-structured-differential-cli.ts \
  --seed <seed> --start-case <caseIndex> --cases 1 \
  --input-index <inputIndex> \
  --failure-out artifacts/value-structured-differential-failure.json
```

最終検証は[品質Gate](../QUALITY_GATES.md)の必須項目を順に実行する。少なくともfrozen install、audit、format、lint、documentation contracts、typecheck、full test、coverage、smoke、protected input、`git diff --check`を含める。実施結果にはcommand、対象revision、件数、成否を記録する。

## 完了時に残す証拠

- 第二段階baselineが不変である試験結果。
- 構造化固定corpusのseed、program数、input数、構文／tag出現数。
- 5 lane一致結果とmutation検出結果。
- 単一case replayとfailure artifactのsample schema。
- 全品質Gateの実行結果。
- 発見したcompiler、generator、oracle、runnerの問題と修正内容。
- 有限corpusであり、`module-value-v1`全体の同値性証明ではないという保証境界。
