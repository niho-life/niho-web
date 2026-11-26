# 共通エディターのホスト契約

`@niho/web/editor` の `PageEditor` は認証済みスタッフ向けの React client component です。ホストから認証済み adapter を渡します。戻る操作や環境表示は `toolbarStart` に渡せます。操作の入口は[画面ガイド](editor-ui-guide.md)を参照してください。

## React不要の文書編集操作

`@niho/web/editor-model` は React を読み込まず、文書編集と検証の関数を提供します。Studio GUI は内部の `EditorOperation` を使い、CLI/APIなどの外部クライアントは `editDocumentById` と `EditorOperationById` を使います。外部操作は配列位置の `NodePath` で要素を指定せず、PageDocument内で安定した `nodeId` を指定します。テキストノードはIDを持たないため、IDを持つ親要素の `parentId` と、その子配列からの `childPath` で指定します。`parentId: null` はページ本文を基準にします。

`editDocument` は変更したノードとその祖先だけをコピーし、それ以外のノード・配列を前の文書と共有します。編集前後の `PageDocument` と共有部分は不変値として扱い、呼び出し側で直接変更しないでください。編集操作の結果はコピーを作らない `validatePageDocument` で検証します。外部入力の読み込み・正規化には、独立した正規化済み文書を返す `parsePageDocument` を使います。保存・公開時のホスト側の全文検証も引き続き必要です。

```ts
import { editDocumentById } from '@niho/web/editor-model';

const next = editDocumentById(document, {
  type: 'style', nodeId: 'hero', breakpoint: 'base',
  property: 'backgroundColor', value: '#e8f0df'
});
```

この関数はGUIと同じロック・部品・サイトスタイル・文書検証を適用します。CLIは文書を読み、操作またはJSONの直接編集をローカルで検証してから、ホストの既存のexpectedVersion付き保存契約へ渡します。認証、保存先、版の競合、公開計画と復元はホスト/APIが引き続き所有します。この入口はReact UIやStudio画面を起動しません。

## ホストへの接続

```tsx
'use client';
import { PageEditor, type EditorAdapter, type EditorBlockRegistry } from '@niho/web/editor';

// ここではホストが所有する認証済みクライアントを渡す。
export function StaffPageEditor({ adapter, blocks }: {
  adapter: EditorAdapter;
  blocks: EditorBlockRegistry;
}) {
  return <PageEditor adapter={adapter} blocks={blocks} />;
}
```

React 18.3 または 19 と、同じ版の React DOM を利用側で用意してください。`adapter` と `blocks` は module scope / `useMemo` 等で参照を安定させます。ホストの通常の再描画で作り直すと一覧・文書の再読込が起こるため、同じ編集セッション内では差し替えません。Next.js では adapter や registry の関数を Server Component から props で serialize せず、ホストの Client Component 内で組み立てます。

