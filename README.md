# niho-web

> 2026-10-22: Studioの2サイト向けvisual editor実行経路は凍結しました。公開サイトの構造・レイアウト・スタイルは各サイトのコードが正本です。editor source/coreは将来用の独立ライブラリとして保持しますが、Studio client bundle、HTML route、server proxyには接続しません。Dashboard、membership、招待など他のplatform機能は継続します。
>
> 2026-10-25: Kamakura の editor だけ読み取り専用で再接続しました（niho-life/kamakura-site#84）。保存・公開はサイト側の凍結で止まり、画面は凍結中と案内します。Experience は凍結したままです。詳細は [Studio runbook](studio/README.md)。
>
> 2026-10-27: Kamakura の English キャンバスはサイト側の canonical localization overlay に接続しました。日本語の見た目編集・ページ単位公開は従来の凍結状態を維持し、英語は表示材料が揃うページだけ読込・下書き保存できます。
>
> 2026-10-28: Kamakura の native 化済みページは Studio から日本語デザインの下書き保存とページ単位公開を行えます。原文ページの保存 locale が `ja`、翻訳設定の原文 mapping が `ja-JP` の場合も、原文を編集対象として開きます。Experience の編集経路は引き続き凍結中です。

公開ページの JSON 文書、入力検証、scoped CSS、React / HTML renderer を共有する TypeScript パッケージです。Astro と Next.js が同じ文書を描画できます。React renderer は本文と登録済みブロックをサーバーで描画し、初期 HTML に含めます。

このリポジトリには公開可能な文書契約と描画処理を置きます。認証情報、管理 API、サイトの非公開データ、価格・在庫・予約の判断処理は利用側が所有します。

`studio/` には、このライブラリとは独立して配置する NIHO Web Studio host があります。Cloudflare Access の Google 認証、Studio専用D1のProject/Site・membership、参加Project一覧とDashboardを所有し、niho-appのUser/Project DBやcookieには接続しません。Experience のサイト編集routeは凍結案内を返し、editor APIは上流へproxyしません。Kamakura は native 化済みの日本語ページの保存・公開と、サイト側の正本 overlay を使う English 下書き編集を提供します。Studio の HTML・JS・CSS は配備間の cache 混在を防ぐため内容ごとの URL で読みます。構成、security boundary、D1 migration、owner bootstrap、配置手順は [Studio runbook](studio/README.md) を参照してください。

ソースは公開されていますが、第三者への再利用ライセンスは付与していません（`UNLICENSED`）。

## 利用開始

Node.js 22 以上が必要です。React renderer には React 18.3 または 19、HTML helper には同じ版の React DOM を利用側で用意します。検証・CSS の `@niho/web/core` だけを利用する場合は React を必要としません。npm 公開前でも、リポジトリ直下を Git dependency として利用できます。利用先ではレビュー済みの commit SHA に固定してください。

```json
{
  "dependencies": {
    "@niho/web": "github:niho-life/niho-web#<reviewed-commit-sha>",
    "react": "^18.3.0 || ^19.0.0",
    "react-dom": "^18.3.0 || ^19.0.0"
  }
}
```

Git からのインストール時は `prepare` が TypeScript をビルドします。パッケージの公開範囲は `dist/`、設計文書、公開サンプルです。共有されたクライアント側コードへ秘密を渡さないでください。

