# L-Lang Semantic Core v1

更新日：2026-09-21。対象snapshot：`381ccf9adb281d6339444941120a5aca4ae7e5ad`。

## 定義

Semantic Core v1は、現在のL-Langが検査済みの意味表現として保持する共通原則と、profile別の意味契約をまとめた名称である。単一のserialize形式、単一のTypeScript型、すべてのprofileを受理する一つのIRを意味しない。

この文書は提供範囲の索引である。個別の構文、上限、ABI、CLI契約は各profile仕様と実装を正本とする。将来の提案やruntime内部に存在する型を、source言語で利用可能な機能として含めない。

## 共通原則

- sourceはprofileを明示し、未知のversion、profile、field、構文を推測して受理しない。
- frontendはsourceをprofile固有のchecked representationへ変換し、型、参照、import、構造上限を検査する。
- checked representationからの生成は同じ入力・toolchain・設定で決定的であることを目標とし、artifactとその入力をhashで結び付ける。
- 評価順、短絡、失敗の優先順、resource limitは観測可能な意味に影響する契約として扱う。
- 外部操作は型付きの要求として表す。operationの宣言は実行権限を付与しない。
- backend固有のlayoutと実行技術を、source profileの意味と区別する。
- 検査済みIRから生成したartifactに対する保証を、任意TypeScript／任意Wasmへ拡張しない。
- test一致、hash一致、署名、replayが示す範囲を分ける。

## Profile対応表

| 機能 | Predicate | Bool | Value | Collection | Effects typed graph |
| --- | --- | --- | --- | --- | --- |
| scalar | boolean、enum文字列、null条件 | boolean | boolean、signed i32、Unicode string | boolean、signed i32、Unicode string | i32、i64、有限f64、bytes、decimal、string、bool |
| record | input contractのfield | flat required boolean record | named required record | genericを含むnamed record | 構造的record value |
| sum／result | 対象外 | 対象外 | tagged union。業務失敗も通常値 | genericを含むtagged union | 専用result型なし。operation failureはruntime event |
| optional／nullable | contract fieldのoptional／nullable／undefinable条件 | 未対応 | optional field未対応 | optional field未対応 | 専用型未対応 |
| collection | 未対応 | 未対応 | 未対応 | homogeneous `List<T>` | homogeneous list value |
| function／module | 一つのpredicate body | typed pure function、relative module | typed pure function、relative module | generics、function value、lambda、recursion、relative module | typed operation graph、relative mixed-source graph |
| control | all／any／not、equals、present | short-circuit all／any、not、call | block、if、exhaustive match、call | const／let、assign、if、while、forEach、match、return、break／continue | await、task group、pull stream、逐次node列 |
| external effect | なし | なし | なし | なし | versioned typed host operation |
| resource | structure limits | evaluation steps、call depth | fuel、wire／string上限 | fuel、call depth、arena、wire、List上限 | host request、task／IO並行数、resource／stream、bytes、memory、fuel等のshared ledger |

「未対応」はそのprofileのsource契約としての判定である。他profileの型や、union等で同じ業務概念を表現できることを否定しない。

## Predicate

`predicate-i32-v1`はcontract fieldに対する限定predicateを表す。fieldはbooleanまたは列挙文字列で、nullable、undefinable、optionalの属性を持ち得る。bodyは`equals`、`present`、`not`、`all`、`any`からなり、property pathは現行profileでは一segmentである。

短絡評価を行い、data recordのfield contractを検査する。任意の計算、関数、module、IOは含まない。Prompt Source、Hybrid、JSONC等が同じPredicate表現へ到達できる一方、要求解決やartifact packageは経路固有である。

## `module-bool-v1`

booleanとrequired boolean fieldだけのflat record、型付きpure function、相対named importを提供する。式はliteral、parameter、field、not、短絡all／any、boolean equals、direct callである。entryはrecord一引数からbooleanを返す。

