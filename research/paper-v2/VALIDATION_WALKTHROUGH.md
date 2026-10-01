# L-Langで課題とOracleを検証する手順書

この手順書は、L-Langを実際に動かしながら、論文用の4課題とその正解表を確認するためのものです。対象はpaper-v2の評価入力です。上から順に進めると、要求を読む、Wasmを作って動かす、採点結果を見る、人の判断を記録する、証跡を保存するところまで確認できます。

今回使うのは保存済みの合成応答を使うfixtureモードです。生成APIの認証や料金は不要です。fixtureの成功はL-Langの実行経路が動く確認であり、新しいLLMの生成精度の測定にはなりません。依存導入にはネットワークが必要な場合があります。

最初の一回は手順1〜6のcontactだけでも構いません。レビューを完了するには4課題を確認し、手順7で記録します。

## 何を確かめるのか

| 確認すること | 方法 | 合格だけでは分からないこと |
| --- | --- | --- |
| 正解表が要求どおりか | あなたが要求から答えを考えてOracleと比較 | コードがその答えを出すか |
| 実行物が正解表に一致するか | L-LangがWasmを作りOracleで採点 | Oracle自体が正しいか |
| 保存した記録が対応するか | reportとbundle検証 | 記録者の本人確認や自然言語の完全な正しさ |

Oracleは「この入力ならtrue／false／入力エラーになる」という正解表です。fixtureはLLMの代わりに返す保存済み応答です。unresolvedは「要求をこの仕組みでは実装できない」という生成結果で、実行時のfalseや入力エラーとは異なります。

今回の流れは、要求と入力契約 → fixture応答からIRを構築・検査 → Wasm生成 → Oracle採点です。手順4のpaper-cliがこの一連の処理をまとめて実行します。通常のアプリ開発用CLIや外部サービスへの配備は使いません。

## 手順1 作業場所と実行環境を準備する

macOSのターミナルで以下を実行します。別の場所にcheckoutした場合はcd先を変更してください。

```sh
cd /Users/y.noguchi/Code/L-Lang
bun --version
python3 --version
```

Bunの指定版はpackage.jsonのpackageManagerで確認します。本手順の動作確認時は1.4.2です。Python 3は補助的な正解表チェックに使います。command not foundの場合は以降を進めず、環境を準備してください。

依存が未導入なら次を実行します。導入済みなら省略できます。

```sh
bun install --frozen-lockfile
```

次に、今回専用の出力先を作ります。以降のコマンドは**同じターミナル**で実行してください。

```sh
mkdir -p artifacts
LLANG_REVIEW_DIR="$(mktemp -d "$PWD/artifacts/human-review-XXXXXX")"
printf '%s\n' "$LLANG_REVIEW_DIR"
```

表示された絶対pathをメモしてください。変数はターミナルを閉じると失われます。再開するときは`LLANG_REVIEW_DIR="メモした絶対path"`と設定します。run/report等の作成コマンドは既存出力先を再利用できません。再実行するときは新しい作業directoryを作り、古い結果を残してください。

## 手順2 要求を読み自分の答えをメモする

まず[source一覧付き確認表](./REVIEW_WORKSHEET.md)を開きます。ただしOracle期待値を答えとして暗記せず、最初に各sourceのrequirementsとcontractを読んでください。ファイルはエディタから開くか、例えば次で表示できます。

```sh
cat research/paper-v2/contact-source.json
```

sourceの読み方は次のとおりです。

| field | 読む内容 |
| --- | --- |
| intent / requirements | 何を判定したいか |
| contract.fields | 入力項目と許す型・値 |
| optional | 項目を省略できるか |
| nullable | nullを許すか |
| undefinable | 明示的なundefinedを許すか |
| unresolvedWhen | 生成を断念すべき条件 |
| examples | 要求に添えた例。Oracle全体とは別 |

contactではemailが存在し、tierがpremiumならtrueです。空文字列は存在する扱いで、nullと欠損は存在しません。次の6件について自分の予想をメモします。

1. email="x"、tier="premium"
2. email=""、tier="premium"
3. email=null、tier="premium"
4. email項目なし、tier="premium"
5. email="x"、tier="basic"
6. email=123、tier="premium"

