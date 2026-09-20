# メモリー安全性と Semantic IR 最適化のコンセプト

状態：提案・未実装。2026-09-20。実装時期は未定。

## 目的と位置付け

L-Lang の制限された型付き Semantic IR を使い、危険なメモリー操作を表現しにくくするとともに、値の型・用途・寿命から不要な割当やコピーを減らす。安全性は決定的な検証で確認し、性能上の効果は対象環境で測定する。LLM は候補や仮説を提案できるが、安全性・意味同値性・採用の根拠を LLM の判断だけに置かない。

本書は将来の着手判断を残すコンセプトであり、直ちに全項目を実装する計画ではない。時期を見て対象を選び、再現、最小変更、比較評価を一つずつ行う。検証によって不要と分かった仕組みや、効果のない最適化は導入しない。

[Wasm 最適化ビルド設計案](./WASM_OPTIMIZED_BUILD_DESIGN.md)を、安全性の保証境界と意味保存の条件から補完する。現行の契約は [Value 仕様](./LLANG_MODULE_VALUE_SPEC.md)、[Collection 仕様](./LLANG_MODULE_COLLECTION_SPEC.md)、[Effects 仕様](./LLANG_MODULE_EFFECTS_SPEC.md)を優先する。過去の構想に記された未実装範囲を、そのまま現在の状態とは扱わない。本書の採用だけでは言語仕様、ABI、資源課金、artifact 検証契約は変わらない。

## 現時点の観察と未検証の仮説

以下は 2026-09-20 の作業ツリーを静的に確認した記録である。基点 HEAD は `f52a0c73d8a6c68f568c94f72e10901f47ba312a`。作業ツリーには別作業の未コミット変更があり、完全に凍結された実験 snapshot ではない。本書作成時には攻撃入力の再現試験や新しい性能測定を実施していない。着手時に対象 revision と実装を再確認する。

| 観察 | 意味と次の検証 |
| --- | --- |
| [RegionMemory](../src/llang-region-memory.ts) は解放済み allocation を Map に残す | 反復利用で管理情報が増える構造。長時間反復で確認する。ただし src 内検索では参照が実装とテストに限られ、実際の Wasm 実行経路への接続は別途確認が必要 |
| [Collection runtime](../src/llang-module-collection-runtime.ts) は encode 後に decode して入力を検査する | host adapter 経由の保証と、Wasm export 直接呼出しの保証を分ける |
| [Collection emitter](../src/llang-module-collection-native.ts) の evaluate は inputLength を入口検証に使わず、heap の計算には i32 加算を使う | 不正 descriptor と整数 wraparound の経路を直接呼出しで再現する。静的な懸念だけで具体的な破壊結果を断定しない |
| [Value emitter](../src/llang-module-value-wasm.ts) は範囲条件と UTF-8 検査を i32.or で結合する | 短絡評価ではないため、検査の存在だけでアクセス前の拒否を保証したと扱わない |
| Collection の map/filter は領域を確保し、出力の materialize では再帰コピーを生成する | 割当量・コピー量を測り、返却先への直接生成やコピー削減の候補を一つ選ぶ |
| Collection には型別 layout と monomorphized call がある | specialization を新規に全面導入せず、未解決の callee や dispatch が残る箇所を調べる |

[ソートの段階評価](../examples/wasm-json-sort/STAGED_RESULTS.md)では、7,100 件の heap の計算部分は生成 TS より約 2.1〜2.2 倍速い一方、全体の時間短縮は約 3〜8% だった。selection では特定の select を if に戻すと速度が回復した。これは専用 example の条件付きの結果であり、Collection 全般への効果や一般的な rewrite の正当性を証明しない。確認時の Binaryen 固定版は `132.0.0`。

## 安全性の対象と信頼境界

初期対象は、検証済み IR から信頼するコンパイラが生成した Wasm に、不正な ABI 入力を渡すケースとする。任意の悪意ある Wasm バイナリが L-Lang の契約を守ることを保証するものではない。

Wasm エンジンによる linear memory 全体の境界検査と、L-Lang のオブジェクト・領域・寿命の検査は分ける。memory 内部の別領域への書込み、古い値の再参照、検証処理による資源消費は、Wasm の妥当性検査だけでは解決しない。

