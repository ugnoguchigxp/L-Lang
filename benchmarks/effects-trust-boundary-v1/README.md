# Effects trust boundary fixture

このdirectoryは、trust/data分離harnessのoffline fixtureです。実モデル、network、人間参加者を使わず、結果は常に`evidenceEligible: false`です。

`protocol.json`は九つのattack category、両armで共通のhost profile、入力・grant・Oracle commitmentを固定します。parserはcase集合、公開入力、期待値、共通host budgetから各commitmentを再計算し、結果観測後の書換えをfreeze mismatchとして拒否します。mutation testは九categoryの期待値を一つずつ壊し、独立した集計Oracleがすべて検出することを確認します。

TypeScript armは意図的に弱い比較対象ではなく、L-Lang armと同じhost profile、timeout、memory、API call上限を使う比較枠です。このfixture自体は実装方式の優劣を測る実験ではありません。独立datasetと実際の両arm実行は別の事前登録済み評価として行います。
