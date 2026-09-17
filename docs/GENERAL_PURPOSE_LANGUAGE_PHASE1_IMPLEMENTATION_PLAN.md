# 汎用言語化・第一弾の実装計画：型付き関数と複数モジュール

作成日：2026-09-17。状態：**Phase 1実装済み**。確定した利用仕様は [L-Lang typed modules Phase 1](./LLANG_MODULE_SPEC.md) を参照する。

上位方針：[汎用言語化コンセプト](./GENERAL_PURPOSE_LANGUAGE_EXPANSION_CONCEPT.md)。現行仕様：[JSONC Predicate v1](./LLANG_JSONC_SPEC.md)。第一弾はコンセプトのG0とG1を対象とし、作業を仕様、コンパイラ、成果物、検証の単位に分ける。

次段階のG2は[第二弾の実装計画](./GENERAL_PURPOSE_LANGUAGE_PHASE2_IMPLEMENTATION_PLAN.md)を参照する。第一弾の品質証跡に関する未チェック項目は、第二弾の開始時に照合する。

## 1. 第一弾で成立させること

**複数の型付き純粋関数を複数ファイルに定義し、TypeScriptとJSONCのどちらからも呼び出して、一つのプログラムとして検証・生成・配布できる状態にする。**

完了時には、同じ利用者判定を次の三構成で書ける。

- TypeScriptだけで構成した3モジュール。
- JSONCだけで構成した3モジュール。
- TypeScriptとJSONCを混在させた3モジュール。両方向のimportを含む。

各構成をTypeScript、再コンパイル可能なJSONC、一つのWasmへ生成する。独立した真理値表で意味の一致を確認し、依存先の変更が成果物と追跡情報へ反映されること、移動したWasm成果物をコンパイラなしで実行できることを検証する。

第一弾で汎用言語全体を完成とは呼ばない。関数・モジュールを通すための小さな型と演算の集合を定め、それをG2以降へ拡張可能な内部構造として実装する。

## 2. 対象範囲を固定する

| 項目 | 第一弾に含める | 後続へ送る |
| --- | --- | --- |
| 関数 | 名前、明示した引数型・戻り値型、複数引数、直接呼出し、private/export | 再帰、closure、高階関数、関数値、overload、default/rest引数 |
| 型 | booleanと、必須boolean fieldのみの平坦な名前付きrecord。構造的な型一致 | 数値、enum/nullishを新関数型へ広げること、ネスト、配列、generics、型推論 |
| 戻り値 | 全関数boolean。entryもboolean | recordや複数値の戻り値、Result、例外 |
| 式 | 引数参照、record field参照、boolean literal、not、all/any、boolean同士のequals、call | 局所変数、if/match、代入、反復、算術 |
| module | 同一module内の複数関数、型alias、相対パスのnamed import、明示export | 循環import、再export、default/namespace/dynamic import、module初期化 |
| ソース | `.ts`と新形式の`.llang.jsonc`、混在した依存グラフ | 任意TypeScript、npm import、JSソース、tsconfigのpath alias |
| 出力 | TypeScript、JSONC、Wasm。共通の検証済みProgramから生成 | 動的link、複数Wasm間呼出し、実行時module探索 |
| 実行境界 | entryは平坦なrecord一引数→boolean。内部では複数引数を許可 | 新しいmemory ABI、IO、async、共有状態 |
| 品質 | 型・名前・依存・cycle・snapshot・改変・再生成の検証 | 最適化競争、生産性live評価、公開registry |

現行Predicate v1で使えるenum・nullish・string存在判定を削除する意味ではない。既存profileはそのまま維持し、新profileの最初の受理範囲をbooleanに限定する。G1で汎用Canonical Typeの全機能を先取りして作らず、Function／Moduleを追加できる最小の共通表現に留める。

## 3. 開始時の基準と既存コードの扱い

調査基点はcommit `0a40782`と未コミットの改善群。実装開始時にはHEAD・作業ツリー・ファイルhashを再採取し、他の作業を上書きしない。[改善記録](./IMPROVEMENTS_RESULTS_20260917.md)の500テスト成功等は過去の基準であり、将来の実装後の成功件数として転記しない。

