# Semantic Closure graph implementation plan

作成日: 2026-07-21

状態: **実装完了**

## 目的

複数のPredicate / Static Judgmentを1つの明示的なgraphとして読み取り、現在のsource、`semantic.lock`、生成物だけから、プロジェクトの機械的なSemantic ClosureをAPIなし・読み取り専用で検査する。

今回のClosureは、現在記録できる次の状態を一括検査する。

- Semantic sourceが現在のlock entryと一致するか
- 生成物が存在し、lockに保存されたhashと一致するか
- manifestに宣言された依存先が存在するか
- 依存graphが循環していないか
- すべてのnodeが`current`か

人間承認は現行`semantic.lock`に記録されていない。承認済みとは推測せず、reportでは`unknown`と明示する。したがって今回保証するのは**artifact-level closure**であり、原案にある人間承認を含む完全なSemantic Closureではない。

## 先行レビュー指摘

Closure実装前に次を修正する。

1. `semantic.lock`の各entryを実行時に厳格検証する
2. Semantic Explainのread-only統合テストへv2 `freeze.json`を追加する

ClosureはlockとExplainの結果を信頼するため、壊れたlockを型castだけで受理してはならない。

## 利用形

```bash
bun run semantic closure semantic-closure.json
bun run semantic closure semantic-closure.json --json
```

## manifest

```json
{
  "version": 1,
  "nodes": [
    {
      "id": "active-customer",
      "source": "examples/active-customer/semantic.ts",
      "dependsOn": []
    },
    {
      "id": "mike-is-cat",
      "source": "examples/static-judgment/semantic.ts",
      "dependsOn": ["active-customer"]
    }
  ]
}
```

制約:

- manifestはworkspace内に置く
- `version`は`1`のみ
- node IDはmanifest内で一意
- source pathはworkspace相対で、workspace外を参照しない
- 1 sourceは1つのPredicateまたはStatic Judgmentだけを持つ
- dependencyはmanifest内のnode IDだけを参照する
- self dependencyとcycleを拒否する
- nodeとdependencyの順序は出力の意味へ影響しない

依存関係は明示宣言だけを正とする。import graphやリポジトリ全体を走査して、未宣言nodeや依存辺を推測しない。

## report model

```ts
type SemanticClosureReport = {
  version: 1;
  scope: "artifact";
  status: "closed" | "open";
  approval: "unknown";
  manifest: string;
  nodes: SemanticClosureNode[];
  edges: SemanticClosureEdge[];
  blockers: SemanticClosureBlocker[];
  summary: {
    total: number;
    current: number;
    stale: number;
    unlocked: number;
    integrityError: number;
  };
  limitations: string[];
};
```

nodeは`semantic explain`の結果から構築する。

```ts
type SemanticClosureNode = {
  id: string;
  kind: "predicate" | "static-judgment";
  source: string;
  symbol: string;
  conceptId: string;
  status: "current" | "stale" | "unlocked" | "integrity-error";
  generated: GeneratedIntegrity | null;
  dependsOn: string[];
};
```

blockerはnode単位で次を表す。

- `stale`
- `unlocked`
- `integrity-error`

manifest不正、存在しないdependency、cycle、source解析失敗、lock形式不正はreportを信頼できないため例外として終了する。

## statusと終了コード

| 状態 | report | exit code |
| --- | --- | ---: |
| graphが有効で全nodeが`current` | `closed` | 0 |
| graphが有効だが1件以上が非current | `open` | 2 |
| manifest、source、lock、graphが不正 | reportなし、stderrへ理由 | 1 |

`closed`はartifact-levelの意味であり、人間承認を保証しない。

## 読み取り専用の保証

Closure checkから次を呼ばない。

- OpenAI / Azure OpenAI adapter
- resolver
- Predicate / Static Judgment compiler transaction
- `writeSemanticLock`
- candidate promotion
- audit作成
- generated file更新
- v2 benchmark実行

実行前後で次が不変であることを統合テストで確認する。

- `semantic.lock`
- Predicate / Static Judgment生成物
- `.semantic/` file set/hash
- v2 `benchmark.json`
- v2 `freeze.json`

## 変更予定ファイル

### 新規

| File | 責務 |
| --- | --- |
| `SEMANTIC_CLOSURE_IMPLEMENTATION_PLAN.md` | 本計画 |
| `src/semantic-closure.ts` | manifest parse、graph検証、Explain集約、status判定 |
| `src/semantic-closure-renderer.ts` | text renderer |
| `src/semantic-closure.test.ts` | manifest、graph、statusの単体テスト |
| `src/semantic-closure.integration.test.ts` | CLI、exit code、read-only統合検証 |
| `semantic-closure.json` | 現在の2つの代表Semantic nodeを束ねる例 |