call cycle、module cycle、再帰、局所状態、例外、IOを受理しない。構造的recordは完全なfield集合を要求する。評価stepとcall depthを制限する。

## `module-value-v1`

boolean、signed i32、Unicode string、named non-recursive record、tagged unionを提供する。blockのimmutable binding、if、conditional expression、exhaustive match、direct callを扱う。optional field、任意union、再帰、loop、assignment、exception、function valueは受理しない。

i32演算はoverflowを検出し、division／remainderはzeroを拒否する。divisionはzero方向へ丸める。call argument、constructor field等は左から右へ一度だけ評価し、短絡と選択されないbranchの非評価を保証する。文字列はUnicode scalarとして検査し、正規化しない。業務上の失敗variantはruntime faultへ変換せず、status 0の通常値である。

## `module-collection-v1`

Valueの基礎に、homogeneous List、explicit generic、function type、lambda、immutable capture、direct／mutual recursion、局所`let`、while、typed for-ofを加える。List intrinsicはlength、at、set、append、map、filter、fold、stableSortである。setとappendは新しいListを返し、for-ofはsource Listをsnapshotする。

callbackはsource順に訪問要素ごと一度実行する。foldはleft fold、sortはstableである。lambdaはparameterとconstを値としてcaptureできるが、letやiteration bindingのcaptureを拒否する。function valueは外部input／output wireやList elementへ置けない。

各evaluationはfresh stateで開始する。fuel、call depth、arena、List長、aggregate element、wire bytes、string bytesを制限し、上限超過を`RESOURCE_LIMIT`とする。invalid index、算術faultとresource faultを区別する。

## `module-effects-v1`

Effectsには互換用のlinear i32 formとtyped graphがある。本節の型表はtyped graphを対象とする。typed valueはi32、i64、有限f64、immutable bytes、scale 0〜18のdecimal、string、bool、record、listである。NaN／Infinityをf64の正常値として受理せず、negative zeroをcanonicalizeする。bytes、i64、decimalはJS numberへ暗黙変換しない。

nodeはtyped await、structured task、pull streamである。各host operationはID、version、request／response／error type、effect、resource kind、cancellation capability、idempotency、signature hashを固定する。sessionはregistryを検査し、dispatchごとにoperationとtarget grantを再検査する。

taskは有限queueと並行上限を持ち、resultをspawn順に返し、runtime faultをsiblingへ伝播する。streamはoutstanding readを一つに制限し、empty bytesとEOFを分け、早期consumer cancellationをproducerへ伝える。request IDはsession、task、generation、sequenceを含み、重複・未知responseを拒否する。取消はgenerationを進め、late responseがstateを再開しないようにする。deadline境界ではtimeoutを優先する。

resource handleはkind、owner scope、ID、generationを持つ。scope disposalはreverse acquisition orderでcloseし、cleanup失敗を主失敗と分ける。ledgerはsessionで共有し、child taskへbudgetを複製しない。

## Capabilityとの関係

Semantic Coreは、programが必要とするoperationと資源を表す。実際のauthorityは外部のpolicy／grantが決め、runtimeがregistry、対象allowlist、budgetと照合する。概念上は次の三要素を結び付ける。

```text
semantic authority: programが要求するoperation・effect・resource kind
runtime authority: 外部policyとgrantが許可するoperation・対象・credential利用
resource budget: sessionが消費を計上する量と上限
```

この整理はCapability package v1／v2をEffects grantのschema versionと同一視するものではない。生成物はgrantを書き換えたり、自ら権限を増やしたりできない。

## 保証境界

この契約は、受理されたsourceとchecked representationの意味を記述する。TS／Wasm等のartifactがこの意味を保存する証拠の範囲は[Observable Semantics](./LLANG_OBSERVABLE_SEMANTICS.md)に記載する。自然言語要求の解釈、外部serviceの正しさ、host OSの完全性、人間による理解の改善はSemantic Coreの型検査だけでは保証しない。