| 現行の責務 | 現在の実装 | 第一弾での扱い |
| --- | --- | --- |
| JSONC構文・位置・診断 | `src/llang-jsonc.ts`、`src/llang-diagnostics.ts` | 字句・位置情報を再利用。新module schemaとv1検査を分離 |
| 単一Predicate検証 | `src/llang-program.ts`、`src/ir.ts` | v1を維持。既存のbody型へ無差別にcallを追加しない |
| 型の正規化 | `src/canonical-type-ir.ts` | 既存のflat record規則を参照・再利用。関数型を既存v1 recordとして偽装しない |
| TypeScript読込・import | `src/typescript-source-loader.ts`、`src/typescript-predicate-importer.ts` | AST処理の部品を選択的に共有。新経路では閉じたsnapshotから解決 |
| 単一関数Wasm生成 | `src/wasm-core.ts`、`src/wasm-emitter.ts` | 従来入口・bytesを維持し、新module emitterを追加 |
| 入力契約・実行 | `src/wasm-contract.ts`、`src/wasm-runtime.ts` | 外部entry ABIと入力検査を再利用。内部関数のsignatureを別に定義 |
| build・成果物検査 | `src/llang-build.ts`、`src/llang-artifact.ts` | 既存manifest v2 readerの受理範囲を広げず、新形式へ分岐 |
| パス・公開処理 | `src/contained-path.ts`、`src/atomic-file.ts` | 部品を再利用し、依存集合全体の照合と新規directory公開を追加 |
| CLIとsmoke | `src/llang-cli.ts`、`src/llang-smoke.ts` | 既存コマンドを維持し、`module`の名前空間を追加 |

現行TypeScript loaderはtsconfigからProgramを作るため、無修正で新module loaderに流用しない。JSONCを含む依存集合、読込対象の閉包、ファイル差替えの検出を新経路で保証する必要がある。

## 4. G0：現行v1の適合性を独立して仕上げる

G0はG1の新構文・IRと別の変更単位にする。受理範囲に影響する修正は互換性注記を付け、保存済みのlockや証跡を新しい定義で書き直さない。

| ID | 修正・仕様化 | 方針案 | 受け入れ条件 |
| --- | --- | --- | --- |
| C01 | 文字列長の単位 | description・enum文字列等の上限はUnicode scalar数に統一。ASCII識別子は従来上限を維持。byte上限は別検査 | 絵文字2,049個のdescriptionをschema/lint双方が受理。4,096/4,097 scalar、surrogate、不正UTF-8を検査 |
| C02 | 診断分類と位置 | 構造不正はLLS、IR上限/profile外はLLP。未知keyはkey、欠落は親を指す | 65条件がLLP001。未知`/body/extra`、ネスト内の欠落、related/rangeを検査 |
| C03 | 入力の規則 | 余分なfieldを拒否し、式で使わないfieldも契約検査。欠損/undefined/nullを別々に定義 | optional/undefinable/nullableの組合せ、未知field・accessor・symbolを既存runtimeと照合 |
| C04 | 順序・canonical hash | v1の実際の整列・serialize規則を仕様化してgolden vectorにする。hash方式は変更しない | key順・空白・コメント、配列順、非ASCII文字で既存hashを再現 |

文字数の修正がWasmContract・Canonical Type・schemaにも及ぶ場合は、単位を揃える共通関数を用い、上限値そのものを一律に変更しない。診断のために例外message文字列を正規表現で分類せず、parser内部からcodeとpathを運ぶ。必要なら互換wrapperを置き、既存呼出側の公開型を保つ。

## 5. 第一弾で採る仕様判断案

以下をPR-1でschema・適合fixtureとともに固定する。名前と版番号は仮置きだが、機能範囲と保証はこの計画の前提とする。範囲を変える場合は変更理由と検証項目を同じPRで更新する。

