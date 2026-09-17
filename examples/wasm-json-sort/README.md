# JSON配列のソート：生成TypeScriptと生成Wasmの比較

約100KiBのJSONを`name`・`age`・`race`で昇順に並べ替える実験です。同じ[入力プログラム](./sort.jsonc)からExample専用コンパイラがTypeScriptとWasmを出力し、両方の結果・計測値を保存します。[初回の実測結果](./RESULTS.md)と[最適化の段階的調査](./STAGED_RESULTS.md)も参照してください。

**標準L-Langのソート対応を意味しません。** 現行の`llang` CLIが扱うPredicate profileには配列・数値比較・ループ・memoryがありません。このExampleは別の実験用profile `json-sort-i32-v1`を実装しています。固定された5種類のアルゴリズムのTS/WATテンプレートを使う小さなコンパイラであり、任意のTypeScriptのWasm化や、自然言語からのアルゴリズム生成ではありません。標準コンパイラ・runtimeには変更を加えていません。

## 実行

リポジトリのルートで、既存のBun・Binaryen依存を使って実行します。C/Rust/LLVMの追加インストールやAPIキーは不要です。

```bash
bun run examples/wasm-json-sort/run.ts
```

デフォルトでは[同梱データ](./data.json)を使い、3キー×5方式の15通りを実行します。出力先は`artifacts/wasm-json-sort/<時刻>/`です。最後に表と出力先を表示します。

```bash
# 年齢をヒープソートで並べ替える
bun run examples/wasm-json-sort/run.ts --key age --algorithm heap

# 1MiBのデータを生成して計測（大きな入力では二乗時間の方式に注意）
bun run examples/wasm-json-sort/run.ts --bytes 1048576 --algorithm heap

# 別のJSON配列を使用する
bun run examples/wasm-json-sort/run.ts --input examples/wasm-json-sort/data.json

# 測定条件を明示する例。出力先は未作成のディレクトリを指定する
bun run examples/wasm-json-sort/run.ts \
  --samples 15 --warmup 30 --iterations 10 --job-order forward \
  --out artifacts/wasm-json-sort/my-forward-run
```

`--job-order reverse`は15通りを逆順で測定します。各sample内のTS→Wasm／Wasm→TSの順番も交互に変えます。`--program <path>`で別の入力プログラムを指定できます。`jobs`で計測対象を選択し、`optimize: false`にするとBinaryenの明示的な最適化パスを省けます。設定値や対応外のキー・方式は拒否します。既存の出力ディレクトリには上書きしません。

## 最適化と規模の比較

```bash
# 同じ入力を4条件で比較し、順序を反転して再実行
bun run examples/wasm-json-sort/study.ts optimization

# 選択ソートのselectをifに戻す診断用比較
bun run examples/wasm-json-sort/study.ts selection

# 710 / 3,550 / 7,100件の比較
bun run examples/wasm-json-sort/study.ts scaling

# 個別に生成・実行
bun run examples/wasm-json-sort/run.ts --optimization O3 --selection-branch true --key age --algorithm selection --records 7100
```

`--records`は1〜20,000件を受け付け、`--input`・`--bytes`とは併用できません。`--selection-branch true`は最適化済みの選択ソートを含むプログラム専用の実験です。選択ソート関数の特定の更新式だけを書き換え、一般的なselect除去はしません。

最適化なしはBinaryenの最適化パスを実行しない意味です。実行エンジン側の機械語生成・最適化を無効にする設定ではありません。各studyの詳しい条件と観測結果は[段階的調査](./STAGED_RESULTS.md)を参照してください。

## データと並べ替えの意味

同梱JSONは固定seedで生成した**102,503 bytes、710件**の架空キャラクターです。ここで`race`は`human`・`elf`・`dwarf`などのファンタジー上の種族です。

```json
[
  { "id": 1, "name": "Aster", "age": 28, "race": "elf", "region": "north", "bio": "Synthetic character" },
  { "id": 2, "name": "Beryl", "age": 19, "race": "human", "region": "south", "bio": "Synthetic character" }
]
```

`id`は重複しない安全な整数、`age`は非負の安全な整数、残りの例示フィールドは文字列です。追加入力フィールドは保持されます。空配列にも対応し、上限は20,000件です。`--bytes`は2〜3,000,000 bytesの目標サイズを受け付け、レコード境界まで生成するため厳密な指定サイズにはなりません。

- `age`：数値順。文字列としての数字順ではありません。
- `name`・`race`：JavaScriptのUTF-16コード単位順。ロケール・読み仮名・大文字小文字の同一視は行いません。
- キーが同じ場合：入力配列での順番を維持します。`id`による並べ替えではありません。

