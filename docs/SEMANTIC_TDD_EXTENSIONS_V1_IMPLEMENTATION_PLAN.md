# Semantic TDD拡張・限定初版 実装計画

作成日：2026-10-01。状態：限定初版を実装済み。回帰検証結果は[実装結果](./SEMANTIC_TDD_EXTENSIONS_V1_RESULTS.md)を参照。

上位計画は[Semantic TDD残作業計画](../SEMANTIC_TDD_IMPLEMENTATION_PLAN.md)。ユーザーの着手指示に基づき、既存の着手順に先行して限定初版を実装する。独立評価、既定機能への昇格、Paper v1の主張拡大は今回の完了条件に含めない。

本書は限定初版の契約を記録する。2026-10-01の追加指示による上位計画の残実装は[完了計画](./SEMANTIC_TDD_EXTENSIONS_COMPLETION_PLAN.md)に分け、v1の保存結果を維持したままv2で拡張する。

## 1. 対象と順序

1. versioned Best-of-N設定と決定的な候補評価・選択を追加する。
2. `tdd-build --best-of-n <config.json>`へ接続し、既存の単一候補buildを維持する。
3. 候補のIR、応答・usage、失敗分類、入力snapshot、選択規則をSelection Report v2へ保存する。旧v1 lockを引き続き読む。
4. `tdd-test`と`semantic verify`で全候補を再評価し、`tdd-replay`でAPIなしに選択結果を再現する。
5. versioned Property Test設定、有限入力生成、決定的縮小、反例を追加する。
6. 明示指定のオフラインproperty check/replayコマンドと利用例を追加する。
7. 回帰確認後、実装状況と論文範囲の文書を更新する。

## 2. Best-of-Nの初版契約

候補数は最大5、並列数1。全候補は同じ要求・型・Project Context・凍結Test Planを受け取り、他候補やhidden Oracleを入力に含めない。個別候補のunresolved、形式・型不正、Hard失敗、Mutation失敗を記録する。失敗候補を修正するloopや自動retryは追加しない。

HardとMutationを通過した候補のうち、Mutation score降順、IR node数昇順、深さ昇順、IR hash辞書順で選択する。同じIRは同じ順位とし、候補順による選択IRの変化を認めない。選択後は既存compilerによる生成コードの型検査、source例、Project回帰を必須とする。最終検査に失敗しても次順位の候補へ自動fallbackしない。

設定には候補数、出力token上限、合計token予算、呼出しtimeout、価格上限の申告と費用予算を固定する。live usage不明・予算超過は採用を止める。usageによる合計tokenと費用は応答後の検査であり、provider請求の絶対上限ではない。この限界を利用ガイドに記載する。fixtureはAPI callと費用を0として区別する。

全候補不適格では生成artifactとimplementation lockを更新しない。凍結Test Plan、audit、排他lockの作成・解除は許可する。「workspace mutation 0」は製品artifact・implementation lockへの変更0と定義し、監査出力まで0とはしない。

## 3. Property Testの初版契約

ユーザーが明示したPredicate IRの期待式と、生成対象のIRを有限入力で比較する。候補IRを期待式として自動採用せず、LLMにexpectedを推測させない。期待式とsource例・凍結Test Planの矛盾は検査開始前に拒否する。

対応型はboolean、literal、literal union、null、optional、深さ3までのobject。string/numberは明示した有限domainを必須とする。配列、必須undefined、循環型、巨大union、無制限文字列、任意callbackは拒否する。seed、件数、入力生成予算、縮小step上限を固定する。

seedから同じ入力列を再生成する。失敗入力は型を維持した有限domain内で縮小する。最小性は指定した縮小順序での局所的な最小性とし、大域的最小を保証しない。入力・期待式・candidate IR・schema・設定・結果のhashを保存し、オフラインreplayで反例と縮小を再検証する。secretの自動検出・除去は保証しないため、domainには公開可能な合成値を用いる。

このproperty検査は明示実行の診断機能であり、既存buildのHard Gateへ昇格させない。有限試験のpassを自然言語要求の完全充足と扱わない。

## 4. 互換性・変更対象

旧Selection Report v1・semantic-test.lock v1は維持する。v2 reportを保存したlockは旧compilerでは読めないため、旧版へのrollbackには対応する旧lockとartifactの組を使う。既存JSONC/Wasm ABI、LLM schema、凍結benchmark入力には変更を加えない。新規依存は追加しない。

## 5. 検証と完了条件

- unit：候補順反転、同点、同一IR、全候補不適格、型不正、個別provider失敗、予算超過、未知fieldを検査する。
- integration：一時workspaceでfixture build、旧単一候補互換、v2 verify/replay、候補IR・選択・入力hash改変拒否、全不適格時のartifact/implementation lock不変を検査する。
- property：同一seed、optional/null、型保持、既知欠陥の検出と縮小、縮小上限、期待式の矛盾、unsupported型、改変拒否を検査する。
- CLI：fixture例と保存reportの再生をAPI keyなしで実行する。
- repository：`bun run check`、`bun run ci:docs`、`bun run ci:protected`、`bun run coverage`を実行する。失敗は原因と対象を記録し、閾値や保護入力を変更して通過させない。

実装結果には実行した検査と未実施の独立評価を分けて記録する。実装完了後も上位Phase 6〜7全体の評価Gateは未完了として残す。