調査時には、各保証について host、IR verifier、生成 Wasm、未保証を記録する。対象は範囲、整数演算、descriptor、alias、寿命、stale handle、input/output overlap、検証に要する資源である。保証には成立条件と根拠となるテストまたはコードを添える。

memory を書き換えられる host 自体は信頼境界の外に置く。input の immutable は言語と実行契約上の制約であり、host による任意の改変を阻止する能力ではない。検査済みデータを再利用する場合は、変更・共有・再入によって検査結果が無効にならない条件が必要となる。

## メモリーモデルの方向

Semantic IR には String、Bytes、List、Record、Union などの型付き操作を置き、raw pointer、任意の pointer arithmetic、malloc/free を公開しない。pointer・length・offset への変換は backend が担う。まず既存 profile で表現できる範囲を調べ、型や構文を追加することを先行させない。

領域の役割と寿命は別々に定義する。次は候補であり、現在の実装済みモデルを示すものではない。

| 領域 | 役割 | 決める必要がある寿命・条件 |
| --- | --- | --- |
| static | 定数 | module/instance の寿命と変更禁止の範囲 |
| input | 呼出しの入力 | 読取り専用。参照 payload を許可領域内に制限 |
| scratch | 中間値 | call 単位の arena。個別 free を持たず、一括回収を基本とする |
| output | 返却値 | host コピー完了、次の呼出し、明示解放等のどこまで有効かを確定する |
| session | await や call を跨ぐ値 | 明示 promote、保持上限、取消・失敗・終了時の回収を定義する |

scratch を参照したまま output/session に値を残さない。初めは copy/promote による単純な境界を採り、直接出力は同じ契約を守れる場合に検討する。最小の escape 解析は必要な profile に限定し、RegionMemory と Wasm allocator が同じ管理機構だと仮定しない。

GC や RC は現段階の前提にしない。領域単位の回収と明示的な寿命で成立するかを検証し、長寿命の共有や保持量が問題になった段階で再評価する。host の既存 GC まで不要になるとは主張しない。

## 小さく検証する安全性改善

Wasm 入口では、descriptor 自体の範囲、count/length 上限、積・和・alignment の安全性、payload の範囲、内容の順に検査する。失敗後に後続のロードを実行しない。UTF-8 や nested list の検査にも深さ・総要素数・処理量の上限を設ける。

allocator は、減算による残容量比較または i64 による検査後の縮小を比較する。zero length、境界値、0xffffffff 付近、overlap、canonical な空リスト、nested descriptor を対象にする。alignment は ABI の制約として確認する。拒否時の fault/trap と、途中の書込みを許す範囲も固定する。

管理情報は累積 allocation 数に比例して増えないことを目標とする。Map からの削除で成立するならそれを優先し、必要な場合だけ slot + generation を使う。ID/generation の枯渇や再利用で古い handle が有効にならない条件も必要となる。

正常呼出しの反復だけでなく、trap 後の状態を確認する。失敗した instance を廃棄するのか、状態を初期化して再利用できるのかを契約化する。現行 host の呼出しごとの instance 生成から、暗黙に永続 instance へ移行しない。

## 最適化で保存する意味

最適化は戻り値だけでなく、評価順序に由来するエラー、checked arithmetic、安定順序、effect、資源契約を対象にする。pure は「trap しない」「必ず停止する」と同義ではない。

例えば map(map(xs, g), f) の融合では、全要素の g の後に f を実行する順序が、各要素で g/f を続ける順序に変わる。g(x2) と f(g(x1)) が別のエラーを起こすと、最初に観測するエラーが変わる。初期の融合候補は、副作用・trap・停止性について成立条件を確認できるものに限定する。

fuel、call depth、arena 上限の扱いは最適化前に決める。割当や呼出しを減らすと、元は RESOURCE_LIMIT だった入力が成功し得る。次の選択を曖昧にしない。

- 現行契約が要求する論理的課金と失敗挙動を保存する。
- 資源削減による成功範囲の拡大を許す契約を、別途明示して採用する。

