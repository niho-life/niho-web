# コレクション（CMS）の画面と adapter の契約

`CollectionWorkspace` は、記事・サークル・会社のような「同じ形の項目が並ぶもの（コレクション）」の一覧と項目の編集の画面です。`@niho/web/collection-workspace` から使います。React 不要の型・runtime parser・値の検証・本文の HTML の無害化は `@niho/web/collection-model` にあります。

この段（U2-c）は画面とホストが実装する adapter の契約だけです。サイト側の API・Studio の BFF への接続（U2-a/b）と、Studio の Dashboard への組み込みはまだ含みません。

## 正本と責務

コレクションの定義・項目・下書き・公開の正本はホストにあります。ライブラリは表示・入力・その場の確かめ・自動保存のタイミング・古い応答の破棄だけを持ち、次のことはホストの責務です。

- 認証と認可。各呼び出しで、今の利用者がそのサイト・コレクション・項目を読める／書けるかを確かめます。画面から渡る `collectionId`・`itemId`・`version` は認可の証明ではありません。権限が無いときは `{ status: "forbidden" }` を返します。画面は表示していた中身を消し、権限が無いと出します。
- 保存。下書きの保存は `version` による楽観的な排他（compare-and-swap）で、ほかの人が先に保存していたら `conflict` を返し、上書きしません。
- 公開と予約。サイトの作り直し・予約の実行・反映の結果（`publishFailed`）はホストが持ちます。
- 画像の置き場と変換。`uploadImage` はファイルの種類・大きさ・権限を確かめ、表示できる URL を返します。
- HTML の最終的な無害化。画面も `sanitizeRichTextHtml` を通しますが、ブラウザの値は信用せず、保存・公開の前にホストのサーバーでも無害化してください。
- 値の確かめ。画面は公開の前に必須・slug・URL などを確かめますが、アドレスの重複など正本でしか分からないことはホストが `invalid` で返します。
- 定義（`fields`）に無い値の保持。画面は `fields` にある値だけを送ります。古い項目などの値はホストが消さずに持ってください。

例外（throw・reject）は画面では一般的な失敗（「保存できませんでした」と再試行）になります。秘密や内部の詳細をエラーの文に含めないでください。

## 使い方

```tsx
import { CollectionWorkspace, type CollectionAdapter } from '@niho/web/collection-workspace';

const adapter: CollectionAdapter = {
  loadSchema: (signal) => host.get('/collections', signal),
  listItems: ({ collectionId }, signal) => host.get(`/collections/${collectionId}/items`, signal),
  loadItem: ({ collectionId, itemId }, signal) => host.get(`/collections/${collectionId}/items/${itemId}`, signal),
  saveDraft: (input, signal) => host.put(`/collections/${input.collectionId}/items/${input.itemId}/draft`, input, signal),
  publish: (input, signal) => host.post(`/collections/${input.collectionId}/items/${input.itemId}/publish`, input, signal),
  uploadImage: ({ collectionId, file }, signal) => host.upload(collectionId, file, signal),
  // 任意: createItem, discardDraft, unpublish, duplicate, remove, schedule, cancelSchedule, retrySchedule, reorder, bulk,
  //       imageUrl, previewUrl, isRichTextImageAllowed
};

<CollectionWorkspace
  adapter={adapter}
  initialCollectionId={route.collectionId}
  initialItemId={route.itemId}
  onNavigate={({ collectionId, itemId }) => router.replace({ collectionId, itemId })}
/>;
```

| props | 内容 |
| --- | --- |
| `adapter` | 下の契約。参照を替えると画面の状態を作り直し、進行中の読み書きを abort します。 |
| `initialCollectionId` / `initialItemId` | 最初に開くコレクション・項目。無い・見つからないときは先頭のコレクションの一覧。最初の表示だけに使います（途中で開き直すときは `key` を替えて作り直してください）。 |
| `onNavigate` | 一覧・項目を移ったときに `{ collectionId, itemId }`（一覧は `itemId: null`）で呼びます。最初の表示では呼びません。URL を合わせるのはホストです。 |
| `renderRichText` | リッチテキストの編集部品の差し替え。受け取る props は `CollectionRichTextEditorProps`（`id`・`labelId`・`describedBy`・`invalid`・`value`・`onChange`・`sanitize`・`uploadImage`）。`id` を編集する要素に付けると、公開前の確かめで focus できます。無ければ既定の contenteditable（`CollectionRichTextEditor` として export）。 |
| `timeZone` | 日時の表示と入力のタイムゾーン。既定は `Asia/Tokyo`（「日本時間」と出します）。 |
| `autosaveDelay` | 直してから下書きを自動で保存するまでの待ち時間（ms）。既定は 1000。 |

