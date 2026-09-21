# Security Policy

L-Langは研究・検証段階のソフトウェアです。生成候補を無条件に本番環境へ適用しないでください。

## Reporting a vulnerability

公開リポジトリでprivate vulnerability reportingが利用できる場合は、それを使用してください。利用できない場合は、認証情報、再現用secret、実データを公開Issueへ貼らず、maintainerへ非公開の連絡経路を求めてください。

## API keys and data

- API keyは`.env`または環境変数で管理し、コミットしないでください。
- `.env`は既定でGit管理対象外です。
- ConceptとTypeScript型宣言は設定されたLLM providerへ送信されます。
- `semanticTest`の値、Benchmark Oracle、hidden casesは通常のモデル入力へ送りません。
- `.semantic/`にはモデル応答や監査情報が保存されるため、公開前に内容を確認してください。

## JSONCとエージェントの境界

TypeScriptとJSONCの両経路を扱います。[経路の対応](./docs/guides/language-routes.md)に応じて認証と検証範囲を確認してください。JSONCのlint/build/testはLLMを起動せず、明示されたProgramを検証します。`llang develop --agent codex-sdk`は別工程として外部エージェントを呼びます。

JSONC経路では固定request・独立suiteとProgramの契約一致を検査します。hashは整合性検査であり署名ではありません。suite合格は自然言語要求の完全な正しさを証明せず、パッケージの部品検証はSAAAの受け入れ・配備を意味しません。生成工程へ渡す要求自体に機密情報を含めないでください。

## Semantic TypeScriptの信頼境界

LLM出力は信頼済みコードではありません。通常の`semantic build`は、制限IRのparse、型文脈検証、決定的生成、候補専用の型検査とSemantic Test、全体typecheck、全体testを通過すると自動昇格します。`--review`、`diff`、`approve`は互換用のcandidate stagingであり、セキュリティ上の信頼水準を引き上げるものではありません。自動昇格済みのartifactも、安全性や業務上の正しさが保証されるわけではありません。`compatible`なSemantic Diffも同様です。

compiler、lock、Pilot、Benchmark、互換utilityが信頼境界から読むJSONにはbyte上限と用途別のstrict parserがあり、未知field、path escape、freeze不一致をfail-closedで拒否します。新しい外部入力経路にも同じbounded parseとknown-key検査を追加してください。promotionはworkspace lock、previous/next snapshot、transaction journalを使用します。未知hashを検出した回復処理は`manual-recovery-required`として停止し、推測でartifactを上書きしません。L-Lang以外のprocessから見た複数fileの同時可視性は保証されないため、promotion中の生成物を直接監視しないでください。

認可、暗号、金額、DB transaction、network副作用、secretアクセスをSemantic Generationへ委譲しないでください。

## Effects署名鍵

Effects attestationはEd25519署名と外部指定のcurrent trust policyを使う。packageへ同梱された発行時policyを自動的にtrust rootへ昇格させない。要求承認者、実行host、監査者の秘密鍵を分離し、repositoryや成果物へコミットしない。署名は鍵の保有とbytesの整合性を示すだけで、自然言語要求、業務結果、host OS、外部service、署名時刻、anti-replayを証明しない。rotation、revocation、紛失、backup、Windows ACLは[鍵運用runbook](./docs/EFFECTS_ATTESTATION_KEY_RUNBOOK.md)に従う。

Effects assurance core v1は、外部dataのsource／sinkと許可flowを署名chainへ固定し、現行IRのcompile時固定requestからauthority-bearing valueをruntime dataで拡張できないことを検査する。これは外部dataが真実または無害であること、許可済みflowが業務上正しいこと、任意TypeScript／Wasmのinformation flow、prompt injection一般への耐性を証明しない。checked-in adversarial fixtureは`evidenceEligible: false`であり、live安全性の根拠にしない。

Effects adversarial benchmarkは、freeze対象をregular fileのexact setとして読み、symlink、hard link、path escape、unknown field、hash差替えを拒否する。TypeScript armはreview済みfixture sourceだけを実行し、禁止API scanと共通host dependency injectionを要求する。Bun workerやこのscannerを任意TypeScriptのOS sandboxとは扱わない。hidden Oracleは全arm終了後に読み、operation logへbody、credential、絶対path、queryを保存しない。fixture／verify／reproduceは外部network、credential、API callを使わない。

## Value Wasmのmemory境界

`module-value-v1`のgenerated Wasmは、direct callerから渡されたinput／outputのbase、length、capacity、overlapを型付きloadより前に検査する。string descriptorはinput wireへの包含を確認してからUTF-8を読み、booleanと選択されたunion variantを段階的に検査する。不正入力はstatus 1で返し、host codecによる事前検査だけに依存しない。

これは信頼するcompilerが検証済みIRから生成した`llang-value-memory-v1` artifactの保証である。任意Wasm、実行中にmemoryを書き換えるhost、threads、shared memory、memory growthは対象外である。input／output以外のmemoryは内部arenaとして変更され得るため、caller所有領域とは扱わない。保証表とnegative vectorは[Value Wasm Memory Safety Matrix](./docs/VALUE_WASM_MEMORY_SAFETY_MATRIX.md)を参照する。

## Effects Wasmのmemory／state境界

`module-effects-v1`のgenerated Wasmは、raw `start`／`resume` callerが渡すdescriptor、capacity、typed payloadをload／storeより前にunsigned rangeとして検査する。成功responseではeventとoutput、typed payloadとoutputの重なりを拒否し、typed output／payloadをembedded request dataとresult scratchから分離する。不正なretryable callはcontinuation state、sequence、accumulator／result、terminalを消費せず、同じpending responseを再試行できる。

この検査はexported memoryへのaccess controlではない。hostがWasm呼出し中または呼出し外でmodule-private bytesを直接変更する場合、typed payloadのJSON意味、external adapter、外部副作用、任意Wasmは保証対象外である。保証表とnegative vectorは[Effects Wasm Memory Safety Matrix](./docs/EFFECTS_WASM_MEMORY_SAFETY_MATRIX.md)を参照する。

## LLVM実験backendの境界

LLVM実験backendは、検証済み`module-collection-v1`から完全一致するchecked `sum(List<i32>)`だけを射影する。生成Wasmはimportなし、2 page固定memoryで、count、input/output range、overlapをload/store前に検査する。このkernel artifactは製品Collection ABIではなく、製品portable verifierも受理しない。

Native laneはWasm sandboxを持たない。runner所有bufferだけを別processへ渡し、timeout、signal、非zero終了、出力上限を分類するが、任意pointer、任意LLVM IR、第三者library、dynamic loader、OSの安全性は保証しない。外部toolは引数配列で起動し、stdout/stderr、時間、artifact sizeを制限する。tool pathとSDK pathは再現用freezeへ保存されるため、共有前にhost情報として確認する。実験結果と保証外は[LLVM実験backend 最小比較 実装結果](./docs/LLVM_EXPERIMENTAL_BACKEND_RESULTS.md)を参照する。
