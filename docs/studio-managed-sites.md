# Studio-native site 契約

Studio で作成した Project、Site、メンバー、ページの下書きと公開履歴は Studio の D1 に保存する。固定ページの管理・公開・復元は Studio GUI で行う。共通 HTTP API は固定ページの読み取りと編集を扱い、対応コマンドは `niho-edit --studio` で呼び出せる。外部ホストとして登録されたサイトは、各ホストの編集 API と権限を使う。

## 作成と識別子

`PUBLIC_SITES_ORIGIN` に、Studio の管理 origin と異なる HTTPS origin を正確な origin 形式で設定したときだけ、Project 一覧の「新規プロジェクト」を有効にする。例は `https://sites.example.com`。path、query、fragment、credential を含む値は無効とする。

認証済みの人がタイトル、公開スラッグ、localeを送ると、`POST /api/projects` は次を1つの D1 batch で作る。

- Project と Site
- 作成者を owner とする membership
- `managed_sites` の一意な公開スラッグ
- 未公開の home ページと revision 1
- 作成 audit

Project と Site の ID、ページの版はサーバーが発行する。共有公開 origin は `managed_sites` の登録から Project の表示に反映する。作成後の canonical editor URL は `/projects/{projectId}/sites/{siteId}/editor`。

## ページ正本と操作

`managed_pages` は編集中の版、公開中の版、公開範囲を保持する。`managed_page_versions` に現在の下書きと公開済みの版を保存し、下書きを保存するたびに公開されなかった前の下書きを削除する。復元では選んだ公開版の内容を新しい版として保存し、編集中の版と公開中の版に設定する。保存・公開・ページ情報の更新は `current_version` を SQL の更新条件に含める。競合時は HTTP 409 を返す。確認の有効期限は10分で、確認時の対象版と操作を実行時に照合する。

GUI のページ操作は次のとおり。

- page catalog と PageDocument snapshot の読取
- opaque version CASによる下書き保存
- 現在版の公開計画・公開
- 公開済みの指定revisionへの復元計画・反映
- 通常ページの作成、タイトル・path更新、visibility更新

URL 変更・非公開化の確認画面では、サイト内の他ページの下書きと公開版からリンク元を集計する。CLI の discovery は共通 API が公開する操作のうち呼び出し元に許可された操作を返す。すべての読取・変更は、そのrequest時点の D1 owner/editor membership と Project/Site を照合する。別siteのpage、plan、version、公開pointerは変更できない。

## 共有公開origin

既存の Studio Worker は `PUBLIC_SITES_ORIGIN` の `GET` / `HEAD /s/{siteSlug}/...` を従来の動的 renderer で配信する。ホームの公開 URL は `/s/{siteSlug}/`。Worker はrequest originの完全一致を先に確認する。公開ページと build が生成した `/_niho/` 配下の専用 JavaScript だけを公開し、管理画面の asset や Access 応答は公開 origin から返さない。静的な公開 Worker のentry/configとR2 artifact配信経路も追加済みだが、公開hostの切替・release配備への組込み前なので、既存の共有originの配信先はまだ変わらない。

公開対象はvisibilityがpublicで、現在の `published_revision` が指す不変PageDocumentだけである。root-relativeな本文リンク、画像、poster、favicon、OG画像には描画時に `/s/{siteSlug}` を付ける。保存文書は書き換えない。既存のserver-safe rendererとhead resolverを使い、title、canonical、robots/noindexを反映する。

オーナーはプロジェクト設定で一意な公開ホスト名を1つ登録できる。Workerに届いたHTTPS hostが登録と完全一致する場合、そのサイトを選び、prefixのない `/`・`/en/...`・CMS pathを同じ公開rendererで返す。登録の変更だけではDNSやWorker routeを設定しない。フォーム接続は現在登録されているhostとpathに固定するため、公開hostを切り替えた後はフォーム参照を再接続してページを再公開する。

従来の動的 renderer は公開HTMLをGET時にCloudflare edgeで最大5分キャッシュする。静的公開Workerはhost対応表とmanifest pointerをisolate内で最大5秒保持し、D1で現在のmanifest pointer・ページ公開状態・host登録を照合してからHTMLを返す。HTML Cache API keyにはhost origin・site ID・manifest publication ID・本文digestを含め、再公開後は別keyを使う。ブラウザーには `Cache-Control: no-cache` とHTMLのETagを返し、一致する `If-None-Match` には304で応答する。NIHO接続URLの解決応答は引き続き `no-store` とする。buildが出すJavaScriptは内容hash付きのURLで1年間immutableにする。