true、false、入力エラーのどれかを選び、理由を一言書きます。「空文字列を許す要求が不適切では」という疑問は、実装不具合とは分けて要求への指摘として残してください。

レビューのメモは作業directoryにnotes.md等を自分で作って残します。次の形式で十分です。

```text
課題: contact
確認項目: requirements
判断: pass / fail / pending のいずれか
理由: 自分が理解した条件と、期待値への同意または反例
未確認: まだ判断できない点
```

## 手順3 入力の検査とレビュー資料を作る

```sh
bun run src/paper-cli.ts validate-study --study research/paper-v2/study-draft.json --out-dir "$LLANG_REVIEW_DIR/validation"
bun run src/paper-cli.ts review-study --study research/paper-v2/study-draft.json --out-dir "$LLANG_REVIEW_DIR/review"
```

各コマンドが正常終了したことを確認してから次へ進みます。終了番号が分からない場合は、直後に`echo $?`で確認できます。

開くファイルは以下です。`$LLANG_REVIEW_DIR`は手順1で表示されたpathに置き換えます。

| ファイル | 確認する点 |
| --- | --- |
| validation/study-validation.json | diagnosticsが空。readyForLive=falseは現在のdraftでは正常 |
| review/review.md | 4課題の要求・契約・全Oracle期待値を通読する |
| review/review-record.template.json | 人が記入する雛形。最初は全て未確認 |

補助チェックも実行できます。

```sh
python3 research/paper-v2/check-oracles.py
```

logic 21、contact 15、boundary 9、unsupported 12の期待値一致と、logic/contactの誤式を拒否する反例が表示されます。このスクリプトもAIが要求から作ったものなので、人の意味レビューを代替しません。

## 手順4 L-LangでWasmを生成し自動採点する

```sh
bun run src/paper-cli.ts run-study --study research/paper-v2/study-draft.json --mode fixture --out-dir "$LLANG_REVIEW_DIR/run"
bun run src/paper-cli.ts report --run-dir "$LLANG_REVIEW_DIR/run" --out-dir "$LLANG_REVIEW_DIR/report"
```

最初のコマンドが終了値0で終わってからreportを実行します。run-studyの終了値0は一連の処理が完了した意味であり、全課題が生成成功した意味ではありません。

`report/table.md`を開き、各行を次と比較してください。

| Task | Status | Oracle |
| --- | --- | --- |
| logic | pass | true |
| contact | pass | true |
| boundary | pass | true |
| unsupported | unresolved | not-run |

`report/summary.json`ではplannedTrials=4、oraclePass=3、oracleFail=0、oracleNotRun=1、recordIntegrity=verifiedを確認します。evidenceEligible=falseは現在の研究状態として正常です。callsはfixture内の論理呼出しを含むので、課金API呼出し数と読み替えないでください。

表現可能3課題の45caseが実際の採点対象です。unsupportedの12caseは生成物がないため未実行です。これを57caseのWasm実行成功と数えないでください。

## 手順5 contactのWasmへ自分で入力を渡す

下のブロック全体をターミナルへ貼り付けます。BunでL-Langのruntimeを呼び、手順4で作った最終候補を実行するものです。attempt番号を固定せず、保存runから最終候補を選びます。

```sh
bun -e '
import {resolve} from "node:path";
import {readCapability} from "./src/capability-package";
import {instantiateWasmPredicate} from "./src/wasm-runtime";
const dir=process.argv[1];
const run=await Bun.file(resolve(dir,"contact-1/run.json")).json();
const last=run.attempts.at(-1);
if(run.status!=="pass" || !last)throw Error("contact not ready");
const path=resolve(dir,`contact-1/attempt-${last.index}/candidate/capability.json`);
const pkg=await readCapability(path);
const runtime=await instantiateWasmPredicate(pkg.build,pkg.bytes);
console.log("candidate:",path);
for(const input of [{email:"x",tier:"premium"},{email:"",tier:"premium"},{email:null,tier:"premium"},{tier:"premium"},{email:"x",tier:"basic"},{email:123,tier:"premium"}]){
try{console.log(JSON.stringify(input),"=>",runtime.evaluate(input));}
catch(error){console.log(JSON.stringify(input),"=>",error.code ?? error.message);}
}
' "$LLANG_REVIEW_DIR/run"
```

