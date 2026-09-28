# Semantic IRを介したLLM生成と再現可能なWebAssembly実行の接続

## L-Langの設計・実装と限定Predicateにおける実現可能性検証

草稿 v0.2／2026-09-27。関連文書：[根拠充足の作業一覧](./PAPER_EVIDENCE_PLAN.md)、[方式と実装対応](./PAPER_METHOD.md)、[関連研究](./PAPER_RELATED_WORK.md)。

> 執筆用注記：本稿は実装と保存済み記録、および2026-09-27のオフライン再検証に基づく。実モデルを新たに呼び出した評価ではない。追加課題のfixture結果を研究結果として扱わない。

## 概要

大規模言語モデル（LLM）による生成を実行可能なプログラムへ接続するには、生成結果を検査し、採用した処理を実行物として固定する仕組みが必要である。本研究では、自然言語の要求と入力契約を含む構造化入力からSemantic IRを生成し、検査、保存、コンパイルを経てWebAssembly（Wasm）として実行する方式を設計し、L-Langとして実装した。Semantic IRを境界として生成とコンパイルを分離し、採用したIR、入力契約、ビルド条件を固定した後は、LLMを再実行せずに実行物を再構築する。

限定Predicateの受付判定1課題について、保存済みの実モデル応答からIRの採用とWasm生成に至る記録を確認した。現在の実装によるオフライン再生では10件の検証が成功した。また、過去の成果物、保存応答の再生結果、独立した2回のCLIビルドで、147 bytesのWasmがバイト単位で一致した。本結果は、対象事例と確認した環境における生成から実行への接続および再構築の実現可能性を示す。一般的な生成成功率、任意の要求との意味的一致、異なるビルド条件間の再現性は評価対象に含めない。

## 1．はじめに

LLMを用いて処理を生成する際、生成結果を得ること、コンパイルできること、要求に沿って実行できること、過去の実行物を再構築できることは、それぞれ異なる問題である。プロンプトのみを保存しても、採用したプログラム自体を保存したことにはならない。そのため、生成の起点と、採用した処理の記録を分けて管理する必要がある。

本研究では、LLMの生成先として、構文と意味を制限したSemantic IRを用いる。生成されたIRを検査し、採用した結果を保存したうえでWasmへ変換する。ここでいうSemantic IRは自然言語の意味を完全に形式化するものではなく、対象の処理をコンパイラが検査・変換できる形で表す中間表現である。

本稿で示す成果は、以下の三点である。

1. 構造化された要求から、LLMによるIR生成、検査、Wasm生成、実行検証までを接続する実装。
2. 採用済みIRと入力契約を保存し、生成モデルを再実行せずに実行物を再構築する構成。
3. 限定Predicateの事例における実行検証と、保存済み成果物を含めたWasmバイト列の一致確認。

自然言語からDSLを作ることや、固定入力から同じバイナリを作ること単独は新規性として主張しない。本稿の貢献は、限定Predicateでこれらの工程を保存可能な境界と検査に接続し、その成立範囲を具体的な証跡で示すことである。比較対象と根拠は[関連研究](./PAPER_RELATED_WORK.md)に示す。

## 2．研究課題と対象範囲

本研究の研究課題は次のとおりである。

- **RQ1：** 自然言語要求と入力契約を与えたLLMの出力を、検査可能なIRを介してWasm実行へ接続できるか。
- **RQ2：** 保存済みIR、入力契約、ビルド条件を用いて、LLMを再実行せずに同一のWasmバイト列を再構築できるか。
- **RQ3：** 対象事例のWasmが、指定した入力と期待結果に対して整合した動作をするか。

現時点の実モデル事例は、`predicate-i32-v1`の受付判定1課題である。起点は自然言語要求、要求項目、型契約、検証例を含む固定JSONである。このJSON自体を上位LLMが生成した記録は、今回の確認範囲にはない。上位LLMが要求を出力する構成は想定できるが、本稿の実証範囲とは区別する。

L-Langには他のprofileも存在するが、コンパイラが対応する機能の広さと、実モデルによる生成を確認した範囲は別である。本稿の中心的な結果をCollectionやEffects全体へ一般化しない。

## 3．方式の設計

### 3.1．生成から実行まで

```text
自然言語要求＋入力契約
          │
          ├─ 生成指示・出力schemaを付与
          ↓
     LLMによるPredicate IR生成
          ↓
     構文・型・制約・Source例の検査
          ↓
     採用IRをLockとして保存
          ↓
     WasmCoreへのlowering
          ↓
     BinaryenによるWasm生成
          ↓
     hostで実行し、期待結果と照合
```

