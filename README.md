# niho-web

公開ページの構造化文書、検証、HTML / React 描画と、Studio の編集部品を提供する TypeScript リポジトリです。Studio GUI と `niho-edit --studio` で編集し、公開時に生成した HTML を別の read-only Worker から配信する構成を進めています。Experience は一覧と Dashboard で参照でき、editor は未接続です。外部 CMS とは連携しません。

## 利用開始

Node.js 22 以上を使います。

    npm ci
    npm run build
    npm test

## 公開 entry points

| Entry | 用途 |
| --- | --- |
| @niho/web | 文書型と標準描画 |
| @niho/web/core | 文書検証と CSS |
| @niho/web/normalize | 文書の正規化 |
| @niho/web/editing-api | ページ・版履歴・1操作公開・サイト共通スタイルの共通編集 wire 契約 |
| @niho/web/editing-client | GUI / `niho-edit` 共通の編集 API client と条件付き読取 |
| niho-edit --studio | Studio-native site の版付きSEO設定をJSONで読み書き |
| @niho/web/react | React renderer |
| @niho/web/presentation-runtime | 公開ページの対話機能 |
| @niho/web/server | HTML 描画 |
| @niho/web/editor | Studio 編集画面と再検証付きページ切替 |
| @niho/web/editor-model | React 不要の編集操作 |
| @niho/web/cms-delivery | CMS 公開 |
| @niho/web/cms-v2 | CMS 定義 |
| @niho/web/collection-model | Collection 型 |
| @niho/web/assets | 素材参照 |
| @niho/web/site-analytics | サイト分析の接続 |
| @niho/web/analytics | 分析モデル |
| @niho/web/analytics-data | 分析データ |
| @niho/web/localization | サイトdraft stylesで検証する翻訳モデル |
| @niho/web/localization-release | サイトpublished stylesを参照する言語別公開モデル |

## Studio runtime entry points

| Entry | 用途 |
| --- | --- |
| `studio/wrangler.json` | Studio の編集・管理 Worker。[固定ページの正本と保存契約](docs/studio-managed-sites.md#ページ正本と操作) |
| `studio/public-sites.wrangler.json` | R2 の生成物を返す公開 Worker。開発時は `npm run studio:public:dev` |

## 文書案内

- **利用開始:** [AI編集手順](docs/ai-editing-guide.md)、[niho-edit の操作](docs/studio-cli.md)
- **描画と編集:** [文書契約](docs/document-contract.md)、[編集 API](docs/editing-api-contract.md)、[エディターのホスト契約](docs/editor-contract.md)、[編集画面の説明](docs/editor-ui-contract.md)
- **サイト機能:** [素材](docs/asset-contract.md)、[CMS](docs/cms-v2-contract.md)、[翻訳](docs/localization-contract.md)、[保存と版履歴](docs/save-history-contract.md)、[サイト共通スタイル](docs/site-styles-contract.md)、[公開生成物と配信](docs/site-publication-contract.md)
- **Studio の運用:** [`npm run studio:release` による配備、smoke、切り戻し](studio/README.md)、[Studio Preview の直接アップロード](docs/studio-preview.md)、[公開配信](docs/studio-managed-sites.md)、[埋め込み契約](docs/managed-embed-contract.md)、[鎌倉専用ブロックの移行](docs/kamakura-block-migration.md)

公開リポジトリですが、第三者による再利用ライセンスはありません。詳しくは package.json の license を参照してください。