順にtrue、true、false、false、false、INVALID_INPUTが期待値です。手順2で書いた自分の予想と比べてください。INVALID_INPUTは入力契約によるhostの拒否で、Wasmのboolean出力ではありません。このコマンドは結果表示用なので、表示内容を見ず終了番号だけで合格にしないでください。

別の入力を試す場合は、ブロック内のinput配列のobjectだけを変更して再実行します。例えば`{email:"x"}`なら必須tierがないのでINVALID_INPUTです。保存したcandidateやOracleを書き換える必要はありません。新しく試した入力と結果をnotes.mdへ残します。

実際の採点記録は`run/contact-1/oracle-evidence.json`です。casesのexpectedとactual、status、全体resultを確認できます。compile対象のWasmやIRを詳しく見る場合は、コマンドが表示したcandidate directoryを開いてください。

## 手順6 残り3課題と網羅性を確認する

[全ケース確認表](./REVIEW_WORKSHEET.md)とreview/review.mdを使います。実行結果に合わせて正解を書き換えず、要求と契約から判断してください。

| 課題 | 人が確認するポイント |
| --- | --- |
| logic | aがfalseなら常にfalse。aがtrueならb=trueまたはc=falseでtrue。8組全ての答えが一致するか |
| contact | tier×email欠損/null/空/非空の8組。数値や未知tierはfalseではなく入力エラーか |
| boundary | highだけtrue、low/mediumはfalse。大小比較や数値しきい値を主張していないか |
| unsupported | literal suffixなら@example.comもtrue、a@example.com.extraはfalse。メール形式検査という別要件を混ぜていないか |

全57件を確認したかメモします。logicの真理値は全域ですが、不正入力や文字列は代表例であり、全ての入力を網羅したとは書きません。

unsupportedについては「意味上の正解」と「生成できるか」を分けます。現行profileでは文字列の中身をWasmへ渡さないため、このsuffix要求はunresolvedが想定どおりです。error/stopped/uncertainをunresolved成功と数えないでください。この表現不能性を自分で判断できなければ、expressibilityはpendingとして技術確認を依頼できます。

explicit undefinedはJSONに書けません。JSONのOracleでは欠損を検査し、undefinedの扱いはhost契約の別検証とします。

## 手順7 自分の判断を記録して検査する

最初の一度だけ雛形をコピーします。既に記入したreview-record.jsonがある場合はコピーせず、そのファイルを開いてください。

```sh
cp -n "$LLANG_REVIEW_DIR/review/review-record.template.json" "$LLANG_REVIEW_DIR/review/review-record.json"
```

review-record.jsonをエディタで開き、taskごとに記入します。studyHashとinputHashesは編集しません。

| field | 記入するもの |
| --- | --- |
| sourceAuthors / oracleAuthors | 実際の作成者ID配列。不明ならnull。AI作成・改訂の経緯もメモに残す |
| reviewer | あなたを区別できる一定のID |
| independent | 作成・実装から独立して確認した場合true、関与しているならfalse、不明ならnull |
| reviewedAt | 実際に確認したUTC日時。例の日時を流用しない |
| recordReference | 自分のnotes.mdの場所など |
| checks | 下記5項目ごとにpass/fail/pending |
| findings | failの項目名と、どの入力で何が違うかを記載 |

5項目はrequirements（要求と正解）、expressibility（表現可否の分類）、unresolved（生成を断念する条件）、inputBoundaries（契約・境界）、taskOverlap（既存例との重複・由来）です。

failの書き方の例は`{"check":"requirements","note":"case名と、期待値が違うと考える理由"}`です。例文をそのまま記録せず、実際の発見を書きます。日時は確認時に`bun -e 'console.log(new Date().toISOString())'`で取得できます。

