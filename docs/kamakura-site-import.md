# 鎌倉サイトを検証用 Studio へ取り込む

## 検証先を登録する

Studio で検証用の新規 Project を作成し、移行元の原文 locale を指定する。登録時に発行された Project ID と Site ID を使う。Studio の `PUBLIC_SITES_PREVIEW_ORIGIN` に登録済みの共有検証 origin が必要。取込 API は `/s/{slug}` に対応する host 行が `enabled=1` かつ `noindex=1` で、公開済みページ・CMS release がないことを確かめる。最初の取込には初期 home 以外のページ、CMS 変更、redirect がない状態が必要。

新規 Project の作成者は owner になる。別担当者と共同作業する場合は既存のメンバー管理で招待する。試験取込は登録済み owner 本人の短期 `NIHO_EDIT_TOKEN` を使う。取込後に CLI で点検する service client が必要な場合は、同じ Project/Site に対し、作業に必要な読取 grant だけを登録する。[Studio-native の登録手順](studio-managed-sites.md) [Studio CLI の認証と grant](studio-cli.md)

## エクスポートと取込

同じ時点の移行元の公開版と現行下書きを、一つの JSON に書き出す。JSON は `formatVersion: 1` とし、保存した UTF-8 バイト列の SHA-256 をエクスポートの取得時に別途記録する。元素材は SHA-256 をファイル名にしたディレクトリに置く。取得元の版・変換指定・原本ファイル・checksum・出力する対応表は非公開の作業先で扱う。

| エクスポートのキー | 内容 |
| --- | --- |
| `siteId`, `origin`, `locale` | 移行元サイト ID、HTTPS origin、原文 locale |
| `pages` | `{ sourceUrl, sourcePageId, path, locale, visibility, published, draft }` の配列。`sourceUrl` は移行元 origin の絶対 URL、`path` は Studio の移行先パス。公開版がないページの `published` は `null`。任意の `title` はページ一覧名 |
| ページの `published`, `draft` | `{ document }`。共通定義を使う文書には `sourceComponents`, `sourceStyles` を同じ版で付ける。本文と共通定義を展開して対象の PageDocument へ保存し、取込後はページ単位で編集する |
| `assets` | `{ source: { provider, id }, url, width, height, altText, contentSha256, byteLength, aliases? }` の配列。`url` は現行の公開原本 URL、`aliases` は同じ ID に対する旧 URL・変換画像 URL。`width` と `height` が不明なら `null`。原本は各 32 MiB まで |
| `assetVariants` | 派生素材に別 ID がある場合の `{ source, original }` の配列。両方とも `{ provider, id }`。`original` は `assets` の元素材 ID |
| `cms` | `null` または `{ schema, items }`。schema は移行元サイトの [CMS v2 定義](cms-v2-contract.md)。項目は `{ collectionId, itemId, published, draft, translations? }`、`published` / `draft` は field ID → 値のオブジェクト。未公開なら `published: null` |
| `cms.items[].translations` | `{ targetLocale, published, draft }`。各版は `null`、または field ID → `{ value, reviewed }`。Studio の CMS 翻訳が対応するテキスト field を指定する。`reviewed` は元の対応版で確認済みだった場合に限る |
| `redirects` | Studio の `{ locale, fromPath, toPath }` の配列。次回公開に使う redirect 正本に取込む |
| `scheduled` | `{ kind: "page", sourceUrl, at }` または `{ kind: "cms", collectionId, itemId, at }` の配列。`at` は RFC 3339 の日時。元予約の情報を検証用計画へ保持し、公開予約ジョブは作成しない |

地図、カレンダー、旧 iframe、カルーセル、フォームを含む版には、必要な `sourceBlocks`, `presentation`, `replacements`, `frameOrigins` も付ける。`replacement.kind` は `frame`、`carousel`、`managed-embed` が使える。既存の変換器が安全に置換できない旧フォーム・iframe を含む場合は保存前に停止する。CMS 専用ブロックが残るページは、公開版と下書きの入力を私有領域へ保存し、対応表に `deferred: "cms-block-conversion"` を記録する。[鎌倉専用ブロックの移行](kamakura-block-migration.md)

フォーム接続が必要な場合は別の作業ファイルを `--embed-connections` で渡す。内容は `{ sourceUrl, refId, src }` の配列。`refId` は本文変換で指定する接続 ID と一致させ、`src` は検証 origin と `/s/{slug}` 以下の対象ページに対して発行された接続 URL を使う。あらかじめ対象サイトの公開配信設定へ埋め込み origin を登録する。接続 URL は Studio の既存のページ接続設定に保存され、PageDocument と対応表には `src` を含めない。[ManagedEmbed の契約](managed-embed-contract.md)

```sh
npm run build
umask 077
node scripts/import-kamakura-site.mjs "$EXPORT" \
  --sha256 "$EXPORT_SHA256" --asset-dir "$ASSET_DIR" \
  --project "$PROJECT_ID" --site "$SITE_ID" --verification-origin "$VERIFICATION_ORIGIN" \
  > "$MAPPING_PREVIEW"
```

この実行はネットワークへ接続せず、元 JSON と原本ファイルを照合し、移行予定の対応表を出力する。フォーム接続がある場合は検証時と適用時に同じ `--embed-connections "$CONNECTIONS"` を追加する。取込を実行する場合は同じ指定に `--apply --origin "$STUDIO_ORIGIN"` を追加し、結果を別のファイルへ保存する。`STUDIO_ORIGIN` は管理用 Studio の HTTPS origin。

## 取込後の確認

- 同じ JSON、checksum、元素材、接続ファイル、サイト、owner を指定して再実行できる。確定した版を再作成せず、途中までの取込から続ける。異なるエクスポート、同じ path の別ページ、取込後に編集された取込対象は競合として停止する。
- 結果に元 URL → ページ ID と版、元素材 ID → 安定参照、元 CMS collection/item ID → 対象 ID と版を出す。検証予定の公開版と現行下書きのみを保持し、旧公開履歴を取り込まない。
- Studio のエディターで現行下書きを読み、版レコードから移行元の公開版と現行下書きを照合する。エディターと `niho-edit --studio assets-resolve` は対象サイト内の移行素材だけを解決する。公開用の素材解決は現行の公開原本 URL を使用し、原本バイトは SHA-256 ごとに非公開 R2 に保持する。
- 固定ページの公開ポインター、CMS release、CMS 公開予約、host と DNS は取込前の状態を保つ。検証ホストでの全体公開、公開ページとの比較、配信先の切替、非公開原本からの公開配信への切替は後続作業で行う。

## Studio API

`POST /api/edit/v2/sites/{siteId}/operations/site.migration-import` は `{ target: { projectId, siteId, verificationOrigin }, sourceDigest, action, payload }` を受け取る。`begin` は取込計画、`page` と `cms` は計画の digest と一致する各項目を受け付ける。`PUT /api/edit/v2/sites/{siteId}/operations/site.migration-import/{assetSha256}` は同じ owner の短期 token と `X-Import-Project`, `X-Import-Verification-Origin`, `X-Import-Source-Digest` の各ヘッダーを照合し、`application/octet-stream` の原本バイトを受け付ける。検証先の照合に失敗した場合は403、取込計画・対象版・既存の経路が衝突した場合は409、入力形式・checksum・サイズが要件を満たさない場合は400を返す。ページ本文は既存の版付き R2、CMS は既存の項目・翻訳 R2 に保存し、現在の版と取込受領記録を D1 のトランザクションで確定する。
