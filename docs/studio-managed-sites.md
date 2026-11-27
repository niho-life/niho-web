# Studio-native site 契約

Studio は Project、Site、メンバー、ページの版情報と公開履歴を D1 に保存し、固定ページの PageDocument 本文を非公開 R2 に保存する。固定ページの編集・管理・公開・復元は Studio GUI と共通 HTTP API で行う。未公開変更一覧と一括公開もGUI・`niho-edit --studio`で共有する。外部ホストとして登録されたサイトは、各ホストの編集 API と権限を使う。

## 作成と識別子

`PUBLIC_SITES_ORIGIN` に、Studio の管理 origin と異なる HTTPS origin を正確な origin 形式で設定し、非公開 R2 binding `CMS_OBJECTS` が利用できるときに Project 一覧の「新規プロジェクト」を有効にする。例は `https://sites.example.com`。path、query、fragment、credential を含む値は無効とする。

認証済みの人がタイトル、公開スラッグ、locale を送ると、`POST /api/projects` は最初の PageDocument を R2 に保存し、次を1つの D1 batch で作る。

- Project と Site
- 作成者を owner とする membership
- `managed_sites` の一意な公開スラッグ
- 未公開の home ページと revision 1
- 作成 audit

Project と Site の ID、ページの版はサーバーが発行する。共有公開 origin は `managed_sites` の登録から Project の表示に反映する。作成後の canonical editor URL は `/projects/{projectId}/sites/{siteId}/editor`。

## メンバー招待とログアウト

owner はメールアドレス、role、期限を指定してメンバーを招待する。招待 URL は作成時だけ返し、D1 には token の SHA-256 hash を保存する。受け取った人は指定のメールアドレスで Cloudflare Access にログインし、招待内容を確認してから明示的に承諾する。preview と accept は token、Project/Site、期限、未使用状態、認証済みメールを検証する。token が有効でも認証メールが招待先と異なる場合は `403 invitation_email_mismatch` を返し、招待先のメールアドレスは応答に含めない。

Studio は招待 URL を読み取った後、token をアドレス欄から除く。アカウント切替では同じ招待へ戻れるよう token をタブ単位の `sessionStorage` に最大10分だけ保持し、Cloudflare Access の logout `returnTo` には含めない。Access JWT、個人情報、招待 token をアプリのログには出さない。

Studio のログアウトは Cloudflare Access のセッションを終了し、同じ Access セッションを使う他のアプリからもログアウトする。ログアウト時に削除するのは本人の端末内にある未保存作業の復旧データだけで、サーバーに保存した下書きと公開済みの内容は維持する。

## ページ正本と操作

`managed_pages` は編集中の版、公開中の版、公開範囲を保持する。`managed_page_versions` は現在の下書きと公開済みの版の R2 キー、本文バイトの SHA-256、リンク索引を保持する。各版の PageDocument は `CMS_OBJECTS` の `sites/{siteId}/pages/{pageId}/{locale}/{revision}/{version}.json` に条件付き PUT で一度だけ保存する。R2 の保存後に D1 の参照を確定する。読取時はキーと文書が対象版に属すること、および本文の digest を照合する。

下書き保存リクエスト（GUI と Editing API）、`pages.apply` のリクエスト、保存する PageDocument のシリアライズ済み UTF-8 はそれぞれ 2 MiB まで。保存するたびに公開されなかった前の下書きの D1 版行を削除する。CLI の操作受領記録には確定時の R2 参照を残し、再送にはそのときの文書を返す。復元では選んだ公開版の内容を新しい版として R2 に保存し、編集中の版と公開中の版に設定する。保存・公開・ページ情報の更新は `current_version` を SQL の更新条件に含める。ページ作成は `page_catalog_version` と一覧の版を照合する。競合時は HTTP 409 `version_conflict` を返し、ページの下書き、公開ポインター、監査履歴は保持する。

D1 に本文が残る旧版は、初回読取時に元の JSON を `legacy.json` として同じ版の R2 キーに保存する。R2 の保存が成功したあとに D1 の参照とリンク索引を確定し、`document_json` を `{}` に置き換える。移行処理が途中で失敗した場合は D1 の本文から読める。

GUI のページ操作は次のとおり。