入力JSONの外側の配列を並べ替え、レコードの内容は保持します。ネストしたpathや降順はこのprofileの対象外です。

## 生成と測定

[compiler.ts](./compiler.ts)が入力のキー・アルゴリズムを検証し、[TSテンプレート](./algorithms.ts)と[WATテンプレート](./sort.wat)から対応するexportを持つ生成物を作ります。WasmはBinaryen 132.0.0で生成します。既定の`legacy`は最適化レベル2・サイズ縮小レベル1で、初回の出力を維持します。`--optimization none|legacy|O2|O3`で明示的に選択でき、O2/O3ではサイズ縮小レベルを0に固定します。TSは生成された`.ts`ファイルをBunで読み込みます。runnerがテンプレートのTS関数を直接実行する比較ではありません。

| アルゴリズム | 特徴 |
| --- | --- |
| insertion | 挿入ソート。ランダム入力では通常O(n²) |
| selection | 選択ソート。O(n²) |
| bubble | バブルソート。交換なしで終了、通常O(n²) |
| shell | シェルソート。gapを半分ずつ減らす方式 |
| heap | ヒープソート。O(n log n) |

両バックエンドのループ・比較・交換の手順を揃えています。遅いアルゴリズムを含むのは計算特性を比較するためで、実用品への推奨ではありません。

ホスト側でキーの異なる値を昇順に並べてrankを付け、`rank × レコード数 + 入力index`をi32に格納します。TS/Wasmは同じ整数列をソートし、剰余で元のレコードへ戻します。これにより、本来は安定でないアルゴリズムでも同値キーの入力順が保たれます。最大値は20,000件で399,999,999となり、符号付きi32に収まります。

**順位付け自体がホスト側のソートを含みます。** 特にユニークな文字列が多い場合、その処理だけで順序決定の相当部分を済ませています。この実験のkernelは「順位付け済み整数列を並べ替える性能」であり、Wasm単独のJSON解析・文字列比較性能を示しません。

| 計測 | 含む処理 |
| --- | --- |
| kernel | 未ソートの整数列を並べ替える。入力コピーは除外。Wasmの関数呼び出し境界・runnerの呼出検査は含む |
| end-to-end | JSON.parse、レコード検査、rank生成、入力コピー、ソート、レコード復元、JSON.stringify |
| phases | parse＋検査、rank生成、TS/Wasmへのコピー、復元、JSON文字列化を別々に測定 |
| startup | Binaryen import、生成、生成TS import、Wasm compile／instantiateを別記録 |

インスタンス・作業バッファは再利用します。各ソート前に必ず元の未ソートデータを入れ直します。両形式ともrank用配列から再利用バッファへコピーします。ファイルI/O・生成・起動はend-to-endに含めません。phaseの値は別測定なので、合計してend-to-endと一致することは保証しません。

数値は1回あたりのmsです。sampleごとに`iterations`回の時間を平均し、そのsample平均の中央値・最小・最大・全sampleを保存します。GCを固定せず、単一Bunプロセス内で測る探索用ベンチマークです。ほかのエンジン・CPUへの一般化や、小差の統計的有意性は主張しません。

## 保存する証拠

- `source.jsonc`・`manifest.json`：入力仕様、生成物・テンプレートのSHA-256、最適化条件
- `sort.generated.ts`・`sort.wasm`・`sort.generated.wat`：実際に比較した生成物
- `sort.before-optimization.wat`：最適化前のWAT。studyでは選択ソート関数と静的命令数も保存
- `input.json`：使用した入力
- `sort_<key>_<algorithm>.typescript.json`／`.wasm.json`：各形式の並べ替え結果。15通りなら計30ファイル
- `report.json`／`report.md`：環境、全計測値、結果ハッシュ、概要表
- `sources/`：runner・ホスト処理・コンパイラ・テンプレートのソースsnapshot

時間測定の外で、毎回、整数ソート結果と、元レコードを直接比較するオブジェクトソートの結果を確認します。TSとWasmが互いに一致するだけでは成功としません。結果ハッシュは保存JSONファイルの末尾LFを含みます。

`artifacts/`はGit管理外です。今回の生の計測記録は[evidence](./evidence/forward.json)にもコピーしています。生成物一式はローカルのartifactsに保存し、別cloneではコマンドで再生成します。

## 検証

```bash
bun test examples/wasm-json-sort/sort.test.ts
bun run typecheck
bunx biome lint examples/wasm-json-sort
bunx biome format examples/wasm-json-sort
```

空・1件・同値キー・ソート済み・逆順・重複の多いデータ、Unicode、数値順、20,000件のmemory拡張、入力拒否、生成物の再現性、結果ファイルとハッシュを確認します。4種類の最適化設定、設定の復元、選択ソートのif版、件数指定も検証します。