| 判断 | 第一弾の案 |
| --- | --- |
| ソース識別 | JSONCは`language:"l-lang", version:2, kind:"module", profile:"module-bool-v1"`。v1とは明確に分岐 |
| module identity | rootからの相対POSIXパスから`.ts`／`.llang.jsonc`を除いたlogical module ID。同一IDの別ファイルは拒否 |
| 公開名 | ASCII識別子、最大128文字。TS予約語を束縛名に許可しない。型・関数・import aliasの名前衝突を拒否 |
| record型 | 1〜64の必須boolean field、ネストなし。field名はASCII識別子で最大128文字（予約語もproperty名には可）。field名順で正規化し、完全な構造一致を要求。width subtypingなし |
| 引数 | 0〜8引数。booleanまたは名前付きrecord。optional/default/restなし。entryだけはrecord一引数を要求 |
| 戻り値 | booleanのみ。実装bodyは一つの式 |
| export | JSONCは宣言に`export:true/false`を必須指定。TSは`export`修飾子の有無に対応 |
| 型import | `import type`相当を明示。JSONCはbindingに`kind:"type"`または`"function"`を指定 |
| 再帰・cycle | 型importを含むmodule cycleと、関数call graphのcycleをそれぞれ検査して拒否 |
| entry | CLIからentry fileとexport名を指定。出力Wasmの公開名は`evaluate`一つ |
| 評価 | callの引数は左から右へ一度ずつ評価。all/anyは左から短絡。暗黙変換・暗黙IOなし |
| v1の取り込み | v1ソースは既存CLIで維持。新module graphへの直接importは拒否。変換は後続の明示migrationへ分離 |

### 5.1 JSONC moduleの構造

新schemaのtop-levelはlanguage/version/kind/profile/imports/types/functionsを必須とし、descriptionのみ任意とする。各階層で未知keyを拒否する。配列中の宣言順で名前の可視性を変えない。同一module内の前方参照は許可し、cycle検査は束縛解決後に行う。

以下は**提案構文の例**であり、現在のparserでは受理されない。

```jsonc
{
  "language": "l-lang",
  "version": 2,
  "kind": "module",
  "profile": "module-bool-v1",
  "imports": [],
  "types": [
    {
      "name": "User",
      "export": true,
      "kind": "record",
      "fields": [
        { "name": "enabled", "type": "boolean" },
        { "name": "suspended", "type": "boolean" }
      ]
    }
  ],
  "functions": [
    {
      "name": "isEnabled",
      "export": true,
      "parameters": [{ "name": "user", "type": { "ref": "User" } }],
      "returns": "boolean",
      "body": {
        "kind": "field",
        "base": { "kind": "param", "name": "user" },
        "name": "enabled"
      }
    }
  ]
}
```

型使用は`"boolean"`または`{"ref":"LocalOrImportedType"}`。type aliasの右辺は平坦なrecordだけとし、alias同士の連鎖や再帰型は第一弾に含めない。import済み型は引数注釈に直接使える。

import要素は次の形にする。`from`は拡張子を含む相対パス、`name`は相手のexport名、`as`はローカル名で省略不可とする。

```jsonc
{
  "from": "./user.llang.jsonc",
  "bindings": [
    { "kind": "type", "name": "User", "as": "User" },
    { "kind": "function", "name": "isEnabled", "as": "isEnabled" }
  ]
}
```

| 式kind | 必須field | 検査 |
| --- | --- | --- |
| literal | value | booleanのみ |
| param | name | 現在の関数の引数に束縛されること |
| field | base、name | baseはrecord引数のparam。存在するfieldのみ |
| not | condition | boolean |
| all / any | conditions | 1〜64個、すべてboolean |
| equals | left、right | 両方boolean。record全体の比較は禁止 |
| call | callee、arguments | ローカルまたはimportした関数名。個数・型が完全一致 |

callの例は`{"kind":"call","callee":"isEnabled","arguments":[{"kind":"param","name":"user"}]}`。関数名を文字列から動的に組み立てる操作は認めない。

### 5.2 TypeScript frontend

受理構文は、named import、named type import、平坦なrecord型alias、名前付きfunction declaration、単一のreturn文に限定する。関数の引数型とboolean戻り値注釈を必須とする。式は識別子、dot field、boolean literal、`!`、`&&`、`||`、booleanの`===`、直接関数呼出し、括弧を対応付ける。

計算式以外のtop-level実行、変数宣言、method、class、arrow function、型assertion、`any`、computed property、JSX、decorator、動的importは拒否する。到達しない関数に未対応構文があっても、読み込んだmodule全体を検査して拒否する。副作用を持つソースを評価して関数一覧を取得してはならない。

JSONCから公開signatureを作り、snapshotだけから構成した仮想TypeScript Programに型宣言を渡す。TypeScript compilerによる診断と共通IRの型検査を併用する。JSONC importのために実ファイルの`.d.ts`をworkspaceへ生成しない。標準libraryを参照しない閉じた型集合とし、ambient declarationや近傍tsconfigから型を流入させない。