生成物を受理するための構文、型、利用可能な操作は実装側で定める。モデルの応答を無条件に実行へ渡すことはしない。コンパイル成功と要求への適合は分けて判定する。

### 3.2．生成の方向づけと人間の役割

人間が事前に用意するものには、IR仕様、生成指示、出力schema、検査器、コンパイラ、host実行環境がある。今回の事例では、課題の要求と入力契約も固定入力として与えている。

実装生成の指示では、`all`、`any`、`not`、`equals`、`present`によるPredicate IRを要求し、単一フィールドの参照、booleanまたは宣言されたenumの比較などに範囲を制限する。IO、時計、暗黙の型変換などを生成対象から除外し、表現できない場合には未解決として返すよう指定する。

テスト生成と実装生成は別の呼出しとして行う。実装は初回候補が不合格の場合に最大1回の修正を扱う。今回の保存記録では初回候補が合格しており、修正試行は記録されていない。ただし、元の要求を作成した過程や記録外の作業まで無介入だったと主張するものではない。役割と開示情報は[方式と実装対応](./PAPER_METHOD.md)にまとめる。

### 3.3．Semantic IRと保存境界

本稿の実証対象となるSemantic IRは、限定Predicateの木構造である。受付判定の生成結果は次の形を持つ。

```json
{
  "kind": "all",
  "conditions": [
    { "kind": "equals", "property": ["enabled"], "value": true },
    {
      "kind": "not",
      "condition": {
        "kind": "equals", "property": ["suspended"], "value": true
      }
    }
  ]
}
```

LockにはIR本体、Sourceのhash、IRのhash、モデル応答に関する情報などを保存する。入力契約はSource側に保持する。保存されたIRは採用した処理の記録であり、要求解釈の完全な正しさを証明するものではない。

L-LangのSemantic Coreはprofile別の意味契約を含む名称であり、全機能を一つのIR型やserialize形式で扱うことを意味しない。本稿ではPredicate IR、lowering後のWasmCore、生成されたWasmを区別する。構文・意味規則とコードの対応は[方式と実装対応](./PAPER_METHOD.md)に示す。

### 3.4．決定的コンパイルと再構築

採用済みIRをI、入力契約をK、ビルド条件をB、WasmをWとすると、後段の処理を `W = C(I, K, B)` と表す。Bにはコンパイラ、依存ライブラリ、設定などを含める。

本稿でいう再現性は、固定された入力と確認したビルド条件で、再構築したWasmがバイト単位で一致することである。同じプロンプトから同じIRが再生成されることを要求するものではない。また、同じIR本体でも入力契約が異なれば、同じWasmになるとは限らない。

IRと入力契約を保存することで、再構築にモデルの再呼出しが不要になる。一方、再現可能な実行物であっても、誤った要求解釈を実装している可能性は残る。再現性と要求への適合を別々に検証する。

## 4．実装

実装の主な責務を表1に示す。

| 表1：処理 | 実装 | 内容 |
| --- | --- | --- |
| モデル接続 | [codex-development-agent.ts](../src/codex-development-agent.ts) | 生成指示と入力を送信し、schema付きJSON応答を受け取る |
| 製造の制御 | [capability-development.ts](../src/capability-development.ts) | テストと実装の生成、候補検証、記録、保存応答の再生 |
| IRの採用と保存 | [prompt-resolution.ts](../src/prompt-resolution.ts) | 応答とSource例の検査、Lockの保存・照合 |
| lowering | [wasm-core.ts](../src/wasm-core.ts) | 契約と式を検査し、フィールド参照をslotに変換 |
| Wasm生成 | [wasm-emitter.ts](../src/wasm-emitter.ts) | Binaryenの命令生成と構造検証、バイト列の出力 |
| 成果物記録 | [prompt-wasm.ts](../src/prompt-wasm.ts) | IRと契約からのbuild、manifestとhashの記録 |
| 実行 | [wasm-runtime.ts](../src/wasm-runtime.ts) | Wasmのcompile・instantiate、入力を受けた評価 |

Predicate emitterは論理演算や比較をWasm命令へ変換する。確認した実装はBinaryen 132.0.0を使用し、manifest上の設定は`mvp-no-optimization`である。BinaryenとWebAssemblyによる構造検証を行うが、これらを要求に対する正しさの検証とは扱わない。

Wasmはhostから呼び出して実行する。今回の入力契約に対する不正入力の拒否はhost側の処理を含むため、不正入力試験の成功をWasm単体の型検査の証拠とはしない。

## 5．評価方法と結果

