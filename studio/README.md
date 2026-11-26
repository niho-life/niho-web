# NIHO Web Studio host

> 2026-10-22: Experience / Kamakura のvisual editorは凍結した。canonical・alias・stagingの既知editor URLはAccess認証後に凍結案内を表示し、editor APIはmembership確認後に `409 visual_editor_frozen` を返して上流を呼ばない。`integration-entry`、各site editor、`PageEditor` は実client bundleへ含めない。source/coreと保存データは将来用に保持するが、サイト変更のpreview一致・schema同期・版同期を受入条件にしない。Dashboard、membership、招待は継続する。以下のBFF説明は再接続時の履歴資料である。
>
> 2026-10-25（niho-life/kamakura-site#84）: Kamakura だけ読み取りを再接続した。`GET catalog`・`GET :pageId`・素材の参照は service binding で kamakura-site へ通し、Kamakura の editor route だけ editor 用 CSP を付ける。保存・公開を止めるのは kamakura-site 側で、ページ文書の `readOnly` を `PageEditor` が読み取り専用の帯として出し、上流の `409 visual_editor_frozen` は競合（`conflict`）と分けて `409 { "error": "visual_editor_frozen" }` で返す。凍結の切り替えは kamakura-site の `worker/visual-freeze.ts` 1 か所。Experience は従来どおり凍結し、上流を呼ばない。
>
> 2026-10-28: Kamakura の native 化済みページはサイト側の段階解除で Studio から日本語の保存・公開が可能。原文ページの保存 locale `ja` と翻訳設定の原文 mapping `ja-JP` は PageEditor 内で区別し、日英切替後もページ一覧の保存 locale に戻る。Experience は凍結中。
>
> 鎌倉の Blank 埋め込みは、公開ホストと同じ `public-map` key / OpenStreetMap の固定URLを Studio に登録する。Studioの編集カードは接続済みとなり、previewだけ iframe を作る。Studio Workerの `frame-src` は鎌倉 editor route に限って当該pathを許可する。
>
> フォームの完了ページ候補は鎌倉の検証済み catalog の固定通常ページから、公開済みの完了ページだけを返す。英語側は対応する完了ページがないため候補を返さない。本文にはページIDだけを保存し、実送信と成功判定・移動は鎌倉ホスト側の接続が必要。

Issue #68 / #69 / #70 の Studio host です。共有 `@niho/web` ライブラリとは別に Cloudflare Workers へ配置し、静的 React UI、Worker API、Studio 専用 D1 registry、Experience / Kamakura editor BFF を1つの境界として運用します。

## この host が所有するもの

- Cloudflare Access の Google ログイン後に使う Studio shell
- セッション確認中はスピナーだけを表示し、認証エラーや期限切れは別の案内を表示する
- `1 Project = 1 Site` の registry と `owner` / `editor` membership
- owner による期限付き one-time 招待、権限変更、参加解除、招待取消
- `project-kamakura` / `kamakura` と `project-experience` / `experience` の安定した Project / Site ID
- 参加 Project の一覧と、Project・Site ID を含む安定 URL の Dashboard、人向けの固定別名 URL
- Studioで作成したProject/Siteと、そのページ下書き・公開版・公開履歴のD1正本
- Studio-native siteを共有HTTPS originの `/s/<slug>/...` で配信するscriptなしの公開renderer
- `project-experience` / `experience` に限定した、下書き・プレビュー・公開・公開版への復元用 editor BFF
- `project-kamakura` / `kamakura` に限定し、Cloudflare service binding で `kamakura-site` の新形式共通ページだけへ接続する editor BFF

D1 が Project / Site / Member / Role / Invitation / Audit の正本です。NIHO account、niho-app の User / Project DB、NIHO cookie、Cloudflare dashboard membership は権限根拠にしません。Kamakura の content CMS はそのサイト側、Experience の contributor content は niho-app 側に残ります。

## Project URL

既存の Project / Site ID 付き URL は引き続き有効です。読みやすい入口として、各 Project に固定 alias を用意しています。`/admin` は Dashboard、`/admin/editor` はサイト編集画面です。

| Project | Dashboard | Editor |
| --- | --- | --- |
| Kamakura (`project-kamakura` / `kamakura`) | `/projects/kamakura-site/admin` | `/projects/kamakura-site/admin/editor` |
| NIHO Experience (`project-experience` / `experience`) | `/projects/niho-experience/admin` | `/projects/niho-experience/admin/editor` |

覚えやすい入口として `/project/<別名>`（例: `/project/kamakura-site`）も使えます。Worker が認証の後に `/projects/<別名>/admin` へ 301 で移します。

### Studio-native site

`PUBLIC_SITES_ORIGIN` がStudioの管理originと異なる有効なHTTPS originなら、Project一覧からタイトル、公開スラッグ、言語を指定して新規作成できます。作成者をownerとするProject/Site、managed登録、未公開homeを1つのD1 batchで作り、`/projects/<Project>/sites/<Site>/editor` の共通 `PageEditor` を開きます。下書き保存、公開、公開済み版への復元、通常ページの作成・更新・visibility変更を提供します。

公開originは、たとえば `https://sites.example.com` の1つだけを設定し、各サイトを `https://sites.example.com/s/<slug>/...` で分離します。Workerはこのoriginで `GET` / `HEAD /s/...` だけを扱い、他pathは404です。現在のvisibleな公開revisionだけを既存rendererで描画し、root-relative linkをsite prefixへ射影します。scriptは描画せず、制限的なCSPを付けます。サイトごとのcustom domainやGit接続は作りません。

D1 schema、CAS、確認plan、GUI/CLI共通操作、公開rendererの詳細は [Studio-native site契約](../docs/studio-managed-sites.md) を参照してください。