新TS frontendはこの独立した言語モードとして提供する。既存のHybrid importerのtsconfig依存や同一ファイル制約を、今回まとめて置き換えない。

## 6. module解決とsnapshot

rootはCLIで明示し、entryから静的importをたどった閉包だけを読み込む。`./`または`../`で始まり、root内に収まる明示拡張子パスを受理する。拡張子省略、directory index、package名、絶対パス、URL、query/fragment、NUL、backslashを拒否する。実ファイル名との大文字小文字の一致を要求し、caseだけが違うlogical IDも拒否してOS差を避ける。

既存のcontained-path検査に加え、各経路のsymlink、regular file、サイズ、UTF-8を検査する。lexical pathだけでroot内判定を済ませない。同じファイルの重複参照は一つのmoduleへ集約し、解決の曖昧さを探索順で隠さない。

読んだbytes、raw hash、正規化パス、source locationをsnapshotへ保持し、parse、型検査、生成はそのsnapshotだけを見る。新TypeScript Programもファイルシステムを再読しない。全出力の生成後、読込閉包の各元ファイルが同じbytes・パス条件を満たすか再検査し、変更・削除・置換があればSOURCE_CONFLICTとして公開しない。

この方式は任意の外部writerとの完全な同時snapshotを保証しない。コンパイルした正確な集合を記録し、公開前の差替えを検出する契約である。全出力は新規staging directoryで組み立て、検査完了後に公開する。既存出力directoryを上書きしない。別プロセスとの出力競合も排他的に検出し、所有していないdirectoryをcleanupしない。

公開手順はPR-7で次の契約を実装する。出力先を非recursiveのmkdirで排他的に確保し、既存なら失敗させる。生成と検査は所有するstaging内で完了し、出力先へ配置後、manifestを最後にatomic writeする。readerはmanifestと全hashの検証が通ったbundleだけを完成品として扱う。失敗時は所有が確認できる一時物だけを削除する。これは完成品としての公開境界であり、directory自体が途中で見えない保証ではない。外部writerによる任意の書換えまで排他制御できるとは主張しない。

### 資源上限案

| 対象 | 第一弾の上限 |
| --- | ---: |
| 一つのソース | UTF-8で1 MiB |
| 依存集合 | 64 modules、合計8 MiB |
| 一つのmodule | 64 functions、64 types、256 import bindings |
| Program全体 | 256 functions、256 types、1,024 import bindings |
| 一つの関数 | 8引数、512 scalar slots以下、256式node、式depth32 |
| call graphの最大深さ | 32 |
| diagnostics | 32件。既存のmessage上限を継承 |
| 一つのWasm成果物 | 現行1 MiB上限を維持 |

宣言数はdead-code除去前にも検査する。DAGでも呼出しの重複で仕事量は大きくなるため、深さだけで実用的停止時間を保証しない。参照evaluatorに評価step budgetを設け、Wasm/TSの試験実行は隔離Worker／子プロセスとtimeoutで中断できるようにする。budget超過を通常のfalseとして返さない。

## 7. 共通IRと型検査

新しい型は既存`PredicateExpression`とは区別し、`ModuleProgram`、`ModuleDefinition`、`FunctionDefinition`、`FunctionSignature`、`ModuleExpression`等として導入する（名前は案）。関数のSymbol IDはlogical module IDと宣言名から一意に得る。型aliasの名前解決後はcanonicalなrecord構造に対応付ける。

source ASTは名前と位置を保持し、検査済みIRは解決済みsymbol、型、引数順、bodyを保持する。型エラーを出すためのsource mapは意味hashの対象外に置く。呼出しを文字列置換して既存Predicate式へ展開する実装は採用しない。

解析順序は、snapshot収集→module/import graph→宣言とexport表→型解決→関数signature→bodyの名前・型解決→call graph cycle→profile検査とする。private名の参照、関数と型の取り違え、alias衝突、引数不足/過多、record構造不一致、非boolean returnを拒否する。

recordはG1では構築・更新できず、入力引数を読み取りまたはそのまま別関数へ渡すだけとする。alias・mutable reference・heap所有権を導入せず、Wasmでは同じfield集合のscalar slotsとして受け渡す。