- page catalog と PageDocument snapshot の読取
- opaque version CASによる下書き保存
- 保存済みの現行版の公開、指定の公開版の復元（`pages.publish`）
- ページ作成、名前・URL・公開範囲の変更（`pages.change`）
- 通常ページの作成、タイトル・path更新、visibility更新

公開対象は「未公開変更」一覧で共有する。ページ編集画面からの公開はそのページの下書きを反映する。他のページは公開中の版から作る。共通設定の公開は全ページを公開中の版から再生成する。`publish --changed` は一覧の変更を一括して順に生成し、全URLを用意できた後に公開ポインターを1回だけ切り替える。生成に失敗した場合はポインターを切り替えない。`publish --all` はコード変更や移行時にCLIからだけ使う。

公開・復元・ページ管理は操作ごとに `expectedVersion` を持つ1要求で完結する。公開済みページのURL変更と公開範囲変更は、ページ情報・redirect・新しい manifest・公開ポインターを同じ batch で切り替える。CLI の discovery は呼び出し元に許可された操作を返す。D1 は Project/Site と現行の owner/editor 権限を照合し、ページ版・ポインター・監査記録を確定する。

## 公開配信

固定ページと CMS の一覧・詳細は公開操作の中で HTML、CSP、hreflang、JSON-LD、埋め込み参照、sitemap・robots・llms を生成し、内容 hash 付きの不変 R2 artifact と manifest を保存する。CMS の項目公開では新しいCMS公開版を使い、サイト全体を作り直す。HTMLが同じURLは、既存の生成物を使う。公開 Worker は登録 host、現在の manifest pointer、manifest、要求された artifact を読むだけで HTML を返す。manifest は hash key ごとに isolate 内で再利用し、host 対応表と公開 pointer は最大5秒だけキャッシュする。通常のページ表示で行う D1 lookup は host 解決と公開 pointer の2つだけで、ページ状態の再照合や manifest 全体の毎回検証はしない。sitemap と llms.txt は本文を読まず、目録の URL と metadata から生成する。

共有 origin の URL は `/s/{siteSlug}/`、主 host の URL は `/`。`managed_site_hosts` が host・path prefix・noindex・主 host の唯一の正本で、公開時の canonical、sitemap、hreflang はその主 host から生成する。独自ドメインの追加・DNS・Worker route は Cloudflare の運用手順に従う。host 設定を変えたときは、そのサイトの公開済み固定ページを再公開して、HTML と discovery file の URL を更新する。旧 `managed_sites.public_domain` / `public_domain_noindex` 列は新 Worker が参照しない。すべての rollback 対象 Worker から依存がなくなった後に `studio/post-deploy/0026_drop_managed_site_domain_mirror.sql` で削除する。

ページ URL の変更と非公開化はページ管理の1操作で新しい manifest を作る。公開 URL の移動は301 redirectになり、非公開ページは manifest と sitemap から外れる。サイト全体の公開履歴から戻すときは、対象 release の manifest pointer だけを切り替える。HTML は immutable、ブラウザーには `Cache-Control: no-cache` と ETag を返し、一致する `If-None-Match` には304で応答する。noindex host では HTML、SEO file、redirect、404、公開 runtime に `X-Robots-Tag: noindex, nofollow` を付け、robots は全体をDisallowし、sitemapとllmsの一覧は空にする。

固定ページ、CMS binding を持つページ、CMS route、sitemap・llms は公開 manifest から配信する。CMS の予約公開も同じ静的生成経路を使い、失敗があれば CMS 公開 pointer と manifest pointer の両方を切り替えない。サイト共通設定だけの再生成では route の `lastmod` を維持する。画像の幅別変換と、1サイトへの複数の独自 host 登録は対象外。

公開SEO出力は `/s/{siteSlug}/sitemap.xml`、`robots.txt`、`llms.txt`。ページ文書の metadata から canonical、robots、OG、title、description を出し、同じ path の翻訳が公開済みの場合だけ hreflang を付ける。公開応答は description・画像 alt・英語本文中の日本語、同じ言語の公開ページと重複する title/description、ページまたは CMS route が見つからないサイト内リンクを警告として返す。CMS route を取得できないときは警告の対象から外す。サイト名、説明、既定 OGP 画像、所有権確認タグ、組織 JSON-LD、robots 方針、GA4 を含む SEO 設定は公開許可設定と同じ版で管理し、GUI と `niho-edit --studio site-seo-read` / `site-seo-save` から読み書きする。固定ページ redirect は Studio GUI または `niho-edit --studio site-redirects-read` / `site-redirects-save` で管理し、ページ移動時に自動作成した redirect も同じ一覧へ反映する。旧データの取込みと95 URLの実サイト受入は未完了で、#489の残りとして扱う。