### 5.1．証拠の区分

本稿では、過去の実モデル生成記録、現在のオフライン再検証、固定ソースの変換試験を区別する。保存記録は過去の呼出しを記録したartifactであり、今回API通信を独立に観測したものではない。

2026-09-27の裏取り時のリポジトリHEADは`4b5073d4d8f3810719cd5b9f0d13aaeeb499f972`である。オフライン再検証はBun 1.4.2、macOS、arm64で実施した。元のlive実行時の正確なcommitと環境の対応は補完を要する。［E01・E02］

### 5.2．実モデル生成の保存記録

受付判定の要求は「有効かつ利用停止中でない利用者だけを受け付ける」であり、`enabled`と`suspended`をbooleanとして定義する。

保存された`run.json`は`mode: live`であり、指定モデル`gpt-5.6-terra`、provider`codex-sdk/medium`、テスト生成と実装生成の2呼出し、その応答を含む。記録上の候補は初回に合格した。元の実測の説明は[SDK接続の実測記録](./CODEX_SDK_PI_EVALUATION.md)にある。

この1課題を一般的な生成成功率へ換算しない。また、固定要求そのものを上位LLMが生成したことは確認していない。

### 5.3．保存応答による再生と実行

保存応答を用いて製造経路を再生し、IRの検査、Lock保存、Wasm生成、候補検証を行った。結果は`pass`で、10件成功、失敗0件、エラー0件だった。Source例が2件、別呼出しで生成されたsuiteが8件である。再生照合は`comparable: true`、`match: true`、API呼出し数は0だった。

suiteは実装の生成とは別に作られるが、同じ要求とモデル系統を用いるため、完全に独立した正解の根拠とはみなさない。別途定義した[8件のOracle](../research/paper-v1/access-oracle.json)は全件passした。未知field、型不一致、Lock・契約・Wasm改変を対応する層で検出し、合法だが誤ったIRは`enabled=true, suspended=true`でOracleが検出した。ただしOracleは未reviewであり、独立した人間による期待値確定は残る。検出段階は[結果記録](./PAPER_EVIDENCE_RESULTS.md)に示す。

追加4課題のfixtureでは、生成passの3 trialについてOracleの全case結果をsidecarに保存した。reportは対象candidate・Wasm・契約・Oracle・developmentとのhash対応とcase判定を再計算し、3件の照合済みpassを得た。これは採点記録の実装確認であり、新規live実測ではない。旧runのOracle passはcase別記録がない自己申告として区別する。case記録のchecksumは外部的な真正性を保証せず、課題とOracleの独立reviewも未了である。

### 5.4．Wasmのバイト再現性

以下の4ファイルを比較した。

| 表2：Wasmの出所 | サイズ | 比較結果 |
| --- | --- | --- |
| 過去の実モデル生成記録に同梱された成果物 | 147 bytes | 基準 |
| 今回の保存応答の再生結果 | 147 bytes | 基準とバイト一致 |
| 保存済みIR・契約からのCLI build A | 147 bytes | 基準とバイト一致 |
| 保存済みIR・契約からのCLI build B | 147 bytes | 基準とバイト一致 |

共通のSHA-256は`a7cceacc4f1a3f2a4738bbdc72986df166f972bd316e6bc0b029816c4ecf28dd`だった。CLI build AとBは別プロセスで実行し、比較ではhashに加えてファイルのbytesを直接照合した。

これは1課題の再構築結果であり、全IR、全OS、任意の依存バージョンでの一致を証明しない。再生と2回のbuildを[`paper-reproduce.ts`](../src/paper-reproduce.ts)で一括実行し、著者の隔離snapshotのクリーンcloneでも確認した。第三者環境での確認は残る。

### 5.5．固定ソースからの複数出力経路

[source-output-matrix](../examples/source-output-matrix/README.md)を再実行した。TypeScript／JSONCからTypeScript／Wasmへの4経路について、各4件の真理値表と3件の不正入力を検証した。runnerは成果物を移動し、ビルド作業ディレクトリを削除した後に別プロセスでも動作を確認する。

この例のTypeScript由来とJSONC由来のWasmは、ともに146 bytesで、hashが一致した。ただし表2の147 bytesの成果物とは別の入力契約・生成経路の試験であり、同一artifactとして扱わない。

本試験は固定ソースの変換を支持する。LLMによる生成成功や、一般のTypeScriptプログラムへの対応を示すものではない。

## 6．考察

本事例は、要求と入力契約を固定し、生成可能な構文を制限することで、LLMが出力したIRを実行可能なWasmへ接続できることを示している。生成の方向づけ、検査器、コンパイラ、hostは、方式を成立させる構成要素である。