reference evaluatorは共通IRを直接評価する。backendの出力を呼んで正解値を得る形にしない。外部entryへの入力は既存WasmContractの規則で全fieldを検査し、その後に実行する。

## 8. backendと外部ABI

### TypeScript出力

対応ソースと関数の型を生成し、moduleの名前衝突を解消した決定的なprivate symbol名へ対応付ける。配布時は一つのgenerated TSに静的にまとめ、型付きentryと入力検査を行う公開wrapperを分離する。元のJSONC importを実行環境へ残さない。固定compiler optionsによるtypecheckを実行する。

### JSONC出力

すべてのmoduleを新JSONC構文で再生成し、正規化したdirectory構造と相対importを保存する。単一entryだけを出力して依存を欠落させない。元の`.ts`は`.llang.jsonc`へ変換し、logical module IDを維持して参照を書き換える。

生成JSONC全体を新規rootとして再読込し、同じentryのprogramHash・公開signature・oracle結果が一致することを必須にする。コメントや元の書式の復元は要求しない。source集合のhashは変わるが、意味hashが変わらないことを検査する。

### Wasm出力

一つのWasm module内に、実際の内部関数とdirect callを生成する。全関数inlineによる式の指数的膨張を避ける。内部record引数はfield名順のi32 slots、booleanはi32の0/1として渡す。全関数の結果はi32 booleanで、record全体をmemoryへ置かない。

外部にはentry wrapperの`evaluate`だけをexportし、契約custom sectionと既存の入力encodingを利用する。memory/table/global/start/importを持たせない。内部関数の複数定義・callを、新emitterと既存stateless validatorの双方で試験する。旧emitterからの既存成果物bytesが変わらないことを回帰条件とする。

契約に適合する外部入力はwrapperで検査する。Wasmの内部関数は公開しないため、内部の型整合性はコンパイル時の責任とする。配布されたバイナリのhash検査と、ソースからの意味保存の検証を別の保証として扱う。

## 9. hash・成果物・移動後検証

新成果物には専用の`format:"llang-module-build", version:1`を提案する。これはソースversion 2、profile名、既存Build Manifest v2、Capability v1/v2とは別の版の軸である。既存readerが新形式を偶然受理しないようにする。

| 記録 | 内容・変化の規則 |
| --- | --- |
| source file hash | 各ファイルのraw bytes。コメント、書式の変更も反映 |
| sourceSetHash | 実パス・file hash・解決済みimport edgeを正規化した集合のhash |
| programHash | logical module ID、宣言、型、解決済み参照、body、entry、profileを含む共通IRのhash。位置・コメント・入力拡張子を除外 |
| interfaceHash | entryの正規化した引数・戻り値・profile・ABI。suiteはこれへ結び付ける |
| build identity | programHash、target、compiler/runtime/ABI版、optionsを含む |
| artifact file hash | 生成TS、生成JSONC各ファイル、Wasm、runtime等のbytes |

canonical serializeではmoduleをlogical ID順、型・関数宣言を宣言名順、record fieldを名前順に並べる。引数・call arguments・conditionsの配列順は保持する。import aliasは解決済みsymbolへ置き換え、位置と物理パスを含めない。TSの括弧を除去し、同種の連続したAND/ORは両frontendで同じ順序の条件列へ正規化する（上限超過は拒否）。JSON object keyの整列規則、UTF-8化、hash対象のformat/versionをPR-1のgolden vectorで固定する。

logical IDや宣言名の変更はprogramHashを変えてよい。任意のalpha-renamingや論理的同値性までcanonical化することは要求しない。解決閉包内の未使用関数もprogramHashへ含め、Wasm側で未使用関数を除外してbytesが変わらなくても、ソース変更を追跡できるようにする。

manifestにはentry、source inventory、依存edge、profile、interface、各hash、target、toolchain/optionsを保存する。package registryはなく、全依存はroot内にあるため、この段階で新しい外部依存Lockは作らない。

buildは生成のみを表し、suite成功を捏造しない。試験reportは固定suiteHash、interfaceHash、sourceSetHash、programHash、実際のartifactHashと結果を記録する。suiteはprogramHashへ固定しないため、実装修正後も同じ期待値で検査できる。