### 埋め込みと計測の設定

オーナーはプロジェクト設定の「公開配信」で iframe と画像・動画の HTTPS origin をそれぞれ登録する。origin は URL の正規化後に完全一致させる。たとえば YouTube は `https://www.youtube-nocookie.com` を登録する。カレンダーなどの公開 URL はエディターの「外部URL」から追加する。SEO設定には GA4 測定 ID とサイト共通 metadata を保存する。設定は次のページ公開で生成物へ反映する。初期状態で外部 iframe、外部の画像・動画、計測は読み込まない。

`GET /api/projects/{projectId}/sites/{siteId}/editor/public-settings` は `{ settings: { frameOrigins, resourceOrigins, seo }, version }` を返す。同じ URL への `POST` は `{ settings, expectedVersion }` を受け、版が古ければ 409 を返す。SEOだけを編集する `GET` / `POST /api/projects/{projectId}/sites/{siteId}/editor/seo-settings` は `{ settings, version }` を返し、同じ `public_policy_version` をCASに使う。CLI は `site-seo-read` で `{ settings, version }` を読み、編集したsnapshotを `site-seo-save --json` に渡す。古いWorkerとの互換性のため、GA4測定IDは既存public policyにも同じ値を保持する。計測を設定したサイトでは、`noindex` のページも含め、広告連携を無効にした Google tag を読み込む。GA4 を外す場合は `seo.ga4MeasurementId: null` を指定する。
固定ページ redirect は `GET` / `PUT /api/projects/{projectId}/sites/{siteId}/editor/redirects` で `{ redirects, version }` を読み書きする。`PUT` は `{ redirects, expectedVersion }` を受け、redirect専用版で競合を検出する。保存全体を一つのD1 batchで置き換える。配列要素は `{ locale, fromPath, toPath }` で、転送元はサイト内で一意。GUIは追加・一覧・削除を行い、CLIは `site-redirects-read` で取得したsnapshotを `site-redirects-save --json` で保存する。ページパス変更時もredirect版を進めるので、古いsnapshotの一括保存で自動作成redirectが消えることはない。

SEO settings の `robotsPolicy: "noindex"` はページの robots meta、`robots.txt`、`X-Robots-Tag`、sitemap/llmsの一覧に反映する。既定OGP画像は同一hostのroot-relative URL、または `resourceOrigins` に登録したHTTPS originだけを使う。組織データは検証済みの値からJSON-LDを生成し、所有権確認タグの内容はHTML属性としてescapeして出力する。鎌倉の旧公開経路は移行完了まで従来設定を維持する。

ページの CSP には、そのページで使う承認済みリソースの origin と必要な専用 JavaScript の URL を入れる。外部画像（`srcSet`、動画の poster、favicon、OG画像を含む）と外部動画は `resourceOrigins` に登録されたものだけが HTML に出る。CMS の一覧・詳細でも、公開素材 manifest と同じ許可リストを照合する。書体は文書で指定されたファミリー名を使う。文書に書体ファイルの URL を指定する入口はなく、書体ファイルの取得は許可しない。

GA4 には計測用に限定した接続先を許可する。標準操作の runtime と NIHO フォームの runtime は別々に必要なページでだけ読み込む。NIHO フォームは iframe 内で送信し、親ページの CSP は `form-action 'none'` を維持する。[ManagedEmbed の保存・公開契約](managed-embed-contract.md)

既存ページの埋め込みとカルーセルを標準描画へ移す手順は [鎌倉専用ブロックの移行](kamakura-block-migration.md)、移行元の版と素材を検証サイトへ保存する手順は [鎌倉サイトの取込](kamakura-site-import.md) を参照する。

## CLI認証

