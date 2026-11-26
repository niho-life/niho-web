# niho-web

公開ページの JSON 文書、編集操作、検証、React / HTML 描画を共有する TypeScript パッケージです。人は Studio、AI は `niho-edit` CLI で同じサイトの正本を編集します。

## 利用開始

Node.js 22 以上が必要です。Git dependency はレビュー済みの commit SHA に固定してください。

```json
{
  "dependencies": {
    "@niho/web": "github:niho-life/niho-web#<reviewed-commit-sha>"
  }
}
```

## 公開 entry points

- `@niho/web` — 文書型、検証、基本描画
- `@niho/web/core` — 文書・スタイル検証と CSS
- `@niho/web/normalize` — 既存文書の整理候補を分析
- `@niho/web/editing-api` — サーバー側の編集 API
- `@niho/web/editing-client` — 編集 API の HTTP client
- `@niho/web/builder` — ブロック登録と builder の型
- `@niho/web/react` — React renderer
- `@niho/web/presentation-runtime` — ブラウザー描画 runtime
- `@niho/web/server` — HTML renderer
- `@niho/web/editor` — Studio のページ編集画面
- `@niho/web/editor-model` — React に依存しない編集操作
- `@niho/web/pages` — ページ・公開 metadata
- `@niho/web/history` — 版履歴と復元
- `@niho/web/projects` — Project の型と検証
- `@niho/web/project-editor` — Project 用 editor adapter
- `@niho/web/project-manager` — Project 管理画面
- `@niho/web/project-directory` — Project 一覧
- `@niho/web/project-dashboard` — Project dashboard
- `@niho/web/site-language-settings` — サイト言語設定画面
- `@niho/web/project-read-model` — Project 読み取り型
- `@niho/web/collection-workspace` — CMS 編集画面
- `@niho/web/cms-delivery` — CMS 公開データの配信
- `@niho/web/cms-v2` — CMS 定義・項目・公開
- `@niho/web/collection-model` — CMS 型と検証
- `@niho/web/localization-workspace` — 翻訳編集画面
- `@niho/web/localization-workspace-model` — 翻訳編集用の型
- `@niho/web/assets` — 素材の型と検証
- `@niho/web/site-analytics` — 分析接続の契約
- `@niho/web/site-apps` — サイト機能の設定画面
- `@niho/web/ui-tokens` — Studio UI の design tokens
- `@niho/web/analytics` — 分析 API と型
- `@niho/web/analytics-data` — 分析データの型
- `@niho/web/localization` — 翻訳データの型と検証
- `@niho/web/localization-release` — 翻訳版の公開

## 開発

```sh
npm ci
npm run build
npm test
npm run studio:typecheck
npm run demo
```

## 文書

- [CLI の使い方](docs/studio-cli.md)
- [編集画面の案内](docs/editor-contract.md) / [ホスト接続契約](docs/editor-host-contract.md)
- [Editing API 契約](docs/editing-api-contract.md)
- [CMS 契約](docs/cms-v2-contract.md)
- [サイト共通スタイル](docs/site-styles-contract.md)
- [AI 編集手順](docs/ai-editing-guide.md)
- [Studio 運用 runbook](studio/README.md)

ソースは公開されていますが、第三者への再利用ライセンスは付与していません（`UNLICENSED`）。