採用済みIRを保存することで、生成と再構築を別の工程として扱える。要求に対するIRの誤りと、IRからWasmへの変換の誤り、実行環境の不整合を分けて調査できる構成となる。ただし、この構成による調査時間の短縮や人間の理解改善は評価していない。

表現力の制限は、検査と変換を構成しやすくする一方、扱える要求を限定する。課題の追加評価では、表現できなかった要求や未解決応答、検査失敗も残し、成功例の選別によって成立範囲を広く見せないことが必要である。

IRを介した決定的コンパイル自体の新規性を主張するのではなく、要求、生成制約、IR保存、実行物構築を接続する具体的設計と成立条件を論じる。既存方式との差は関連研究の調査後に確定する。

## 7．限界と妥当性への脅威

- **課題の規模：** 実モデル記録の中心例は二つのbooleanによる1課題であり、広い生成能力を代表しない。
- **要求の出所：** 自由な自然言語だけでなく、型契約などを含む固定JSONを用いている。上位LLMからの要求生成は未確認である。
- **正解の独立性：** 別呼出しで作成したsuiteにも共通の誤解が入り得る。要求から別に定義したOracleは未reviewであり、独立した期待値レビューが必要である。
- **再現条件：** 現在のローカル環境と、著者が作成した隔離snapshotのクリーンcloneで再構築を確認した。第三者環境での再現は未確認である。
- **記録の保存：** 元のlive記録と今回の生データはGit管理外の`artifacts/`にある。第三者が利用できる証拠パッケージは未整備である。
- **保証範囲：** 有限の試験から一般的な意味保存、自然言語要求の完全充足、運用安全性を結論しない。

## 8．関連研究

自然言語からDSL式を構成する研究には[Desaiら](https://arxiv.org/abs/1509.00413)があり、LLM補完をDSL合成に用いる研究には[HYSYNTH](https://arxiv.org/abs/2405.15880)がある。Wasmのvalidationとexecutionは[標準仕様](https://www.w3.org/TR/wasm-core/)で定義されている。bit単位の一致は[Reproducible Buildsの定義](https://reproducible-builds.org/docs/definition/)に沿う局所的な確認であり、[SLSA Provenance](https://slsa.dev/spec/v1.1/provenance)が扱うbuild証明は本稿に含まない。各研究との対応は[関連研究](./PAPER_RELATED_WORK.md)に記録した。

## 9．結論

自然言語要求と入力契約からLLMが生成した限定Predicate IRを検査・保存し、Wasmへコンパイルして実行する方式をL-Langとして実装した。保存済み実モデル記録を用いた再検証では10件の実行検証に成功し、過去の成果物と今回の再生・再ビルド結果がバイト単位で一致した。

本結果は、採用したIRと契約を境界として生成とコンパイルを分離し、モデルを再実行せずに実行物を再構築する方式の実現可能性を、限定した事例で支持する。追加課題はfixtureで評価経路を検査したが、新規live評価は未実施である。今後は課題とOracleの独立review、実行条件の確定、クリーン環境での再現、および証拠の配布を進める。

## 付録：証跡の所在

以下はリポジトリルートからの相対パスで、Git管理外のローカル証跡である。他のcheckoutで存在するとは限らない。

| 証跡 | パス |
| --- | --- |
| 元の実モデル記録 | `artifacts/codex-terra/access-live/run.json` |
| 固定要求 | `artifacts/codex-terra/access-live/source.json` |
| 保存IR | `artifacts/codex-terra/access-live/attempt-0/source.json.lock.json` |
| 今回の再生結果 | `artifacts/paper-audit-20260927-replay/replay-check.json` |
| 今回の実行検証 | `artifacts/paper-audit-20260927-replay/attempt-0/report.json` |
| バイト比較の集計 | `artifacts/paper-audit-20260927-summary.json` |
| 独立CLI build | `artifacts/paper-audit-20260927-build-a/`、`artifacts/paper-audit-20260927-build-b/` |
| 4経路の実行結果 | `artifacts/paper-audit-20260927-matrix/comparison.json` |

［E01・E02・E10：これらを入力・実行条件・再生成手順と結び付け、永続的な配布先へ整理する。］

第四弾の実装では、新規study runの検査済み入力をrun内のsnapshotへ保存し、実行・再開・集計時にrunと照合する。元入力を全ファイル同時刻に取得したことや、書込み権限を持つ別processに対する完全な不変性は保証しない。新規live評価と独立reviewは未実施である。