移動後のportable検証は、新manifest・ファイルhash・Wasm ABI・指定suiteをcompilerなしで確認する。ソース→Wasmの意味保存をportable検証だけで証明したとは呼ばない。再build検証はソースsnapshotとtoolchainが必要な別モードとする。

生成TSは実行可能なコードなので、単なる自己申告hashを信頼根拠にしない。第一弾のTS実行試験は、自分でビルドした生成物を隔離子プロセスで動かす範囲とする。子プロセスは完全なsandboxではない。外部から受け取ったTS成果物をportable verifierが暗黙に実行しない。

新module成果物をCapability v2へ無理に押し込まない。既存request/suite/package/develop/replayとhostの互換を維持し、module用の固定suiteとportable runnerを追加する。エージェントによる複数module修正、Capabilityへの正式な収録、SAAA接続は後続計画へ分離する。

## 10. CLI・suite・診断の提案

既存`llang lint/build/test`の意味を変えず、`llang module`配下に集約する。以下は**実装予定の使用例**であり、現時点では実行できない。

```text
bun run llang module lint src/main.llang.jsonc --root project --entry canAccess --json
bun run llang module build src/main.llang.jsonc --root project --entry canAccess --target all --out-dir artifacts/module-demo
bun run llang module test src/main.llang.jsonc --root project --entry canAccess --suite tests/cases.json --json
bun run llang module verify artifacts/module-demo/module-build.json --suite tests/cases.json --json
```

entryとsuiteのパスは`--root`相対、出力pathとverifyのmanifest/suiteはcwd相対として固定し、helpへ明記する。buildのtargetはtypescript/jsonc/wasm/all。testはreference、TS、JSONC再生成→再読込、Wasmを同じsnapshotとsuiteで検証する。verifyはWasmを含むbundleが対象で、TSのみ／JSONCのみのbundleを「実行検証済み」にしない。各単独targetのファイル整合性はbuild時とreaderで検査する。

suite案は`format:"llang-module-suite", version:1, interfaceHash, cases`。各caseはid、input、expectedを持つ。expectedはboolean値またはINVALID_INPUT。case ID重複、未知field、空suite、不正型、1 MiB／1,024 cases超過を拒否する。requestからの要件coverage機能を新設しない。caseの期待値は実装生成から独立して固定する。

終了値は0成功、1診断・期待値不一致、2引数／I/O／実行障害。source解決不能やcycleはソース診断として1、読み取り中の消失やSOURCE_CONFLICTは運用上の失敗として2を提案する。JSONモードはstdoutに一つのJSONを出し、未実行targetを成功扱いしない。

新診断群は構造、module解決、symbol、型、call cycle、profile、資源上限に分ける。import cycleには経路、call cycleには呼出し列をrelatedとして付ける。JSONCはJSON Pointerとrange、TSは元ファイルrangeを持ち、共通のdiagnostic envelopeへ載せる。具体的なcode文字列はPR-1で固定する。

## 11. 実装単位と依存順序

下記の新ファイル名は責務を示す配置案であり、空の抽象層を先に大量作成することは求めない。PRは作業の分割単位であり、この計画作成だけで公開・送信を行うものではない。

| 単位 | 実施内容・主な変更先 | 依存 | その単位の出口 |
| --- | --- | --- | --- |
| PR-0：G0適合性 | `llang-program`、`ir`、文字列上限の共有箇所、既存schema/適合テスト | 基準採取 | C01〜C04。既存hashと通常例の挙動を保持 |
| PR-1：仕様とfixture | 新module/suite/build schema、仕様書、accept/reject fixture、診断と上限表 | PR-0 | 本計画の版・構文・ABI・hash・パス規則を固定。例をschemaで検査 |
| PR-2：閉包と共通IR | `llang-module-loader.ts`、`llang-module-ir.ts`、`llang-module-checker.ts`、`llang-module-evaluator.ts`相当 | PR-1 | in-memory module集合で名前・型・cycle・resource検査とreference評価 |
| PR-3：JSONC frontend | `llang-module-jsonc.ts`相当。既存parser/位置情報再利用 | PR-2 | JSONC 3-moduleの受付・拒否・snapshot試験 |
| PR-4：TSと混在frontend | `llang-module-typescript.ts`、snapshot仮想Program、型binding | PR-3 | 全TSと両方向の混在import。top-levelを実行しない。共通IR一致 |
| PR-5：TS/JSONC出力 | `llang-module-source-emitter.ts`相当、必要な型・wrapper生成 | PR-4 | TS typecheck＋oracle、JSONC round-tripとprogramHash一致 |
| PR-6：Wasm関数生成 | `llang-module-wasm.ts`相当、internal signature/slot/call、stateless検査 | PR-4 | 実際の関数callでoracle一致。旧emitter回帰、膨張・深さ・timeout試験 |
| PR-7：成果物とCLI | `llang-module-build.ts`、`llang-module-artifact.ts`、専用runner/worker、`llang-cli.ts` | PR-5、PR-6 | 全target、suite、hash、公開競合、移動後検証、help・終了値 |
| PR-8：縦断例とCI | `examples/module-access/`案、module smoke、日英入口・CLI説明、結果記録 | PR-7 | 全構成×全target、全品質Gate、対応OS CI証跡 |

