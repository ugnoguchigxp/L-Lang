# Schema Evolution v2 evaluation blocker

記録日: 2026-07-20

状態: **局所Blocker / 対応保留**

この文書は、Schema Evolution v2のモデル出力を取得する前の事前確認で見つかった評価設計上の問題を記録する。これは独立した人間レビューの完了記録ではない。

## 判定

現在のv2入力を`human-reviewed`として承認したり、live benchmarkを実行したりしてはならない。

このBlockerが停止するのは次の範囲である。

- Schema Evolution v2のlive benchmark
- v2を根拠にした型付き2/3 Consensusの信頼性評価
- Predicate限定MVPの実プロジェクトPilot移行判断

次の範囲は停止しない。

- 既存Predicateのbuild、replay、test、check、diff、approve
- Static Judgmentの検証
- Semantic Testの拡張
- `semantic explain`
- PredicateとJudgmentを対象とするSemantic Closureの設計・検証

## 凍結状態

- Authoritative input: [`benchmark.json`](./benchmark.json)
- Review metadata: [`freeze.json`](./freeze.json)
- Frozen SHA-256: `1062aec2076994b6a74df1d5b8acb294d82d85be7cf7cf74be5be767071a3aa0`
- `freeze.json`は`status: draft`、`humanReviewed: false`
- 2026-07-20時点でv2のlive API実行結果は存在しない
- 同日時点のローカル確認は`bun run typecheck`成功、`bun test`が`50 pass / 0 fail`

`benchmark.json`と`freeze.json`は、このBlockerへの対応時にも既存v2の証拠として保存する。

## 問題1: `present`と「usable」の境界が一致しない

4つの`representation`ケースは、所有者、支払参照、成果物、登録経路を`string[] | null`で表し、Oracleでは`present`を使用する。

対象フィールド:

| Concept | Field |
| --- | --- |
| Actionable Ticket | `assigneeIds` |
| Payable Invoice | `paymentTokens` |
| Deployable Release | `artifacts` |
| Enrollable Course | `enrollmentChannels` |

現在の`present`は、値が`null`でも`undefined`でもないことだけを判定する。

```ts
value !== null && value !== undefined
```

したがって空配列`[]`も真になる。一方、各Conceptは`usable`な値が存在することを要求している。空配列をusableとみなすかは入力に定義されておらず、hidden testにも空配列境界がない。この状態では、OracleがConceptを十分に表現していると証明できない。

同様に、nullableな`string`へ`present`を使用するケースでは空文字`""`も真になる。空文字をusableとみなすかも明示されていない。

## 問題2: optional nullableの欠損意味が未定義

4つの`optionality`ケースでは、除外状態を表すフィールドがoptionalでnullableである。

```ts
blockedAt?: string | null
voidedAt?: string | null
withdrawnAt?: string | null
retiredAt?: string | null
```

Oracleは各フィールドに`equals null`を要求する。このため、明示的な`null`は合格するが、欠損による`undefined`は不合格になる。

しかしConceptだけからは、欠損を次のどちらとして扱うか一意に決められない。

- 除外状態が存在しない
- 除外状態が不明であり、安全のため不合格にする

さらに各フィールドには`omitWhenNegative: true`が指定されているため、生成されるnegative fixtureでは設定済みのtimestamp値ではなくフィールド欠損が使用される。期待する境界とfixture生成規則の対応を再確認する必要がある。

## 問題3: v1からの独立性に関する留保

v2の4 Conceptは業務領域と型名こそ新しいが、resolved Oracleはいずれも主に次の論理骨格を使用する。

1. 肯定状態を`equals`で確認する
2. 除外timestampを`equals null`で確認する
3. 必須の役割を`present`で確認する

これはv1のActive CustomerおよびShippable Orderと同型である。新しい名前とスキーマだけで十分なheld-out性を持つか、また`any`や`not`を含む未知の論理構造へ一般化した証拠になるかは未確認である。

これはコンパイラの不具合ではなく、v2から主張できる一般化範囲に対する留保である。

## なぜ全体Blockerではないか

確認された問題は、v2のConcept、Oracle、fixture境界の対応に局在する。

- `present`の実装は定義どおりに動作している
- 既存の型検査と回帰テストは成功している
- fail-closed、human approval、draft時のAPI拒否は維持されている
- Static Judgmentはv2 manifest、Predicate IRの`present`、Schema Evolution Consensusへ依存しない

ただし、共通の`semantic.lock`をStatic Judgmentへ拡張する場合は、既存Predicate entryとreplayの後方互換性を回帰条件とする。

## 対応保留中の禁止事項

- `freeze.json`を`human-reviewed`へ変更しない
- `bun run benchmark:schema-evolution:v2`を実行しない
- 現在のv2をConsensus信頼性やPilot移行の成功証拠として扱わない
- 結果を改善する目的で既存`benchmark.json`を書き換えない
- このBenchmarkだけを理由に`present`の既存意味を変更しない
- v2を修正して再利用した結果を、新規held-out evidenceとして扱わない

## 後日再開時に決めること

1. `usable`が空文字・空配列を許容するかをConceptまたは専用IRで定義する
2. optionalな除外マーカーの欠損を、非アクティブと不明のどちらとして扱うかを定義する
3. `equals null`、`not present`、または`unresolved`のどれを正解とするかを決める
4. v1と異なる論理構造をheld-out評価へ含める必要があるかを決める
5. 既存v2を保留記録として残し、新規versionの評価セットを作るかを決める

## 再開条件

次をすべて満たした後に、独立レビューとlive評価を再開する。

- 上記の未決事項について期待意味が文書化されている
- resolved Oracleが空文字、空配列、`null`、`undefined`を含む必要な境界テストと一致する
- Oracle自身をfixtureで評価する自動検証が成功する
- 既存v2を変更する場合は、それを新規held-out evidenceとして再利用しない方針が明記されている
- 新しいauthoritative inputがSHA-256で凍結されている
- モデル出力を見ていない独立した人間レビューが完了している
- `bun run typecheck`と`bun test`が成功している

## 関連ファイル

- [`REVIEW.md`](./REVIEW.md)
- [`benchmark.json`](./benchmark.json)
- [`freeze.json`](./freeze.json)
- [`../../PROJECT_STATUS_AND_ROADMAP.md`](../../PROJECT_STATUS_AND_ROADMAP.md)
- [`../../src/generator.ts`](../../src/generator.ts)
- [`../../src/schema-evolution-v2.ts`](../../src/schema-evolution-v2.ts)