独自ドメインの noindex が有効な場合、HTML・SEOファイル・リダイレクト・404・公開runtimeの全応答に `X-Robots-Tag: noindex, nofollow` を付ける。`robots.txt` は全体をDisallowし、sitemapとllmsの一覧は空にする。

既存の共有公開originはリクエスト時にD1の公開版から描画する。静的公開Workerは公開時に生成したHTMLをR2から返すが、配備・host切替は未実施。CMS bindingを持つページの静的生成、画像の幅別変換、1サイトへの複数host登録は未対応。

公開SEO出力は `/s/{siteSlug}/sitemap.xml`、`robots.txt`、`llms.txt`、`llms-full.txt`。ページ文書のmetadataからcanonical、robots、OG、title、descriptionを出し、同じpathの翻訳が公開済みの場合だけhreflangを足す。ページのJSON-LD、CMS詳細・一覧のJSON-LD、301リダイレクト、404も公開rendererが返す。公開計画はdescription・画像alt・英語本文中の日本語、同じ言語の公開ページと重複するtitle/description、ページまたはCMS routeが見つからないサイト内リンクを警告として返し、公開自体は止めない。CMS routeの照合に失敗した場合も公開計画は続行する。サイト名、説明、既定OGP画像、所有権確認タグ、組織JSON-LD、robots方針、GA4を含むSEO設定は、公開許可設定と同じ版で管理する。GUI と `niho-edit --studio site-seo-read` / `site-seo-save` から読み書きでき、公開HTMLへ反映する。旧リダイレクト18件の取込みと静的公開Workerのdiscovery file配信は未対応で、#489の残りとして扱う。

### 埋め込みと計測の設定

オーナーはプロジェクト設定の「公開配信」で iframe と画像・動画の HTTPS origin をそれぞれ登録する。origin は URL の正規化後に完全一致させる。たとえば YouTube は `https://www.youtube-nocookie.com` を登録する。カレンダーなどの公開 URL はエディターの「外部URL」から追加する。SEO設定には GA4 測定 ID とサイト共通 metadata を保存する。設定は公開済みページにも反映される。初期状態で外部 iframe、外部の画像・動画、計測は読み込まない。

`GET /api/projects/{projectId}/sites/{siteId}/editor/public-settings` は `{ settings: { frameOrigins, resourceOrigins, seo }, version }` を返す。同じ URL への `POST` は `{ settings, expectedVersion }` を受け、版が古ければ 409 を返す。SEOだけを編集する `GET` / `POST /api/projects/{projectId}/sites/{siteId}/editor/seo-settings` は `{ settings, version }` を返し、同じ `public_policy_version` をCASに使う。CLI は `site-seo-read` で `{ settings, version }` を読み、編集したsnapshotを `site-seo-save --json` に渡す。古いWorkerとの互換性のため、GA4測定IDは既存public policyにも同じ値を保持する。計測を設定したサイトでは、`noindex` のページも含め、広告連携を無効にした Google tag を読み込む。GA4 を外す場合は `seo.ga4MeasurementId: null` を指定する。

SEO settings の `robotsPolicy: "noindex"` はページの robots meta、`robots.txt`、`X-Robots-Tag`、sitemap/llmsの一覧に反映する。既定OGP画像は同一hostのroot-relative URL、または `resourceOrigins` に登録したHTTPS originだけを使う。組織データは検証済みの値からJSON-LDを生成し、所有権確認タグの内容はHTML属性としてescapeして出力する。鎌倉の旧公開経路は移行完了まで従来設定を維持する。

ページの CSP には、そのページで使う承認済みリソースの origin と必要な専用 JavaScript の URL を入れる。外部画像（`srcSet`、動画の poster、favicon、OG画像を含む）と外部動画は `resourceOrigins` に登録されたものだけが HTML に出る。CMS の一覧・詳細でも、公開素材 manifest と同じ許可リストを照合する。書体は文書で指定されたファミリー名を使う。文書に書体ファイルの URL を指定する入口はなく、書体ファイルの取得は許可しない。