独立性はコマンドを通すためにtrueにするものではありません。あなたが実装や課題作成に関与している場合も内容レビューには価値があり、自己レビューとして残せます。独立レビューを論文で主張するには別の適切なreviewerによる確認が必要です。作成者が不明なら記録はpendingになり得ますが、架空のIDで補わないでください。

記入後に検査します。

```sh
bun run src/paper-cli.ts verify-study-review --study research/paper-v2/study-draft.json --record "$LLANG_REVIEW_DIR/review/review-record.json"
```

| 結果 | 意味と次の行動 |
| --- | --- |
| accepted / 終了値0 | 必須記入と対象hashが整合。自然言語の正しさやlive承認の証明ではない |
| pending / 終了値1 | 未記入・未確認がある。分かる範囲だけ記入し残りを依頼する |
| changes-requested / 終了値1 | failまたは独立性不成立等。reasonsを読み、内容指摘と自己レビューの区別を確認する |
| 終了値2 | JSON形式、対象変更、failの理由欠損等。入力を確認し再検査する |

入力を直した場合は、新しいstudy版とreview資料を作ります。古い記録のhashだけを新値へ差し替えないでください。

JSON編集が難しければ、次の形でこの会話へ返してください。判断の転記は支援できます。

```text
対象: paper-v2
課題: contact
確認したcase: 確認した範囲を書く
requirements: pass/fail/pending と理由
expressibility: pass/fail/pending と理由
unresolved: pass/fail/pending と理由
inputBoundaries: pass/fail/pending と理由
taskOverlap: pass/fail/pending と理由
担当者と作成への関与: 分かる事実のみ
```

## 手順8 実行証跡を保全する

これは任意の最終確認です。runとreportが完了し、実行中processがない状態で行います。

```sh
bun run src/paper-cli.ts bundle-study --run-dir "$LLANG_REVIEW_DIR/run" --out-dir "$LLANG_REVIEW_DIR/bundle"
bun run src/paper-cli.ts verify-study-bundle --bundle-dir "$LLANG_REVIEW_DIR/bundle"
```

両方の終了値0、recordIntegrity=verified、evidenceEligible=falseを確認します。bundle検証はWasmを再実行しません。手順5の実行確認とは別です。

bundleに人間のreview-recordやnotesは自動では入りません。これらはreview directoryとともに別途保持します。bundle内へ後から追加すると全ファイル集合の検査に失敗するので、追加しないでください。ローカルbundleには生記録や元pathを含むため、公開する場合の確認は別途必要です。

## 困ったときと終了の目安

| 症状 | 対応 |
| --- | --- |
| 出力先が既に存在する | 古い記録を消さず、新しい作業directoryで始める |
| PAPER_STUDY_LOCKED | 実行processを確認する。lockを手動削除して再送しない |
| uncertain | 送信・採点の確定が不明。自動resumeせず記録とエラーを共有する |
| source revision/hash mismatch | source/fixture/Oracleの版が混在していないか確認。期待hashを適当に書換えない |
| fixture結果が期待と違う | run.jsonのreasonと該当trial記録を確認。正解を実装に合わせない |
| レビュー記録がacceptedにならない | reasonsを読む。未記入や自己レビューなら終了値1は想定内 |

あなたが確認できた要求、case、疑問、未確認項目がメモに残れば、内容レビューとして成果があります。「実行は動いた」「Oracle内容を確認した」「独立reviewが完了した」を別々に記録してください。

この手順にはlive実行を含めません。人のレビュー後、モデル・反復・予算・入力freeze・承認を確定してから別手順で実施します。[修正版の説明](./README.md)と[研究評価の実行条件](../../RESEARCH_EVALUATION_PREREQUISITES.md)を参照してください。

## 手順書の動作確認記録

2026-10-01、既存依存環境のBun 1.4.2で、入力validation、review資料生成、Python参照チェック、fixture run、report、手順5のWasm実行、bundle作成・照合を実施した。contactの6件はtrue/true/false/false/false/INVALID_INPUTだった。出力はartifacts/review-walkthrough-20261001-nTYUXqに保存。依存導入は再実行していない。人間の判断は未記入であり、この手順の動作確認を独立review完了とは扱わない。
