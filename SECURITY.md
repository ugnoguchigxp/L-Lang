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

## Trust boundary

LLM出力は信頼済みコードではありません。制限IRのparse、型文脈検証、決定的生成、型検査、テスト、人間承認を通過するまで候補として扱ってください。`compatible`なSemantic Diffも安全性や業務上の正しさを保証しません。

認可、暗号、金額、DB transaction、network副作用、secretアクセスをSemantic Generationへ委譲しないでください。
