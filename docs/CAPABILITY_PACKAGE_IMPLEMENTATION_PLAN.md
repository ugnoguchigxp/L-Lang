# 次の実装計画：検証付きWasm能力パッケージの提出

2026-09-15。状態：P1〜P5実装済み。検証結果は末尾の結果文書を参照。[実装コンセプト](./AGENT_CAPABILITY_IMPLEMENTATION_CONCEPT.md)のF1と、F2の最小テスト実行部分を対象にする。

## 目的と完了条件

Coding Agentが自然言語Sourceから作ったWasmと、別に作った部品テストを一つの候補として提出できるようにする。提出先はその候補を別ディレクトリへ移して検証を再実行し、どの仕様・バイナリ・テストについて合格したかを機械的に判断できる。

今回の到達点は「SAAAへ渡せる、再検証可能な候補」である。部品テスト合格を能力の配備許可とは扱わない。SAAAの受け入れrunner、能力レジストリ、修正の自動反復は次の計画に分離する。

## 対象範囲

- 既存のpredicate-i32-v1、Prompt Source、Resolution Lock、Wasm生成・読み込みを再利用する。
- Coding Agentが独立したJSONテスト仕様を書き、共通runnerで実行できるようにする。期待値は要求から記述し、実装結果から自動採取しない。
- 実装とテストを別成果物として扱う。今回の「テスト検証コード」は制限した宣言形式と共通実行器の組み合わせとする。任意のJavaScriptを実行する仕組みや、新しいLLMテスト生成adapterは追加しない。
- モデルなしでpackage/verify/inspectできる。既存の意味解決が必要な場合は既存の明示的resolveを先に実行する。

## 提出物の最小契約

新しいCapability Manifestは、既存Build Manifestを変更せず外側に置く。schemaVersion、能力ID・版、目的・適用範囲、profile、boolean出力契約、必要権限（今回は空）、Source・Lock・Build Manifest・Wasm・テスト仕様の相対パスとhashを持つ。入力契約は既存contractを参照し、二重定義を避ける。

packageHashは検証報告を除いたCapability Manifestの正規化内容から計算する。各構成物のhashは保存したbytesを対象にする。既存Source revision等の意味上のhashと混同しない。日時や絶対パスをpackageHashへ含めない。

候補は新規ディレクトリに、完成した構成物からManifestを最後に公開する。既存候補を上書きしない。元Source等の変更との競合を検出し、一貫したsnapshot以外を公開しない。パッケージ内の自己完結したSource/Lock/成果物の対応も検証する。

検証報告は候補の外に保存し、候補自身のhashに含めない。packageHash、検証器の版、各テストの結果、要求ID別の対応、未検証項目、合計、部品検証のpass/fail/errorを記録する。SAAA受け入れは常にnot-runとして明示する。

## テスト仕様

テストsuiteは版、対象Source revision、ケースID、対象要求ID、入力、期待結果を持つ。正常入力のboolean期待値と、不正入力に対する安定したエラーコードの期待を区別する。欠損とundefinedの表現は既存Sourceの規則に合わせる。

正例・負例を必須にし、必須・禁止要求にはケースの対応を要求する。ただし要求IDが付いているだけで意味を網羅した証拠とはしない。未知の要求ID、重複ID、空suite、対応外期待値、過大入力を拒否する。具体的なサイズ・件数上限は既存WASM_LIMITSと整合する定数として実装する。

Source既存例も引き続き実行する。追加suiteはSource例と別に保存し、package/verifyから意味解決モデルへ渡さない。実行時の正解はIRではなくsuiteの期待値を用い、実際のWasmと照合する。

## API・CLI案

以下は新設予定であり、現在利用できるコマンドではない。

```text
capability package <source> --tests <suite> --metadata <file> --out-dir <new-directory>
capability verify <package-manifest> --report <new-report>
capability inspect <package-manifest> --json
```

packageは既存buildを利用して自己完結した候補を作る。verifyは既存runtimeで実行し、LLM、TS scanner、Wasm emitterを必要としない。inspectは内容と整合性を表示し、保存済み報告だけで合格を宣言しない。CLIのJSON出力と終了コードを固定し、0=部品検証合格、1=期待との不一致、2=入力・整合性・実行エラーとする。

verifyは読み込んだsnapshotを対象にし、検証後に内容が変更された候補へ結果を流用しない。将来のSAAA受け入れ・配備側でもpackageHashを照合する必要がある。hashを再計算できる第三者の偽造を防ぐ署名基盤は今回の範囲外である。

## 実装単位

| 順序 | 作業 | 受け入れ条件 |
| --- | --- | --- |
| P1 | Manifest、suite、reportのstrict schemaとhash規則 | 不明項目、不正参照、重複、上限超過を拒否する |
| P2 | 自己完結した候補の組み立てと読み込み | 別ディレクトリへ移動しても検証でき、元ファイル変更や部分出力を成功扱いしない |
| P3 | Wasm部品テストrunnerと結果記録 | 正常・異常入力を実Wasm経路で検証し、failとerrorを分ける |
| P4 | Agent向けCLI/APIと操作例 | JSONで候補・結果を受け渡せ、モデル接続なしで再検証できる |
| P5 | 故障注入、回帰、結果文書 | 誤った条件の候補を検出し、修正版を別候補として合格させる |

コードはcapability-package、capability-tests、capability-cliを目安に分離する。既存のprompt-wasm、wasm-artifact、wasm-runtime、contained-pathの検証を再利用し、必要な責務分離に留める。

## 縦断例と重要な失敗試験

「有効かつ利用停止中でない利用者だけを許可する」能力を使う。Source例と追加suiteを分け、追加suiteで停止中の利用者を拒否することを確認する。

1. 正しい候補を作り、別ディレクトリ・別プロセスでverifyして合格する。
2. 停止条件を欠いた、Source例だけでは見逃す候補を用意し、追加suiteで失敗させる。
3. 修正版を新しい候補として提出し、同じsuiteで合格させる。この再提出は今回手順で行い、自動修正loopにはしない。
4. Source、Lock、Wasm、suiteの差し替え、別候補の報告流用をhashと対応検査で検出する。
5. package外へのパス、symlink、欠損物、途中の公開物を拒否する。
6. 生成・読み込み中の変更、既存出力との衝突で古い候補を破壊しない。
7. verifyの依存経路にモデル・コンパイラが入らず、合格結果にもSAAA受け入れnot-runが残る。

生成suiteの質そのものは、このrunnerだけでは保証できない。意図的な誤実装の検出は今回の実行証拠とし、汎用mutation engineや実モデルのテスト生成精度評価は後続に回す。

## 検証と完了報告

変更箇所のテストに加え、リポジトリのformat、lint、typecheck、coverage、smoke、protected inputs、Markdownリンクの既存Gateを通す。パス処理やファイル公開を追加するため、対応OSのCIも確認する。

完了報告には候補の作成・検証コマンド、成功と故障注入のreport、packageHash、実行環境、モデルAPI呼び出し0回、未実装のSAAA受け入れを記載する。部品検証の合格から実モデル精度や実SAAA連携の成功を主張しない。

この計画の実装には、人間による4ケースの都度承認、実SAAAへの接続情報、有料API実行は不要である。完成後は同じpackageHashを対象にSAAAの受け入れ記録を追加する計画へ進める。

## 実装の参照先

[操作例](../examples/capability-access/README.md)と[実装結果](./CAPABILITY_PACKAGE_RESULTS.md)を参照する。CLI/APIとJSON suite、report parserを追加し、テストは任意コードの実行ではなく共通runnerを使う。
