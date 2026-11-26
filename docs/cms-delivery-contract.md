# 外部ホストへの CMS 配信契約

Studio を正本とする CMS の公開版を、外部ホストのビルドへ渡します。配信単位は Site・locale ごとの CMS 全体です。外部ホストは固定ページの版とは別に CMS の版を選び、公開サイトは配備済みの成果物から描画します。詳細は [Studio CMS の正本と公開単位](adr/0001-platform-cms-source-and-publication.md) を参照してください。

## 接続と権限

Studio 管理画面と同じ origin から、Site の owner が次の HTTPS API を使います。発行と失効は空の body と同一 origin の `Origin` / `Sec-Fetch-Site` を要求します。

| メソッドとパス | 結果 |
| --- | --- |
| `GET /api/projects/{projectId}/sites/{siteId}/cms/delivery/credentials` | owner が有効な資格IDと発行時刻を読む |
| `POST /api/projects/{projectId}/sites/{siteId}/cms/delivery/credentials` | `201` と `{ credentialId, secret }` を一度だけ返す |
| `DELETE /api/projects/{projectId}/sites/{siteId}/cms/delivery/credentials/{credentialId}` | 該当 Site の資格を失効し `204` を返す |
| `GET /api/projects/{projectId}/sites/{siteId}/cms/delivery/{locale}/status` | owner / editor が現行 release の `idle` / `pending` / `failed` / `deployed` を読む |

資格は1 Site の公開 snapshot、公開通知、ack 専用です。ホストのビルドと配備の秘密ストアに保存してください。資格IDは失効時に使います。発行・失効の操作は資格の秘密を含めず監査に記録します。Site ごとに最大8件を並行して使えます。更新は新しい鍵を発行し、ビルド・配備の設定を置き換えてから古い鍵を失効します。

Studio Worker は専用の `CMS_DELIVERY_MASTER_KEY`（32バイトのランダム値を小文字 hex で表記）から、Site と資格IDごとの HMAC 鍵を導出します。D1 に保存する SHA‑256 の確認値は署名に使えません。Worker の master key 更新は既存の配信資格をすべて無効にします。運用時はサービス用パス `/api/cms-delivery/v1/sites/*` だけをホストが Access の人向けログインなしで呼べるようにし、Studio 管理APIは引き続き Access で保護します。配信 API 自体は全要求で以下の署名を照合します。

`X-Cms-Credential` は発行ID、`X-Cms-Timestamp` は10桁の UTC Unix 秒、`X-Cms-Signature` は HMAC-SHA-256 の小文字 hex です。署名対象は次の行を LF で連結した UTF‑8 です。末尾 LF は含めません。

```text
niho-cms-delivery-v1
HTTP method
Site ID
request path
timestamp
credential ID
SHA-256 of raw body, lowercase hex
```

GET の body は空です。POST は UTF‑8 の `application/json` です。query string は受け付けません。時刻はサーバーとの差が120秒以内で、再送の副作用は ack の冪等性で防ぎます。公式クライアントは指定した HTTPS origin だけに要求を送り、リダイレクトを拒否します。

## 公開 snapshot と通知

基点は `/api/cms-delivery/v1/sites/{siteId}` です。

| メソッドと相対パス | 内容 |
| --- | --- |
| `GET /{locale}/snapshot` | その locale の現行 CMS snapshot |
| `GET /{locale}/snapshot/{releaseId}` | 指定した公開済み release の不変 snapshot |
| `POST /events` | `{ afterSequence }` から公開イベントを最大25件読み、`{ events, nextSequence }` を返す。初回は `0` |
| `POST /{locale}/ack` | 現行の snapshot を使った配備結果を記録する |

snapshot は全コレクションの定義、公開項目版、CMS 一覧・詳細・転送のルート、公開素材 manifest を含みます。Studio 内部ルート表の固定ページや未公開の予約、項目や翻訳の下書き、プレビュー資格は配信に含みません。snapshot は `contractVersion: 2`、公開 renderer は `X-Cms-Renderer-Version: 1`、応答 body の UTF‑8 バイトに対する SHA‑256 は strong ETag の `"sha256-{digest}"` に入ります。一致する `If-None-Match` には `304` を返します。移行前に公開済みの版は現行 pointer から読めます。イベント履歴と過去版の固定 ID 取得は導入後に確定した release が対象です。

公開 pointer、履歴、通知イベントは同じ D1 transaction で確定します。通知には Site、locale、その Site 内の `sequence`、`eventId`、`releaseId`、`snapshotDigest`、`rendererContractVersion` が入ります。`eventId` は release ID と同じです。ホスト側の通知 adapter は自分の durable cursor からイベントを取得し、ビルド依頼を確定した後に cursor を保存します。失敗したときは同じ cursor から読み直し、受信済みのイベントは Site とイベント ID で重複排除します。通知はビルドの合図であり、通知だけでは配備完了になりません。新しい版が出ていたら最新の snapshot を取り直します。

Kamakura の受信・配備 adapter と実サイトの受入は移行時に接続します。現在の Studio API はホストがイベントを取りに来る方式を提供します。ホストが登録した URL へ Studio から HTTP を送信する機能は対象外です。

## ビルドと配備

`@niho/web/cms-delivery` は React 非依存の Node 22 以上向けビルド用クライアントです。Astro / Next.js のサーバー側ビルド工程で使います。

```ts
import { createCmsDeliveryClient, cmsDeliveryRoutes } from "@niho/web/cms-delivery";

const delivery = createCmsDeliveryClient({
  origin: process.env.STUDIO_ORIGIN!,
  siteId: process.env.STUDIO_CMS_SITE_ID!,
  credentialId: process.env.STUDIO_CMS_CREDENTIAL_ID!,
  secret: process.env.STUDIO_CMS_DELIVERY_SECRET!,
  rendererContractVersion: 1
});

const cms = await delivery.snapshot("ja");
const { lists, details, redirects } = cmsDeliveryRoutes(cms.snapshot);
```

Astro は `getStaticPaths`、Next.js はビルド時の `generateStaticParams` で `details` を利用できます。同じ snapshot から一覧データと転送設定も生成します。`assetManifest` のルート相対URLは、成果物を配備するホスト自身がそのパスで素材を公開する契約です。公開ページに通信クライアントの設定を含めず、静的なデータと必要な素材参照だけを成果物に収めます。

任意の `CmsDeliveryCache` をビルド側に渡すと、検証した body と ETag を origin・Site・locale・取得パスごとに保存し、次のビルドで条件付き取得に使います。ヘッダーの renderer 版、scope、snapshot の形、配信ルート、素材参照、body と ETag の一致を照合します。Studio の停止や契約の不一致、検証の失敗で新しいビルドは止まります。静的な成果物を配備した公開サイトは、Studio に接続せず表示を続けられます。

配備後に、成果物と一緒に固定した `releaseId` / `snapshotDigest` / `rendererContractVersion` と不透明な `artifactId` を使い、`delivery.acknowledge(locale, { state: "deployed", ... })` を呼びます。配備までに失敗した場合は同じ release / digest / renderer 版で `state: "failed"` を送り、前の成果物を維持します。失敗 ack に `artifactId` は不要です。配備成功後に同じ内容を再送しても記録時刻は変わりません。古い release、異なる digest、違う成果物による成功記録の上書き、成功後の失敗は `409` で拒否します。対応外の renderer 版は `400` です。ack は配備結果だけを記録し、Studio の公開 pointer を動かしません。