| 入口 | 用途 |
| --- | --- |
| `@niho/web` | JSON 型、`validateDocument` / `parsePageDocument`、閉じた組み込みアイコン・フォーム・Map / YouTube / Vimeo / Lottie / Facebook / X / Instagram / host承認済みBlank埋め込み・VideoWithButton・Loop Box、CSS、リストの印と画像の行内縦位置、画像・native動画を含む React SSR の `PageRenderer` |
| `@niho/web/core` | 検証・文書型・embed URL正規化・CSS・共通部品の検証と展開、form完了ページの安全な純粋resolverだけの入口。React の runtime import を含みません |
| `@niho/web/builder` | 汎用の挿入カタログ、モーション定義、host拡張の型と検証。React非依存 |
| `@niho/web/react` | `PageRenderer` / `SitePageRenderer` とブロック registry の型。編集キャンバスでは props と一致する host view が無いブロックだけ見本または空の枠へ戻し、他の要素を表示し続ける。外部 frame は [サイト単位の許可リスト](docs/site-presentation.md) と実行コードの信頼済みリストの積集合で制限できる |
| `@niho/web/presentation-runtime` | SSR後の検証済みDOMへ、native presentation、VideoWithButton、Loop Box、reduced-motion対応Lottie player、明示操作後だけ読み込むFacebook / X / Instagram投稿の標準操作を接続するclient runtime。返されたcleanupを再初期化前に呼ぶ |
| `@niho/web/server` | Astro の build / server で使える `renderPageToHtml` |
| `@niho/web/editor` | 認証済みホストadapterへ接続する `PageEditor` と型。50pxの左ツール列＋300pxの追加パネル、左レールの版履歴と文章検索・選択、300pxの右インスペクタ、表示幅・端末切替とサイト単位の「編集モード」（Mini / Mobile / Tablet / Small / PC、opaque version CAS）の下部ツールバー、キャンバス左右端の表示幅ドラッグを共通化する。左ツール列は短い画面でも独立スクロールでき、方向キー・Home・Endで有効な操作へフォーカス移動する。未接続ホストでは従来の `breakpoints` を読み取り専用表示する。任意のhost-owned `responsiveProposal` は、選択範囲またはページ全体の幅別style提案をレビューし、1回のundo対象として適用する（未接続時は入口なし。AI/provider/auth/storageはホスト責務）。`initialTarget`、任意の日英切替、原文ページの「サブは確認してから公開」、許可ブロック、trusted host 固有の設定 UI、任意の安全なform完了ページ候補を扱う。原文の保存 locale が翻訳用 mapping と異なる場合も、ページ一覧の原文 locale を使って開き直せる。原文 snapshot の任意な英語公開状態と、安全な明示更新・再試行も本文 version と独立して扱う。Kamakura の日英一覧は Studio BFF の `localization/editor/site`、English キャンバスは `editor/pages/:pageId/snapshot` から読み、保存はサイト側の正本 overlay へ戻す（[編集・公開契約](docs/editor-contract.md)、[UI設計](docs/editor-ui-design.md)、[多言語 editor 契約](docs/localization-editor.md)、[ManagedEmbed 契約](docs/managed-embed-contract.md)）。React / React DOM が必要 |
| `@niho/web/projects` | 1 Project = 1 Site の検証、純粋操作、atomic CAS契約。React不要 |
| `@niho/web/project-manager` | 認証済みホストadapterへ接続する `ProjectManager`。React / React DOM が必要 |
| `@niho/web/project-directory` | 管理フォームと独立した日常の `ProjectDirectory`。内部またはhost shellの名前・ドメイン検索、OG画像／頭文字カード、更新順の一覧表、Dashboard / Editorメニュー |
| `@niho/web/project-dashboard` | 選択した1 Project・1 Siteに固定した共通Studio shellの `ProjectDashboard`。上部のタブ（ホーム・サイト機能・アナリティクス）で画面全体を切り替え、公開状況・変更履歴表・メンバー表・アクセス解析・設定を表示 |
| `@niho/web/site-language-settings` | サイト設定に置く日英2言語のシンプルな選択画面 `SiteLanguageSettings`。原文言語からサブを明示し、初回サブ公開後は固定表示にする。Studio は既存サイトの明示した原文言語を設定画面に表示し、CSP 対応の CSS を自身の束に含める。保存・認可・版の競合確認はホストが行う（[デモ](examples/site-language-settings-demo.mjs)） |
| `@niho/web/project-read-model` | summary / dashboardの型・読み取りadapter・runtime parser。React不要 |
| `@niho/web/collection-workspace` | コレクション（CMS）の一覧と項目の編集の `CollectionWorkspace`。ホストの adapter で読み書き・自動保存・公開・予約、本文と独立した任意の英語公開状態の更新／安全な再試行、同じ画面で切り替える任意の原文／翻訳タブと訳文タブへの直接リンク（[接続方法](docs/collection-contract.md)） |
| `@niho/web/localization-workspace` | 要対応から始まる翻訳一覧・対象外の理由別表示・自動翻訳の設定・任意の版付き用語集の確認・初回公開の内訳確認を含む `LocalizationWorkspace` と、CMS 項目に埋め込む `LocalizationItemWorkspace`。一覧の含む内容と関連する訳文への導線、ホストの編集先（Kamakura の共通ページは English キャンバス、CMS は同じ項目の English タブ）、CMS 詳細ページの英語テンプレートへのリンク、保存済みの未公開原文、訳文の自動保存・出どころ別の未確認表示・確認済み・翻訳案・プレビューを共通化する（[接続方法](docs/localization-workspace-contract.md)）。型と parser は `@niho/web/localization-workspace-model` |
| `@niho/web/collection-model` | コレクションの定義・項目の型、adapter の応答の runtime parser、公開前の値の検証、本文の HTML の無害化。React不要 |
| `@niho/web/project-editor` | 既存 `EditorAdapter` をProjectの唯一のSiteへ限定するwrapper。サイト単位ブレークポイントの read / save も site ID と応答を再検証する |
| `@niho/web/pages` | ページのパス検証・ツリー・内部リンク影響、公開メタ情報（title / description / OG画像 / robots / canonical）の解決と `<head>` 出力。React不要 |
| `@niho/web/site-analytics` | GA4 / Search Console の接続状態・所有確認・変更計画の型と境界検証。React不要 |
| `@niho/web/site-apps` | サイト設定の `SiteApps`。計測タグ・所有権確認・レポート接続を分け、変更確認・再試行・解除を提供（[接続方法](docs/site-apps.md)） |
| `@niho/web/ui-tokens` | Studio と各画面が共有する配色・角丸・文字のトークン（`uiTokensCss`・`uiColor`）。各画面の CSS は先頭にこれを持ち、ホストは `--nw-*` を上書きできる。React不要（[見た目と実装の契約](docs/editor-ui-design.md#見た目と実装の契約)） |
| `@niho/web/assets` | 素材参照の列挙・解決済み素材 map の検証、素材ライブラリ adapter の型と応答検証。React不要 |
| `@niho/web/history` | 文書の差分（`diffDocuments`）、版履歴の項目の検証、端末内の緊急復元ストア（ページ・サイトごとの共通部品）。React不要 |
| `@niho/web/analytics` | GA4 / Search Console を分けて示す読取専用画面、型付きadapter、応答検証 |
| `@niho/web/analytics-data` | サーバーで使う分析DTO・adapterの型と応答検証。React不要。画面と同じパーサーを使用 |
| `@niho/web/localization` | 明示的な日英設定、安定IDの翻訳単位、自動訳の更新・人の訳の保護、候補・手編集・確認、共通構造からの文書生成。React不要 |
| `@niho/web/localization-release` | 言語単位の不変snapshot、全ページの訳・確認必須ページ・共通部分・用語集の公開条件、route・内部リンク・SEO、prepare/apply/rollback検証。React不要 |

React は optional peer dependency です。API サーバーなど React を入れない利用先では `import { parsePageDocument } from '@niho/web/core'` を使います。root と `/react` は React runtime を import します。

多言語coreは共通構造を保ったまま、明示的な `sourceLocale` とlocale mapping、安定IDの翻訳単位、自動翻訳結果の反映と人の訳の保護、手編集、確認、target文書生成を扱います。翻訳provider・認可・永続化・公開snapshotはホスト責務です。詳細は [多言語core契約](docs/localization-contract.md) を参照してください。

言語別公開は `@niho/web/localization-release` で、ページ・共通部品・ナビ・スタイル・外部resource hash・route・SEOを1つの完成版として検証します。token、認可、永続化、CAS、CDNと実サイト描画はhostが所有します。詳細は [言語別公開・ルート・SEO契約](docs/localization-release.md) を参照してください。

## 文書の形

```ts
import { parsePageDocument, type PageDocument } from '@niho/web';

const document: PageDocument = {
  schemaVersion: 1,
  siteId: 'demo',
  pageId: 'home',
  locale: 'ja-JP',
  revision: 1,
  title: '海のそばで過ごす',
  tokens: {
    ink: { type: 'color', value: '#172d25' },
    space: { type: 'length', value: '1.5rem' },
  },
  body: [{
    type: 'element', id: 'intro', tag: 'section',
    style: {
      base: { color: { token: 'ink' }, padding: { token: 'space' } },
      responsive: [{ minWidth: 768, declarations: { maxWidth: '64rem' } }],
    },
    children: [{
      type: 'element', id: 'heading', tag: 'h1',
      children: [{ type: 'text', text: '海のそばで過ごす' }],
    }],
  }],
};

// API・ファイル・ストレージから受け取る値は unknown として検証する。
const checked = parsePageDocument(document);
```

`validateDocument(input, blocks?)` は `parsePageDocument` と同じ検証入口です。検証済みの新しい文書を返し、不正入力には例外を返します。サーバーの JSON 受け取り処理でも利用できます。

[公開サンプル](examples/page.json)にはリンク、トークン、Flex、レスポンシブ指定を含めています。`schemaVersion` は文書契約の版、`revision` はページ内容の更新番号です。同じ site / page / locale / revision の内容は不変として扱い、内容を変えたら revision を増やします。

## Next.js の React renderer

```tsx
// app/page.tsx（Server Component）
import { PageRenderer } from '@niho/web';
import document from './page-document.json';

export default function Page() {
  return <PageRenderer document={document} />;
}
```

`PageRenderer` は `useEffect` やクライアントでの JSON fetch を必要としません。scoped `<style>` と本文の `<div lang="…">` を返します。`title` は文書の情報として保持し、Next.js の `metadata` / Astro の `<head>` へ設定するのは利用側の責務です。読み込む文書を site / page / locale から選ぶ処理も利用側に置きます。VideoWithButton・Loop Box・Lottie・Facebook / X / Instagram投稿を公開ページで動かす場合は、client側で `initializeSitePresentation(document)` を1回呼び、再初期化前にcleanupします。LottieはSSRで静的fallbackだけを返し、このruntimeを呼ばない限り外部playerを読み込みません。runtimeも`prefers-reduced-motion: reduce`ではplayerを読み込まず、設定変更に追従します。Facebook / X / Instagram投稿はSSRと編集canvasで投稿リンクと静的状態だけを返し、runtimeが表示したボタンを訪問者が押した後にだけ隔離iframeを生成します。Xを有効にするホストは、親documentとは別originの固定HTTPS HTML endpointをtrusted codeから`initializeSitePresentation(document, { xPostFrameUrl })`へ渡します。値はpage JSON・data属性から読まず、欠落・不正・同一originならX buttonを隠したままにします。投稿が非公開・削除済みの場合やブラウザが埋め込みを拒否した場合もリンクは残ります。Loop Boxはruntimeが無くても元内容を1組SSRし、runtime起動時だけ画面幅を満たす非アクセシブルな複製を作って無限スクロールします。文書が保存するのは検証済みの固定構造と閉じたdescriptorだけで、イベントコードは保存しません。フォームはアクセシブルなlabel・required・選択肢をSSRしますが、既定では送信しません。回答送信、ファイル保存、完了画面、検証・CSRF・認可はホストがtrusted codeで接続し、action URLやイベントコードをページJSONへ保存しません（[標準埋め込み契約](docs/document-contract.md#標準埋め込み)、[フォーム契約](docs/document-contract.md#フォーム)）。

X endpointにはcanonical投稿URLだけが`url` query parameterで渡り、親CSPはその固定endpointだけを`frame-src`で許可します。`platform.twitter.com`向けのscript/frame許可はendpoint側のCSPが所有し、親へは追加しません。鎌倉Studio hostは固定endpointを`PageEditor`へ接続します。Instagramは従来どおりopaque `srcdoc`で動き、親CSPに公式script/frame許可が必要です。詳細は[標準埋め込み契約](docs/document-contract.md#標準埋め込み)を参照してください。

## 登録済み動的ブロック

文書に保存するのは名前と公開 props だけです。利用側のコードに registry と許可する props を定義します。すべてのノードを検証した後にブロックを描画します。未知ブロック、未知 props、型違い、必須値不足はエラーになります。

```tsx
import { PageRenderer, type BlockRegistry } from '@niho/web/react';

const blocks = {
  PublicNotice: {
    props: {
      heading: { type: 'string', required: true, maxLength: 80 },
      href: { type: 'url', required: true },
      tone: { type: 'enum', values: ['info', 'warning'] },
    },
    component: ({ heading, href }) => (
      <aside><a href={String(href)}>{heading}</a></aside>
    ),
  },
} satisfies BlockRegistry;

// body の flow content 内へ追加するノード:
const notice = {
  type: 'component', id: 'notice', block: 'PublicNotice',
  props: { heading: 'お知らせ', href: '/news', tone: 'info' },
};

// PageRenderer document の body に notice を含める。
// <PageRenderer document={document} blocks={blocks} />
```

ブロックの内側の見た目（カードの見出し・画像の収まり・予約ボタンの色など）をスタッフに整えさせる場合は、registry の `slots` で変更できる領域とプロパティを宣言し、ブロックが該当要素へ `data-nw-slot` を付けます。値の正本は props とホストのデータのままです。詳細は [業務ブロックの表示領域契約](docs/block-slot-contract.md) を参照してください。

props 契約は `string` / `url` / `number` / `boolean` / `enum` です。入れ子のオブジェクト、配列、関数、React の特殊 props、イベント props を文書から渡せません。URL に使う prop には `url` を指定します。既存の型付きコンポーネントへ接続するときは registry の小さな adapter で props を渡してください。

registry は利用側がレビューした信頼できるコードです。文書からモジュールや JS を取得しません。ブロックは同期描画できるよう、必要な公開データを利用側で取得してから接続します。価格や在庫を表示する場合も、計算・認可・取得元の判断は利用側に置きます。Client Component の接続・hydration は各フレームワークの規則に従います。

## 共通部品

スタッフが組んだ要素の部分木をサイトごとの部品ライブラリへ登録し、文書から `instance` ノードで参照できます。ヘッダー・フッター・セクション見出しなどを複数の文書で共有し、部品を1回更新すると、使っている文書のプレビューと公開差分に反映されます。部品は公開時に通常の element へ展開します。

```ts
import { parseComponentLibrary, parsePageDocument, resolvePageDocument } from '@niho/web/core';

// 下書きの検証。部品ライブラリを渡したときだけ instance を受け付ける。
const library = parseComponentLibrary(rawLibrary, blocks);
const draft = parsePageDocument(rawDraft, blocks, { components: library });

// 公開時は展開済みの文書を、新しい revision の公開版として保存する。
const { document: resolved } = resolvePageDocument(draft, library, blocks);
const published = { ...resolved, revision: nextRevision };
```

`PageRenderer`・`renderPageToHtml`・CSS 生成は展開済みの文書だけを描画し、未展開の instance は拒否します。公開版の形は従来の v1 文書のままなので、公開サイトの renderer を更新しなくても導入できます。詳細は [共通部品契約](docs/component-contract.md) を参照してください。`PageEditor` では、adapter に `components` を渡すと「部品」パネル・インスタンスの設定・部品の編集を使えます（[エディター契約の「共通部品」](docs/editor-contract.md#共通部品)）。

## Astro の静的 / サーバー HTML

```astro
---
import { renderPageToHtml } from '@niho/web/server';
import document from '../content/page-document.json';

const html = renderPageToHtml(document);
---
<html lang={document.locale}>
  <head><title>{document.title}</title></head>
  <body><Fragment set:html={html} /></body>
</html>
```

`set:html` へ渡すのは `renderPageToHtml` の戻り値だけにしてください。JSON 内の本文文字列は React が escape します。この入口は静的 HTML 用です。操作を伴うブロックを hydrate する場合は Astro の React integration を使い、registry を定義したアプリ側 React wrapper を island として配置します。

## 検証と対応範囲

- 未知フィールド、schema の版違い、重複 ID、画像の `alt` 不足、代表的な不正 HTML の入れ子を拒否します。
- アイコンは閉じた名前カタログだけを保存し、任意 SVG/HTML を受け付けません。動画は HTTPS / root-relative URL または asset 参照の一方を持つか、編集中はソース未設定にでき、アクセシブル名と限定した media 属性を検証します。asset URL は文書へ保存しません。既存embedはMap / YouTube / Vimeo / Lottie / Facebook / X / Instagramだけをprovider固有URLへ正規化します。Blankは文書に短いkeyだけを保存し、trusted hostの`createBlankEmbedRegistry`が固定HTTPS URLと限定sandboxへ解決します。いずれも任意iframe HTML・src・sandbox・JavaScriptを文書から受け付けません。
- HTML タグ・属性・CSS プロパティは許可リスト方式です。任意 HTML / CSS / selector / JavaScript / event handler は扱いません。
- URL は資格情報のない HTTPS、`/` から始まる同一サイト内パス、`#id` に限定します。HTTP、protocol relative、data、javascript、制御文字を含む値を拒否します。
- 色・フォント・寸法・余白・Flex・Grid・位置・画像の収まり等を扱います。名前付きの文字スタイル（`textStyles`）と表示名付きの token で見た目を共通化できます。任意 CSS 関数や `url()` は許可しません。背景画像は素材参照だけを指定でき、`url()` はホストが解決した安全な URL から描画時に生成します。数値の寸法は px、line-height 等の数値プロパティは単位なしです。
- レスポンシブ指定は 320–3840px の `minWidth` を昇順に最大 12 個。DOM ノードは最大 5,000、深さは最大 48 段、本文テキスト合計は最大 1,000,000 文字です。

エラーは `DocumentValidationError` で、`path` に対象位置が入ります。公開 API は描画・CSS 生成時にも入力を検証します。詳細と制約は [文書・描画契約](docs/document-contract.md) を参照してください。

## 開発

Basicの埋め込み群はBlankを先頭に置き、続けてMap / YouTube / Vimeo / Lottie / Facebook / X / Instagramを表示します。registry未接続時はBlankのカードと詳細selectを無効化し、中心の追加経路でも配置を拒否します。
鎌倉サイトでは公開ホストとStudioの両方に同じ`public-map` keyを登録し、OpenStreetMapの固定埋め込み先だけを双方のCSPに許可します。編集キャンバスでは外部通信せず、プレビューと公開描画で承認済みkeyを解決します。

スタッフ向けエディターは `@niho/web/editor` の `PageEditor` を使います。左の追加パネルは Basic / Parts / Sections に分かれ、Basic のセクション・ボックス・画像・テキスト・組み込みアイコン・リッチテキスト・native動画、埋め込み群のBlank / Map / YouTube / Vimeo / Lottie / Facebook / X / Instagram、Form1/2/3とInput・Textarea・Select・Radio・Confirm・Checkbox・File・Submit・Search・Passwordに加えて、編集可能なボタン・カード・見出しセット・リストと、ヘッダー・ヒーロー・特徴グリッド・CTA・FAQ・フッターをクリックまたはドラッグで配置できます。フォーム名、項目名、必須、入力型、placeholder、選択肢、checkbox label、file accept、submit captionは右インスペクタで編集できます。動画は直接URLまたは素材ライブラリのready MP4を選び、配信URLを文書へ保存しません。標準埋め込みはprovider固定のままURLとアクセシブルなタイトルを編集し、未設定なら公開出力から省きます。`npm run demo` では追加パネルから X / Instagram カードを配置し、URL保存、編集時の静的表示、プレビューでの明示読込を確認できます。ページ・レイヤーパネル、中央キャンバスでの直接文字編集とドラッグ配置、右インスペクタ（編集段と表示段の要約、幅・高さ、マージン、パディング、方向、ギャップ、9点＋横・縦の配置、外観、位置。`flex` 比率と高さの `dvh` を含む）、下書き保存、楽観ロック、公開/rollbackの対象ドメインと差分確認も提供します。[ホスト接続・編集・公開の契約](docs/editor-contract.md)と `npm run demo` のインメモリ動作例を参照してください。ホストが所有する表示部品（カレンダー・地図・カルーセル・一覧など）をキャンバスの同じ iframe に公開と同じ見た目で出すには、`PageEditor` の `previewComponent` に表示中の文書・幅・表示モード・従来の描画を受けるコンポーネントを渡します（[ホストの表示部品を同じ iframe へ差し込む](docs/editor-contract.md#ホストの表示部品を同じ-iframe-へ差し込む)、`npm run demo:host-preview`）。

Studioへの新しいサイト接続と、独自挿入・motion・block・共通部品・画像・CAS保存・SSRを持つ第三サイト `atelier` の動作例は[ビルダー接続ガイド](docs/builder-integration-guide.md)を参照してください。`npm run demo:builder` で `127.0.0.1` 限定のdemoを起動できます。

フォームの完了ページはoptionalな`EditorAdapter.listFormCompletionPages`を実装したときだけ、同じsite/localeの公開済み通常ページから選べます。保存するのはページIDだけで、URL・action・method・イベントコードは保存せず、公開rendererは`method="dialog"`のままです。送信成功後はtrusted hostが`resolveFormCompletionPath`へ検証済み文書と現在の候補一覧を渡し、削除・非公開化・未公開化・危険なpathを再検証してから移動します。送信、CSRF、永続化、失敗時の入力保持、navigationはホスト責務です。

同じ論理ページの日英編集はoptionalな`EditorAdapter.localization`で追加できます。原文言語を明示し、訳文の実キャンバス編集、候補比較・採用・確認、サイト全体の翻訳job状態、サーバー側でも使える共通構造検証を提供します。初回のサイト選択前と取得中は読み込み中として操作を止め、明示的な取得失敗だけを再試行可能なエラーとして表示します。[多言語エディターのホスト接続](docs/localization-editor.md)と`npm run demo:localization`を参照してください。

ページ一覧（検索・フォルダ・テンプレートと共通枠の区別）、ページの作成・複製・URL変更・公開切替の影響確認、ページ別とサイト共通の公開情報は [ページ管理・公開情報の契約](docs/page-contract.md) を参照してください。公開ページの `<head>` は `@niho/web/pages` の `resolvePageMetadata` で、編集画面と同じ値から作ります。
画像とnative動画は URL を直接書く代わりに、サイト別の素材ライブラリの素材ID（`{ provider, id }`）で参照できます。`PageEditor` に `assets` adapter を渡すと、素材のアップロード・検索・代替テキスト編集・配置・置き換え・使用中素材の削除防止を使えます。サイトのアップロード素材、NIHO の公開許可済み CMS 画像、ライセンス確認済みストックを出所ごとに分けて、同じパネルから選べます。公開時の URL 解決は `PageRenderer` / `renderPageToHtml` の `assets` で行います。[素材ライブラリ契約](docs/asset-contract.md)を参照してください。

保存状態の表示、任意の自動保存、端末内の緊急復元、409競合の比較、版履歴と復元、公開前レビューは [保存・作業復元・版履歴の契約](docs/save-history-contract.md) を参照してください。

プロジェクト管理は `@niho/web/projects` と `@niho/web/project-manager` を使います。1プロジェクトは唯一のサイトと複数メンバーを持ち、同じメンバーは別プロジェクトにも参加できます。ユーザーIDは数字開始を含む最大128文字のopaque値として扱い、既存Projectの消失やSite差替えを拒否します。権限・ロール・招待・認証・ID採番・本番DB/APIは含まず、認証済みホストのatomic CAS adapterが必要です。[共通プロジェクト契約](docs/project-contract.md)を参照してください。

サイト接続の状態・変更計画は `@niho/web/site-analytics` の `SiteAnalyticsConnectionAdapter` を使います。GA4測定IDとレポート用プロパティID、Search Consoleの所有確認とAPI読取権限は別々の状態です。認証・Google API・保存・サイト公開設定はホスト側の責務です。[サイト分析・接続契約](docs/site-analytics-contract.md)を参照してください。

```sh
npm run demo:projects
```

この動作例は架空メンバーを持つ2プロジェクトの日常一覧、選択した1サイトのDashboard、既存ProjectManagerと `PageEditor` の導線を表示します。表示メタデータは `Project` 正本と分けて読み取りadapterから取得し、未接続の解析・未取得の数値・権限喪失・遅延応答を区別します。[一覧・Dashboardのホスト接続契約](docs/project-views-contract.md)を参照してください。日時・画像・解析値も合成値で、実アカウント、実サイト、本番永続化には接続しません。

サイト分析は `@niho/web/analytics` の `SiteAnalytics` を認証済みホストの読取adapterへ接続します。[サイト分析の契約](docs/analytics-contract.md)と `npm run demo:analytics` の合成データ例を参照してください。

```sh
npm ci
npm test
npm run typecheck
npm pack --dry-run
```

Studio hostだけの静的UI・Worker buildは次で確認します（test suiteには追加しません）。

```sh
npm run studio:typecheck
npm run studio:build
```

テストは文書検証、拒否すべき URL / 属性 / CSS、レイアウト、スコープ分離、ブロック契約、React SSR と HTML helper の出力を確認します。public GitHub Actions は secrets・外部 API・非公開リポジトリに依存せず同じ確認を実行します。

## サイト共通のカラー・文字スタイル

`SiteSettings` に任意の `tokens` / `textStyles` を持たせると、サイト全ページで同じスタイルを参照できます。ページの同名定義は優先され、既存のページ JSON と `schemaVersion: 1` はそのまま使えます。

```tsx
const settings = parseSiteSettings(siteSettingsJson);
const page = parsePageDocument(pageJson, blocks, { siteStyles: settings });
<PageRenderer document={page} blocks={blocks} siteStyles={settings} />;
// Astro / SSR
renderPageToHtml(page, blocks, { siteStyles: settings });
```

`parseSiteSettings` は `@niho/web/pages`、`resolvePageStyles` / `detachRemovedSiteStyles` は `@niho/web/core` から利用できます。共通スタイルの保存は既存の `readSiteSettings` / `saveSiteSettings` に接続します。設定を省略したホストはページのスタイルだけで動作します。参照の厳格検証・scope・移行確認・削除時の原子的な切り離し・公開 snapshot の詳細は [文書契約](docs/document-contract.md#サイト共通スタイル) と [サイト設定の契約](docs/page-contract.md#サイト共通スタイルの保存と削除) を参照してください。

型・優先順位・保存契約・多言語と言語別公開・ホストの実装手順をまとめた正は [サイト共通スタイルの契約](docs/site-styles-contract.md) です。React 不要の最小例は `npm run demo:site-styles`（`examples/site-styles-demo.mjs`・`examples/site-settings.json`・`examples/site-styled-page.json`）で、2 ページが同じサイト共通カラーを参照し、1 回の変更で両方の CSS が変わること、ページ固有の上書きが残ること、削除時の切り離しを標準出力で確認できます。
