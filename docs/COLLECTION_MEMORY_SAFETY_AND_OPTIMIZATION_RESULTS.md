# Collectionメモリー安全性と最適化基盤 実装結果

実装日: 2026-09-20。対象: `module-collection-v1` / `llang-collection-native-v1`。

## 結果

generated Wasmの`evaluate`がhost codecとは独立してABI引数とwire valueを検査するようにした。base、length、capacity、alignment、memory containment、input/output overlapをload前に確認する。型別validatorはboolean、String、List、Record、Unionを走査し、canonical empty、UTF-8、payload containment、payload overlap、List上限、aggregate上限をentry実行前に拒否する。

direct corpusはemptyから4,096要素までの固定境界をreference evaluator、host runtime、raw ABIの三経路で比較する。negative corpusはinput length無視、overflow前allocator検査の欠落、alignment検査の欠落、nested validatorの省略、fault後続行という5種類のWAT変異を区別する。これによりtestが実装と同じvalidatorだけをoracleにする状態を避けた。

allocatorは加算結果を境界と比較する方式を廃止し、残容量に対してpaddingとsizeを順に比較してからheapを更新する。byte copyもsourceとdestinationをmemory範囲内と確認してから実行する。検査失敗はfault code 5でtrapし、`busy`を残して同一instanceの再利用を拒否する。public runtimeは従来どおり評価ごとにfresh instanceを生成する。

`RegionMemory.release`は解放済みentryをMapから削除する。handle IDを再利用せず、safe integer枯渇前にfail-closedとした。active allocation、free block、used/peak bytes、lifetime別bytesをimmutable診断値として取得できる。1,000,000回のallocate/release testでactive metadata 0、free block 1を確認する。これはCollection Wasm arenaとは独立した修正である。

## 計測と最適化判断

instrumented buildを通常buildと分離した。通常artifactのexportは`memory`、`evaluate`、`fault_code`の3つのままである。instrumented buildはallocation、alignment込みbytes、copy、validation、arena peak、output promotionを整数counterとして返す。計測専用のvalidation probeとkernel probeにより、時間をbuild、instantiate、encode、host validation、Wasm validation、kernel、decode、end-to-endへ分離し、RSSとlinear memoryを別に記録する。

checked-in fixtureの決定的観測は次のとおり。

| 指標 | 値 |
| --- | ---: |
| allocation sites / calls | 9 / 9 |
| requested / aligned bytes | 96 / 96 |
| copy sites / calls / bytes | 9 / 15 / 68 |
| output promotion allocation / copy bytes | 12 / 24 |
| validation descriptors / List elements | 7 / 4 |
| arena peak | 108 bytes |
| product / instrumented Wasm | 2,672 / 3,620 bytes |

output promotionはcopy bytesの35.29%を占め、30%の候補選択閾値を超えた。ただし、このcopyはinputまたは一時arenaのlifetimeをABI outputへ露出させないために必要である。ABI v1、output所有権、portable decodeを維持したまま削除する案が成立しないため、候補を却下した。性能コードを入れないことをPR-7の正式な結果とした。checked-in fixture一件から一般性能や本番memory削減は主張しない。

候補はholdout比較へ進む前の意味保存条件で却下されたため、比較armとholdout結果は作っていない。`holdout/README.md`にこの空状態を明記する。local timing観測は単一baselineのraw 30 samplesを保存し、OS releaseとCPU modelを含むenvironment、各区間のmedianを出力する。

2026-09-20にBun 1.4.2、darwin 25.6.0 arm64、Apple M4で実行した単一baselineのmedianは、build 12.7846 ms、instantiate 0.8579 ms、encode 0.0725 ms、host validation 0.0244 ms、Wasm validation 0.0078 ms、kernel 0.0289 ms、decode 0.0113 ms、end-to-end 0.1745 msだった。これはそのhostでの再現確認であり、性能採用の根拠や他環境の値ではない。raw observationは環境依存のためrepositoryへ固定せず、`/tmp/collection-timing.json`へ生成して確認した。

## 計画との対応

