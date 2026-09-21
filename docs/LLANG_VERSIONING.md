# L-Lang version・ABI・hash契約

更新日：2026-09-21。対象snapshot：`381ccf9adb281d6339444941120a5aca4ae7e5ad`。

## 独立してversioningする対象

L-Langでは、source format、semantic profile、build／artifact format、Wasm ABI、suite、capability／grant、evidenceを別の契約として扱う。同じ数字は互換性を意味せず、異なる数字は意味論の世代が必ず異なることも意味しない。

readerは対応するformatとprofileをstrictに検査し、未知版を既知版として推測しない。writerが現在出力する版と、readerが互換性のために受理する旧版を区別する。

## Module profile対応表

| Semantic profile | JSONC source | 現行build manifest | Suite | Wasm ABI／layout | Reader上の補足 |
| --- | --- | --- | --- | --- | --- |
| `predicate-i32-v1` | L-Lang program v1 | direct build manifest v2 | capability／経路固有 | manifest内Wasm contract、`evaluate` | profile名のi32はWasm loweringを指し、source value型一覧ではない |
| `module-bool-v1` | module source v2 | `llang-module-build` v1 | module suite v1 | 独立`abi` fieldなし。manifestのcontractと`evaluate` | source v2とbuild v1を対応させる |
| `module-value-v1` | module source v3 | build v2 | suite v2 | `llang-value-memory-v1` | layout hashとinterface hashを持つ |
| `module-collection-v1` | module source v4 | build v4 | suite v3 | `llang-collection-native-v1` | build v3／`llang-collection-memory-v1`はretired host-evaluated shellとして隔離 |
| `module-effects-v1` | module source v5 | build v5 | typed suite v5 | `llang-effects-session-v1`。linear envelopeまたは`typed-wire-v1` layout | typed graphと単一source linear互換形式を同じprofile内で明示判別 |

restricted TypeScript sourceはJSONC headerのversion番号をsourceに記述しない。CLIのprofile選択とparserのshapeが対応範囲を決める。従って「TypeScript source version 4」のようには表記せず、対応するprofileとfrontend contractを示す。

## Predicate系の経路固有version

| 対象 | 現行version／profile | 意味 |
| --- | --- | --- |
| JSONC request／program | request v2、program v1、`predicate-i32-v1` | 要求packageと実行programは別format |
| Capability package | verifier／manifest v2、`predicate-i32-v1` | request、source、build、Wasm、testsをhashで結ぶpackage contract |
| Prompt Source／Resolution | source v1、resolution protocol `prompt-predicate-v1` | 要求、独立example、解決lock、source revisionの契約 |
| Hybrid artifact | resolution／build／artifact v1、`predicate-i32-v1` |限定TS import、canonical type、semantic hash、Wasmの契約 |
| Semantic TypeScript | semantic source／lock等の各format固有版 | project typeへ適応する生成経路。module source versionとは独立 |

これらは同じPredicate IRやWasm emitterを共有し得るが、packageの互換性とtrust boundaryは経路固有である。

## Effectsの実行・証拠version

Effects build v5とoperation version、grant version、evidence versionは独立する。

| 対象 | 現行契約 | 備考 |
| --- | --- | --- |
| Operation | operationごとの正整数versionとsignature hash | request／response／error型、effect等をregistryで照合 |
| Execution grant | `llang-effects-grant` v1 | bundle identityとauthorityを実行時に指定 |
| Requirement contract | v1 | authority ceilingと構造bindingをbundleへ結ぶ |
| Trust/data boundary | 各document v1 | source／sink、許可flow、runtime data分類 |
| Execution evidence | 実行経路によりversion 1以降 | unsigned、requirements付き、signed等の段階をformat readerで明示判別 |
| Key／trust policy | key／policy format v1 | role、rotation、revocationをcurrent policyで評価 |

数値だけで証拠の保証を判断せず、format名、必須field、署名の有無、current policyによるtrust decisionを確認する。過去policyで署名がvalidだったことを現在のtrusted statusへ自動昇格させない。

## Hashの対象

| Hash | 主な対象 | 一致を要求する場面 |
| --- | --- | --- |
| `sourceHash` | 一つのsourceのraw bytes | build中の差替え検出、provenance |
| `sourceSetHash` | graph内source pathとraw hashの集合 | module graph inventoryの固定。別frontend／flatten後に必ず同じとは限らない |
| `programHash` | profile固有のchecked logical program。Effects graphではsource inventory等を含む | 同じ表現のround-trip。profile間で同じ定義とは扱わない |
| `interfaceHash` | entry signatureやoperation requirement等の公開境界 | suiteとprogram／bundleの対応 |
| `layoutHash` | Value／Collectionのwire type layout | runtime contractとartifactの対応 |
| `loweredHash` | backendへ渡すlowered representation | Collection native lowering、Effects continuation programの照合 |
| `irHash`／`semanticHash` | Predicate系の解決bodyまたはcanonical meaning | 経路固有manifest・resolutionとの対応 |
| `wasmHash` | 生成されたWasm bytes | artifact差替え検出、manifestとの対応 |
| bundle identity | manifestの固定field・artifact commitment | grant、requirements、execution evidence、auditの結合 |

hash一致は対象bytes／canonical valueの一致または由来の対応を示す。publisher authenticity、自然言語要求の正しさ、一般的な意味的同値性は示さない。

Effects all-target bundleでは、original graphの`programHash`とflattened JSONCから再構築した`programHash`はsource inventoryが違うため同一を要求しない。inspectionはinterface、operation／effect、lowered hash、生成TypeScript／Wasm bytes等を個別に照合する。

## 互換性の規則

- 既存source、manifest、suite、ABIのversion値を同じ意味のまま維持する。
- 新fieldをstrict readerが拒否する場合、既存formatへ黙って追加しない。
- ABI変更、field意味変更、unknown statusの再解釈には新しい識別子またはversionと移行契約が必要である。
- source formatの拡張とsemantic profileの拡張を区別する。profile名が同じままなら、既存sourceとartifactに対する意味の互換性を説明する。
- retired formatは現行runtimeへ暗黙変換せず、専用reader／legacy runtimeで明示する。
- `semanticCore: 1`等の横断fieldは現行artifactの必須要件ではない。必要性、strict reader、hash、移行への影響を別途設計する。

## 変更時の確認

versionまたはhash契約を変更する場合、writer、reader、schema、CLI、portable verifier、fixture、移動後verify、mutation、replayを同時に確認する。既存artifactを新readerが受理するか、新artifactを旧readerがどう拒否するかを記録する。版番号だけを更新して互換性を推定しない。