契約変更が決まるまでは現行仕様の保存を既定とする。map(identity, xs) の除去や direct output にも同じ確認を適用する。入力上限を満たす通常例だけで意味保存を判定しない。

型検証・Wasm validation・テストによる一致・同値性の証明は区別する。有限領域の全列挙、property-based test、reference evaluator と生成 Wasm の differential test を使い、証拠が保証する範囲を記録する。Agent の候補は同じ検証を通し、速さだけで採用しない。

## 段階的な着手と採否

日付を決めて一括実装せず、各段階で得た証拠を次の着手条件にする。安全性の欠陥が再現された場合は、最適化の準備を待たず修正対象として扱う。

| 段階 | 着手条件 | 最小の作業と完了条件 |
| --- | --- | --- |
| A：現状の固定 | 対象 profile と revision を選べる | Memory Safety Matrix、実行経路、資源・エラー契約を記録。代表ケースと不正入力、baseline を固定する |
| B：安全性の改善 | 保証の欠落を再現できる | overflow または入口検証等を一つ修正。adapter を迂回した直接呼出しテストと既存正常系を通す。未解決の境界を残す |
| C：コストの把握 | 安全性と比較条件が揃う | allocation site 数と実行時 allocation bytes/copy bytes を区別して記録。kernel と入出力込み時間を分け、主要コストを特定する |
| D：一候補の比較 | 主指標と成立条件を決められる | コピー削減、直接出力、既知 callee 等から一つだけ実装。正しさ、資源、安全性、性能の順で採否を決める |
| E：適用範囲の拡大 | 一候補の効果と適用条件が再現する | 必要に応じて escape 解析、融合、複数 runtime、recipe 再利用へ進む。各追加項目を個別に検証する |

各段階で採用、修正して再評価、見送りを記録する。改善が確認できない結果も完了とする。成果物の数を満たすために安全性変更と最適化変更を無理に一件ずつ実装しない。

初回は Collection の直接呼出し境界を中心に、RegionMemory の接続状況を独立して確認する。大規模な session 解析、一般的 optimizer、full e-graph、backend 全面移行、任意 pointer 操作は初回対象にしない。

## 測定と再現性

候補探索前に、対象入力、主指標、許容する回帰、反復数と集計方法を固定する。最初は一つの runtime と代表処理に絞る。探索用と評価用の入力を分け、空・最大・偏りのある入力も含める。実行順と warmup を管理し、ばらつきが効果を上回る場合は改善と断定しない。

初回の指標は、静的 allocation site 数、実行時の割当量・コピー量、arena 最大使用量、kernel 時間、入出力込み時間を基本とする。静的推定と実測には別の名前を使う。計測用 instrumentation の負荷を含む時間を、そのまま製品の性能として扱わない。

必要に応じて validation、encode、copy、decode、compile、instantiate を分離する。ピーク RSS と linear memory 容量、arena 使用量、Wasm ファイルサイズは別々に扱う。入出力が支配的なら、その事実を次の候補選択に反映する。

安全性修正は速度向上を採用条件にしない。必要な検証の費用を測り、回帰の許容範囲を判断する。最適化は同じ安全性契約で比較し、検査の削除を性能改善に混ぜない。trusted internal boundary の追加は別の契約設計として扱う。

記録には source/IR/lowered/Wasm の識別子、入力、runtime/CPU、Binaryen version・optimizeLevel・shrinkLevel・pass sequence・features、結果と却下理由を残す。保持する意味上の識別子と、変換で更新する成果物 hash を分ける。既存 hash の意味、replay、portable suite を暗黙に変更しない。Binaryen の global setting を使う場合は並列 build との競合も検証する。

通常 build は固定 recipe で再現できるようにし、Agent による候補探索は別工程とする。target 別の派生成果物を導入しても portable Wasm を維持する。recipe 検索用 database や embedding は必要性が確認されるまで導入しない。

## LLVM を利用する独立した実験経路

2026-09-20 に提示された「L-Lang LLVM Optimization Backend 実験」を、将来の比較実験として取り込む。以下は未実装・未測定であり、LLVM を標準 backend にする決定ではない。既存の直接 Wasm 生成と Binaryen の経路を維持し、仮称 `llvm-experimental` を独立した候補とする。この名前は L-Lang 内の案であり、既存 CLI の選択肢ではない。

