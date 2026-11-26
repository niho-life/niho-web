# AI編集対象と正本の対応表

この文書は、公開ページの要素から編集元へ戻るときに参照する契約です。公開HTML・CSS・JSON-LDは確認用の生成結果であり、編集の正本ではありません。編集対象はコンテンツ面かコード面のどちらか一方に属し、両者の間を自動同期しません。

人はStudio GUI、AIはCLI/APIまたは通常のGitから編集します。構造化コンテンツでは両者が同じホストの認証済み編集契約・版・検証・公開計画を使います。Studioの編集画面はAIの実行条件ではありません。コード面のGitレビュー・CI・配備と、コンテンツ面の保存・公開権限は分離します。

## 対応表

| 編集対象 | 面と正本 | 人のGUI | AIの経路 | 公開出力から戻る手掛かりと現在の境界 |
| --- | --- | --- | --- | --- |
| ページ本文、要素、色・文字・余白・幅別スタイル、フォーム表示 | コンテンツ面。検証済み `PageDocument` | `@niho/web/editor` の `PageEditor`。鎌倉Studioの日本語通常編集は差分操作の `pages.apply` を使い、全文置換やfallbackは `pages.save` を使う | 共通wire契約の `pages.read` で文書と版を読み、`@niho/web/editor-model` の `editDocumentById` またはJSON編集でローカル検証し、`pages.save` にexpectedVersion付きで保存。公開は `pages.release-plan` の差分・originを確認し、`pages.release` に同じoperation IDを渡す。ホストは `@niho/web/editing-api` をサイトoriginへmountする。既存Studio CLIも同じ正本を更新する互換経路として残る | `data-nw-scope` がsite/page/locale/revision、`data-nw-owner` と `data-nw-node` が所有文書と安定ノードIDを示す。テキストノードにはIDがないので親ノードと相対位置を使う。URLからページIDへの対応はホストの公開ルート一覧が必要 |
| サイト共通スタイル、ブレークポイント、公開設定 | コンテンツ面。ホストのサイト設定API/DB | `PageEditor` のサイト設定adapter。鎌倉Studioはブレークポイントだけ共通wireへ接続 | ブレークポイントは `niho-edit breakpoints-read/save` が共通wireの `site.breakpoints.read/save` を直接呼ぶ。サイト共通スタイルの保存APIは未接続で、対応は [#341](https://github.com/niho-life/niho-web/issues/341) で追跡する | CSSのスコープとノードIDから利用箇所は追える。実効値・所有者・版はサイト設定APIが返す。鎌倉の旧Studio D1値は初回読取時に共通APIへ一度だけ移行する |
| 共通部品、登録ブロック、業務ブロックの表示props/領域 | 表示値はコンテンツ面のPageDocument/部品文書。実装とregistryはコード面のGitソース | GUIは登録済みのpropsと宣言済みslotだけを編集 | 文書に保存する値は `pages.save`。ブロック実装・registryはGitのbranch/PR/CI。共通部品ライブラリのGUI保存は鎌倉Studioで未接続であり、ホストが利用する段階で共通APIへ接続する | `data-nw-node`、`data-nw-owner`、`data-nw-block`、必要なら `data-nw-slot` が文書のブロックと表示領域へ戻る。propsの宣言元やコード位置はホストの認証済み逆引き情報が必要 |
| CMS項目・CMSスキーマ | コンテンツ面。ホストのCMS API/DB | CMS用のStudio/ホスト画面 | `cms.*` の委任操作 | 公開HTMLにCMS項目IDが含まれるとは限らない。項目・テンプレートへの逆引きはホストAPIが提供する。HTMLを編集してCMS値を変更しない |
| 画像・動画などの素材 | コンテンツ面。ホストの素材API/DBと安定素材ID | 素材ライブラリとPageEditor | `assets.*`、アップロード時は一時アップロード許可 | ノードIDからPageDocument内の素材参照へ戻る。公開URLは配信時に解決されるため、URLだけから素材の正本を推定しない |
| 翻訳 | コンテンツ面。ホストの翻訳overlayまたは翻訳対象localeの文書 | Studioの翻訳画面とページ編集画面 | `translations.*` の委任操作 | ページscopeのlocale/revisionとノードIDで表示対象を特定する。原文との対応や確認済み翻訳の版はホストの翻訳APIが返す |
| title、description、OG画像、favicon、robots/canonical | コンテンツ面。PageDocumentの `meta` またはホストのサイト設定 | ページ/サイト設定画面 | `pages.read/save` またはホストの設定操作 | `<head>` の値から直接の生成元は分からない。ページルートとscopeを使って文書/設定を取得する |
| JSON-LD | 選択可能な種類はコンテンツ面のPageDocument `meta.structuredData`。JSON-LD本文と生成規則はホストのデータ/APIまたはコード面 | GUIはホストが許可した種類だけ選択 | 許可されたIDの編集は文書/API。生成規則はGit | JSON-LDはホストが生成する読み取り専用出力。任意JSONやscriptをPageDocumentに保存しない |
| URL、転送、sitemap、HTTP header、公開pointer | コンテンツ設定またはホストの配信設定。種類ごとに正本を一つ指定 | ホストの管理画面 | ホストが公開するCLI/API。実装変更はGit | pathからpageIdへ引く公開ルート表と、公開状態/版を返すホストAPIが必要。生成物やHTTP応答だけを書き換えない |
| 独自HTML/CSS/JavaScript、テンプレート、ブロック実装、JSON-LD生成規則、ビルド設定 | コード面。ホストGitリポジトリ | GUIでは登録ブロックのprops/slotだけを編集 | 通常のGit branch・PRレビュー・CI・配備 | ソースパスやcommitは公開HTMLに含めない。URLからリポジトリ位置と版を返す認証済み逆引きAPIが必要。現行の共通CLIにファイル編集APIは作らない |
| フォーム送信、予約、決済、認証、保存などの業務処理 | ホストのAPI/DBまたはコード面 | ホストが提供する業務画面 | ホストの業務API、または通常のGit | フォーム表示と送信処理は別の責務。PageDocumentからaction/scriptを指定しない |

## 鎌倉StudioのGUI書込み経路

鎌倉Studioの `EditorAdapter.readDocument` は日本語・英語の両方で共通 `pages.read` を使います。英語キャンバスは `locale=en` を指定し、alias URLの解決を含む `presentation` を共通snapshotから読みます。英語専用のsnapshot BFF routeはありません。

次の表は、現在の鎌倉Studioが実装する `EditorAdapter` と素材adapterの全メソッドから、永続化・公開・確認計画の書込みを抽出したものです。BFF route欄は認証済みproject/site prefix以降のpathです。GUIはadapterメソッドから共通操作IDへ接続し、同じ操作catalogを `@niho/web/editing-api` または `niho-edit` が使います。ホスト固有のGUI専用保存経路は追加しません。素材アップロード本体だけは、共通APIの `assets.upload-intent` が発行した短命tokenで署名済みURLへ直接PUTします。

| GUI adapter method | 共通操作ID | Studio BFF route | 接続内容 |
| --- | --- | --- | --- |
| `EditorAdapter.applyPageChange` | `pages.change-apply` | `POST /editing-api/v1/sites/kamakura/operations/pages.change-apply` | ページ変更確認後の適用 |
| `EditorAdapter.applyOperations` | `pages.apply` | `POST /editing-api/v1/sites/kamakura/operations/pages.apply/:pageId?locale=:locale` | 日本語ページの通常編集を未送信操作の差分で保存 |
| `EditorAdapter.breakpointSettings.save` | `site.breakpoints.save` | `PUT /editing-api/v1/sites/kamakura/operations/site.breakpoints.save` | サイト単位の表示幅保存 |
| `EditorAdapter.englishPublication.retry` | `pages.english-publication-retry` | `POST /editor/:pageId/english-publication-retry` | 明示操作による英語公開再試行 |
| `EditorAdapter.localization.command` | `translations.editor-set-value`, `translations.editor-adopt-candidate`, `translations.editor-review-current` | `POST /localization/editor/pages/:pageId/command` | actionに応じて訳文編集・候補採用・確認済み化。ページ単位の翻訳依頼はadapterが拒否し、翻訳画面を使う |
| `EditorAdapter.preparePageChange` | `pages.change-prepare` | `POST /editing-api/v1/sites/kamakura/operations/pages.change-prepare` | ページ変更の影響・確認tokenを取得 |
| `EditorAdapter.prepareRelease` | `pages.release-plan` | `POST /editing-api/v1/sites/kamakura/operations/pages.release-plan/:pageId?locale=:locale` | 単一ページ公開・rollbackの確認計画 |
| `EditorAdapter.prepareReleaseSet` | `pages.release-set-plan` | `POST /editing-api/v1/sites/kamakura/operations/pages.release-set-plan` | 複数ページ公開の確認計画 |
| `EditorAdapter.release` | `pages.release` | `POST /editing-api/v1/sites/kamakura/operations/pages.release/:pageId?locale=:locale` | 単一ページ公開・rollback |
| `EditorAdapter.releaseSet` | `pages.release-set` | `POST /editing-api/v1/sites/kamakura/operations/pages.release-set` | 複数ページ公開 |
| `EditorAdapter.saveDraft` | `pages.save`, `translations.editor-save` | `PUT /editing-api/v1/sites/kamakura/operations/pages.save/:pageId?locale=:locale`; `POST /localization/editor/pages/:pageId/save` | 日本語の全置換・操作queue fallback、英語の翻訳保存 |
| `PageEditorProps.assets.deleteAsset` | `assets.delete` | `POST /editing-api/v1/sites/kamakura/operations/assets.delete/:provider/:assetId` | 使用中でない素材の削除 |
| `PageEditorProps.assets.updateAsset` | `assets.update` | `PUT /editing-api/v1/sites/kamakura/operations/assets.update/:provider/:assetId` | 素材metadataの更新 |
| `PageEditorProps.assets.uploadAsset` | `assets.upload-intent` | `POST /editing-api/v1/sites/kamakura/operations/assets.upload-intent` | upload intent発行後、署名済みURLへファイル本体をPUT |

適合テストはTypeScriptの返却adapterを走査し、読み取りメソッドと上表の書込みメソッドで実装面を網羅していること、全ての操作IDが公開catalogにあることを検証します。鎌倉Studioで未接続のoptional機能（共通部品ライブラリ、サイト共通スタイル、snapshot作成、サイト全体翻訳・翻訳版の公開、素材folder/acquire）は書込みUIとして有効化しません。サイト共通スタイルは [#341](https://github.com/niho-life/niho-web/issues/341)、共通部品ライブラリはホストが利用を開始するまで低優先で、接続時に独立したIssueと共通操作IDを用意します。

ページ編集HTTP契約とホストの責任は[ページ編集HTTP契約](editing-api-contract.md)、既存Studio CLIの操作と認証・保存・公開契約は[Studio CLI](studio-cli.md)を参照してください。`cms.*`、`assets.*`、`translations.*`など、ホスト固有の機能があることは全ホスト共通の操作や保存先があることを意味しません。

## 公開DOMからの文書逆引き

通常のPageRendererは次のdata属性を出力します。

| 属性 | 意味 |
| --- | --- |
| `data-nw-scope` | 文書のsiteId、pageId、locale、revisionを長さ付きで連結したscope |
| `data-nw-owner` | そのDOMノードを所有する文書scope。共通枠や入れ子の文書でも所有元を区別する |
| `data-nw-node` | PageDocumentの安定した要素/ブロック/部品ノードID |
| `data-nw-block` | 信頼済みhost registryのブロック名 |
| `data-nw-slot` | ブロックregistryが宣言した表示領域 |

`@niho/web/core` の `parsePageScope` は `data-nw-scope` から `{ siteId, pageId, locale, revision }` を復元します。`pageScope` と同じ検証済みの識別子形式だけを受け入れます。ページURLはホストの公開ルート一覧でpageIdへ引き、scopeのrevisionは出力を作った正確な文書版を示します。ノードIDは `editDocumentById` の対象として使えます。生成CSSもscope・owner・nodeをselectorに使うため、要素の表示を元文書のスタイルへ対応付けられます。

この属性にGit上のパス、commit、CMS内部ID、素材の保存URLを埋め込みません。これらは公開情報ではありません。コード位置、CMS項目、head/配信設定のようにDOMだけで分からない正本は、認証済みのホスト逆引きAPIで返します。下書きと公開版が異なる場合、`pages.read` の現在の下書きを公開出力の版だと推測せず、ホストの版履歴からscopeのrevisionを取得します。

## プレビューと公開

React UIを使わない検証では、共通coreでPageDocumentを検証し、決定的なHTML/CSSと文書差分を確認できます。ホストのプレビューURLは同じrendererと登録済みブロックを使い、有効期限・認証・noindexをホストが管理します。幅別画像はホストのヘッドレス実行環境で生成します。ブラウザーなしは画面操作とブラウザーセッションが不要という意味で、描画やプレビューを禁止する意味ではありません。

生成されたHTML・CSS・JSON-LDの直接編集は保存操作になりません。変更は正本へ適用し、共通の検証を通し、対象版を固定した公開計画から公開します。コード面はGitレビュー・CI・配備を通します。