部品は `<style>` で `collectionCss` を入れます。Studio のように inline の `<style>` を CSP で拒むホストは、`collectionCss`（`@niho/web/collection-workspace` から export）をファイルにして読み込んでください。React の `style` 属性は使いません。色・角丸・文字は `@niho/web/ui-tokens` のトークン（`--nw-*`）だけを使い、`collectionCss` の先頭にその定義を持ちます（[見た目と実装の契約](editor-ui-design.md#見た目と実装の契約)）。定義の詳細度は 0 なので、ホストは `:root` や `.nw-collection` で同じ名前を上書きできます。一覧の見出しの「＋ 新しい○○」だけを黒、公開・保存などは青で描きます。クラスの接頭辞は `cw-`、根は `.nw-collection` です。項目の編集の上のバーは画面の上に貼り付くので、ホストに固定のヘッダーがあるときは `--niho-sticky-top` にその高さを入れてください。

## adapter

すべて `(input, signal: AbortSignal) => Promise<unknown>` で、戻り値は runtime parser（`parseCollection…Result`）で確かめます。形が違えば例外（`DocumentValidationError`）で、画面では失敗として扱います。どの応答でも `{ status: "forbidden" }` を返せます。項目を指す応答は `{ status: "not_found" }` も返せます。

| メソッド | 入力 | 応答 |
| --- | --- | --- |
| `loadSchema` | — | `{ status: "ready", collections: CollectionDefinition[] }` |
| `listItems` | `{ collectionId }` | `{ status: "ready", collectionId, items: CollectionItemSummary[] }`（`collectionId` は要求と一致） |
| `loadItem` | `{ collectionId, itemId }` | `{ status: "ready", item }` / `not_found` |
| `saveDraft` | `{ collectionId, itemId, version, values }` | `{ status: "saved", item }` / `{ status: "conflict", item }` / `{ status: "invalid", errors: { field, message }[] }` |
| `publish` | `{ collectionId, itemId, version, redirect? }` | `{ status: "published" \| "publishing", item }` / conflict / invalid |
| `uploadImage` | `{ collectionId, file }` | `{ status: "uploaded", url, width?, height? }` / `{ status: "rejected", reason: "type" \| "size" \| "permission" \| "invalid" }` |
| `createItem`（任意） | `{ collectionId }` | `{ status: "created", item }`（下書きとして作る） |
| `discardDraft`（任意） | `{ collectionId, itemId, version }` | saved（公開中の内容に戻した項目）/ conflict |
| `unpublish`（任意） | `{ collectionId, itemId, version }` | saved / conflict |
| `duplicate`（任意） | `{ collectionId, itemId }` | created（複製した下書き） |
| `remove`（任意） | `{ collectionId, itemId, version, redirectTo? }` | `{ status: "removed" }` / conflict / invalid（移動先の選び直し） |
| `schedule`（任意） | `{ collectionId, itemId, version, at, redirect? }` | saved（`status: "scheduled"`・`scheduledAt`）/ conflict / invalid |
| `cancelSchedule`（任意） | `{ collectionId, itemId, version }` | saved / conflict |
| `retrySchedule`（任意） | `{ collectionId, itemId, version }` | saved（失敗した公開予約をやり直した項目）/ conflict / invalid |
| `reorder`（任意） | `{ collectionId, ids, from, to }` | `{ status: "saved" \| "publishing", items }` / `{ status: "conflict", items }` / invalid |
| `bulk`（任意） | `{ collectionId, action: "publish" \| "unpublish" \| "remove", items: { id, version }[] }` | `{ status: "saved" \| "publishing", items }` / `{ status: "conflict", items }` / invalid |
| `imageUrl?(url, width)` | — | 一覧の小さい画像・項目の画像の表示用 URL（同期）。無ければ `url` のまま。 |
| `previewUrl?(collectionId, item)` | — | 保存済みの下書きを別タブで開く URL（同期）。`null` なら「プレビュー」を出しません。 |
| `isRichTextImageAllowed?(src)` | — | 本文の画像で、`/` から始まる同じサイトの path を残してよいか。既定は https の画像だけ残します。 |

- 任意の操作は、メソッドが無いか、その定義の `capabilities` が `false` のとき出しません（`createItem` は `create`、`duplicate`・`remove`・`unpublish`・`schedule`／`cancelSchedule` は同じ名前、`retrySchedule` は `retrySchedule`、`reorder` は `reorder` と `ordering: "manual"`、`bulk` は `bulk`、`publish`・`schedule` の `redirect` と `remove` の `redirectTo` は `redirects`）。`discardDraft` は状態が「変更あり」のときだけ出します。
- `redirect`（boolean）は、`capabilities.redirects` で、公開中の項目（`path` と `publishedAt` がある）の slug を公開中のアドレスから変えたときだけ付けます。`true` は前のアドレスを開いた人を新しいアドレスへ移す、`false` は移さない。ほかのときは付けません（ホストの既定に任せます）。
- `redirectTo` は、`capabilities.redirects` で、サイトに出ている項目（`path` があり `published`・`changed`・`publishing`）を消すときだけ付けます。付けない＝ホストの既定（一覧へ移す）、`null`＝移さない、string＝同じコレクションのほかの公開中の項目（`path` があり `published`・`changed`）の `path`。ホストが受け付けない移動先は `invalid`（`field: ""`）で返します。
- `reorder` の `ids` は、一覧の項目のうち `order` が `null` でないものを `order` の小さい順に並べた id（同じ `order` は一覧の応答の順）です（`collectionReorderSequence`）。`from`・`to` はその中の位置で、`to` は動かした後の位置です（`moveCollectionIds`）。ホストの並びと `ids` が違えば `conflict` と今の一覧を返します。
- `bulk` の `items` は 1〜100 件で、画面は直前に各項目の `loadItem` を呼んで最新の `version` を付けます（一覧の要約は `version` を持たないため）。どれかの `version` が違えば `conflict` と今の一覧、操作できない項目があれば `invalid`（`field: ""` の文を帯の近くに並べます）。
- `reorder`・`bulk` の `items` は操作の後（`conflict` は今）の一覧で、画面は一覧をこれで置き換えます。
- `saved`・`conflict`・`published` などの `item.id` は要求の `itemId` と一致必須です。`conflict` の `item` はほかの人が保存した最新です。
- `invalid` の `field` が `fields` の key なら、その項目の下に `message` を出します。key でなければ（`""` など）画面の上にまとめて出します。
- `uploadImage` の `url` は https、または `/` から始まる同じサイトの path だけです（http・data・javascript・資格情報付きは拒否）。
- 一覧から「非公開にする」「削除する」を選ぶと、先に `loadItem` で最新の `version` を読んでから呼びます。

## 定義（CollectionDefinition）

```ts
type CollectionDefinition = {
  id: string; label: string; addLabel: string;          // 例 "記事" / "新しく書く"
  icon?: 'document' | 'people' | 'person' | 'tag';
  ordering: 'publishedAt' | 'manual';                    // 一覧の並び
  pathPrefix: string | null;                             // 公開時のアドレスの前（例 "/posts/"）
  titleField: string;                                    // type: text の項目
  slugField: string | null;                              // type: slug の項目
  imageField: string | null;                             // type: image の項目（shape: round なら一覧の画像も丸）
  subtitleField: string | null;                          // fields のどれか（一覧の下の文字はホストが summary.subtitle で返す）
  capabilities: {
    create: boolean; duplicate: boolean; remove: boolean; unpublish: boolean; schedule: boolean;
    redirects?: boolean; reorder?: boolean; bulk?: boolean; retrySchedule?: boolean;  // 無ければ false
  };
  fields: CollectionField[];                             // 並び順どおりに出す
};
```

項目（field）は共通で `key`・`label`・`placement: "main" | "side"`、任意で `hint`・`required` を持ちます。`key` とコレクションの `id` は `^[A-Za-z0-9_][A-Za-z0-9_-]*$`（80 文字まで・`__proto__` などは不可）。

| type | 追加の設定 | 値 |
| --- | --- | --- |
| `text` | `maxLength?`・`placeholder?` | string |
| `longText` | `rows`（1〜40）・`maxLength?` | string（改行を含む） |
| `richText` | — | string（HTML） |
| `url` | `placeholder?` | string（http・https） |
| `image` | `shape?: "rect" \| "round"` | string（URL）\| null |
| `select` | `multiple`・`options: { id, label }[]` | string[]（単一は長さ 0〜1） |
| `reference` | `multiple`・`collectionId` | string[]（参照先の項目の id。単一は長さ 0〜1） |
| `tags` | — | string[] |
| `datetime` | — | タイムゾーン付き ISO の string \| null |
| `slug` | — | string（`^[A-Za-z0-9_-]+$`） |
| `gallery` | `captionLabel`・`maxItems?`（1〜500）・`captionMaxLength?` | `{ id, image, caption }[]`（画像と説明の並び。`id` は既存の行の id、新しく足した行は `""`。`image` は `image` の項目と同じ形の URL \| null） |

`parseCollectionSchemaResult` は、key・option・コレクションの重複、知らない type・設定、`titleField` などの指す項目の型、`reference` の参照先が同じ schema にあることを確かめます。`capabilities` は 5 つの key が必須で、`redirects`・`reorder`・`bulk`・`retrySchedule` は任意です（無ければ `false` にそろえます。5 つだけを返す古いホストもそのまま開けます）。ほかの key は拒否します。

項目の値は `parseCollectionValues` で定義の形にそろえます。無い key は空の値（`""`・`null`・`[]`）で補い、`fields` に無い key は捨てます（ホストが保持）。型が違う・単一の選択に 2 つ以上・同じ値の重複は例外です。`gallery` の各行は `id`・`image`・`caption` の 3 つちょうどで、`id` は `""` か `^[A-Za-z0-9._~:-]{1,128}$`（`""` 以外の重複は不可）です。slug の形や URL の scheme などの中身は、下書きでは自由で、公開・予約の前に `validateCollectionValues` で確かめます（`gallery` は行の数・画像の URL・説明の文字数）。

## 項目（CollectionItemSummary / CollectionItem）

```ts
type CollectionItemSummary = {
  id: string; title: string; subtitle: string | null; imageUrl: string | null;
  path: string | null;                                   // 公開中（予定）のサイト内のパス。"/" から始まる
  status: 'draft' | 'published' | 'changed' | 'publishing' | 'scheduled';
  publishedAt: string | null; updatedAt: string | null; updatedBy: string | null; scheduledAt: string | null;
  publishFailed: boolean; order: number | null;
};
type CollectionItem = CollectionItemSummary & { version: string; values: Record<string, unknown> };
```

| status | 意味 | 一覧の印 | タブ |
| --- | --- | --- | --- |
| `draft` | まだ公開していない | 下書き（中抜きの丸） | 下書き |
| `published` | 公開中で、出していない変更は無い | 公開中 | 公開中 |
| `changed` | 公開中で、まだ出していない変更がある | 変更あり（半分の丸） | 公開中 |
| `publishing` | 公開して、サイトの作り直しを待っている | 反映中（回る印） | 公開中 |
| `scheduled` | 予約した日時に公開する（`scheduledAt` 必須） | 予約 10/30 9:00 | 下書き |

`publishFailed` は「前回の公開に失敗」を、`scheduled` 以外で `scheduledAt` があれば「予約 …」を足して出します。印は色だけでなく形と言葉でも分かるようにしています。日時はタイムゾーン付きの ISO で、表示は `timeZone` の時刻です。

一覧の並びは、`ordering: "publishedAt"` なら公開日時の新しい順（公開日時の無いものは先頭で、その中は更新の新しい順）、`manual` なら `order` の小さい順（`order` の無いものは先頭）です。同じなら更新の新しい順・題名順（`sortCollectionItems`）。

## 画面のふるまい

一覧:

- 左に「コンテンツ」としてコレクションの並びと件数、本文の上にコレクション名と件数、「すべて・公開中・下書き」の絞り込み（件数つき）、題名（とアドレス）の検索、主ボタン「＋ {addLabel}」。
- 行は小さい画像・題名（下に `subtitle`、無ければ `path`）・状態の印・公開日時・最終更新（日時と人）・「…」（開く・上へ・下へ・複製する・非公開にする・削除する）。
- 並べ替え（`reorder`）: 検索も絞り込みもしていない一覧で、`order` のある行の左に掴む印を出し、ドラッグ（マウス・指。Esc で取り消し）と「…」の「上へ」「下へ」で動かします。`order` が `null` の行（下書きだけ）は並びの外として先頭にまとめ、印も「上へ」「下へ」も出しません。応答を待つ間は動かした後の並びを出し、終わったら応答の一覧で置き換えます。「上へ」「下へ」の後は動かした行の「…」へ focus を戻します。`conflict` は一覧を置き換えて「ほかの人が先に並びを変えていました」と出します。絞り込み中は「並べ替えは、検索と絞り込みをやめると使えます。」と出します。
- まとめての操作（`bulk`）: 行の左の選択（「「題名」を選ぶ」）と「全部を選ぶ」（表示している行だけ）。選んでいる間は帯に「n 件を選択中」「公開する」「下書きに戻す」「削除する」「選択をやめる」を出します。下書きに戻す・削除は確認の後だけ呼び、削除の確認は `redirects` のホストでは「公開中の項目のアドレスは一覧へ移します。」と書きます。検索・絞り込みで見えなくなった行は選択から外します。100 件を超えて選ぶと操作を止めて知らせます。成功したら一覧を置き換えて選択を外し、`invalid` は帯の下に文を並べ（選択は残す）、`conflict` は一覧を置き換えて「ほかの人が先に変えました」と出します。
- 読み込み中・空・検索で 0 件・失敗（再試行）・権限なしを分けて出します。幅 900px 以下はコレクションの並びを上で折り返し、640px 以下は行を縦のカードにします。320px でも横にはみ出しません。
- 項目から一覧へ戻ると、その項目の行へ focus を戻します。

項目の編集:

- 上のバーに「‹ 一覧へ」・状態の印・保存の状態（保存中… / 保存しました / 保存できませんでした［再試行］）・「プレビュー」・「…」（変更を取り消す・非公開にする・複製する・削除する）・主ボタン（「公開する」、変更ありなら「変更を公開する」、公開中で変更が無ければ「公開中」、反映中は「反映中」）。
- `placement: "main"` の項目を中央の列に、`"side"` の項目を右の欄に並び順どおり出します。`titleField` は大きい題名の入力です。右の欄の一番上に「公開」（状態・公開日時・最終更新・アドレス＝`pathPrefix` + slug・予約）を置きます。幅 900px 以下は右の欄を本文の下に出します。
- 直すたびに `autosaveDelay` 待って下書きを自動で保存します（`version` を付けて 1 回）。保存中にさらに直したら、終わった後にもう一度保存します。
- `conflict` は上書きせず「ほかの人が先に保存しました」と出し、「最新を読み込む」で読み直します（この画面でいま直したところは消えると書きます）。解決するまで自動保存と公開を止めます。
- `invalid` は該当の項目の下にエラーを出し、入力に `aria-invalid` と `aria-describedby` を付けます。直すとその項目のエラーを消します。
- 公開・予約の前に `validateCollectionValues`（必須・文字数・slug・URL・日時・選べない選択肢）を確かめ、だめなら最初の項目へ focus して止めます。通れば、保存待ちの下書きを先に保存してから `publish` を呼びます。`publishing` なら「公開しました。サイトに出るまで少しかかります。」と出します。
- 削除・非公開・変更の取り消しは確認のダイアログの後だけ呼びます。ダイアログは Esc で閉じ、Tab は中で回り（選択の部品も含む）、閉じると開く前の場所へ focus を戻します。
- 削除の移動先（`redirects`）: サイトに出ている項目を消す確認（一覧・項目の編集とも）に「このアドレス（/posts/…）を開いた人の移動先」として「一覧へ移す」（既定・`redirectTo` を送らない）・「ほかの{コレクションの label}へ移す」（候補があるときだけ。選ぶと候補の一覧を出し、その `path` を送る）・「移さない」（「このアドレスを開いた人には『見つかりません』が出ます。」・`null`）を出します。公開していない項目は今までの確認のままです。
- 予約のやり直し（`retrySchedule`）: 予約があり `publishFailed` のとき、右の欄の予約に「予約していた公開に失敗しました。」と「もう一度公開する」を出します（保存待ちの下書きを先に保存してから呼びます）。
- 保存待ちのまま「一覧へ」を押すと、先に保存してから戻ります。保存できなければ「変更を捨てて戻る」かを確かめます。保存待ち・保存中・画像を上げている途中にタブを閉じようとすると `beforeunload` で止めます。
- 公開中の項目の slug を変えたとき: `capabilities.redirects` のホストでは slug の欄の下に「前のアドレス（/posts/…）を開いた人を新しいアドレスへ移す」の checkbox（既定は on）を出し、公開・予約に `redirect` を付けます（外したときだけ「移さないと、前のアドレスを開いた人や検索結果からは見つからなくなります。」と出します）。転送できないホストでは「前のアドレスを開いた人や検索結果からは見つからなくなります」と出します。

項目の入力:

- 画像: 縮小した表示（`imageUrl(url, 480)`）・「画像を選ぶ／画像を変える」（`uploadImage` の URL を値に）・「外す」。`rejected` は理由（種類・大きさ・権限・読めない）を出します。`shape: "round"` は丸く出します。
- 参照: 参照先のコレクションの題名から検索して選びます（候補は `listItems` の結果。8 件まで）。選んだものは「外す」ボタン付きのチップ。単一は選び直すと置き換えます。見つからない id は「（見つからない項目）」と出します。
- タグ: 入力して Enter（日本語の変換中は足さない）か「足す」で足すチップ。前後の空白を詰め、重複は足しません。
- 選択: 単一はラジオ（必須でなければ「なし」付き）、複数はチェックボックス。選んだものは色に加えて ✓ を出します。
- 日時: `datetime-local` で `timeZone` の時刻を入力し、ISO（UTC）に直して値にします。「消す」で `null`。
- 画像と説明の並び（`gallery`）: 行ごとに画像（`imageUrl(url, 320)`。「画像を選ぶ／画像を変える」は `uploadImage` を同じ `collectionId` で呼ぶ）・説明（`captionLabel` の textarea。`captionMaxLength` があれば文字数）・「上へ」「下へ」「外す」。下に「追加」（新しい行は `{ id: "", image: null, caption: "" }`）。`maxItems` に達したら「追加」を出さずに「これ以上は追加できません」と出します。動かした・外した・足した後は、その行（外したときは隣の行）へ focus を移します。
- 既定のリッチテキスト: contenteditable と道具（段落・見出し・小見出し・太字・斜体・箇条書き・番号付き・引用・リンク・画像）。変更のたびに `sanitizeRichTextHtml` を通した HTML を値にします。書式は `document.execCommand` を使い、無い環境（jsdom など）では書式の道具は何もしません。画像は `uploadImage` の後に入れ、execCommand が無いときは本文の最後に段落として足します。リンクは http・https・mailto だけです。貼り付けも無害化してから入れます。

## 本文の HTML の無害化（sanitizeRichTextHtml）

`sanitizeRichTextHtml(html, { isImageSrcAllowed? })` はブラウザ（テストは jsdom）の `DOMParser` で読み、次だけを残します。

- 要素: `p`, `h2`, `h3`, `h4`, `strong`, `em`, `ul`, `ol`, `li`, `blockquote`, `br`, `hr`, `a`, `figure`, `figcaption`, `img`。`b` → `strong`、`i` → `em`、`h1` → `h2`、`h5`・`h6` → `h4`、中に段落などのかたまりを持たない `div` → `p` に置き換えます。
- 属性: `a` の `href`（http・https・mailto だけ。それ以外の `a` は外して中身を残す）、`img` の `src`（https だけ。`isImageSrcAllowed` が許した `/` から始まる path も可。それ以外の `img` は消す）・`alt`・`width`・`height`（数字だけ）。
- `script`・`style`・`iframe`・`object`・`embed`・`svg`・`math`・`template`・`noscript`・フォームの部品・音声・動画などは中身ごと消します。知らない要素（`span`・`section`・`u`・`font` など）は外して中身を残します。`on*`・`style`・`class`・`id` などの属性とコメントは落とします。

ホストは保存・公開の前に、サーバーでも同じ以上の無害化をしてください。

`renderRichText` で差し替えるホストの部品は、`props.sanitize` の代わりに自分の許可リストを使ってかまいません。ただし `sanitizeRichTextHtml` が残すものはすべて同じ形で残し（上位集合）、`script`・`on*` 属性・`javascript:` などのリンク・外の読み込みを含む `style` は落としてください。既存の本文の書式（見出しの `id`・`figure` の `style`・埋め込みなど）を保つ必要があるサイトのための例外です。NIHO Web Studio の鎌倉の本文の部品（`studio/rich-text-editor.tsx`）は `sanitizeStudioRichTextHtml`（`studio/rich-text-sanitize.ts`）を使います。

## 当初の案から変えた点

- `CollectionItemSummary` に `path` を足しました（一覧で題名の下にアドレスを出すため。`CollectionItem` は summary を含むので、そのまま持ちます）。
- `discardDraft`・`unpublish`・`remove`・`schedule`・`cancelSchedule` の入力に `version` を付け、`conflict` を返せるようにしました（一覧からの操作も最新を読んでから行い、ほかの人の変更を上書きしないため）。どの応答でも `forbidden`、項目を指す応答では `not_found` を返せます。
- `createItem` 以降の操作のメソッドは任意にしました。メソッドが無いときも `capabilities` が `false` のときと同じく出しません。
- 本文の画像は https だけを残すのを既定にし、同じサイトの画像を本文に使うホストのために `isRichTextImageAllowed` を足しました（Studio の CSP は `img-src 'self' https:`）。
- 無害化で `h1`・`h5`・`h6`・段落を含まない `div` を置き換えるようにしました（既存の本文の見出しと、contenteditable が作る改行を失わないため）。
- props に `timeZone`・`autosaveDelay` を足しました。
- デモのポートは 4179 です（4173〜4178 はほかのデモが使っています）。
- U2-e（鎌倉の /admin の撤廃）で、`capabilities` に任意の `redirects`・`reorder`・`bulk`・`retrySchedule`、adapter に `retrySchedule`・`reorder`・`bulk`、`publish`・`schedule` の `redirect`、`remove` の `redirectTo` と invalid、項目の型 `gallery` を足しました。新しい key は任意なので、5 つの capabilities だけを返すホストは今までどおり動きます。

## 既知の不足

- 既定のリッチテキストは `document.execCommand`（非推奨の API）に頼ります。表・コード・下線・打ち消し線・文字色・見出しの `id`（目次のアンカー）・`/` から始まるリンクは残りません。画像の `alt` と `figcaption` は入力できません（既存の値は残ります）。きちんとした本文の編集はホストが `renderRichText` で差し替えてください。
- 反映中（`publishing`）の結果は見に行きません。ホストが一覧を読み直したときに反映します。
- ドラッグの並べ替えは、一覧を画面の外まで自動ではスクロールしません（長い一覧は「上へ」「下へ」を使います）。
- まとめての操作は、選んだ項目を 1 件ずつ `loadItem` で読んでから呼びます（同時に 6 件まで）。

## デモと検証

`npm run demo:collections`（または `npm run build` の後に `node examples/collection-demo.mjs`）で `http://127.0.0.1:4179` に、記事・サークル・カテゴリの 3 つのコレクションと、全部の項目の種類が出るデモを出します。データはすべて架空で、ブラウザのメモリ上の adapter にだけあり、再読み込みで戻ります。画像はローカルのサーバーのメモリに置きます。「開いている項目をほかの人が保存したことにする」で衝突を、「権限を外す」で権限なしを試せます。記事ではまとめての操作・削除の移動先・アドレスを変えたときの転送・予約のやり直し（「冬至のキャンドルの夜」は予約の公開に失敗した形）を、サークルでは並べ替え・まとめての操作・画像と説明の並び（「活動の写真」）を試せます（転送と移動先はデモの帯に送った値を出すだけです）。

`test/collection-model.test.mjs` は定義（capabilities の新旧の形・`gallery`）・一覧・項目・操作（`reorder`・`bulk`・`remove` の invalid）・画像の parser、値の検証、並び（並べ替えの並び）、日時の変換、無害化を確かめます。`test/collection-workspace-actions-ui.test.mjs` は jsdom で、並べ替え（印・「上へ」「下へ」・ドラッグ・conflict・絞り込み中）、まとめての操作（選択・最新の version・確認・invalid・conflict）、削除の移動先、slug を変えたときの転送の選択と `redirect`、`gallery` の行の操作と値の形、予約のやり直しを、古い capabilities では出ないことと合わせて確かめます。`test/collection-workspace-ui.test.mjs` は jsdom で、一覧（並び・件数・印・検索・絞り込み・capabilities）、項目の編集（main と side・約 1 秒後に 1 回の自動保存と version）、conflict と invalid、公開前の確かめと focus・保存してからの公開、各項目の値の形、確認のダイアログと focus の戻り、権限なし、adapter の差し替え・閉じたときの abort と遅い応答の破棄、一覧へ戻るときの保存と `beforeunload` を確かめます。
