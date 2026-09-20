# Effects adversarial benchmark 実装結果

実施日: 2026-09-20。対象計画: [Effects adversarial比較benchmark実装計画](./EFFECTS_ADVERSARIAL_BENCHMARK_IMPLEMENTATION_PLAN.md)。

## 実装したもの

- `llang-effects-adversarial-study` version 1のstrict parser、public／hidden path分離、exact file set、stable read、symlink／hard-link／path escape拒否。
- analysis plan、sample-size plan、dataset provenance、claim-to-evidence matrix、未登録preregistration bundle。fixtureのprecision入力から9 independent familyを要求し、反復trialをcase数へ数えない。
- fixture／candidate／reviewedのreview・freeze。reviewedは別author／reviewer、正確なstudy hash、外部timestamp入力、owner run approvalがなければfreezeできない。softwareは人物の実在性やtimestamp authorityを自己認定しない。
- networkを開かない一つの`EffectsBenchmarkHost`、同一grant／input／budget／fault schedule、armごとの状態分離、redacted operation log。
- checked benchmark programを読むL-Lang adapterと、型検査対象のhand-written TypeScript baseline。L-Lang trialはEffects compiler、requirement approval v2、execution v4、execution／audit attestation v2、portable package verification、summary生成まで実際のEffects assurance core v1を通してから共通host operationを完了する。秘密鍵は一時directoryから削除する。
- 各L-Lang trialでfull chainを省略せず実行し、bundle identity、requirements、trust boundary、実operationのcommitmentをhost logへ照合する。TypeScript baselineはfreeze確認済みbytesをメモリ上で変換して実行し、確認後のsource差し替えとruntime importを拒否する。
- freeze済みseedによるcase blockの順序化とarm counterbalance、排他run lock、trialごとのcheckpoint／JSONL、completed trialを再実行しないresume、uncertainのfail-closed停止。
- trialごとにfreeze hashを再照合し、strict JSONで読み直す。output directoryのsymlink／identity差し替えを拒否し、処理済みerrorでは所有lockを確実に解放する。
- 全arm終了後だけhidden Oracleを読むblind scoring。許可operation sequence、禁止operation／target群、終端、cleanupを独立に固定し、host logだけからcompletion、block、flow、false rejection、Oracle mismatchを採点する。
- case pair単位の二arm差、保守的simultaneous 95% Hoeffding interval、事前指定threshold判定、attrition、missingness、worst-case sensitivity lane、ablation分離。反復はcase内でall-passへ縮約する。
- portable result package、外部freeze照合、source非実行verify、raw observationからのJSON／Markdown／category × variant × arm table CSV／figure CSV再生成、clean output directoryへのreproduce。
- paper artifact bundle。claims、preregistration status、analysis／sample-size plan、dataset manifest、ethics status、environment、raw、derived、tables、figures、scripts、checksums、第三者再現record templateを含む。
- `validate | plan | fixture | freeze | run | analyze | verify | reproduce` CLI。fixture／verify／reproduceはexternal network、credential、API call、token、costがすべて0。

checked-in datasetは9 categoryのsynthetic regression fixtureである。二つのarmは72 trial（9 pair × normal／adversarial × 2 arm × 2 repetitions）を実行するが、研究比較ではない。`evidenceEligible: false`、外部登録未実施、第三者再現未実施を維持する。

## PR-0〜PR-9

| 単位 | 実装 |
| --- | --- |
| PR-0 | research contract、schema、precision再計算、claim／preregistration template |
| PR-1 | study／task／input／Oracle parser、public-hidden分離、exact file set |
| PR-2 | review binding、freeze、不変hash、evidence gate |
| PR-3 | common host、redacted observation、budget、virtual clock、fault schedule commitment |
| PR-4 | frozen hand-written TypeScript baseline、型検査、禁止API scanner、同値trial |
| PR-5 | checked L-Lang adapter、execution v4からsummaryまでのfull-chain verification |
| PR-6 | counterbalanced runner、lock、incremental checkpoint、resume、uncertain停止 |
| PR-7 | hidden Oracle、九category mutation sensitivity、paired metric、primary／sensitivity解析 |
| PR-8 | 八つのCLI、portable package、report、offline fixture smoke |
| PR-9 | environment、raw-to-paper、checksums、clean-directory reproduce、第三者record template |

