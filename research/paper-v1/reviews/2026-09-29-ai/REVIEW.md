# 課題・OracleのAIレビュー

2026-09-29。結論：**期待値の誤りは見つからなかったが、評価範囲に不足があり差戻しを推奨する。** 現行studyの4課題・Oracle 13 caseを確認した。accessは今回のstudy外なので判定対象に含めない。

これは同じ会話で計画・文書作成に関わったCodexによるAIレビューであり、独立した人間によるレビューではない。review-record.jsonではreviewerをcodex-current-thread-ai、independentをfalse、作成者は未確認なのでnullとした。人間の本人確認・独立性を捏造せず、研究入力のreviewフラグや承認を変更していない。

## 方法と証跡

要求・契約・Oracleを読み、要求から参照式を直接記述した。[audit.ts](./audit.ts)と[audit-results.json](./audit-results.json)に検証手順・結果・対象hashを保存した。実行コマンドは`bun run research/paper-v1/reviews/2026-09-29-ai/audit.ts`。再実行するとこのディレクトリの派生記録を更新するので、別版をレビューする場合は別directoryにコピーする。

生成candidate・生成suite・fixture応答の内容は意味判断や参照式作成に使用していない。既存loaderはfixtureもhash採取のため読み込むが、fixtureの実行結果を正解根拠にしていない。契約拒否と表現可能性の確認には現行host契約コードを使ったため、この部分は実装から独立した検証ではない。モデル呼出し・Wasm生成・実行は行っていない。

[レビュー記録](./review-record.json)には項目別判断を保存した。requirementsのpassは「現在列挙されたcaseの期待値が要求と一致する」という判断であり、十分なテスト網羅性を意味しない。

## 課題ごとの結果

| 課題 | 意味の確認 | 修正が必要な点 |
| --- | --- | --- |
| logic | `a && (b || !c)`。既存4件の期待値は一致。AND/OR/NOTで表現可能 | boolean全8通りのうち4通りだけ。不正入力caseなし |
| contact | emailがnull/undefinedでなく、tier=premium。空文字列は存在する。既存3件は一致 | 要求に明記された空文字列とnullのcaseがOracleにない。状態とtierの交差が不十分 |
| boundary | `level == high`。有効enum全3値と契約外値1件の期待値は一致 | 数値境界の課題ではない。入力契約違反と要求の表現不能をunresolvedWhenで区別する必要がある |
| unsupported | emailの末尾が@example.com。既存2件の期待値は一致。現行profileでは表現不能 | Oracleの2件がsource例と同一。期待する生成結果unresolvedの成功判定を別途明記する必要がある |

### R1：contactの明示要件が未検証（評価開始前に修正）

`{email:"", tier:"premium"}`の期待値はtrueである。`Boolean(email) && tier === "premium"`という誤った実装でも現行Oracle 3件を通過する。空文字列はsource例にもなく、現在の独立Oracleではこの誤りを検出できない。

emailの欠損・null・空文字列・非空文字列とbasic/premiumの交差8件を追加する。premiumかつ空/非空文字列の2件だけtrue、残りはfalse。さらにemailの数値/boolean、tier欠損/null/数値/未知enum、未知fieldをINVALID_INPUTとして確認する。

明示undefinedはJSONに表現できず、現行Oracle schemaにはsource例のundefinedFields相当もない。欠損を明示undefinedの試験と呼ばない。今回はJSON範囲をOracleの評価範囲とし、明示undefinedは別のhost契約試験で確認したことを記載するか、必要性を判断してschema拡張を別途行う。

### R2：logicの全真理値表が不足（評価開始前に修正）

未収録の入力は000=false、001=false、011=false、110=true（順序a,b,c）。全8通りを保存するコストは小さい。誤式`a && (b === c)`は現行4件に一致するが110をfalseとし、この追加caseで拒否できる。

各必須fieldの欠損・null・型不正と未知fieldをINVALID_INPUTとして追加する。有限booleanの全域を確認した結果と、不正入力の代表例確認を区別する。

### R3：boundaryの主張と停止条件を明確化（評価開始前に修正）

現在の契約はenumで、値配列はhigh/low/mediumである。「上限に達した」という表現から数値順序の比較を実証したとは言えない。要求を「levelがhighのときだけ許可する」と明確にし、論文ではカテゴリ選択課題と呼ぶ。現行の有効enum3値のOracleは十分に網羅している。

契約外levelが必要なら要求を生成できないという意味と、実行時にlevel=criticalを受けたらINVALID_INPUTという意味を分ける。source.unresolvedWhenの文面を修正候補として提示する。levelの欠損/null/非文字列・未知fieldの拒否も追加する。

### R4：unsupportedは意味Oracleと未解決検出を分ける（評価開始前に修正）

要求自体は明確である。wasm-contract.tsのencodeInputではstringの文字内容を渡さず、存在状態だけを渡す。監査ではa@example.comとa@other.comのencoded値は両方[2]だった。同じWasm入力から異なるbooleanを返すことはできず、このprofile/ABIのまま一般のsuffix要求を満たせない。

この課題の望ましい生成結果はunresolvedである。現行runnerではunresolved時に意味Oracleを採点しないため、「Oracle未実行1件」を意味テストの成功と数えない。課題別に期待生成状態との対応を研究手順・結果表で明示する。新しい集計機能を作らなくても、事前指定と課題別結果の提示は必要である。

また、既存2件はsource例と同一なので独立した評価入力として弱い。別local-part、空文字列、a@example.com.extra=false、a@sub.example.com=false、要求のliteral suffix解釈では@example.com=true等を候補にする。メール形式の妥当性を暗黙に追加しない。これらを増やしても表現不能性自体は解消しない。

## 由来・独立性と次の処理

logic/contactはstudyでexisting-example-adaptedと明記されており、その説明は妥当。boundary/unsupportedのnew-draftは「新規の独立held-out dataset」を意味しない。作成者の実名・識別子と作成経緯は未確認であり、重複・モデル汚染の網羅調査も行っていない。

1. R1〜R4の修正を新しい入力版として反映し、旧Oracle・既存run・bundleを保持する。
2. 修正後のstudyと入力hashでreview資料を再生成する。旧review-recordのhashだけを置換しない。
3. 実際の作成者を確認し、作成から独立した人が要求・期待値・表現範囲を確認して記録する。
4. その後にモデル・予算・反復・freeze・承認を確定する。今回のレビューをlive承認としない。

この依頼ではレビュー結果と修正案までを保存し、評価用入力や既存成果を直接変更していない。
