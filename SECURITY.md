# 脆弱性の報告

未修正の脆弱性、再現手順、実データ、tokenや署名URLは、公開IssueやPRに投稿しないでください。
[GitHubの非公開脆弱性報告](https://github.com/niho-life/niho-web/security/advisories/new)からmaintainerへ連絡してください。
報告には影響範囲と合成データによる再現方法を含め、認証情報や利用者の情報は添付しないでください。
報告窓口を利用できない場合は、技術詳細を含めずにmaintainerへ非公開の連絡手段を問い合わせてください。

## 配布・CI変更の確認

mainへの変更はPRと既存の必須検査を通します。maintainerは、特にworkflow、配布処理、依存lock、install scripts、認証境界の差分を確認します。
通常の公開PRはread-onlyのGitHub-hosted環境で検証し、本番の秘密、private checkout、trusted self-hosted runnerを渡しません。
Actionの完全commit SHA固定は取得するコードを固定するための措置です。更新時にも出所と差分を確認します。
利用側への採用は固定版の差分・互換性・必要な認可検査を確認して行い、公開mainへの反映だけで本番採用とはしません。