### 責務と接続点

検証済み Semantic IR を接続点の候補とする。実装着手時には profile ごとの検証・lowering・Wasm 生成経路を確認し、共有できる情報と backend 固有の表現を整理する。添付案の概念図を、現行実装に共通 backend interface が存在する証拠とは扱わない。

```text
検証済み Semantic IR
  ↓ 意味保存を確認した変換・specialization
  ├─ 既存の直接 Wasm 生成 → 固定した Binaryen 設定 → Wasm
  └─ 実験用 LLVM IR 生成 → LLVM 最適化
                              ├─ Wasm
                              └─ Native（初回候補: macOS ARM64）
```

アルゴリズム選択、既知 schema/type/callee による specialization、融合、割当・コピー削減は L-Lang 側で成立条件を検証する。LLVM はその結果を受け取り、SSA、不要処理除去、ループ、インライン化、ベクトル化などの低レベル最適化と target 向けコード生成を担う候補とする。命令選択とレジスタ割当も Native 向けには LLVM のコード生成側の責務であり、Wasm の実行時コンパイルとは分ける。

LLVM は Semantic Optimizer の代替ではない。LLM の提案は検証を経て Semantic IR に反映し、初期実験では LLM による LLVM IR の任意書換えを対象にしない。既存の型別 layout や monomorphized call を活用し、LLVM 導入のために Semantic IR 全体を作り替えない。

### 最初に最後まで通す範囲

最初に scalar、関数、分岐、ループ、List、Record、memory、closure、effects の現行表現を整理し、対応・未対応を明示する。候補 subset は bool/i32/i64/f64、引数・戻り値・局所変数、演算・比較・if・loop・直接 call とするが、一度にすべてを実装しない。現行 profile が表現・検証できる操作から一つ選び、未対応の型や操作は明示的に拒否する。

最小実験は `sum(List<i32>)` 相当または単純な sort kernel 一つを候補とする。List を使う場合は pointer + length の内部表現、要素 layout、境界検査、所有者と寿命を先に定める。現行 IR で表現できない場合は実験用 subset と言語拡張を区別し、既存 profile に未知の操作を追加しない。String、Union、closure、async/effects、session lifetime、resource handle の全面対応は初回対象外とする。

PoC は TypeScript から textual LLVM IR（`.ll`）を出力する小さな emitter と CLI toolchain を候補とする。着手環境で `clang`、`llvm-as`、`opt`、`llc`、`wasm-ld` と Native linker の有無・版・target 対応を確認し、実際に使えたコマンドを保存する。固定の古いコマンド列や全ツールの存在を前提にしない。

まず同じ program から直接 Wasm、Binaryen 最適化 Wasm、LLVM 最適化 Wasm、LLVM 最適化 Native を生成し、結果比較まで通す。Native は macOS ARM64 の executable を初回候補とする。library は次の独立した検証として、小さな scalar 関数の C ABI export と呼出しを確認する。List/Record の公開 ABI、解放責任、エラー表現を scalar の成功だけから一般化しない。他 OS、x86-64、共有・静的 library の拡張は必要性を確認してから進める。C/Rust ソース生成、独自 linker、LLVM C++ custom pass、JIT/ORC、LTO/ThinLTO、PGO は初回には導入しない。

### 意味・メモリー解析から渡せる情報

backend が変わっても、本書の「最適化で保存する意味」を適用する。整数の overflow・除算、浮動小数点、評価順序、境界違反、資源上限、失敗時の状態を明示し、LLVM 側で同じ挙動になる lowering を検証する。Wasm の検査や trap を Native が自動的に引き継ぐとは扱わない。Native には Wasm と同じ sandbox を前提にできないため、生成物の信頼境界と実行条件も別途記録する。

`noalias`、`readonly`、`nonnull`、alignment、range、`noundef`、`dereferenceable`、`lifetime.start/end`、`nsw/nuw` などは、将来検討する属性・metadata・intrinsic・命令フラグの候補である。それぞれの LLVM 上の成立条件を確認し、verifier と memory/escape 解析で保証できる事実だけを渡す。初期 PoC は追加情報を推測せず、正しく動く lowering を優先する。