| 計画単位 | 実装 |
| --- | --- |
| PR-0 | ABI、runtime、Binaryen、閾値を`freeze.json`へ固定 |
| PR-1 | host codecを通さない`CollectionDirectHarness`とnegative test |
| PR-2 | 型別Wasm validator、claim table、UTF-8、aggregate検査 |
| PR-3 | safe allocator、copy containment、capacity canary test |
| PR-4 | RegionMemory metadata削除、診断、1,000,000反復test |
| PR-5 | productから分離したinstrumented buildとcost schema |
| PR-6 | 決定的baselineと候補decisionをchecked-in artifact化 |
| PR-7 | output promotionを選択し、ownership条件により却下 |
| PR-8 | Matrix、仕様、結果、index、roadmap、品質Gateを更新 |

### 受け入れ条件との対応

| ID | 状態 | 根拠 |
| --- | --- | --- |
| MSO1 | 完了 | `freeze.json`がprofile、ABI、Bun 1.4.2、Binaryen 132を固定する。対象revisionは計画書の基点と実行時Git状態を併記する。 |
| MSO2 | 完了 | `memory-safety-matrix.json`の各行が保証層、条件、positive/negative vector、制限を持ち、schemaで検査される。MarkdownはJSONから生成して一致をtestする。 |
| MSO3 | 完了 | `CollectionDirectHarness`がhost decodeを介さずexport `evaluate`を直接呼ぶ。 |
| MSO4 | 完了 | direct testが負値、memory末尾、`0xffffffff`長、output wraparoundをfault 5で拒否する。 |
| MSO5 | 完了 | 完全・部分・1-byte境界のinput/output overlapをdirect testで拒否する。 |
| MSO6 | 完了 | root layoutより短い`inputLength`をroot load前に拒否する。 |
| MSO7 | 完了 | String/Listのpointer、count、alignment、canonical emptyを型別validatorとdirect testで検査する。 |
| MSO8 | 完了 | validatorと`$allocArray`がstride除算で積の上限を先に確認し、`i32.mul`はその後だけ実行する。 |
| MSO9 | 完了 | String/List payloadをclaimし、Record/Unionを型layoutに従って再帰検査する。 |
| MSO10 | 完了 | byte単位claim bitmapがroot、descriptor、payloadの完全・部分aliasを拒否する。 |
| MSO11 | 完了 | scalar UTF-8 validatorが不正sequence、最大4-byte scalar、16 KiB境界、超過を検査する。 |
| MSO12 | 完了 | compilerの型深度上限に加え、Wasm entryがList 4,096、aggregate 16,384、String 16 KiB、wire 256 KiBを適用する。 |
| MSO13 | 完了 | validationはwire 256 KiBのbitmapとaggregate 16,384回以下の走査に制限され、外部入力に対して線形上限を持つ。 |
| MSO14 | 完了 | `$fail`はfault設定直後にtrapし、`busy`を残す。同一instanceの再呼出し拒否、fresh instance成功、fault後続行mutantの検出をtestする。 |
| MSO15 | 完了 | `$alloc`がpaddingとsizeを残容量から順に検査し、成功後だけheapを更新する。capacity不足とcanaryをtestする。 |
| MSO16 | 完了 | `$copyBytes`がsource/destinationのbaseとlengthを減算比較で検査する。 |
| MSO17 | 完了 | 拒否したdirect入力でinput snapshotとinput/output近傍canaryが不変である。 |
| MSO18 | 完了 | 同一canonical入力をreference evaluator、host runtime、direct ABIで評価し、値を比較する。 |
| MSO19 | 完了 | 既存Collection suiteがindex、division、arithmetic、resource faultと最初のfaultを回帰検査する。安全性違反だけfault 5に分類する。 |
| MSO20 | 完了 | product exportは3件のままで、既存manifest v4、suite v3、portable verificationとsmokeが通る。 |
| MSO21 | 完了 | 1,000,000回のallocate/release後もactive metadata 0、free block 1である。 |
| MSO22 | 完了 | 単調IDを再利用せず、release済み、偽造、二重releaseを`STALE_REGION_HANDLE`で拒否する。slotを再利用しないためgeneration方式は不要である。 |
| MSO23 | 完了 | Matrix、仕様、結果でRegionMemoryとCollection Wasm arenaを独立実装として記録する。 |
| MSO24 | 完了 | 同一program/inputの決定的cost projectionを二回生成し、checked-in JSONともdeep equalityで比較する。 |
| MSO25 | 完了 | product buildのexportが`memory`、`evaluate`、`fault_code`だけであることをtestする。計測exportは別emitterだけにある。 |
| MSO26 | 完了 | timingをbuild、instantiate、encode、host validation、Wasm validation、kernel、decode、end-to-endへ分離する。 |
| MSO27 | 完了 | linear memory、arena peak、RSS before/after、peak RSS、steady RSSを別fieldに保存する。 |
| MSO28 | 完了 | `benchmark.json`と`freeze.json`が入力、順序、warmup 5、反復30、閾値、runtimeを結果から独立して固定する。 |
| MSO29 | 完了 | copy shareの優先規則でoutput promotion一件だけを選び、ownership成立条件と判断を保存する。 |
| MSO30 | 完了 | 最適化を採用しなかったため製品意味は安全性修正以外に変わらない。既存differential、portable、fault testで値・評価順・fuel・resource outcomeを確認する。 |
| MSO31 | 完了 | 35.29%の候補を「改善」と扱わず、ABI output ownershipを維持できないため`rejected`としてexpected observationへ保存する。 |
| MSO32 | 完了 | Matrix生成、direct suite、決定的cost生成・`--verify`をcredentialやnetworkなしで実行できる。 |
| MSO33 | 完了 | Binaryen 132のparse/validate/emit経路だけを使い、global optimization設定や製品passを変更していない。 |
| MSO34 | 完了 | 下記「保証しない範囲」に任意Wasm、host同時改変、本番性能、未実行OSを明記する。 |
| MSO35 | 完了 | Bun 1.4.2で全check、coverage、docs、protected、smoke、Collection/RegionMemory対象testを実行する。 |
| MSO36 | 完了 | 本表がMSO1〜MSO35の根拠を列挙し、却下候補と未保証範囲を残す。 |