既存外部ホストと、operatorが明示的にgrantを設定済みのStudio-native siteは、従来のAccess service tokenと期限付きD1 grantを使える。新規Projectにservice grantがない場合は、Cloudflare Accessでmember本人が取得した短時間のapplication tokenを `cf-access-token` headerで受ける。Workerはブラウザと同じAccess JWT署名・issuer・audience・期限・subject・email検証を再利用し、さらに現在のD1 membershipへ固定する。人の CLI はこの短期 token を `NIHO_EDIT_TOKEN` で渡す。

CLIはtoken、service credential、Access subjectを標準出力へ含めない。操作IDを使う共通 API は、同じ actor・対象サイトの再送と異なる内容での操作ID再利用を区別する。取得手順は [Studio CLI](studio-cli.md) と [CloudflareのCLI向けAccess手順](https://developers.cloudflare.com/cloudflare-one/tutorials/cli/) を参照する。

## CMS

Studio-native site の Dashboard にある「CMS」から、初期コレクション「お知らせ」の項目を編集する。owner はコレクションを追加でき、owner と editor は下書き保存、確認付き公開、公開予約、予約取消、公開の取り下げ、削除、下書きへの復元を行える。公開中の項目は先に取り下げ、予約中の項目は先に予約を取り消す。初期実装は home の言語を CMS 全体に使う。公開リストは `/s/{slug}/cms` と `/s/{slug}/cms/posts`、詳細は `/s/{slug}/cms/posts/{itemSlug}`。固定ページ用にこの名前空間を割り当てることはできない。CMS release はこの route を不変 HTML として生成し、変更項目を使う一覧・詳細 route と discovery artifact を一つの manifest pointer 更新で公開する。本文はテキストで描画し、詳細の画像とギャラリーは snapshot の公開素材 manifest から描画する。素材付き項目の公開には Site の素材 resolver が必要。既定の Worker に resolver は設定していない。[公開素材の manifest](cms-v2-contract.md#公開素材の-manifest)

Studio の共通編集 API と CLI の経路は [CMS v2 契約](cms-v2-contract.md) を参照する。CMS の保存先は Studio の D1 と非公開 R2 binding `CMS_OBJECTS`。Kamakura などの外部ホストの編集先や権限は各ホストで管理する。個人情報・予約台帳・資格情報などは CMS に保存しない。

### PageDocument との結び付け

CMS bindings が生成した画像の参照は、ページ公開版が固定する CMS snapshot の公開素材 manifest から解決する。公開ページで実際に参照され、サイトの配信設定が許可した素材を renderer に渡す。CSP に登録するのも、ページ内で使う素材の origin に限る。

Studio の PageEditor は CMS list と detail を `CmsPageBindingsDocument` sidecar でページ要素へ結び付けます。sidecar は `managed_page_versions` の当該 revision と一緒に保存し、固定ページの公開版は不変 CMS `releaseId` と `schemaRevision` を固定します。公開 HTML はその release の項目だけから描画し、後から行う CMS 保存・schema 移行は過去の公開ページを書き換えません。CMS release の公開では、該当する CMS route と discovery artifact を生成し、CMS の公開版とサイト manifest pointer を一つの D1 batch で切り替えます。固定ページの明示的な公開は別操作で、その時点の CMS release を固定します。

編集 preview は actor、site/page、page version、CMS item revision に結び付いた5分・一回限り token を使い、公開配信や履歴へ下書きを含めません。schema 移行計画は保存中の全 page bindings を検査します。固定ページの公開要求は detail slug ごとの path を現在の固定ページ・予約 URL・CMS route と照合します。CMS image の公開表示は素材 manifest と配信を含む #379 / #380 完了後に有効になります。

## CMS の公開と復旧

CLI からの項目公開は `cms.publish-now` に項目版と operation ID を渡す1要求で受領します。同じ actor・ID・入力の再送は同じ受領結果を返します。`cms.operation-status` は公開ジョブの結果を返します。公開予約・複数項目の選択・定義移行は CMS v2 の各操作で扱います。

- 項目の revision、release snapshot、locale ごとの route table は `sites/{siteId}/items/...`、`sites/{siteId}/releases/...`、`sites/{siteId}/routes/{locale}/{revision}.json` に不変オブジェクトとして置く。D1 state は最後に公開した snapshot の route table revision を保持する。CMS の計画時はStudioで管理する固定・予約 pathと組み合わせた現行版を作り、公開 snapshot に保存する。R2 の条件付き PUT により、同じキーの内容を上書きしない。
- 項目 blob のキーは site、actor、operation ID、入力 digest、項目の識別子から決まり、R2 書込みの応答が不明でも同じ要求は同じ blob を再利用する。D1 に参照が確定していない blob は公開されない。
- オブジェクト保存後に、D1 batch で同一世代への CAS、revision の登録、受領記録、監査、outbox を確定する。配信前の公開は現在の snapshot のまま。必要なオブジェクトが揃い、予約時と現在の公開版・定義が一致した時点で、公開 pointer と outbox 完了を同じ batch で確定する。固定ページの公開は別処理。
- Cron は毎分、期限到来の outbox を60秒の lease で取得する。一時的な障害は間隔を空けて最大5回まで試す。lease を持つ処理が中断した場合、期限後に別の実行が取得できる。公開前提の不一致と再試行上限は `dead` に残り、現在の公開版を保つ。再実行は現行の公開版・定義・項目版から新しい確認計画を作る。
- サイトごとに、復元可能な削除済み項目を含めて500項目、同時に25件の公開・予約、D1で確定したR2履歴は100 MiBまで。公開・予約の1計画には最大500項目と25,000件の明示転送を指定できる。公開時はsnapshotとroute tableの各オブジェクトを履歴サイズに算入する。API本文は `cms.items.save` が128 KiB、`cms.release.plan` と `cms.schedule.create` が4 MiB、その他の操作が64 KiBまで。単一 snapshot は最大2 MiB（確認計画にも収まる大きさが必要）。確定済み履歴を自動削除する期限はなく、上限到達時は新規保存が409になる。未確定の孤立オブジェクトは公開にも使用済み容量にも含めない。
- 旧CMSの公開画像URLを移行した安定参照は、`sites/<siteId>/migration/legacy-assets.json` に保存するサイト専用manifestから解決する。manifestは非公開R2に置き、対象サイトに属する `kamakura-source` 参照だけを読み取る。画像ファイル自体は既存の公開URLから配信し、manifestが無い参照は公開できない。
- 死活確認は `managed_cms_outbox` の `kind`、`state`、`attempts`、`available_at`、`failure` を対象にする。失敗したジョブの行や公開ポインターは直接更新せず、現行版から再計画する。

### エクスポートと復元演習

1. 管理リクエストの書込みとCronを停止した隔離環境で、D1を `wrangler d1 export <DB> --output studio.sql` で書き出す。同じ時点の非公開 R2 bucket の `sites/` を、権限を限定した S3 互換クライアントで全件コピーし、キー、サイズ、SHA-256 の一覧を付ける。wrangler の `--local` または `--remote` は対象環境を明示する。SQL と R2 のコピーは同じ復元セットとして暗号化し、CMS の書込み再開より先に照合する。期限付きのトークン行が含まれるため共有範囲を運用担当者に限定する。[D1 のエクスポート](https://developers.cloudflare.com/d1/best-practices/import-export-data/) [R2 の S3 API](https://developers.cloudflare.com/r2/api/s3/api/)
2. 新しいローカルまたは隔離 D1 に `wrangler d1 execute <DB> --file studio.sql --local` で読み込む。別の非公開 bucket に元のキーのまま R2 オブジェクトを戻し、サイズ・ハッシュと `managed_page_versions` / `managed_page_operations` / `managed_cms_revisions` / `managed_cms_releases` / 未処理の outbox が参照するキーを照合する。確認用の設定で D1 と bucket をバインドする。復元検証が終わるまで Cron を起動しない。
3. CMS の下書き API と公開一覧・詳細を読み、公開中と最新下書きが異なる場合はその状態が保たれていることを比較する。別サイトの snapshot / preview を表示できないこと、既存操作IDの受領記録が引けること、予約を再開する際に現行の owner / grant を満たすことを確認する。
4. ローカルの自動演習は `node --test test/studio-managed-sites.test.mjs`。テストは SQLite と条件付き PUT を検証する R2 fixture を同じ時点でエクスポートし、別インスタンスへ復元して公開 HTML、snapshot、下書きの revision を比較する。実際の Cloudflare リソースは利用しない。
