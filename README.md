# niho-web

公開ページの構造化文書、検証、HTML / React 描画と、Studio の編集部品を提供する TypeScript リポジトリです。現在の製品方針は、鎌倉のサイトを Studio GUI と `niho-edit --studio` から編集・公開することです。Experience は一覧と Dashboard で参照でき、editor は未接続です。外部 CMS とは連携しません。

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
| @niho/web/editing-api | 共通編集 wire 契約 |
| @niho/web/editing-client | 編集 API client |
| @niho/web/react | React renderer |
| @niho/web/presentation-runtime | 公開ページの対話機能 |
| @niho/web/server | HTML 描画 |
| @niho/web/editor | Studio 編集画面 |
| @niho/web/editor-model | React 不要の編集操作 |
| @niho/web/cms-delivery | CMS 公開 |
| @niho/web/cms-v2 | CMS 定義 |
| @niho/web/collection-model | Collection 型 |
| @niho/web/assets | 素材参照 |
| @niho/web/site-analytics | サイト分析の接続 |
| @niho/web/analytics | 分析モデル |
| @niho/web/analytics-data | 分析データ |
| @niho/web/localization | 翻訳モデル |
| @niho/web/localization-release | 言語別公開モデル |

## 文書案内

- **利用開始:** [AI編集手順](docs/ai-editing-guide.md)、[niho-edit の操作](docs/studio-cli.md)
- **描画と編集:** [文書契約](docs/document-contract.md)、[編集 API](docs/editing-api-contract.md)、[エディターのホスト契約](docs/editor-contract.md)、[編集画面の説明](docs/editor-ui-contract.md)
- **サイト機能:** [素材](docs/asset-contract.md)、[CMS](docs/cms-v2-contract.md)、[翻訳](docs/localization-contract.md)、[保存と版履歴](docs/save-history-contract.md)、[サイト共通スタイル](docs/site-styles-contract.md)
- **Studio の運用:** [`npm run studio:release` による配備、smoke、切り戻し](studio/README.md)、[Studio Preview の直接アップロード](docs/studio-preview.md)

公開リポジトリですが、第三者による再利用ライセンスはありません。詳しくは package.json の license を参照してください。