GA4 には計測用に限定した接続先を許可する。標準操作の runtime と NIHO フォームの runtime は別々に必要なページでだけ読み込む。NIHO フォームは iframe 内で送信し、親ページの CSP は `form-action 'none'` を維持する。[ManagedEmbed の保存・公開契約](managed-embed-contract.md)

既存ページの埋め込みとカルーセルを標準描画へ移す手順は [鎌倉専用ブロックの移行](kamakura-block-migration.md) を参照する。

## CLI認証

既存外部ホストと、operatorが明示的にgrantを設定済みのStudio-native siteは、従来のAccess service tokenと期限付きD1 grantを使える。新規Projectにservice grantがない場合は、Cloudflare Accessでmember本人が取得した短時間のapplication tokenを `cf-access-token` headerで受ける。Workerはブラウザと同じAccess JWT署名・issuer・audience・期限・subject・email検証を再利用し、さらに現在のD1 membershipへ固定する。人の CLI はこの短期 token を `NIHO_EDIT_TOKEN` で渡す。

CLIはtoken、service credential、Access subjectを標準出力へ含めない。操作IDを使う共通 API は、同じ actor・対象サイトの再送と異なる内容での操作ID再利用を区別する。取得手順は [Studio CLI](studio-cli.md) と [CloudflareのCLI向けAccess手順](https://developers.cloudflare.com/cloudflare-one/tutorials/cli/) を参照する。

## CMS

Studio-native site の Dashboard にある「CMS」から、初期コレクション「お知らせ」の項目を編集する。owner はコレクションを追加でき、owner と editor は下書き保存、確認付き公開、公開予約、予約取消、公開の取り下げ、削除、下書きへの復元を行える。公開中の項目は先に取り下げ、予約中の項目は先に予約を取り消す。初期実装は home の言語を CMS 全体に使う。公開リストは `/s/{slug}/cms` と `/s/{slug}/cms/posts`、詳細は `/s/{slug}/cms/posts/{itemSlug}`。固定ページ用にこの名前空間を割り当てることはできない。本文はテキストで描画し、詳細の画像とギャラリーは snapshot の公開素材 manifest から描画する。素材付き項目の公開には Site の素材 resolver が必要。既定の Worker に resolver は設定していない。[公開素材の manifest](cms-v2-contract.md#公開素材の-manifest)

Studio の共通編集 API と CLI の経路は [CMS v2 契約](cms-v2-contract.md) を参照する。CMS の保存先は Studio の D1 と非公開 R2 binding `CMS_OBJECTS`。Kamakura などの外部ホストの編集先や権限は各ホストで管理する。個人情報・予約台帳・資格情報などは CMS に保存しない。

### PageDocument との結び付け

CMS bindings が生成した画像の参照は、ページ公開版が固定する CMS snapshot の公開素材 manifest から解決する。公開ページで実際に参照され、サイトの配信設定が許可した素材を renderer に渡す。CSP に登録するのも、ページ内で使う素材の origin に限る。

Studio の PageEditor は CMS list と detail を `CmsPageBindingsDocument` sidecar でページ要素へ結び付けます。sidecar は `managed_page_versions` の当該 revision と一緒に保存し、公開時に page publication が不変 CMS `releaseId` と `schemaRevision` を固定します。公開 HTML はその release の項目だけから描画し、後から行う CMS 保存・schema 移行は過去の公開ページを書き換えません。CMS 公開と固定ページ公開は別の操作で、両者の原子切替はありません。

編集 preview は actor、site/page、page version、CMS item revision に結び付いた5分・一回限り token を使い、公開配信や履歴へ下書きを含めません。schema 移行計画は保存中の全 page bindings を検査します。公開計画は detail slug ごとの path を現在の固定ページ・予約 URL・CMS route と照合します。CMS image の公開表示は素材 manifest と配信を含む #379 / #380 完了後に有効になります。

## CMS の公開と復旧

- 項目の revision、release snapshot、locale ごとの route table は `sites/{siteId}/items/...`、`sites/{siteId}/releases/...`、`sites/{siteId}/routes/{locale}/{revision}.json` に不変オブジェクトとして置く。D1 state は最後に公開した snapshot の route table revision を保持する。CMS の計画時はStudioで管理する固定・予約 pathと組み合わせた現行版を作り、公開 snapshot に保存する。R2 の条件付き PUT により、同じキーの内容を上書きしない。
- 項目 blob のキーは site、actor、operation ID、入力 digest、項目の識別子から決まり、R2 書込みの応答が不明でも同じ要求は同じ blob を再利用する。D1 に参照が確定していない blob は公開されない。
- オブジェクト保存後に、D1 batch で同一世代への CAS、revision の登録、受領記録、監査、outbox を確定する。配信前の公開は現在の snapshot のまま。必要なオブジェクトが揃い、予約時と現在の公開版・定義が一致した時点で、公開 pointer と outbox 完了を同じ batch で確定する。固定ページの公開は別処理。
- Cron は毎分、期限到来の outbox を60秒の lease で取得する。一時的な障害は間隔を空けて最大5回まで試す。lease を持つ処理が中断した場合、期限後に別の実行が取得できる。公開前提の不一致と再試行上限は `dead` に残り、現在の公開版を保つ。再実行は現行の公開版・定義・項目版から新しい確認計画を作る。
- サイトごとに、復元可能な削除済み項目を含めて500項目、同時に25件の公開・予約、D1で確定したR2履歴は100 MiBまで。公開・予約の1計画には最大500項目と25,000件の明示転送を指定できる。公開時はsnapshotとroute tableの各オブジェクトを履歴サイズに算入する。API本文は `cms.items.save` が128 KiB、`cms.release.plan` と `cms.schedule.create` が4 MiB、その他の操作が64 KiBまで。単一 snapshot は最大2 MiB（確認計画にも収まる大きさが必要）。確定済み履歴を自動削除する期限はなく、上限到達時は新規保存が409になる。未確定の孤立オブジェクトは公開にも使用済み容量にも含めない。
- 旧CMSの公開画像URLを移行した安定参照は、`sites/<siteId>/migration/legacy-assets.json` に保存するサイト専用manifestから解決する。manifestは非公開R2に置き、対象サイトに属する `kamakura-source` 参照だけを読み取る。画像ファイル自体は既存の公開URLから配信し、manifestが無い参照は公開できない。
- 死活確認は `managed_cms_outbox` の `kind`、`state`、`attempts`、`available_at`、`failure` を対象にする。失敗したジョブの行や公開ポインターは直接更新せず、現行版から再計画する。

### エクスポートと復元演習

1. 管理リクエストの書込みとCronを停止した隔離環境で、D1を `wrangler d1 export <DB> --output studio.sql` で書き出す。同じ時点の非公開 R2 bucket の `sites/` を、権限を限定した S3 互換クライアントで全件コピーし、キー、サイズ、SHA-256 の一覧を付ける。wrangler の `--local` または `--remote` は対象環境を明示する。SQL と R2 のコピーは同じ復元セットとして暗号化し、CMS の書込み再開より先に照合する。期限付きのトークン行が含まれるため共有範囲を運用担当者に限定する。[D1 のエクスポート](https://developers.cloudflare.com/d1/best-practices/import-export-data/) [R2 の S3 API](https://developers.cloudflare.com/r2/api/s3/api/)
2. 新しいローカルまたは隔離 D1 に `wrangler d1 execute <DB> --file studio.sql --local` で読み込む。別の非公開 bucket に元のキーのまま R2 オブジェクトを戻し、サイズ・ハッシュと `managed_cms_revisions` / `managed_cms_releases` / 未処理の outbox が参照するキーを照合する。確認用の設定で D1 と bucket をバインドする。復元検証が終わるまで Cron を起動しない。
3. CMS の下書き API と公開一覧・詳細を読み、公開中と最新下書きが異なる場合はその状態が保たれていることを比較する。別サイトの snapshot / preview を表示できないこと、既存操作IDの受領記録が引けること、予約を再開する際に現行の owner / grant を満たすことを確認する。
4. ローカルの自動演習は `node --test test/studio-managed-sites.test.mjs`。テストは SQLite と条件付き PUT を検証する R2 fixture を同じ時点でエクスポートし、別インスタンスへ復元して公開 HTML、snapshot、下書きの revision を比較する。実際の Cloudflare リソースは利用しない。