input という名前だけで `readonly` や `noalias` を付けず、host の変更・共有・再入、他の参照経路も確認する。input/output/scratch の領域名が異なるだけでは非 alias の証明にならない。scratch の call 内寿命と lifetime 情報の対応、output/session へ残る参照の禁止、alignment と参照可能な長さにも根拠が必要となる。checked arithmetic の overflow 検査を `nsw/nuw` の付与で置き換えるなど、契約にない仮定は導入しない。

### 比較条件と採否

backend 差の評価では Semantic IR、アルゴリズム、入力、検証、資源契約を揃える。specialization や融合を追加する実験は別軸とし、backend 変更と同時に混ぜて効果を帰属させない。

| 比較 | 固定する条件・解釈 |
| --- | --- |
| 直接 Wasm / Binaryen 最適化 Wasm / LLVM Wasm | 同じ Wasm runtime と host adapter、ABI、features、入力・出力処理で比較する。最適化前の直接出力を取り出せるかも確認する |
| LLVM O0 / O2 / O3 | 標準設定から始め、実際の pipeline と toolchain 版を記録する。Binaryen の O2/O3 と同じ変換内容だとは扱わない |
| Wasm / LLVM Native | 同じ計算と意味契約で比較し、host 呼出し、データ変換、検査、実行環境の差を併記する。速度差全体を LLVM optimizer の効果とは呼ばない |

Semantic evaluator、直接 Wasm、LLVM Wasm、LLVM Native の正常結果とエラーを differential test で比較する。境界値、空・最大入力、資源制限も含め、property-based test と探索に使わない評価入力を必要に応じて加える。evaluator が未対応なら、その subset の比較 oracle と保証範囲を先に定める。テスト一致を完全な同値証明とは扱わない。

ビルド時間は IR 生成、LLVM 最適化、target コード生成、link/archive、全体を分ける。実行側は Wasm compile/instantiate または Native の起動・load、kernel、入出力込み時間を分ける。ピーク RSS、linear memory、Native の割当量、作業領域も区別する。library の拡張子だけでビルド費用を推定せず、どの工程が支配するかを測る。

証跡には source/Semantic IR hash、最適化前後の LLVM IR と hash、artifact hash、LLVM・linker の版、target triple・data layout・CPU features、最適化設定、ABI/profile、入力・測定条件を残す。既存 artifact 形式への拡張は verifier/replay との整合性を設計してから行い、実験記録の追加だけで既存 hash の意味を変えない。

初回の完了条件は、現行経路と subset の整理、一つの処理の生成・正しさ比較、工程別ビルド時間・kernel・入出力込み時間、生成 IR の分析、次の仮説と採否が揃うことである。改善しない場合も結果として残す。原因は Semantic IR、lowering、alias 情報、割当・コピー、LLVM pipeline、Wasm runtime に分けて調べ、最適化レベルの引上げだけで対応しない。

採否は「LLVM の対応範囲を広げる」「特定 profile に限る」「現時点では既存経路を維持する」から実測で判断する。添付案の速度倍率は説明用の例であり、目標や実績として採用しない。ビルド費用、保守・配布依存、利用回数を含めて価値を判断する。直接 Wasm の経路を保持し、LLVM 採用を成功条件にしない。この実験は前節の段階 C/D で選べる候補であり、安全性改善や LLM による意味最適化の必須前提にはしない。

## 将来の実装時に残す証拠

各変更では仮説、適用条件、before/after、実行コマンドと環境、採否、未解決事項を残す。確認対象は正常結果、エラー、境界入力、繰返し呼出し、資源上限である。対象の unit/adversarial/differential tests に加え、変更範囲に対応する replay・artifact verification・portable suite を実行する。

統合時は、その時点の [品質 Gate](../QUALITY_GATES.md) に従う。現在の入口は `bun run check`、`bun run ci:docs`、`bun run ci:protected`。これらを実行しても全 profile の安全性が証明されたとは扱わず、対象固有の試験を併記する。コンセプト文書だけを作成した段階では、実装済み・安全性向上済み・性能改善済みとは報告しない。