## EAB1〜EAB40

| 条件 | 主な検証 |
| --- | --- |
| EAB1〜EAB4 | strict study、exact files、public-hidden分離、九categoryのpaired fixtureとprecision plan |
| EAB5〜EAB8 | review target、role分離、fixture／candidate gate、全file freeze hash |
| EAB9〜EAB13 | common host／grant／state parity、baseline scan、actual Effects v4 full chain |
| EAB14〜EAB17 | arm自己申告を使わないhost scoring、normal completion、九category mutation |
| EAB18〜EAB21 | deterministic block order、resume、complete matrix、timeout／failure／uncertain分類 |
| EAB22〜EAB24 | relocated package verify、redaction、verify／reproduceのsource・network・API実行0 |
| EAB25〜EAB27 | failure／threshold未達の保持、既存Effects回帰Gate、claim boundary |
| EAB28〜EAB31 | RQ／仮説／estimand／閾値、precision式、pilot隔離、provenance |
| EAB32〜EAB35 | effect／95% interval／multiplicity／missingness、worst case、ablation分離、raw-to-CSV |
| EAB36〜EAB39 | environment、clean output再生成、ethics status、第三者自己認定拒否 |
| EAB40 | null／逆効果／attrition／threshold未達を同じresult schemaで保持 |

## 保証境界

fixtureが示すのは、parser、freeze、runner、二arm adapter、Oracle、解析、再現経路がsynthetic inputで動作し、意図的なmutationを検出することだけである。独立dataset author、domain reviewer、外部immutable timestamp、ownerによるconfirmatory run承認、第三者再現は未提供である。

したがって研究比較は`not-run`である。live model生成品質、人間の監査性、TypeScript一般への優位、実運用安全性は未実証であり、reportのclaim-to-evidence matrix外へ昇格させない。

## 検証結果

2026-09-20に、macOS Darwin 25.6.0／arm64／Apple M4、Bun 1.4.2、TypeScript 5.9.3で次を実行した。

- `bun run format`: 成功。435 files。
- `bun run check`: 成功。707 tests、0 failed、15,531 assertions。既存lint warning 88件、新規error 0件。
- `bun run coverage`: 成功。707 tests、0 failed。全体93.11% functions、92.70% linesでthreshold通過。
- `bun run ci:docs`: 成功。Markdown linkとdocument contractを検証。
- `bun run ci:protected`: 成功。
- `bun run ci:smoke`: 成功。L-Lang、module、Effects smokeを含む。
- benchmark対象test: 29 tests、0 failed、1,067 assertions。
- CLI fixture: 9 case、72 trial、72 completed、failed／unknown／uncertain／excludedはすべて0。`apiCalls: 0`、`sourceExecution: 0`、`network: 0`。
- portable result hash: `ab04acdd159d212c564cea83d9d19cf63545275b0b29b5eef659926277838764`。
- analysis hash: `4696722bd40eb000bad9c69239e34d372652d22cef6a3a8cbe536c15ccd98556`。
- reproduce derived hash: `42c0502630a4a05a580044c73c5b13a1f28ef675f393be51f5824fc089c9ff31`。外部freeze照合済みで、元runとclean reproduceの`result.json`、`table.csv`、`figure.csv`はbyte一致。
- `git diff --check`: 成功。

fixtureの二つのprimary estimateは0、family単位の同時95%区間は[-0.986805, 0.986805]で、superiorityとnoninferiorityはいずれも`threshold-not-met`だった。これは研究比較ではなく、synthetic regression fixtureの両armが同じ正常操作を完了した結果である。

Ubuntu／Windowsはこのlocal作業では未実行であり、成功とは記録しない。独立dataset、domain review、外部immutable timestamp、owner confirmatory-run approval、第三者再現も未実施である。