### 変更

| File | 変更 |
| --- | --- |
| `src/semantic-lock.ts` | lock entryの厳格なruntime parser |
| `src/semantic-lock.test.ts` | malformed lockの拒否テスト |
| `src/semantic-explain.integration.test.ts` | `freeze.json`不変検査 |
| `src/semantic-cli.ts` | `closure` command、`--json`、exit code 2 |
| `package.json` | `semantic:closure` script |
| `README.md` | manifest、status、制限、CLI利用法 |
| `PROJECT_STATUS_AND_ROADMAP.md` | Gate 2の実装状況と残課題 |

## 実装フェーズ

### Phase 0: ベースライン固定

```bash
bun run typecheck
bun test
bun run semantic:explain
bun run semantic:judgment:explain
```

完了条件:

- `72 pass / 0 fail`以上
- 両exampleが`current`
- 両generated integrityが`verified`
- 作業ツリーに開始前の未記録変更がない

### Phase 1: lock厳格化

- Predicate entryの必須string、IR、response、日時を検証
- Static Judgment entryの必須string、boolean、response、日時を検証
- `entries` / `judgments`がplain recordであることを検証
- map keyとentry fingerprintの一致を検証
- malformed lockをfail-closedで拒否

完了条件:

- 現在のroot `semantic.lock`をmigrationなしで読める
- 不正boolean、IR、日時、hash、namespaceを拒否する
- replayとExplainの既存挙動が変わらない

### Phase 2: Closure modelとgraph

- manifestを厳格parse
- source pathをworkspace内へ制限
- duplicate ID、unknown dependency、self dependency、cycleを拒否
- nodeを決定的順序へ正規化
- 各sourceへ`explainSemanticSource`を実行
- status、summary、blocker、edgeを構築

完了条件:

- PredicateとStatic Judgmentを同じgraphに含められる
- 非current nodeを1件も取りこぼさない
- graph順序を変えても正規化出力が同じ
- API、resolver、compilerを呼ばない

### Phase 3: rendererとCLI

- `semantic closure <manifest>`を追加
- default textと`--json`を追加
- `closed=0`、`open=2`、error=1を実装
- unknown optionと`--fixture`を拒否

完了条件:

- text / JSONで同じstatus、summary、blockerを表現する
- CIがexit codeだけでopenを検出できる
- approvalを`unknown`以外として表示しない

### Phase 4: read-only統合検証と文書更新

- currentな複数node graph
- stale node
- unlocked node
- generated missing / mismatch
- duplicate / unknown dependency / cycle
- malformed lock
- API keyなしのCLI
- protected artifactの前後hash比較
- README、ロードマップ、計画書の更新

完了条件:

- 型チェック成功
- 全テスト成功
- root manifestが`closed`、exit code 0
- text / JSONが同一のclosure状態を返す
- protected artifactが不変
- Predicate / Static Judgment replay hashが不変

## 非対象

- リポジトリ全体からのSemantic source自動探索
- TypeScript import graphの自動依存解析
- 未宣言dependencyの推測
- 自動build / replay / repair
- LLMによるClosure説明
- 人間承認の新規保存や推測
- runtime LLM Judgment
- Schema Evolution candidateのgraph統合
- HTML、IDE、LSP表示

## 最終完了条件

- lock entryが厳格に実行時検証される
- 複数Predicate / Static Judgmentを1つのmanifestで検査できる
- graphの参照整合性とcycleを検出できる
- stale / unlocked / integrity-errorを一括検出できる
- text / JSONとfail-closed終了コードを提供する
- approvalを`unknown`として明示する
- Closure checkがworkspaceを変更しない
- v2 Blockerと凍結入力へ影響しない
- 型チェックと全テストが成功する

## 実装結果

2026-07-21にPhase 0からPhase 4まで完了した。

- `semantic.lock`のPredicate / Static Judgment entryを厳格なruntime parserへ移行
- Explainのread-only保護対象へv2 `freeze.json`を追加
- 明示manifest、複数node、依存辺、duplicate / unknown dependency / self dependency / cycle検査を実装
- `semantic closure`のtext / JSON、`closed=0`、`open=2`、error=1を実装
- root manifestはPredicate 3件とStatic Judgment 1件の4/4 nodeが`current`、artifact-level `closed`
- API keyなしで成功し、lock、生成物、audit、v2 benchmark / freezeは不変
- `bun run typecheck`: 成功
- `bun test`: `78 pass / 0 fail`
