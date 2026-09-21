# Semantic Core安定化・第一段階 実施結果

実施日：2026-09-21。対象計画：[第一段階 実装計画](./SEMANTIC_CORE_STABILIZATION_PHASE1_IMPLEMENTATION_PLAN.md)。

## 結果

計画SC1-01〜SC1-06の文書化と検証を完了した。既存コード、schema、artifact、fixture、依存関係は変更していない。Semantic Coreを新しい単一IRとして実装せず、現行profileのchecked representationを基盤に、architecture、意味論、観測条件、version／hash契約を整理した。

| 作業 | 結果 | 成果物 |
| --- | --- | --- |
| SC1-01 基点・台帳 | commit、未コミット差分、tool version、試験結果を記録 | 本文書 |
| SC1-02 Architecture | frontendからruntime／verificationまでの経路と合流点を整理 | [Architecture](./LLANG_ARCHITECTURE.md) |
| SC1-03 Profile意味論 | 共通原則とPredicate／Bool／Value／Collection／Effectsの提供範囲を固定 | [Semantic Core v1](./LLANG_SEMANTIC_CORE_V1.md) |
| SC1-04 Observable semantics | 比較ケース、観測値、正規化、現在の証拠と空白を定義 | [Observable Semantics](./LLANG_OBSERVABLE_SEMANTICS.md) |
| SC1-05 Version／hash | source、profile、build、ABI、suite、Effects証拠とhash対象を分離 | [Version契約](./LLANG_VERSIONING.md) |
| SC1-06 整合・引継ぎ | 文書導線、差分、次段階の着手条件を記録 | 本文書、[文書一覧](./README.md) |

## 調査基点

| 項目 | 値 |
| --- | --- |
| Git commit | `381ccf9adb281d6339444941120a5aca4ae7e5ad` |
| 着手時の既存差分 | `docs/README.md`、安定化コンセプト、第一段階計画。いずれも本作業の直前段階で作成した未コミット文書 |
| Bun | 1.4.2 |
| TypeScript | 5.9.3 |
| Biome | 2.5.13 |
| Binaryen | 132.0.0 |
| API／network | profile試験と文書検査ではAPI credential・外部networkを使用していない |

文書はこのsnapshotの実装と試験を根拠にする。未コミット文書を含むため、将来の参照では最終commitを別途記録する必要がある。

## 検証結果

| コマンド群 | 結果 | 確認範囲 |
| --- | --- | --- |
| Bool／Value／Collection | 37 pass、0 fail | frontend合流、4経路結果、値・collection・fault・portable bundle |
| Effects loader／build／graph | 15 pass、0 fail | TS／JSONC checked program、all-target build、typed request replay、task／stream |
| Effects contract／session／concurrency | 11 pass、0 fail | registry、grant、ledger、deadline、cancel、cleanup、structured concurrency |
| Prompt／Hybrid／Predicate projection | 20 pass、0 fail | lock、source競合、artifact linkage、canonical import、inspection TS |
| 合計 | 83 pass、0 fail | 固定fixtureと既存境界case。全programの同値証明ではない |

実行コマンドは計画第7節の4つの`bun test`で、すべてBun 1.4.2、timeout 30000 msで完了した。文書完成後に`bun run ci:docs`と`git diff --check`を実行し、結果を最終確認した。

コードを変更していないため、coverage、全test、smoke、protected、audit、remote CIは今回の完了判定として実行しない。これらの未実行を成功として扱わない。

## 差分台帳

| ID | 分類 | 対象・現状 | 影響 | 後続 |
| --- | --- | --- | --- | --- |
| SCG-001 | 証拠不足 | Effectsはreference graphとportable Wasmで同じtyped suiteを利用するが、generated TSを含む全targetのresult／effect trace統一比較runnerがない | Effectsのcross-target equivalenceを一括報告できない | deterministic host fixtureとtrace schemaを先に設計する |
| SCG-002 | 一部解消 | bool／value／collectionのdifferentialは固定suite中心だった。Value pure i32には第二段階で決定的generatorを追加 | Valueの対象subsetは拡張、Valueの残りとBool／Collectionは固定fixture中心 | [第二段階の結果](./SEMANTIC_CORE_STABILIZATION_PHASE2_RESULTS.md)を基準に、証拠表の空白から次subsetを選ぶ |
| SCG-003 | 契約判断 | Collectionのfuel／arenaやEffects ledger等のresource量は、すべてのtargetで同じ単位を共有するとは限らない | resource consumptionの完全一致という表現が過大になる | outcome、logical counter、物理量を分けたprofile別比較表を作る |
| SCG-004 | 契約判断 | taskのjoin result順はspawn順で固定されるが、並行dispatchの全順序を一般契約として固定していない | effect order比較にscheduler条件が必要 | fixed schedulerと許容partial orderを分けて設計する |
| SCG-005 | 説明不足 | Predicate、Prompt、Hybrid、Semantic TypeScriptは共通部分を持つが、module系とはartifact／verification contractが別 | 単一路線に見せると対応範囲を誤認する | Architectureと経路ガイドの対応を維持し、統合は別判断にする |
| SCG-006 | 説明不足 | Effects assurance core v1とSemantic Core v1は名称にCoreを含むが、前者はtrust/data assurance、後者は意味契約 | 文書検索時に役割を混同し得る | 文書一覧と両文書で適用範囲を相互説明する |

第一段階を妨げる仕様・実装の直接矛盾は、今回確認した範囲では見つからなかった。SCG-001〜004は「全profileのcross-target同値性が完成した」という主張を制限するため、次段階で解消または比較範囲を確定する必要がある。

## 確定した境界

- Semantic Core v1は既存profileの共通原則と意味契約であり、新しいartifact形式ではない。
- restricted TS／JSONCは同じmodule profile内でchecked representationへ合流する。source provenanceは別に保持する。
- Predicate系の複数経路とmodule系は、共有部品があってもartifact・verification contractを分ける。
- observable semanticsはresultだけでなくfault、effect、task／stream、resource、cleanupを含み、Effectsでは環境条件を比較ケースへ含める。
- versionとhashはformat／profileごとの対象を持ち、数値やfield名だけで横断的互換性を推定しない。
- 現在の試験は実用的な有限証拠であり、一般の意味的同値性や要求の正しさの証明ではない。

## 次段階への引継ぎ

最初のgenerated differential testingは`module-value-v1`のpure expression／i32 subsetを候補とする。このsubsetはreference evaluator、generated TS、normalized JSONC、direct Wasm runtimeがあり、正常値とoverflow／division-by-zeroを安定codeで比較できる。

次の計画では少なくとも以下を定める。

- generatorが作る型、式、depth、i32 literal／inputの範囲。
- deterministic seed、case数、実行予算、反例のserialize形式。
- reference／TS／JSONC／Wasmから同じobservable outcomeを収集するadapter。
- independent expected fixtureとmutationにより、共通実装の誤りを見逃さない方法。
- shrinkまたは小さな反例への還元、固定回帰testへの昇格条件。
- SCG-003に従い、最初は物理resource consumptionを比較対象に含めないこと。

EffectsはSCG-001とSCG-004を先に設計し、generated TSとWasmへ同じgrant、host response、logical clock、scheduleを注入できるsubsetから着手する。