## 再現

```sh
bun run src/llang-collection-cost-cli.ts benchmarks/collection-memory-v1/benchmark.json /tmp/collection-cost.json --deterministic --verify benchmarks/collection-memory-v1/expected/cost.json
bun test src/llang-collection-memory.test.ts
bun test src/llang-collection-cost.test.ts
bun test src/llang-region-memory.test.ts
bun test src/llang-module-collection.test.ts
```

時間とRSSを含むlocal観測は`bun run collection:memory`で生成する。`observations/`は実行環境依存なので正本へしない。

## 最終品質Gate

2026-09-20にBun 1.4.2で同一作業ツリーを検証した。

| Gate | 結果 |
| --- | --- |
| `bun run check` | 721 pass、0 fail、15,657 assertions。format、lint、typecheckを含む。lintの既存warning 90件はexit 0。 |
| `bun run coverage` | 721 pass、0 fail、15,657 assertions。全体90% functions／90% lines、`semantic-transaction.ts` 95%／95%の設定閾値を通過。 |
| `bun run ci:docs` | Markdown linkとdocumentation contractが通過。 |
| `bun run ci:protected` | protected benchmark inputsが通過。 |
| `bun run ci:smoke` | semantic、L-Lang、module、Collection portable 3 cases、Effects smokeが通過。 |
| 対象test | Collection memory/cost/moduleとRegionMemoryの29件が通過。 |
| deterministic cost | checked-in `expected/cost.json`とのsemantic JSON照合が通過。 |
| fresh copy再現 | Git metadataを含まない一時copyで対象29件、Matrix再生成一致、cost JSON照合が通過。 |
| `git diff --check` | 通過。 |

## 保証しない範囲

- 任意のWasm、共有memory、検査中にmemoryを書き換えるhost。
- Collection以外のprofileへ同じvalidatorが入ったという主張。
- live workload、長時間soak、全OSでの性能またはRSS改善。
- RegionMemoryとCollection Wasm allocatorの接続。
- output promotionを省略できる新ABIまたはownership規則。

詳細な層別保証は[Collection Memory Safety Matrix](./COLLECTION_MEMORY_SAFETY_MATRIX.md)を参照する。
