# niho-web

人は Studio の画面、AI は `niho-edit` から、同じページの正本を編集・公開できます。共有の文書形式と renderer で、公開サイトに HTML と CSS を生成します。

## 利用開始

Node.js 22 以上が必要です。`@niho/web` は Git dependency として利用できます。依存先ではレビュー済みの commit SHA に固定してください。

```json
{
  "dependencies": {
    "@niho/web": "github:niho-life/niho-web#<reviewed-commit-sha>"
  }
}
```

React を使う入口には同じ版の React と React DOM（18.3 または 19）を用意します。`core` は React 不要です。

## 入口

パッケージ名は `@niho/web` です。以下の `/…` は subpath を示します。

| 入口 | 用途 |
| --- | --- |
| `@niho/web` | 文書型と基本 API |
| `/core` | 文書の検証・変換と CSS 生成 |
| `/normalize` | サイトの正規化候補、計画、検証 |
| `/editing-api` | ホストに組み込む編集 HTTP API |
| `/editing-client` | 編集 HTTP API のクライアント |
| `/builder` | 挿入・モーションの定義 |
| `/react` | React renderer とブロック registry |
| `/presentation-runtime` | 公開 DOM の操作とモーション |
| `/server` | サーバーと静的ビルド用の HTML 生成 |
| `/editor` | `PageEditor` とホスト adapter の型 |
| `/editor-model` | React 不要の文書編集操作 |
| `/pages` | ページ管理、URL、公開メタ情報 |
| `/history` | 文書差分、版履歴、作業復元 |
| `/projects` | プロジェクト・サイトの検証と操作 |
| `/project-editor` | 対象サイトを限定する adapter |
| `/project-manager` | プロジェクト管理画面 |
| `/project-directory` | プロジェクト一覧 |
| `/project-dashboard` | サイトの管理画面 |
| `/site-language-settings` | サイトの言語設定画面 |
| `/project-read-model` | 一覧・管理画面の読み取り契約 |
| `/collection-workspace` | CMS の一覧・編集画面 |
| `/cms-delivery` | CMS 公開 snapshot の取得 |
| `/cms-v2` | CMS 定義・項目・公開のモデル |
| `/collection-model` | CMS の adapter 型と入力検証 |
| `/localization-workspace` | 翻訳一覧と項目の編集画面 |
| `/localization-workspace-model` | 翻訳画面のデータと型 |
| `/assets` | 素材参照と素材ライブラリの契約 |
| `/site-analytics` | GA4 / Search Console の接続契約 |
| `/site-apps` | 計測・検索の接続画面 |
| `/ui-tokens` | 管理画面の共通 UI トークン |
| `/analytics` | 分析レポート画面 |
| `/analytics-data` | 分析レポートの型と検証 |
| `/localization` | 日英の翻訳単位と文書の組み立て |
| `/localization-release` | 言語版の公開 snapshot と検証 |
| `niho-edit` | サイトを CLI / stdio MCP で編集 |
| `niho-studio` | Studio 経由の CLI 操作 |

## 開発

```sh
npm ci
npm test
npm run demo
npm run bench:editor
```

Studio のビルドと配備は [運用手順](studio/README.md) を参照してください。

## ドキュメント

- [文書と公開描画](docs/document-contract.md) / [表示設定](docs/site-presentation.md)
- [ホスト接続](docs/editor-contract.md) / [画面の使い方](docs/editor-ui-guide.md)
- [編集 HTTP API](docs/editing-api-contract.md) / [AI 編集ガイド](docs/ai-editing-guide.md) / [編集の正本](docs/ai-edit-source-map.md) / [Studio CLI](docs/studio-cli.md)
- [サイトの組み込み](docs/builder-integration-guide.md) / [Studio でのサイト運用](docs/studio-managed-sites.md)
- [契約文書一覧](docs/) / [作業フロー](docs/panes/panes-workflow.md)