| adapter メソッド | 役割 |
| --- | --- |
| `listSites(signal)` | 編集権限のあるサイトと、許可済みの HTTPS 公開 origin 一覧 |
| `listPages(siteId, signal)` | 指定サイトで編集権限のあるページ・locale の一覧 |
| `readDocument(target, signal)` | 文書、opaque な `version`、データ連動値のロック、戻せる公開版。対応 host は `cmsBindings` も返す |
| `prefetchDocument(target, signal)`（任意） | ページ行の hover / focus で現在版を先読み。`readDocument` と同じ認可・版検証を行い、画面状態は変更しない |
| `saveDraft({ target, document, expectedVersion, cmsBindings? }, signal)` | 楽観ロック付き下書き保存。対応 host は page sidecar も同じ CAS で保存。成功時は新しい version とサーバー採番の revision、競合時は `status: 'conflict'` |
| `cmsBindings.read(target, signal)` / `cmsBindings.preview(request, signal)`（任意） | CMS schema とプレビュー可能な項目を読み、短命の一回限り認可で下書き page と実項目を合成して表示 |
| `applyOperations({ target, baseVersion, operationId, operations, ...dependencyVersions }, signal)`（任意） | GUIの未送信 `EditorOperationById` を `pages.apply` へ送信。鎌倉Studioの日本語通常編集で接続済み。未接続hostは従来の `saveDraft` を使う（[操作単位の保存契約](editing-api-contract.md#操作カタログ)） |
| `prepareRelease(request, signal)` | 公開 / rollback の正確な対象ドメイン、公開内容との差分、確認 token を発行 |
| `release(plan, signal)` | 確認済みの内容を公開 / rollback。成功時は最新 snapshot、競合時は `status: 'conflict'` |
| `prepareReleaseSet(items, signal)` / `releaseSet(plan, signal)` / `releaseSetStatus(operationId, signal)`（任意） | 同じサイトの複数ページを一つの変更セットとして公開。3メソッドすべてを実装したホストだけ複数選択UIを表示 |
| `englishPublication`（任意） | 原文と独立した英語版公開状態の明示更新と、ホストが許した失敗だけの再試行 |
| `preparePageChange` / `applyPageChange`（任意） | ページの作成・複製・名前とURLの変更・公開切替。影響の確認と一回限りの確認 token。[ページ管理の契約](page-contract.md) |
| `site.styles.read/save/release-*`（任意） | 共通スタイルのdraft/public版、楽観ロック、影響確認と全公開ページへの一括反映（[サイト共通スタイルの契約](site-styles-contract.md)）。`readSiteSettings` / `saveSiteSettings` は公開情報用 |
| `responsiveProposal.propose(request, signal)`（任意） | 現在文書のレスポンシブstyle提案。AI/provider/auth/storage/利用量はホスト所有。省略時は操作を表示しない |
| `listRevisions` / `readRevision` / `createSnapshot`（任意） | 版履歴の一覧・読み取り専用の表示・名前付きスナップショット。履歴項目は人/AIと確認済み委任元の表示名、操作種別、要素IDと変更fieldを表示し、変更前後の値は出しません。[保存・履歴の契約](save-history-contract.md) |

共通HTTP APIを使うホストは `createEditingApiHistoryAdapter(client)` の返す `listRevisions` / `readRevision` を既存の `PageEditor` adapterへ追加できます。ページ履歴のAPI権限 `pages.history.read` は、通常文書の `pages.read` と別にホストで認可してください。

`EditorAdapter.cmsBindings` を提供する host では、CMS パネルから list のテンプレート、件数・絞り込み・並べ替え、field と text / image / link / 許可属性の対応、slug を使う detail page を設定できます。読み込み・保存・削除は host の API に委ね、bindings は `PageDocument` と別に page version と同じ CAS で保存します。リストは最大25件で、detail slug と既存 route の衝突を公開計画で拒否し、計画後に route table が変わった場合は適用時の競合にしてください。実データ preview は actor・page・文書版・CMS item revision に固定した短命 token を使い、公開 CDN や公開 snapshot へ下書きを混ぜません。bindings 変更は通常の手動保存・自動保存・端末復元の dirty 状態に含まれます。

`listPages` の各ページに任意で `path`・`kind`（page / template / shared）・`visibility`・`published` を返すと、左のページパネルにフォルダ（`template` は「テンプレート」の見出しの下）と公開状態の点（緑＝公開中、灰＝未公開、輪郭＝非公開）を表示します。`publication` があれば、その label と description を点のツールチップと読み上げに使います。任意メソッドを実装しないホストでは、ページ操作とサイト設定の保存を表示しません。

3つの公開変更セットメソッドをすべて実装したホストでは、ページ一覧に複数選択を出します。選択した各ページの保存済み公開差分を単一ページの `prepareRelease` で確認し、差分があるページだけを一つの変更セットへ渡します。差分がある対象・差分・件数を確認してから適用し、ページ単位の `released` / `conflict` / `pending` と操作全体の状態を表示します。通信が途切れた場合は同じ計画の再試行または operation ID の状態照会を使います。未保存の編集中ページは保存してから開始し、変更セットAPIを提供しないホストでは複数選択を表示しません。

### 原文ページに対応する英語版の公開状態

原文の `EditorSnapshot` と原文公開成功時の `snapshot` は、任意で `englishPublication: { state, retryable, updatedAt? }` を返せます。状態は `initial-release-required` / `queued` / `translating` / `review-required` / `publishing` / `published` / `withdrawn` / `retryable-failure` / `superseded` の閉じた値です。`updatedAt` はタイムゾーン付きの有効な ISO timestamp、`retryable` は boolean とし、未知の state・余計な field・不正日時は拒否します。訳文 snapshot に原文の値を補完しません。省略時は何も表示せず、`superseded` もバナーに表示しません。

`EditorAdapter.englishPublication` は optional capability です。`refresh(target, signal)` は状態だけを読み、`retry(target, signal)` は `{ status: "accepted", englishPublication }` または `{ status: "conflict" }` を返します。画面は `retryable: true` かつ `initial-release-required` 以外でだけ再試行を出します。明示更新と再試行成功は状態だけを差し替え、未保存文書、undo/redo、文書 version を変えません。別ページへ移った後の遅い応答は破棄し、accepted を published と推測しません。日本語の公開成功案内と英語版の状態は別に扱います。

Kamakura Studio は同一 origin の `POST /api/projects/project-kamakura/sites/kamakura/editor/:pageId/english-publication-retry` に空の `{}` だけを送り、署名済み BFF が `/internal/studio/web-content/:pageId/english-publication-retry` へ中継します。BFF は固定 project/site、owner/editor membership、page ID、POST、query なし、空の要求本文を検査し、上流の accepted 応答も既知 field だけに再構成します。raw upstream error、内部情報、原稿はブラウザへ返しません。見た目編集の凍結とこの再試行は独立です。

target は `siteId/pageId/locale` の組です。文書の組と一致しない読込結果は受け入れません。ホストは各呼出しで現在のセッションの認証・サイト/ページ権限を確認し、文書を `@niho/web/core` で検証してください。UI の選択値やロック表示をサーバーの認可の代わりにしません。

翻訳一覧などからページを直接開く場合、`PageEditor` に `initialTarget={{ siteId, pageId, locale }}` を渡します。マウント時だけ使い、サイトとページが一覧にあるときは指定した言語の `readDocument` を呼びます。ページが無ければ通常の先頭ページを開きます。指定の妥当性と権限はホストの `readDocument` でも確認してください。

## 読み取り専用の原文

既存の業務原稿を仮想ページとして確認する場合、`readDocument`の現在snapshotに`readOnly`を返せます。省略した既存hostは従来どおり編集可能です。

```ts
{
  document,
  version,
  readOnly: {
    reason: "この公開テキストは業務編集画面が正本です。",
    editUrl: "/staff/business/public-text/experience",
    editLabel: "業務原稿を編集"
  }
}
```

`reason`は必須の1〜500文字、`editLabel`は任意の1〜80文字です。`editUrl`はホストが決めた1〜2,048文字のNIHO-app内root-relative routeまたは資格情報を含まないHTTPS URLだけを許可し、`http:`、`javascript:`、`data:`、protocol-relative、fragment-only、制御文字を拒否します。URLを表示文言から組み立てません。外部HTTPSの場合は新しいtabを`noopener noreferrer`で開きます。

これはdocument-levelの表示ポリシーで、認可機構ではありません。ホストは`saveDraft`、公開、page操作等の各書込APIで現在の正本ポリシーを再読込し、read-only targetへの直接要求も403等で拒否してください。原文snapshotのポリシーを派生言語へコピーせず、その派生snapshotに`readOnly`が無ければ編集できます。別の共通部品master編集、site設定、素材libraryの権限もこの値から推測しません。

`AbortSignal` は読込の切替と unmount 時に abort します。公開処理は signal が abort されてもサーバーで成立する可能性があるため、ホスト側で結果の照会と重複実行の防止を実装します。例外の生メッセージ・token・秘密を UI に表示しません。

### ホスト所有のレスポンシブ提案

`EditorAdapter.responsiveProposal` は任意です。省略時はボタン、無効なAI表示、接続案内を含めて入口を出しません。実装時もniho-webはAI/providerへ直接接続せず、認証・認可・provider選択・prompt・利用量・ログ・保存はホストが所有します。文書schema、`saveDraft`、公開APIは変わりません。

`propose` には次を渡します。

```ts
{
  target: { siteId, pageId, locale },
  document,                         // 現在の検証済みPageDocument
  fingerprint,                      // JSON直列化した現在文書との一致確認用
  scope: { type: 'page' } | { type: 'node', nodeId },
  breakpoints: [768, 1024]          // 利用者が選んだ、設定済みminWidthだけ
}
```

応答は `{ fingerprint, changes }` だけです。`changes` は最大40件で、各項目は `{ nodeId, breakpoint, property, value }` だけを持ちます。`value: null` はその幅の直接指定を外します。許すpropertyは既存style操作で扱うレイアウト・余白・サイズ（寸法、margin/padding、Flex/Grid、位置、overflow、objectFit、文字サイズ・行高・字間）だけです。色、内容、構造、meta、素材、リンク、状態style、演出は提案から変更できません。

エディターはhost応答を信頼しません。fingerprint、40件上限、要求した幅、選択subtree、node ID、`(nodeId, breakpoint, property)`重複、閉じたproperty、値を確認し、全変更を既存`editDocument`へ順に通します。1件でも不正なら文書へ何も適用しません。レビュー時と適用時にnode IDから現在pathを解決し直し、適用時にも文書fingerprintを再確認します。レビューには幅と各値の変更前・変更後を表示し、明示的な適用またはキャンセルだけを受けます。適用は既存履歴の1操作なので、undo 1回で全件を戻せます。

提案中は30秒でtimeoutし、キャンセル・ページ移動・対象/文書変更・unmountで`AbortSignal`をabortします。遅い応答、別文書の応答、staleなレビューは適用しません。レビュー中はlive文書を変更しません。版履歴、翻訳側、読み取り専用、ロックを含む文書、未確定のfield入力、コンポーネント本体編集中、処理中には開始できず、理由を画面に表示します。ホストも要求を受けた時点でtarget権限と文書を再検証し、UIの制限を認可の代わりにしないでください。

## 楽観ロックと編集の保持

`version` は HTTP ETag や DB の更新番号を文字列にしたもの等、ホストが管理する opaque な値です。文書内の `revision` と別に扱います。下書き保存時は `expectedVersion` と保存先の現行版を原子的に比較し、サーバーが現行 revision より大きい safe integer を採番して文書に設定し、必ず新しい version とともに返します。同じ site/page/locale/revision に異なる内容を保存しません。

成功応答は `{ status: 'saved', version: 'new-version', revision: 2 }` の形式です。送信文書の revision は編集開始時点の基準であり、採番をクライアントへ任せません。ホストは revision 以外の送信内容を変形せず保存してください。応答の revision が送信時以下・非整数・safe integer 外の場合、エディターは応答を採用せず、手元の編集と元の version を保持します。

HTTP 409 は adapter で `{ status: 'conflict' }` へ変換します。`status: 409` を持つ例外も競合として表示します。他の例外は一般的な保存失敗として扱います。どちらの場合も文書・undo/redo・元の expectedVersion を保持します。競合の自動上書きや自動 merge はしません。再読込で手元の変更を破棄する場合は、明示確認が必要です。

保存中も編集を続けられます。成功時は現行の作業コピー・undo/redo履歴・保存開始時の文書から作る保存済み基準を、返された revision に揃えます。内容と履歴の順序を保つため、保存中の追加編集は未保存のまま残り、undo/redoで保存時点に戻すと正しく保存済みになります。次の保存では新しい version と revision を送信し、サーバーがさらに新しい revision を採番します。保存処理中のページ切替や公開操作はできません。

作業コピーと履歴の revision は最新の保存先を表す基準です。編集中の内容をその revision の公開済み文書として扱わず、永続化・公開する際は保存で採番した不変の文書を使います。rollback で過去の内容を復元するときも、異なる内容へ古い revision を再利用せず、新しい revision の文書を返してください。

## 要素の名前

`EditorAdapter.discoverPageNodeNames(target, signal)` が保存先の discover で `pages.name` を確認して `true` を返したときだけ、要素名を編集できます。値の形式は[文書契約](document-contract.md#ノード)、保存の前提は[編集 HTTP API](editing-api-contract.md)を参照してください。

## 操作単位の保存

ホストが任意の `EditorAdapter.applyOperations` を実装すると、通常編集の自動保存・手動保存は全文の `saveDraft` ではなく、未送信の操作を `pages.apply` へ送ります。要求は `{ target, baseVersion, operationId, operations, componentsVersion?, presentationVersion?, stylesVersion? }` です。サイト共通スタイル機能を交渉した場合は、下書きスタイル版も `draftStylesVersion` として固定します。依存版は任意です。操作は配列位置ではなく `nodeId`、テキストでは `parentId` と `childPath` で対象を指定します。`operationId` と同一入力の組を、応答が不明なときの再送にも保管してください。認証済みhostは `gui` / `cli` / `api` の `clientKind` を認証文脈に含めてください。

エディターは最後に確定した正本 document/version と未送信操作の queue を分けて保持します。送信成功時にはホストの正規文書を次の正本にし、送信中に確定した操作をその文書へ適用し直します。保存中の編集を消したり、古い送信結果で新しい作業コピーを置き換えたりしません。

409 `version_conflict` では queue を保持して最新版を読み直し、各操作を手元で再適用します。サーバーも、前提条件付きの `style` / `text` / `attribute` / `prop` 更新だけを自動 rebase し、対象ノード・親ID・対象フィールドの旧値を確認します。サーバーでのrebaseが成功した場合は正規文書を受け取り、未送信の後続操作をその文書へ再適用します。対象ノード消失、前提不一致、構造操作などで再適用できない場合は、recovery store が設定されていれば手元の文書を端末内へ保管し、既存の比較画面へ誘導します。未設定なら現セッションの作業コピーを保持して比較画面へ誘導します。GUIは競合を確認なしで再送しません。

## フォームと埋め込み

- `EditorAdapter.listFormCompletionPages(target, signal)` は、同じ site・locale の公開済み通常ページだけを返します。保存するのはページ ID です。公開 renderer は `method="dialog"` を使い、実送信・CSRF・保存はホスト側で扱います。成功後は `resolveFormCompletionPath` に現時点の候補を渡し、削除・非公開・危険なパスを除外してから移動してください。
- Blank は `PageEditor` に渡した `blankEmbeds` の承認済みキーだけを使います。任意の公開 HTTPS URL の追加を許可する場合は `enableUrlEmbeds` を設定し、ホストの CSP で該当する `frame-src` を許可します。外部通信はプレビューで行います。詳細は[埋め込み契約](managed-embed-contract.md)を参照してください。

## 挿入カタログとモーションの拡張

`PageEditor` の `builder` に `@niho/web/builder` の `BuilderDefinition` を渡します。挿入の `create` は信頼済みホストのコードです。生成した全 element / component / instance の ID は引数の `id()` で採番してください。保存するのは通常の `PageNode` です。`builder.motions` の定義も保存時には文書の style と motion に展開します。

型と実装例は[ビルダー接続ガイド](builder-integration-guide.md)を参照してください。

## ホストの表示部品を同じ iframe へ差し込む

| prop | 内容 |
| --- | --- |
| `document` | 表示中の検証済み・展開済みの文書。編集中の訳と未保存の変更を含む。言語版は `document.locale` で、iframe の `lang` も同じ値になる |
| `width` / `breakpoint` | キャンバスの表示幅（px）と、その幅が属する段（`"base"` または段の minWidth） |
| `mode` / `readOnly` | `edit` / `preview` / `history`。プレビュー・履歴の表示と、読み取り専用の原文・訳文では `readOnly` が true |
| `baseVersion` / `historyRevision` | 未保存編集の基準版（共有部品の編集中は部品ライブラリの版、それ以外はページ下書きの版）と、履歴で選択した版 |
| `blocks` | 従来の描画が使った登録ブロック。キャンバス用 `preview` を持つブロックは `component` を置き換え済み |
| `assets` | 従来の描画が使った、ホストが解決した素材 |
| `presentation` | 従来の描画が使った native presentation。共有枠・メニューの編集中はその内容を含む。presentation を持たないサイトでは渡さない |
| `externalFramePolicy` | `PageEditor` に渡した外部枠の policy |
| `children` | 従来の描画結果。置き換えない文書ではそのまま返す |

使い方は2つです。

- **包む**: `children` をそのまま返し、その前後にホストの `<style>` / `<link rel="stylesheet">`、context provider、サイトの枠を足す。
- **描き直す**: `blocks` の見本を公開と同じ表示部品に差し替えた registry を、`SitePageRenderer`（presentation を持つサイト）または `PageRenderer` に渡して同じ文書を描き直す。両 renderer は `data-nw-owner` / `data-nw-node` / `data-nw-slot` を出すため、要素の選択・ドラッグ・直接の文字編集・表示領域の編集は従来どおり動きます。表示部品は `data-nw-slot` の付け方を見本と同じにし、`data-nw-owner` / `data-nw-node` を自分で付けないでください。

表示部品は props と自分の context から同期に描画し、`document` を直接変更しません。データ取得・権限確認・予約・送信・保存・課金などの副作用を起こさず、公開表示データは `PageEditor` の外側の provider か module scope から表示部品と同じ版で供給します。コンポーネントの参照は安定させて渡してください（module scope / `useMemo`）。再描画のたびに作り直すと部品が付け替わります。

制約と従来どおりの点:

- 受け付けるのは `ComponentType<EditorCanvasPreviewProps>`（関数・class・`memo` / `forwardRef` / `lazy`）だけです。文字列・数値・配列・プレーンオブジェクトなど React コンポーネントでない値は実行時に無視し、従来の描画を使います。任意の HTML 文字列・実行文字列・URL からの読み込みは受け取りません。
- ホスト画面の global CSS は iframe へ自動では入りません。表示部品と同じ版の CSS・font・画像を、部品の中の `<style>` / `<link rel="stylesheet">` で供給します。iframe は `srcdoc` のためホスト画面の CSP を継承し、sandbox（通常は`allow-same-origin`、source設定済み標準embedまたは外部枠を持つpresentationのときだけ`allow-scripts`を追加）は変えません。
- プレビュー・履歴の読み取り専用状態、リンク移動と form 送信の抑制、未保存編集・選択言語・履歴の整合性、描画に失敗したときの error boundary（「ブロックのプレビューを表示できません」）は従来の Canvas が扱います。
- ページの保存方式、公開権限、認証・API・予約・翻訳の判断は変わりません。ホスト固有の処理は表示部品と provider の側に置きます。

動作例は `npm run demo:host-preview`（`examples/host-preview-demo.tsx`）、検証は `test/editor-host-preview.test.mjs` と `test/host-preview-demo.test.mjs` です。

## 業務ブロックの見た目

registry の各ブロックに `styleProperties` を指定すると、そのブロックで変えられる見た目を限定できます。インスペクタは指定外の項目を表示せず（「このブロックで変更できる見た目だけを表示しています。」）、モデルも指定外のプロパティの変更を「このブロックでは変更できない見た目です。」で拒否します。テキストスタイルの適用は `'textStyle'`、状態は `'states'`、登場は `'appear'`、幅別の非表示は `'hidden'` を含めたときだけ許可します。省略時はすべての見た目を変更できます。スタイル操作から props は変わりません。

```tsx
const blocks = {
  PublicNotice: {
    props: { heading: { type: 'string', required: true } },
    styleProperties: ['marginTop', 'marginBottom', 'backgroundColor', 'textStyle'],
    component: ({ heading }) => <aside>{heading}</aside>,
  },
} satisfies EditorBlockRegistry;
```

### 表示領域（slots）

- **反映**: 領域の操作は `slotStyle` として1回の履歴にまとめ、モデルでも許可外のプロパティを拒否します。値（料金・在庫・予約先など）を入力する欄はありません。
- **プレビュー用の描画**: registry の各ブロックに `preview` を渡すと、キャンバスと共通部品の縮小表示ではそれで描画します。副作用（予約・決済・データ更新）を起こさず、実データに近い見本を複数件表示してください。公開用の `PageRenderer` は引き続き `component` を使います。

キャンバス用の詳細設定 UI は registry の `settings` へ信頼済み React component を渡します。`insertableBlocks` を空配列にすると、新規追加を隠しつつ既存の登録ブロックは編集できます。

`presentation.hostViews` に同じブロックの表示例があっても、編集中の props と完全一致する view が無い場合は、そのブロックだけ登録済みの React 見本へ戻します。見本も無い場合は静的な空の枠を表示し、前後のページ要素は描画し続けます。公開 SSR は従来どおり一致する host view を要求して失敗させ、公開前の不整合を隠しません。

iframe は通常scriptsを許可しないsandboxとして表示し、公開ページのCSS・fixed要素が編集UIへ重ならないようにします。source設定済みの標準embedまたはpresentation external frameを描く場合だけ、内側frameのsandbox継承に必要な`allow-scripts`を外側へ追加します。registry は依然として信頼できるホストコードです。React の effect や親 window からの処理までは隔離できないため、プレビュー用ブロックで課金・予約・データ更新などの副作用を起こさないでください。

## 素材ライブラリ

`PageEditor` に `assets`（`AssetLibraryAdapter`）を渡すと素材ライブラリを使えます。`listProviders` を実装するホストでは、左レールに「アップロード」「ストック」「接続」を出し、それぞれサイトへのアップロード素材・ストック素材・接続済みCMS素材だけを表示します。「接続」はCMS素材を参照する入口で、外部サービスの接続設定はホスト側の設定画面が担当します。インスペクタの画像選択では、配置を許可された出所をまとめて選べます。`listProviders` のない既存ホストは単一の「素材」パネルを維持します。`assets` を渡さない場合は、画像を追加して「画像 URL」で指定する案内を表示します。adapter・素材の形・ホストの責務は[素材ライブラリ契約](asset-contract.md)を正とします。

素材 URL は `adapter.resolveAssets` で解決し、文書には `{ provider, id }` を保存します。アップロード・削除・利用先の検査・出所ごとの権限は[素材契約](asset-contract.md)に従ってください。

## データ連動値のロック

ブロックに共通のデータ連動値は registry に明示します。

```tsx
const blocks = {
  PublicNotice: {
    props: {
      heading: { type: 'string', required: true },
      count: { type: 'number', required: true },
    },
    defaultProps: { heading: 'お知らせ', count: 3 },
    lockedProps: { count: '公開データから取得する件数です。ホスト側で管理します。' },
    component: ({ heading, count }) => <aside>{heading}: {count}</aside>,
  },
} satisfies EditorBlockRegistry;
```

ページ固有のロックは snapshot の `locks` に `{ nodeId, fields, reason }` として返します。fields は `props.count`、`attrs.href`、`style.base.color`、`style`、`children`、`*` 等の文書フィールドです。text node 自体はIDを持たないため、その親の `children` をロックしてください。

画像の `asset`、`attrs.src`、`attrs.srcSet` は1つの画像ソースとして扱います。いずれかをロックすると、残りの指定による差し替えも入力・履歴・復元の検証で拒否します。altは別フィールドです。素材IDを使う画像には独立した `src` / `srcSet` を保存できません。

ロックされた欄は理由付きで無効化し、モデル側でも編集・削除・undo/redoによる変更を拒否します。データ連動値を含む要素やその祖先の複製・削除も拒否し、移動は値を変えない場合に許可します。ロックは編集補助なので、同じ制約を保存・公開APIでも適用してください。価格・在庫・予約の取得や計算をパッケージへ持ち込みません。

## 公開 / rollback の二段階確認

公開操作は保存済みの文書だけに許可します。ホストは初回など保存済み下書きがない snapshot に `hasSavedDraft: false` を返すと、公開前確認を無効化して下書き保存を案内できます。省略した既存ホストの挙動は変わりません。保存成功後はエディターがこの状態を true に進め、再読込時はホストの現在値を使います。ホストは公開 API 側でも保存済み下書きを再確認してください。prepareRelease は現在の公開内容と保存済み下書きの差分をホスト側で計算し、人が理解できる `path/before/after` の文字列配列として返してください。rollback の場合は指定した公開版を反映した結果との差分にします。UI は plan をコピーして保持します。

plan の target、expectedVersion、action、rollback revision が要求と一致し、domain が listSites の許可済み HTTPS origin に含まれることを確認してからダイアログを開きます。origin は `https://example.com` の形式で、パス・資格情報・末尾 `/` を含めません。対象ドメインと差分を表示し、明示チェック後だけ実行ボタンを有効にします。確認中は背後の編集を無効化します。

ホストは confirmationToken を対象文書・version・ドメイン・action・rollback revision・正確な差分に結び付け、短い有効期限と一回限りの利用を実装してください。release 時も認可と version を原子的に再検証し、UI から渡された domain や changes を権限の根拠にしません。token をログや永続文書に保存しません。

### 複数ページ公開変更セット

`prepareReleaseSet` / `releaseSet` / `releaseSetStatus` は `@niho/web/editing-api` の `pages.release-set-*` と同じ契約を実装してください。各ページの単一公開差分を確かめた結果、差分があるページだけを同じサイトの変更セットへ含めます。計画は対象、全 expected version と依存版、domain、operation ID を固定します。実行結果はページごとに `released` / `conflict` / `pending`、全体を `completed` / `publishing` とし、部分完了を隠しません。同じactor・operation ID・入力で再送したときは完了済みページを再公開せず、処理待ちだけを再開します。全ページ同時切替やページとCMSをまたぐ公開は要求しません。永続化、CAS、認可、actor監査はホストの責務です。詳細は[共通編集API契約](editing-api-contract.md#操作カタログ)を参照してください。

公開409は現在の編集内容を保持して確認を閉じます。通信失敗は「成立したか不明」として扱い、ホスト側で公開状態を確認するよう表示します。成功時はホストが返す最新 snapshot を検証して読込むため、文書と version を必ず最新状態で返してください。

## 共通部品

`EditorAdapter.components` に `EditorComponentAdapter` を渡します。ページの読込に先立って同じサイトの `readLibrary` を呼びます。未保存の部品があるときは部品を先に `saveLibrary` で保存し、次にページを保存します。自動保存では `trigger: "autosave"` が付きます。競合後は最新ライブラリと現在のページの整合を確認してから更新します。

公開計画には編集中のライブラリの版を `componentsVersion` として渡します。文書の展開、依存関係と公開の責務は[共通部品の契約](component-contract.md)、自動保存と競合時の扱いは[保存・履歴の契約](save-history-contract.md)を参照してください。

## サイトとページのスタイル所有権

ページとサイト共通の値は別の所有者と版を持ちます。`site.styles.read` と書込み操作を接続すると、ホストの共通の下書き・公開版を使用します。共通定義の削除・名前変更は `site.styles.migration-plan/apply` に対応するホストだけで許可します。型、優先順位、版と原子的な適用は[サイト共通スタイル契約](site-styles-contract.md)を参照してください。

## ブレークポイント設定

`EditorAdapter.breakpointSettings` はサイト単位の設定を読み取り、現在の opaque version を条件に保存します。文書にある幅の指定は、サイト設定の開始幅を変更しても自動で移行されません。現行設定と文書のずれを確認してから移行する場合は、[正規化 CLI](normalization-contract.md)を参照してください。