PR-5とPR-6はPR-4の検証済みIR契約を共有できれば独立した変更に分けられる。ファイル分割が依存順の代わりにはならない。各PRで未実装targetを既定に選ばず、途中の開発機能を現行v1の完了表示に混ぜない。

## 12. 最小縦断例と検証表

### 12.1 例の内容

`domain/user`でUser型とisEnabledを公開し、`policy/access`でUser/isEnabledをimportしてisAllowedを定義する。`application/main`はisAllowedをimportし、公開entry canAccessから呼ぶ。Userはenabledとsuspendedのboolean fieldを持ち、期待値はenabledかつ非suspendedとする。

別にprivate helper `both(left:boolean,right:boolean):boolean`を置き、複数引数とcall結果の引数渡しを検証する。代表混在構成はJSONC user→TS policy→JSONC mainとし、反対方向の型importも別fixtureで確認する。

正しい期待値を変換器から計算せず、4通りの真理値表を固定する。追加fixtureでは3〜6個のboolean fieldや共有calleeを使い、同じcalleeが複数回呼ばれる場合を含める。

### 12.2 必須試験

| ID | 確認内容 | 期待する結果 |
| --- | --- | --- |
| T01 | 全TS／全JSONC／混在2方向 | 同じlogical構造から同じprogramHash、公開型、Wasm bytesを生成 |
| T02 | 3入力構成×3targetの基本matrix | 固定oracle一致。JSONCは再コンパイルして照合 |
| T03 | private参照、存在しないexport、alias衝突、型と関数の取り違え | 元の参照位置に診断、成果物未公開 |
| T04 | 引数数・record field・boolean型・戻り値不一致 | 共通型検査で拒否。backendへ通さない |
| T05 | module cycle、type-only cycle、直接/相互再帰 | 有限時間で拒否し、cycleの経路を表示 |
| T06 | root外参照、symlink、case衝突、暗黙拡張子、bare import | loaderで拒否。外部ソースを評価しない |
| T07 | 未使用の危険なtop-level/関数構文、ambient型依存 | 明示拒否。到達性を理由に黙認しない |
| T08 | 依存ファイルの意味変更・コメント変更・import変更 | sourceSetHash/programHash/生成bytesの規定どおりの変化 |
| T09 | 読込後・生成後・公開直前の変更、削除、差替え | 注入した同期点でSOURCE_CONFLICT。既存出力不変、所有stagingのみcleanup |
| T10 | 同名関数を別moduleで定義、共有callee、前方参照 | 名前衝突なし。参照先が意図した関数と一致 |
| T11 | module数・byte数・式数・call深さの上限±1 | 境界値で受理/拒否。指数的inlineを起こさない |
| T12 | 深いDAGでの重複呼出し、実行timeout | reference/Workerが中断し、falseや合格を返さない |
| T13 | JSONC生成→別rootで再読込 | logical ID・programHash保持、依存欠落なし |
| T14 | Wasm bundle移動、原ソース削除、compiler依存なし | Bun＋配布runtimeのみで実行・suite検証可能 |
| T15 | manifest・source inventory・生成物・ABI・suite改変 | hashや契約の不一致を検出。署名の代用とはしない |
| T16 | 旧v1のJSONC、Hybrid、Capability、host、replay | 既存挙動・公開形式・固定条件でのWasm bytesを維持 |
| T17 | CLIのhelp、正常、診断、I/O、fail、timeout | 文書どおりの終了値と単一JSON |