Studio-native CMS は Dashboard の「CMS」または `/projects/<Project>/sites/<Site>/cms` にあります。R2 binding `CMS_OBJECTS` に非公開 bucket を割り当て、D1 migration `0013_managed_cms.sql` と `0014_cms_page_bindings.sql` を適用してから Worker を接続します。Cronは毎分、予約を含む outbox を処理します。ローカルの復元演習、公開ルート、保持期間・容量は運用契約を参照してください。[Studio-native site契約](../docs/studio-managed-sites.md#cms-の公開と復旧)

CMS 項目の翻訳は同じ画面の翻訳 workspace から手入力・確認し、`cms.localization.release.plan` / `apply` で target locale の CMS 全体 snapshot を公開します。公開対象は現行原文 snapshot の項目に限り、未完了・未確認・原文と版がずれた訳文は省略されます。日本語を代わりに表示しません。安全な parser / serializer がない rich-text 項目も省略されます。公開 route は `/en/cms/...` または `/ja/cms/...` です。editor は訳文を公開でき、CMS 定義の変更・適用は owner に限ります。固定ページ公開と CMS snapshot は別々に切り替わります。[CMS v2 契約](../docs/cms-v2-contract.md#cms-項目の翻訳と-locale-snapshot)

### サイト機能（鎌倉）

鎌倉の Dashboard は「ホーム・CMS・素材・翻訳・アナリティクス」を表示します。CMS は Studio のコレクション画面、翻訳は Studio の翻訳画面、ページと共通コンポーネントはデザインエディタで扱います。素材の入口はエディタと CMS の画像欄です。旧サイト管理画面の埋め込みと切替設定は撤廃しました。

各機能には `/projects/<別名>/admin/cms`・`/assets`・`/translations` などの Studio 内の URL があり、`/project/<別名>/cms` からも入れます。この URL に含まれる `/admin` は Studio の Dashboard の経路であり、鎌倉サイトの旧 `/admin` とは別です。

- `GET /api/projects/<Project>/sites/<Site>/site-admin` は、D1 の現行 owner / editor にだけ `{ "connected": true }` を返します。未接続サイトは 404 `not_connected` です。
- 鎌倉の Dashboard HTML の CSP は、CMS・翻訳の画像本体の直接 PUT 先を `connect-src` に、翻訳プレビューの枠だけを `frame-src` に許します。旧管理画面と Access のログイン画面は枠に許しません。editor の CSP と `frame-ancestors 'none'` は変えません。
- Studio の CMS は `CollectionWorkspace` と `createKamakuraCmsAdapter`、翻訳は `LocalizationWorkspace` と `createKamakuraLocalizationAdapter` を使います。原文が CMS の項目なら Studio の該当項目へのリンクを表示します。

## 認証・認可境界

Cloudflare Access 側で Studio hostname 全体を Access application として保護します。そのうえで Worker は静的 HTML/JS/CSS と API の全 request について `Cf-Access-Jwt-Assertion` を検証します。

- `alg=RS256` と `kid` を確認し、設定した issuer の `/cdn-cgi/access/certs` から取得した JWKS で署名検証する
- `iss`、Access application の `aud`、`exp`、`iat`、任意の `nbf` を検証する
- app identity token の `type=app`、空でない安定 `sub`、IdP で検証済みの `email` claim を必須にする。service token の空 `sub` や app token 以外は受け付けない
- email は ASCII の通常形式だけを受け付け、小文字へ正規化する。不正形式、前後空白、制御文字、複数の `@` は拒否する
- email や request URL の Project ID だけを membership として信用しない。Project 読取と owner 操作は request ごとに D1 の現在 membership を照合する
- owner 操作の SQL 自体にも actor の owner 条件を入れ、D1 `batch()` の transaction 内で mutation と audit を実行する
- 最後の owner の削除・降格は DB trigger が transaction 内で拒否するため、同時 request でも迂回できない
- 非参加者には Project の存在・名称を返さない。ただし、検証済み email に明示的に宛てられた有効な招待 token を提示した場合だけ、受諾に必要な Project / Site 名と role を返す
- membership revoke は次の API request から有効になる
- Experience / Kamakura editor の list/read/save/release 各 request と Kamakura CMS の各 request でも、Access `sub`、固定 Project/Site、D1 の現在の `owner` / `editor` membership を再照合する
- API・HTML・版のない静的応答は `no-store`。CSP、frame 拒否、MIME sniff 拒否等を付与する。長期 cache の対象は、build が内容 hash 付き URL で出力する JS/CSS（`assets/<名前>-<hash>.js|css` と `assets/chunks/<名前>-<hash>.js`）と Studio の書体（`assets/fonts/<名前>-<版>/*.woff2` と `assets/fonts/fonts-<hash>.css`）で、`private, max-age=31536000, immutable` を付ける。

Member 管理 mutation は従来どおり `POST` のみです。request URL と完全一致する `Origin`、`Sec-Fetch-Site: same-origin`、`application/json`、16 KiB の streaming 上限、JSON object、endpoint ごとの完全な key set を必須にします。この 16 KiB 境界は editor 追加後も変更しません。Editor mutation も同じ same-origin / JSON 条件を要求し、draft だけ 600 KiB、release-plan / release は 16 KiB の streaming 上限です。token、token hash、JWT、HMAC secret、request body は application log に出力しません。

Kamakura の旧Studio D1ブレークポイントroute (`GET /api/projects/project-kamakura/sites/kamakura/breakpoints`) は、サイトAPIへの初回移行と手動復旧のための読み取り専用です。`0006_site_breakpoint_settings.sql` が初期設定 JSON と整数versionを保持します。Studio GUIが共通APIから404を受けた場合だけ、現在のowner/editor membershipを再確認してD1の設定を読み、旧版 `b.<integer>` を期待版にしてホストの共通APIへ一度だけ引き継ぎます。保存後の正本・CAS・監査記録はkamakura-siteのR2/Workerが所有し、Studio D1のPUTは405になります。

## CLIの認証・操作契約

機械クライアントの認証と操作手順は [Studio CLI](../docs/studio-cli.md) を参照してください。

## Experience editor bridge

通常編集は同一 origin の `/api/projects/project-experience/sites/experience/editor`、STG検証は `/api/projects/project-experience/sites/experience/editor-staging` だけを呼びます。ブラウザは NIHO API、NIHO cookie、bridge secret へ直接アクセスしません。BFF は query string、別 Project/Site、allowlist 外 page ID、未知の route/method を拒否します。対象 page ID は `home`、`experiences`、`experience-detail`、`booking`、`host`、`chrome`、locale は `en`、公開先は `https://experience.niho.life` に固定します。components / localization / assets API は backend にないため接続しません。

上流は固定 origin `https://api.niho.life`、prefix `/api/internal/studio/experience` です。各 request は browser cookie や Access JWT を転送せず、次の header だけで Studio identity を渡します。

```text
X-NIHO-Studio-Project: project-experience
X-NIHO-Studio-Subject: <verified Access sub>
X-NIHO-Studio-Timestamp: <unix seconds>
X-NIHO-Studio-Signature: v1=<lowercase hex HMAC-SHA256>
```

署名 message は次の改行区切りです。`rawBody` は転送する body の同一 byte 列で、GET は空 byte 列の SHA-256 です。

```text
v1\n${timestamp}\n${method}\n${pathname}\n${sha256hex(rawBody)}\n${project}\n${subject}
```

`NIHO_STUDIO_BRIDGE_SECRET` は padding なし canonical base64url で、decode 後 32 byte 以上を必須にします。欠落・不正なら fail-closed 503 です。上流 fetch は redirect を追跡せず、timeout、`no-store`、JSON media type、2 MiB response 上限を適用します。3xx、非 JSON、上限超過、上流 401/403/404/429/5xx は Studio の Access session error と混同せず 503 にします。409 だけ editor conflict として保持します。

STG検証は同じ allowlist と署名契約を使いますが、上流は固定 `https://api-stg.niho.life`、鍵は `NIHO_STUDIO_BRIDGE_SECRET_STG` です。STG UI は環境を明示します。通常の Experience editor ルートや本番用 key/origin は切り替えません。STG API が未配備、secret が無効、または owner 以外なら閉じます。公開・復元の受入操作は STG API 上でのみ行い、本番 API へは送信しません。

Editor HTML route だけ `PageEditor` の inline style と `iframe srcDoc` に必要な `style-src 'unsafe-inline'` / `frame-src 'self'` を追加します。鎌倉の editor route は「外部URL」のプレビュー用に `frame-src` へ `https:` を追加します。Instagramの固定公式script URLを許可し、Directory / Dashboardなど他routeには同じ緩和を適用しません。

鎌倉の「外部URL」は編集キャンバスで静的に表示し、プレビューで公開HTTPS URLを隔離iframeに読み込みます。NIHO Travelの予約URLは、Studioと別originの場合に限り予約ウィジェットの表示に必要なoriginとフォーム権限を付け、`preview=1` で予約操作を無効にします。既存のホスト部品が出力するframeには `studio/kamakura-catalog.ts` の `KAMAKURA_EXTERNAL_FRAME_SOURCES` と `KAMAKURA_ORIGIN_RETAINING_FRAME_SOURCES` を引き続き適用します。

## Kamakura editor bridge

公開ドメインは catalog の `project.site` と `sites[0]` で一致する単一値を使い、`https://next-kamakura.niho.life` または `https://kamakura.niho.life` に限定します。公開確認と ManagedEmbed の親 origin 検証もその値に揃えます。切替前に両ホスト対応版を配備し、切替時にホストの公開先と D1 の `sites.public_origin` を揃え、Studio を再読込してください。切戻しは両方を元へ戻して再読込します。署名済み service binding と素材直接 PUT の確認用ホストは維持します。

ブラウザは同一originのStudio editor BFF配下だけを呼びます。画面固有routeに加えて共通editing APIの `pages.read`・`pages.apply`・`pages.save` を使い、日本語の通常編集は未送信操作を `pages.apply` へ送り、全置換・fallbackは `pages.save` を使います。日本語ページは `pages.read` のeditor snapshot profileから本文・presentation・`editorState`を1回で読みます。編集状態が欠けた応答はfail-closedし、旧全snapshot・分離presentationのreadにはfallbackしません。`pageId` は `^(?!(?:catalog|create|index)$)[a-z][a-z0-9-]{0,59}$` に固定し、query string、未知の route / method、600 KiB を超える draft を拒否します。

上流は Cloudflare service binding `KAMAKURA_SITE`（service `kamakura-site`）だけです。署名用 URL は `https://next-kamakura.niho.life/internal/studio/web-content/...` に固定し、任意 origin のネットワーク fetch や generic proxy にはしません。browser cookie、Cloudflare Access JWT、NIHO account 情報は転送しません。各 request は Experience と同じ HMAC message 形式で、Project header だけ `project-kamakura` を使います。secret は別の `KAMAKURA_STUDIO_BRIDGE_SECRET` とし、canonical base64url、decode 後 32 byte 以上を必須にします。

上流応答は redirect 拒否、timeout、JSON media type、2 MiB 上限を適用します。409 は editor conflict として保持し、上流の 401 / 403 / 429 / 5xx と catalog endpoint の 404 は Studio の Access session expiry と混同せず 503 として扱います。既存ページの 404 はそのまま保持します。catalog の契約検証・正規化は `studio/kamakura-catalog.ts` に集約し、BFF と browser が同じ parser を使います。Project / Site metadata、`ja` の新形式 page ID、旧形式 page path、件数、重複、制御文字を検証し、既知 field だけを browser へ返します。ページタイトルはコンテンツ文字列として扱い、2 MiB の応答上限で保護します。表示用の文字数制約を API 契約へ持ち込みません。

catalog がこの契約に合わない場合は `502 { "error": "upstream_contract_invalid", "supportId": "<UUID>" }` を返し、通信・Binding・secret の利用不能を示す `503 { "error": "service_unavailable", "supportId": "<UUID>" }` と分けます。Kamakura bridge のログには同じ問い合わせID、固定 operation、固定 failure category、存在する場合だけ上流HTTP statusを記録し、同じIDを service binding request header に渡します。secret、署名、Access subject、本文、上流応答本文、任意の例外メッセージは記録しません。

失敗カテゴリは `bridge_secret_missing_or_invalid`、`bridge_signing_failed`、`service_binding_failed` / `service_binding_timeout`、`upstream_auth_rejected`、`upstream_unexpected_4xx`、`catalog_endpoint_missing`、`upstream_rate_limited`、`upstream_server_error`、`upstream_redirect_rejected`、`upstream_invalid_response`、`upstream_contract_invalid`、`bridge_processing_failed` です。operation は `catalog`、`page_read`、`draft_save`、`release_plan`、`release`、`embed_import`、`embed_status`、`asset_list`、`asset_upload_intent`、`asset_update`、`asset_usages`、`asset_resolve` の固定値です。画面で問い合わせIDを受け取ったら、Studio Worker のログから同一IDの行を検索してください。HTTP status が無い `service_binding_*` はStudio側のbinding・到達性を、`upstream_auth_rejected` は両Workerのsecret設定と署名検証を、`catalog_endpoint_missing` は kamakura-site のendpoint配備を確認します。

Kamakura の `PageEditor` が編集するのは `src/site/niho-web` の native 化済みページです。日本語ページの下書き保存とページ単位公開は、サイト側が返す版と表示コンテキストを照合して行います。未変換のページは `readOnly.reason` で停止します。CMS の操作はサイト側の管理機能で扱います。

編集画面を直接開くと、Access のセッション・プロジェクト一覧・設定と同時に editor catalog の取得を始めます。参加資格を確認した後、翻訳状態とブレークポイントを取得しながら、catalog の一覧から最初のページを開きます。ページ管理用の `pages.catalog` は変更の確認時に版を取得するために使います。

日本語ページは共通 API の editor snapshot profile を必須とし、本文・presentation・公開履歴・英語公開状態・readOnly情報を同じ `pages.read` 応答から採用します。`editorState` が欠けた場合は編集を開始せず、旧全snapshotや分離presentationへfallbackしません。これによりページ読込の本文転送は1回です。権限エラーや不正なスナップショットは既存のエラー表示へ渡します。[編集 API 契約](../docs/editing-api-contract.md)

Kamakura の editor route にも Experience と同じ範囲限定 CSP 緩和を適用します。native presentation のフォントだけは `https://kamakura-media.niho.life/niho-web/fonts/v1/` を font-src に追加します。manifest・共有枠・保存CASの契約は [site-presentation.md](../docs/site-presentation.md) に従います。Directory / Dashboard / invite route の CSP は変えません。

### Kamakura の素材ライブラリ（#85）

Kamakura の `PageEditor` には `studio/kamakura-assets.ts` の素材 adapter を渡します。共通編集APIを実装したサイトでは、一覧・利用先・解決・metadata更新・upload intent を `.../editor/editing-api/v1/sites/kamakura/operations/assets.*` から呼びます。共通操作がまだ無い旧hostに限り、BFFの `POST .../editor/assets/{list,upload-intent,update,usages,resolve}` へfallbackします。非公開アップロードのプレビューは同一originの `GET .../editor/assets/<uuid>/preview` のままです。アップロード本体は `PUT https://next-kamakura.niho.life/internal/studio/asset-upload/<uuid>` へ直接送ります。

共通操作の認証は、Access sessionを操作別capabilityの短期bearer tokenへ委任してサイトoriginにservice binding接続します。`forbidden` やhost障害は旧BFFへ迂回しません。アップロード先は `next-kamakura.niho.life` に固定し、応答のtokenは検査済みのHTTPS origin以外へ送らないでください。CLIは同じサイト共通APIを直接呼び、別のupload originを使う場合は `--upload-origin` または `NIHO_EDIT_UPLOAD_ORIGIN` に明示します。

- BFF は要求ごとに Access `sub` と D1 の `owner` / `editor` membership を照合し、本文を検証して正規化した JSON だけを署名して service binding へ渡します。`siteId` は `kamakura`、出所は `kamakura-upload`（Studio からのアップロード。ID は UUID）・`kamakura-admin-upload`・`kamakura-studio`・`kamakura-cms`・`kamakura-approved-remote` に固定し、`update` と `upload-intent` は `kamakura-upload` だけを受けます。削除の route はありません。
- 上流の `409 visual_editor_frozen` はそのまま返し、素材の拒否（413・415・507）は status を保って `{ "error": "asset_rejected" }` で返します。画面はこれで「大きすぎる」「形式」「容量」を表示します。それ以外の 4xx・5xx は従来どおり 503 `service_unavailable` と問い合わせ ID です。
- `GET .../assets/<uuid>/preview` は同一 origin（`Sec-Fetch-Site: same-origin`）の GET を署名つき `POST assets/preview` に変え、画像の Content-Type の応答だけを `no-store` で流します。公開前の Studio アップロードを公開 URL なしで表示するための経路で、ほかの出所の素材は公開 CDN（`kamakura-media.niho.life` の `/cdn-cgi/image` 幅指定）のサムネイルをそのまま使います（`img-src https:`）。
- アップロードは、`upload-intent` で得た一回限りのトークンを `Authorization: Bearer` に付け、`credentials: "omit"` で kamakura-site へ直接 PUT します。Studio Worker は画像本体を中継しません。Access Cookie・JWT・bridge secret はブラウザにも kamakura-site にも渡りません。
- 追加の secret はありません（`KAMAKURA_STUDIO_BRIDGE_SECRET` を共用）。契約の全体は [素材ライブラリ契約](../docs/asset-contract.md)「鎌倉サイトでの接続」と kamakura-site の `worker/README.md`、テストは `test/studio-worker-assets.test.mjs`・`test/kamakura-assets-adapter.test.mjs` です。

### Kamakura の Dashboard 公開情報

`GET /api/projects/project-kamakura/sites/kamakura/dashboard` は、D1 の membership を確かめた後、service binding `KAMAKURA_SITE` に署名つきの `GET /internal/studio/web-content/_site/overview` を送ります（editor・CMS と同じ HMAC・`redirect: manual`・JSON 64 KiB 上限・8 秒で打ち切り）。`_` で始まるのはページ ID と重ならないためです。値の出どころ（公開 origin・sitemap の URL 数・GitHub の commit と Workers Builds）は kamakura-site の `worker/README.md`「Dashboard の公開情報」が正です。

- 応答は `ProjectOverview` の 6 つの key（`publicationStatus`・`publishedUrl`・`lastPublishedAt`・`publishedPageCount`・`assetBytes`・`recentChanges` 最大 20 件・id 重複なし）だけで組み立て直し、上流の未知の key は捨てます。日時は UTC の ISO に揃えます。
- 上流の 3xx・401/403・404（endpoint 未配備＝`overview_endpoint_missing`）・429・5xx・本文や形の誤り・timeout・secret 未設定は、`overview: { "status": "unavailable" }` にして Dashboard 全体は 200 で返します。ログは他の Kamakura bridge と同じく問い合わせ ID・operation `site_overview`・分類・上流 status だけです。
- `publishedUrl` は D1 の `sites.public_origin`（今は `https://next-kamakura.niho.life`）と同じ origin のときだけ出します。違うときは URL だけ `null` にします（client の parser が許可外の origin を拒むため）。11/3 の切替では、kamakura-site の `PUBLIC_SITE_ORIGIN` と D1 の `public_origin` を同じ日に `https://kamakura.niho.life` へ替えます。
- 解析（`analytics`）は下の「サイト分析」で GA4 を接続したサイトだけ、28日の要約（アクティブユーザー・ページ表示）を返します。未接続は `disconnected`、失敗・権限失効は `unavailable` です。Experience の公開情報は今までどおり上流を呼ばず `unavailable` です。
- 配備は kamakura-site を先に出します（後から出すと、それまで公開情報は `unavailable`・分類 `overview_endpoint_missing`）。テストは `test/studio-worker-dashboard.test.mjs` です。

## Kamakura の CMS bridge（コレクション）

鎌倉サイトの記事・サークル・会社を、[コレクションの画面](../docs/collection-contract.md)（`CollectionWorkspace`）から編集するための BFF と adapter です。Dashboard の「CMS」から直接使います。

- ブラウザが呼ぶのは同一 origin の `/api/projects/project-kamakura/sites/kamakura/cms/...` と、画像本体の `PUT https://next-kamakura.niho.life/internal/studio/cms-upload/<uuid>` だけです。BFF は service binding `KAMAKURA_SITE` の `/internal/studio/cms/...` へ、editor と同じ HMAC の header（同じ関数）で署名して渡します。追加の secret はありません。
- 鎌倉以外の Project / Site は 404 です。要求ごとに Access の `sub` と D1 の現在の `owner` / `editor` を確かめます（無ければ 403）。query string、知らない route（404）・method（405）、GET の本文は拒否します。
- 書き込みの本文は、同一 origin（`Origin` 一致・`Sec-Fetch-Site: same-origin`）・`application/json`・JSON object を要求し、操作ごとの key の集合が完全に一致するときだけ通します。BFF は確かめた値だけで JSON を作り直し、Access で確かめた email を `actor: { email }` に入れます。ブラウザが `actor` を送ってきたら 400 です。

| route（`cms/` の後ろ） | ブラウザの本文 | 上流の成功 |
| --- | --- | --- |
| `GET schema` | – | 200 `{ status: "ready", collections }` |
| `GET collections/:col/items` | – | 200 `{ status: "ready", collectionId, items }` |
| `GET collections/:col/items/:id` | – | 200 `{ status: "ready", item }` |
| `GET …/:id/english-publication` | – | 200 `{ status: "ready", englishPublications }` |
| `POST …/:id/english-publication` | `{}` | 200 `{ status: "accepted", englishPublications }`（BFF が `actor` を追加） |
| `POST collections/:col/items` | `{}` | 201 `{ status: "created", item }` |
| `PUT …/:id/draft` | `{ version, values }`（直した key だけ） | 200 `{ status: "saved", item }` |
| `POST …/:id/publish` | `{ version, redirect? }`（`redirect` は boolean） | 202 `{ status: "publishing", item }` |
| `POST …/:id/unpublish` | `{ version }` | 202 `{ status: "publishing", item }` |
| `POST …/:id/discard-draft`・`cancel-schedule`・`retry-schedule` | `{ version }` | 200 saved |
| `POST …/:id/schedule` | `{ version, at, redirect? }`（BFF が `at` を UTC の ISO にそろえる） | 200 saved |
| `POST …/:id/duplicate` | `{ version }` | 201 created（別の id） |
| `POST …/:id/remove` | `{ version, redirectTo? }`（`redirectTo` は null かサイトの中のパス） | 200 `{ status: "removed" }` |
| `POST collections/:col/reorder` | `{ ids, from, to }`（ids は 2〜2000 件・重複なし、from・to は 0 以上 ids の数未満の違う整数） | 202 `{ status: "publishing", items }` |
| `POST collections/:col/bulk` | `{ action: "publish" \| "unpublish" \| "remove", items: { id, version }[] }`（1〜100 件・id の重複なし） | 202 `{ status: "publishing", items }`・200 `{ status: "saved", items }` |
| `POST uploads/intent` | `{ collectionId, name, mimeType, bytes }` | 201 `{ uploadUrl, uploadToken, uploadId }` |

- 任意の key（`publish`・`schedule` の `redirect`、`remove` の `redirectTo`）は、無ければ上流へも送りません（上流の既定: 転送する・一覧へ移す）。`redirectTo` が同じコレクションの公開中の項目か一覧のパスかは上流が確かめ、違えば 422 です。
- 上限: 下書きの本文 2 MiB（`values` の key は `^[a-z][A-Za-z0-9]{0,63}$` で 100 個まで、値は string〔100 万字まで〕・null・string[]〔200 個まで・各 1〜200 字・重複なし〕・作品のような `{ id, image, caption }` の並び〔200 行まで・`id` は `""` か不透明な id・説明は 2 万字まで〕）、並べ替え・まとめての操作の本文 128 KiB、ほかの本文 16 KiB、上流の応答 3 MiB（upload intent は 16 KiB）。`collectionId` は `^[a-z][a-z0-9-]{0,39}$`、画像は jpeg / png / webp / avif / gif で 50 MiB まで（実際の上限は鎌倉の Worker の 413）。
- 上流の待ち時間は、読み取り 12 秒、書き込み 30 秒（公開・非公開・削除は鎌倉側で commit まで行う）。
- 応答は `studio/kamakura-cms-contract.ts` の parser（BFF とブラウザで共有、`src/collection-model.ts` の parser を使う）で確かめ、既知の field だけを返します。schema の項目の key も `values` と同じ形に限ります。

| 上流 | ブラウザへ |
| --- | --- |
| 契約どおりの成功 | 同じ status で、確かめ直した JSON |
| 409（項目つき） | 409 `{ error: "conflict", item }`（item はほかの人が保存した最新） |
| 409（並べ替え・まとめての操作） | 409 `{ error: "conflict", items }`（items は今の一覧） |
| 422 | 422 `{ error: "invalid", errors }`（先頭の 50 件） |
| upload intent の 413 / 415 | 同じ status で `{ error: "image_rejected" }` |
| 404 | 404 `{ error: "not_found" }`（schema の 404 は endpoint の未配備として 503） |
| 400（と本文の 413） | 400 `{ error: "invalid_request" }` |
| 401 / 403 / 429 / 5xx / 3xx / JSON でない / 上限超え / timeout / 想定外の 4xx | 503 `{ error: "service_unavailable", supportId }` |
| 契約に合わない応答（field の過不足・id の不一致・成功の status 違いなど） | 502 `{ error: "upstream_contract_invalid", supportId }` |

log は editor と同じく問い合わせ ID・固定の operation（`cms_schema`・`cms_list`・`cms_read`・`cms_english_publication_read`・`cms_english_publication_retry`・`cms_create`・`cms_draft_save`・`cms_publish`・`cms_discard_draft`・`cms_unpublish`・`cms_duplicate`・`cms_remove`・`cms_schedule`・`cms_cancel_schedule`・`cms_retry_schedule`・`cms_reorder`・`cms_bulk`・`cms_upload_intent`）・固定の分類（editor の分類と `cms_endpoint_missing`）・上流の status だけで、本文・email・subject は出しません。

ブラウザ側は `studio/kamakura-cms.ts` の `createKamakuraCmsAdapter({ siteOrigin })` が `CollectionAdapter` を返します（`siteOrigin` は Project の `site.domains[0]`）。

- 項目ごとに最後に読んだ version と値を覚え、`saveDraft` は**その値との差分だけ**を送ります（触っていない本文などを、画面側の正規化で書き換えないため）。覚えていない version なら読み直し、違えば保存せずに conflict を返します。
- 403 → forbidden、404 → not_found、409 → conflict、422 → invalid。非公開（上流は 202 publishing）は画面の契約に合わせて saved で返します。複製は覚えている version で呼び、競合なら最新の version でもう一度だけ試します。
- `publish`・`schedule` の `redirect`、`remove` の `redirectTo` は、画面が付けたときだけ送ります。`reorder`・`bulk` は成功（並べ替えは 202、まとめての操作は 202 / 200）と 409 の一覧をそのまま画面へ返し、触った項目の覚えた version を捨てます（次に開いたときに読み直す）。`retrySchedule` は `retry-schedule` を呼びます。
- 英語公開状態は項目本文と別の署名済み endpoint で読み、再試行します。`englishPublications` の page ID は posts / circles の1件、companies / creators の2件に完全一致させ、状態の余分な field も拒否します。adapter は raw page ID を落として「記事ページ」「サークルページ」「会社ページ」「クリエイターページ」に直し、本文の既知 version・値を変更しません。
- 上流の schema が 5 つの capabilities だけでも、新しい 4 つ（`redirects`・`reorder`・`bulk`・`retrySchedule`）と項目の型 `gallery` を返しても読めます（新しい key は無ければ false）。Studio を先に配備し、鎌倉の Worker の新しい key・型は後から出します。
- 画像: BFF の `uploads/intent` を呼び、`uploadUrl` が鎌倉の Worker の `/internal/studio/cms-upload/<uploadId>` であることを確かめてから、`credentials: "omit"`・`Authorization: Bearer <uploadToken>` で直接 PUT します。結果の URL は `https://kamakura-media.niho.life/uploads/...` だけを受けます。拒否は type / size / permission / invalid で返します。
- `imageUrl` は `kamakura-media.niho.life` の画像だけ `/cdn-cgi/image/width=<w>,format=auto/` の URL にします。`previewUrl` は公開中（変更ありを含む）の項目だけ、サイトの公開 URL と `item.path` から作ります（下書きのプレビューはありません）。
- Dashboard の HTML の `connect-src` には、切替が on のときだけ画像の PUT 先（`https://next-kamakura.niho.life`）を足します（editor の画面は従来どおり）。
- Dashboard の中では `studio/site-cms.tsx` が `studio/kamakura-cms-workspace.tsx` を `import()` で読み、adapter と本文の部品（`createStudioRichText({ imageUrl: adapter.imageUrl })`）を描画の外でサイトごとに 1 回だけ作ります。

テストは `test/studio-worker-cms.test.mjs`（BFF）、`test/kamakura-cms-adapter.test.mjs`（adapter）、`test/studio-site-admin.test.mjs`（切替・CSP・URL）、`test/studio-client-cms.test.mjs`（client の枠とコレクション画面の切り替え・URL・戻る/進む）です。

## Kamakura の翻訳 bridge（LocalizationWorkspace）

Dashboard の「翻訳」と CMS 項目の English タブは、[翻訳の画面](../docs/localization-workspace-contract.md)を使います。Studio は同一 origin の `/api/projects/project-kamakura/sites/kamakura/editor/editing-api/v1` から、鎌倉のサイト Worker の [共通 Editing API](../docs/editing-api-contract.md#翻訳操作) に接続します。CLI も同じサイト API を使います。訳文、原文の同期、公開状態、版の比較はサイト Worker が管理します。

- Studio の BFF は Cloudflare Access と D1 の現在の参加資格を毎回確認し、書き込みでは同一 origin からの JSON のみ受け付けます。共有の操作定義で入力を検証し、操作に必要な scope を持つ 60 秒の署名付きトークンで固定先の service binding へ渡します。編集者は読み取り・原文同期・翻訳案の依頼・訳文の編集ができ、公開・戻し・設定の変更には owner が必要です。概要、公開状態、操作一覧には役割で許可した範囲のトークンを使い、編集者には公開の再開用トークンを返しません。
- 概要・翻訳案の依頼・原文の同期・プレビュー・公開の操作は 30 秒、それ以外は 12 秒で上流への接続を打ち切ります。翻訳の本文は 4 MiB、応答は 5 MiB（プレビューの材料は 2 MiB + 64 KiB）が上限です。プレビューの枠は鎌倉サイトの `/_studio/localization-preview`（拡張子付きも可）だけを受けます。
- ブラウザ側の `createKamakuraLocalizationAdapter({ studioOrigin, siteOrigin, ... })` は共通クライアントの `executeLocalization` を使います。該当項目がない場合や権限がない場合は画面用の結果に変換し、版が競合した訳文・設定はサイトから返った現行値を使います。相対パスの画像は表示用 URL だけを `siteOrigin` で補います。翻訳画面は開いたときだけ読み込みます。
- 訳文に使う画像はサイトで使える公開 URL が必要です。画像のアップロード開始には既存の `POST localization/uploads/intent` を使い、ホストが返す短命のトークンで固定されたアップロード先に画像を直接 PUT します。訳文への適用は共通の `localization.items.command` を通します。下書き用の素材アップロードとは公開時点が異なります。
- English キャンバスの文書と翻訳情報の読み込み、キャンバスの下書き保存は、既存の `editor/pages/:pageId/snapshot` と `localization/editor/*` を引き続き使います。旧翻訳 workspace 経路は既存クライアントとの互換用です。

テストは `test/studio-worker-localization.test.mjs`（BFF・CSP・bundle の分割）、`test/kamakura-localization-adapter.test.mjs`（adapter）、`test/studio-client-translations.test.mjs`（画面の接続と URL の遷移）です。

## サイト分析（GA4 / Search Console）

各プロジェクトのサイトの持ち主が、自分の GA4 プロパティと Search Console プロパティを Studio につなぎ、Dashboard の「アナリティクス」タブで集計を見ます。NIHO 専用ではなく、どの Studio プロジェクトでも同じ仕組みです。NIHO アプリの分析とは別のホストで、Studio はそれに依存しません。実装は `studio/site-analytics-host.ts`（API・D1・ガード）と `studio/google-analytics.ts`（Google API）、D1 は `0012_site_analytics.sql` です。

### 認証と、サイトの持ち主がすること

- Google への認証は Studio 専用のサービスアカウント1つです。JSON 鍵を Worker secret `STUDIO_ANALYTICS_GOOGLE_SA_JSON` に対話入力で設定します（`wrangler secret put STUDIO_ANALYTICS_GOOGLE_SA_JSON --config studio/wrangler.toml`）。scope は `https://www.googleapis.com/auth/analytics.readonly` と `https://www.googleapis.com/auth/webmasters.readonly` だけです。access token は isolate の中で期限の5分前まで使い回します。
- secret が無い・壊れているときも落ちません。接続は未接続、集計は未接続（接続済みの source は `failed`）、Dashboard の要約は `disconnected`、prepare・verify・retry は `503 { "error": "analytics_unavailable" }` です。
- サイトの持ち主は (1) GA4 の「プロパティのアクセス管理」でサービスアカウントのメールを「閲覧者」に、(2) Search Console の「ユーザーと権限」で同じメールを「ユーザー」（制限付きでよい）に追加し、(3) Studio のアナリティクスの「連携」で GA4 のプロパティID（数字）と Search Console の URL プレフィックス（`https://<公開origin>/`）を入れて、確認画面から適用します。
- サービスアカウントのメール・鍵・プロパティIDはリポジトリ・Issue・PR に書かず、運用者からサイトの持ち主へ別経路で伝えます。

### 他社のデータを混ぜないためのガード

- 対象の origin は D1 の `sites.public_origin` と完全一致するものだけです。リクエスト由来の origin は受け付けず、`target` はサーバーが D1 から組み立てます。`public_origin` が無いサイトと、共有 origin + path で配信する Studio-native site は未対応です（接続は未接続、prepare は `409 { "error": "unsupported_site" }`）。
- GA4: Admin API でプロパティの Web データストリームを読み、`defaultUri` の origin がサイトの origin と完全一致するストリームがちょうど1つのときだけ接続します。0件・複数は `409 property_mismatch` で保存しません。時間帯はプロパティの値を保存します。集計の `runReport` は必ず接続した `streamId` とサイトの `hostName` の両方で絞るので、同じプロパティに別のサイトが入っていても数えません。
- Search Console: 公開 origin のルートの URL-prefix（`https://<origin>/`）と完全一致するものだけです。`sc-domain:`・別 origin・パス付きは `409 property_mismatch` です。`sites.get` の permissionLevel が `siteOwner` / `siteFullUser` / `siteRestrictedUser` のときだけ接続し、`siteUnverifiedUser`・403・404 は `409 permission_required` です。Search Analytics は `dataState: "final"` で、dimension は `date` と `page` だけです。検索語（`query`）は取得しません。page の行は同じ origin の安全な path だけを返します。
- 接続の後に公開 origin が変わったら、前の origin で接続した source は不一致にし（集計は `failed`）、つなぎ直すまで値を返しません。鎌倉の公開 origin を切り替える日は、owner が接続し直します。
- 接続の変更・解除で `version` が進みます。集計の cache は site・source・期間・`version`・期間の終端日に束縛し、古い cache は使いません。401/403 を検知したら `permission-revoked` にして cache を消し、権限が戻って「接続を確認」か「同期を再試行」をするまで集計を返しません。失効の検知より前に始まった取得が遅れて成功しても、cache を作らず `connected` に戻しません。404 は `property-mismatch`、429・`RESOURCE_EXHAUSTED` は `quota-limited`、5xx・timeout・redirect は接続状態を変えずにその回だけ `failed` です。
- Google への通信は redirect を追わず、10 秒で打ち切り、応答は 2 MiB までです。鍵・access token・Google の生の応答・検索語・個人単位の行は D1・ログ・ブラウザに出しません。ログは `NIHO Studio analytics failure` に固定の operation・分類・HTTP status だけです。

### API

すべて `/api/projects/:projectId/sites/:siteId/analytics/` の下です。毎リクエストで D1 の membership を確かめ、参加していなければ `403` です。

| method と path | 権限 | 内容 |
| --- | --- | --- |
| `GET report?period=7d\|28d\|3m\|12m` | owner・editor | `SiteAnalyticsSnapshot`（閲覧契約の parser を通してから返す） |
| `GET connection` | owner・editor | `SiteAnalyticsConnection` |
| `POST ga4/reporting/prepare` `{ propertyId }` | owner | 接続の `SiteAnalyticsChangePlan` |
| `POST ga4/reporting/apply` `{ confirmationToken }` | owner | 接続して計測タグの状態を確かめる |
| `POST ga4/reporting/verify` `{}` | owner | 権限・ストリーム・時間帯・計測タグを確かめ直す |
| `POST ga4/reporting/retry` `{}` | owner | cache を捨てて28日を取り直す |
| `POST ga4/reporting/disconnect/prepare` `{}`・`disconnect/apply` `{ confirmationToken }` | owner | 接続と cache の解除（計測タグは変えない） |
| `POST search-console/reporting/...` | owner | 上と同じ6つ。prepare は `{ property: { kind, value } }` |

- POST は既存の same-origin・JSON・16 KiB の境界を使い、body の key は完全一致です。apply・verify・retry・解除の応答は状態として使わず、画面は `connection` を読み直します。
- prepare は一回用の confirmation token を返します。D1 には SHA-256 の hash だけを、site・操作・actor・接続の `version`・payload・2分の期限と一緒に保存します。apply は plan と「今も owner であること」を書き込みと同じ文で確かめ、`version` の CAS で保存してから plan を消費します。期限切れ・使用済み・別の人・別の操作の token は `409 plan_invalid`、先に別の変更が入っていたら `409 version_conflict` です。
- 計測タグの公開・削除（`ga4/tag/...`）と Search Console の所有権確認（`search-console/ownership/...`）は、Studio が HTML を配信していないサイトがあるため扱いません（`409 not_supported`）。CLI（studio-cli）には出していません。

### 集計

- GA4: 期間の終端はプロパティの時間帯で昨日です。7日・28日はちょうどその日数、3か月・12か月は暦の月（89〜92日・365〜366日）で数え、直前の同じ長さと比べます。sessions・activeUsers・screenPageViews（契約の pageViews）、日別の sessions、`sessionDefaultChannelGroup` 別の sessions（日本語名。自然検索・直接・参照元サイト・ソーシャル・有料検索・メール・不明のほかは「その他」）、`pagePath` 上位20件のページ表示（安全な path だけ・title なし）です。そのサイト（`streamId` と `hostName`）で最初に記録がある日を計測開始日とし、それより前の日は未計測として扱います。直前期が計測開始日より前の日を含む場合（12か月表示など）は、比較値を未取得（`null`、画面では「—」）にします。当期の日別も、計測開始日より前は 0 ではなく `null`（折れ線が途切れる）です。
- Search Console: Pacific Time の今日の3日前までです。合計・日別・page 上位20件で、CTR は 0〜1 です。Search Analytics が返す履歴は16か月までなので、直前期がそれより古い日を含む場合（12か月表示）は直前期を問い合わせず、比較値を未取得（`null`、画面では「—」）にします。
- 0 は実測値、取れなかった値は `null`、行の無い成功は `empty` です。片方の失敗はもう片方に影響しません。cache は正規化した集計だけを30分保存します。
- 計測タグ: GA4 の接続と確認のときに、公開 origin の `/` を redirect なし・4 秒・1 MiB までで読み、ストリームの測定IDがあれば `published`、無ければ `not-configured`（測定IDは示さない）、読めなければ `failed` です。Tag Manager 経由の設置は見つけられません。
- Dashboard の要約は GA4 の28日（cache があればそれ）で、「アクティブユーザー」「ページ表示」と表示します。

### 画面

アナリティクスのタブは、上に `SiteAnalytics`（集計）、owner には下に `SiteApps`（`capabilities={{ trackingTag: false, ownershipVerification: false }}`）を出します。owner かどうかは owner だけが読める `GET membership` で確かめ、editor には接続欄を出しません。Studio-native site にも接続欄は出しません。ホームの要約の「アクセス解析を見る」はこのタブを開きます。2つの部品の CSS は、CSP で inline の `<style>` を使えないので `studio:build` が `studio.css` に入れます。

テストは `test/studio-worker-analytics.test.mjs`（API・ガード・cache・権限失効・secret 未設定）、`test/studio-client-analytics.test.mjs`（タブ）、`test/site-apps-ui.test.mjs`（capabilities）です。

## Migration と初回セットアップ

前提: Node.js 22、依存関係、Wrangler CLI。Wrangler は環境側で管理し、Cloudflare にログイン済みの operator が実行します。

1. NIHO アカウントに作成済みの `niho-web-studio` D1 と `studio/wrangler.toml` の binding・account ID を照合する。token、credential、実メールアドレスはリポジトリへ書かない。Studio-native siteを有効にする環境では、管理originとは別の共有HTTPS originを `PUBLIC_SITES_ORIGIN` に設定する。ローカル例は `https://sites.example.com` とし、値にpathを含めない。DNSやcustom domainの作成はこのWorkerの配備手順に含めない。
2. 作成済みの専用 Cloudflare Access application `NIHO Web Studio` が `studio.niho.life` 全体を保護し、専用ポリシー `Allow NIHO Web Studio staff`（Google ログインと `@niho.life`）のみを使うことを照合する。Cloudflare dashboard membership を Studio role として使わない。Access session は 12 時間、Cookie は HttpOnly。
3. 作成済み Access application の AUD tag と `ACCESS_AUDIENCE`、issuer `https://niho-coliving.cloudflareaccess.com` を照合する。
4. まず NIHO API STG と Studio Worker に、STG 専用 `NIHO_STUDIO_BRIDGE_SECRET_STG` を同じ値で設定する。STG用と本番用の secret は別にする。Kamakura の secret もExperienceとは共用しない。本番 Experience secret は本番受入時まで設定しない。値を shell 引数、リポジトリ、ログへ残さず、対話入力または承認済みの secret handling で設定する。

```sh
wrangler secret put NIHO_STUDIO_BRIDGE_SECRET --config studio/wrangler.toml
wrangler secret put NIHO_STUDIO_BRIDGE_SECRET_STG --config studio/wrangler.toml
wrangler secret put KAMAKURA_STUDIO_BRIDGE_SECRET --config studio/wrangler.toml
```

`NIHO_STUDIO_BRIDGE_SECRET_STG` には NIHO API STG が参照する Secret Manager の値だけを設定します。本番値との共用は禁止です。Secret Manager から Cloudflare へ移すときも対話型またはログに出ない承認済みの secret handling を使い、shell 引数・ファイル・ログ・Issue に値を残しません。

5. `studio/wrangler.toml` の `KAMAKURA_SITE` が同じ Cloudflare account の service `kamakura-site` を指すことを確認する。
6. Experience STG は、(1) niho-app PR #19268 の API を STG に反映、(2) Cloud Run STG が Secret Manager の STG key を参照していることを確認、(3) Studio Worker の STG key を設定、(4) この Worker を配備、(5) owner で STG画面を開き list / read / save / release-plan / release / rollback を受入確認、の順に進める。本番用 API key や本番コンテンツはこの確認に使わない。
7. Kamakura は、(1) 両 Worker に Kamakura secret を設定、(2) `kamakura-site` の署名済み `/internal/studio/web-content/*` を先に配備し service binding 経由の catalog smoke を確認、(3) Studio D1 migration `0004` を適用、(4) Studio Worker を配備、(5) owner/editor で catalog / read / save / release-plan / release / rollback を受入確認、とする。Studio を先に配備して backend 未反映を編集可能とは案内しない。各deploy後に新しい Worker version が有効になったことを確認して次段へ進む。

```sh
npm ci
npm run studio:typecheck
npm run studio:build
wrangler d1 migrations apply niho-web-studio --remote --config studio/wrangler.toml
```

`0001_studio_registry.sql` は2つの Project/Site を seed し、membership を暗黙追加しません。`0002_membership_administration.sql` は既存 membership を保持したまま nullable email、招待、audit を追加します。`0003_experience_site_metadata.sql` は Experience site を API と同じ metadata に更新します。`0004_kamakura_site_metadata.sql` は Kamakura site のmetadataを更新し、`0010_kamakura_site_name.sql` はcatalogとsite名を揃えます。`0011_managed_sites.sql` はStudio-native site、ページ、immutable version/publication、短命plan、auditを追加し、既存 `sites.public_origin UNIQUE` を変更しません。`0012_site_analytics.sql` はサイト分析の接続・一回用plan・集計cacheを追加するだけで既存tableを変えません。`0013_managed_cms.sql` は Studio-native CMS の版付き定義・項目・release・予約を追加します。`0014_cms_page_bindings.sql` はページ revision に保存する CMS bindings、公開 page publication の CMS release pin、bindings 更新の operation receipt を追加します。Worker より先に適用します。Migration は既存 membership と owner bootstrap を壊しません。

## owner の out-of-band bootstrap

最初の owner だけは招待では作れないため、既存どおり operator が out-of-band で追加します。候補 owner が Access 経由で Studio に入り、署名検証済み `GET /api/session` の `subject` と `email` を本人確認します。operator は本人と対象 Project を別経路で確認してから D1 へ明示的に追加します。

以下の placeholder をローカルで置換して実行します。実 `sub`、氏名、メールをファイルや shell history に残さない運用を推奨します。email は小文字へ正規化してください。

```sql
INSERT INTO project_members (project_id, access_subject, role, display_name, email)
VALUES ('project-kamakura', '<VERIFIED_ACCESS_SUB>', 'owner', '<DISPLAY_NAME>', '<verified-email@example.com>');

INSERT INTO project_members (project_id, access_subject, role, display_name, email)
VALUES ('project-experience', '<VERIFIED_ACCESS_SUB>', 'owner', '<DISPLAY_NAME>', '<verified-email@example.com>');
```

`0001` 時点ですでに追加済みの member は email が `NULL` のままでも利用できます。owner UI では「メール未登録（bootstrap）」と表示されます。招待による新規 member は Access email が保存されます。

## 招待と member 管理の運用

Dashboard 下部の「メンバー管理」は、現在 D1 で owner のユーザーだけに表示されます。

1. owner が email、`editor` または `owner`、1・3・7日の期限を指定して招待を作成する。
2. Worker は 32 byte の暗号学的乱数 token を生成し、D1 には SHA-256 hash だけを保存する。
3. creation response にだけ招待 URL を返す。未ログインでも Access の認証後に招待へ戻れるよう、token は一回限りの URL query に入れる。Studio は読み取り後すぐ address bar から query を除去する。Access やブラウザの履歴には一時的に URL が残り得るため、安全な経路で本人にだけ共有する。
4. owner が URL を安全な別経路で本人へ共有する。Studio はメールを送信しない。
5. 招待先本人が Access へ同じ email でログインし、表示内容を確認して「招待を承諾する」を押す。
6. D1 transaction が、未使用・未取消・期限内・email 一致を再確認し、membership insert、token consume、audit insert を一括実行する。email 一致だけの auto join は行わない。

招待 URL は creation response 後に再表示できません。紛失時は古い pending 招待を取消し、新しい招待を作成します。owner は pending 招待の取消、owner/editor の変更、member の削除ができます。最後の owner は必ず残ります。各成功操作は `actor_subject`、action、Project、target、時刻を `studio_audit_records` へ記録し、raw token は記録しません。

## API scope

Project 固有 API はすべて次の prefix 配下です。

```text
/api/projects/:projectId/sites/:siteId/
```

- `GET dashboard`: 現在 member のみ（Kamakura は公開情報をサイト側から読む・上記）
- `GET membership`: 現在 owner の member / invitation 一覧
- `POST invitations`: owner の招待作成
- `POST invitations/revoke`: owner の pending 招待取消
- `POST members/role`: owner の昇格・降格
- `POST members/remove`: owner の member 削除
- `POST invitations/preview`: 招待 token hash、scope、verified email が一致する本人だけ
- `POST invitations/accept`: 本人の明示承諾。membership と token consume を atomic に実行
- Experience: `GET editor/sites`、`GET editor/sites/experience/pages`、`GET editor/sites/experience/pages/:pageId/en`（通常編集は owner/editor）
- Experience: `PUT .../draft`、`POST .../release-plan`、`POST .../release`
- Experience STG: 同じ route を `/editor-staging` 配下で提供し、owner のみ許可
- Kamakura: `GET editor/catalog`、`GET editor/:pageId`
- Kamakura: `PUT editor/:pageId/draft`、`POST editor/:pageId/release-plan`、`POST editor/:pageId/release`
- Kamakura: `POST editor/assets/{list,upload-intent,update,usages,resolve}`、`GET editor/assets/:uuid/preview`（owner/editor）
- Kamakura CMS: `GET cms/schema`、`GET|POST cms/collections/:col/items`、`GET cms/collections/:col/items/:id`、`GET|POST …/:id/english-publication`、`PUT …/:id/draft`、`POST …/:id/{publish,discard-draft,unpublish,duplicate,remove,schedule,cancel-schedule,retry-schedule}`、`POST cms/uploads/intent`（owner/editor・鎌倉以外は 404）
- サイト分析: `GET analytics/{report,connection}`（owner/editor）、`POST analytics/{ga4,search-console}/reporting/{prepare,apply,verify,retry,disconnect/prepare,disconnect/apply}`（owner）。詳細は上の「サイト分析」
- Kamakura 翻訳: `editor/editing-api/v1/sites/kamakura/operations/localization.*`（[共通 Editing API の操作表](../docs/editing-api-contract.md#翻訳操作)）。画像のアップロード開始と English キャンバスは `localization/uploads/intent` と `localization/editor/*`。

unknown Project/Site と権限のない Project/Site は、外部から区別できる詳細を返しません。owner API が返す member 情報は、その owner が管理する同一 Project に限定します。

編集対象の追加手順、trusted registry、client component map、worker adapter mapの境界は [ビルダー接続ガイド](../docs/builder-integration-guide.md) を正とします。登録されていないProject/Site/environmentはHTMLとAPIの両方で閉じます。

## local 確認と配置

```sh
npm run studio:typecheck
npm run studio:build
wrangler dev --config studio/wrangler.toml
```

ローカルでも Worker は実 Access JWT を要求します。JWT 検証を迂回する development mode は設けていません。配置前に Access application の hostname、issuer、AUD、D1 binding、custom domain を相互確認し、`wrangler deploy --config studio/wrangler.toml` を実行します。

`studio:build` は HTML・entry JS・CSS に内容由来の名前を付け、Worker がその HTML を直接読みます。Cloudflare の静的アセット cache で旧 `app.js` と新しい chunk が混ざると白画面になるため、配備後は Chrome で Studio を再読み込みして Dashboard と CMS・翻訳の遅延画面が開くことを確認します。配備を取り消すだけでは旧アセットが戻らない場合があり、そのときは旧版を build して旧 chunk を含むアセット集合を再配備します。
サイトの言語設定部品は、ほかのホストでは自身の `<style>` を使い、CSP が inline style を拒否する Studio では `studio:build` が同じ CSS を `studio.css` に入れます。設定画面の確認では項目の表示だけでなく、選択肢が横並びのカードとして整っていることも見るようにします。

## 制約と follow-up

- Experience editor の本番UIは Backend Draft PR #19268 の本番配備と、Studio Worker／NIHO API の本番 secret 設定が揃った場合だけ有効にします。secret が欠落・不正なら API 接続は 503 で fail-closed します。STG用 secret は本番で再利用しません。
- Kamakura editor は native 化済みの共通ページだけを扱います。ブロック契約は kamakura-site の `GET catalog` が保存時検証と同じ正本から返し、Studio はそれを検証して安全なローカルプレビューを組み立てます。外部表示・予約・送信・CMS取得のコードは実行しません。未変換ページは読み取り専用です。素材は「Kamakura の素材ライブラリ」のとおり接続済みで、サイト側の段階解除が適用されたページ用にアップロードと更新を受け付けます。作成、旧形式ページ編集、CMS 操作はこの bridge の対象外です。
- Experience editor は production API が提供するページ文書・下書き・公開・復元だけを扱います。自由追加できない NIHO 業務ブロックは `insertableBlocks=[]` とし、components / localization / assets は未実装です。
- 招待メールの配信、再送、token の再表示はありません。URL の安全な共有は owner の運用責任です。
- Access email の変更や IdP account の統合は自動追従しません。membership の主体は安定 `sub` で、保存 email は招待照合と owner 表示用です。
- out-of-band bootstrap SQL 自体は application audit に自動記録されません。operator 側の変更記録を残してください。
- audit の閲覧 UI/API、保持期間、export は未実装です。D1 には改変・削除を拒否する record として保存します。

### 鎌倉のページ操作

固定ページの一覧名・URLの変更、作成、公開範囲の切り替えは、ホストが `pageChangeActions` で公開した操作を使います。`editor/page-changes/prepare` と `editor/page-changes/apply` は Access・プロジェクトの権限・same-origin を検証してから、要求と確認トークンを署名付きでホスト API に送ります。公式 CLI も同じ API を使います。詳細は [ページ管理契約](../docs/page-contract.md#鎌倉studioの接続範囲)。
