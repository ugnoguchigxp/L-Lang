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