T01の同じlogical構造とは、入力形式以外の宣言名・module ID・式の形を揃えたfixtureを指す。論理的に同値な任意のプログラムに同一hashを要求しない。混在2方向のfixtureを含め、matrixの件数は最終fixture一覧から数える。

### 12.3 実行コマンドと品質Gate

G0の局所検証には既存テストを使い、module用は実装した責務ごとにtestファイルを追加する。次の新ファイルを使うコマンドは配置案であり、作成前には実行しない。

```text
bun test src/llang-jsonc.test.ts src/llang-program.test.ts src/llang-improvements.test.ts --timeout 30000
bun test src/llang-module-loader.test.ts src/llang-module-checker.test.ts --timeout 30000
bun test src/llang-module-frontends.test.ts src/llang-module-backends.test.ts --timeout 30000
bun test src/llang-module-artifact.test.ts src/llang-module-cli.test.ts examples/module-access/module.test.ts --timeout 30000
```

各変更単位でformat、lint、typecheck、該当テストを分けて記録する。最終revisionでは指定Bunと固定依存で全体coverageを取り、既存の全体functions/lines 90%、semantic-transaction 95%の閾値を下げない。

```sh
bun install --frozen-lockfile
bun audit
bun run format:check
bun run lint
bun run typecheck
bun run coverage
bun run ci:docs
bun run ci:protected
bun run ci:smoke
git diff --check
```

module smoke（script名案`ci:module-smoke`）を既存`ci:smoke`へ追加し、APIキーなしでmixed build→test→JSONC再build→Wasm移動後verifyを実行する。文書のコマンド照合も、従来10コマンドだけでなく新しいsubcommandを検出できるよう拡張する。

Ubuntu/Windows CIとmacOSローカルの結果を区別し、実行していないOSを合格にしない。全体テストとcoverageを同時に動かさず、編集中のソースで最終結果を採取しない。環境、revision、dirty状態、検証前後のsource/config hash、コマンド終了値、件数、coverage、ログを記録する。

## 13. 主要なリスクと対応

| リスク | 計画上の対応 |
| --- | --- |
| TS/JSONCそれぞれに別の型仕様が生まれる | 共通checkerを最終判定にし、frontend差分fixtureを必須にする |
| JSONC importをTS compilerが解決できない | snapshot由来のvirtual declarationとresolverをPR-4の独立課題にする。disk shimを増やさない |
| moduleを追加しただけで検証が遅くなる | 閉包だけを読み、上限を先に検査。source count・IR node count・build時間を記録し、cache導入は別判断 |
| 単純inlineで成果物が膨張する | internal function/direct callを使い、共有calleeのサイズ・処理量を検査 |
| raw hash一致を意味や信頼の証明と誤認する | source追跡、portable検証、再build検証、期待値検査を区別 |
| 既存host/packageの意味が変わる | 新formatとCLI namespaceへ分離。既存の変換・replayを回帰検査 |
| 小さなG1に汎用機能を詰め込む | 再帰・数値・collection・memory・effectを受理範囲に入れない。拒否fixtureで境界を固定 |

## 14. 完了条件と次段階への引継ぎ

- [x] C01〜C04の仕様適合差を解消し、変更した受理・診断の契約を文書化した。
- [x] 型付き関数、複数引数、private/export、型import、関数importが使える。
- [x] 全TS、全JSONC、混在2方向のmodule閉包を同じcheckerで検証できる。
- [x] module cycleとcall cycleを区別して拒否し、上限・snapshot競合を検証した。
- [x] TS、JSONC、Wasmを生成し、固定oracle・再生成・移動後実行が成功した。
- [x] sourceSetHash、programHash、interfaceHash、artifactHashが実際の対象と一致する。
- [x] 旧Predicate v1と既存経路の公開契約・凍結証跡を維持した。
- [x] CLI、schema、仕様、examples、対応範囲表、smokeを実装と揃えた。
- [ ] 同一最終revisionの全品質Gateと対象CIの結果を記録した。未実行があれば完了条件として残した。

第一弾の成果は「boolean領域で型付き関数・module・依存・複数backendが一貫して動くこと」である。次のG2には、数値・文字列・複合戻り値・制御・型付き失敗の仕様判断と、それに必要な最小memory ABIを引き継ぐ。G1の制限を言語全体の恒久的な上限にはしない。
