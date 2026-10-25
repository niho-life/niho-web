# NIHO Web Studio host

> 2026-10-22: Experience / Kamakura のvisual editorは凍結した。canonical・alias・stagingの既知editor URLはAccess認証後に凍結案内を表示し、editor APIはmembership確認後に `409 visual_editor_frozen` を返して上流を呼ばない。`integration-entry`、各site editor、`PageEditor` は実client bundleへ含めない。source/coreと保存データは将来用に保持するが、サイト変更のpreview一致・schema同期・版同期を受入条件にしない。Dashboard、membership、招待は継続する。以下のBFF説明は再接続時の履歴資料である。
>
> 2026-10-25（niho-life/kamakura-site#84）: Kamakura だけ読み取りを再接続した。`GET catalog`・`GET :pageId`・素材の参照は service binding で kamakura-site へ通し、Kamakura の editor route だけ editor 用 CSP を付ける。保存・公開を止めるのは kamakura-site 側で、ページ文書の `readOnly` を `PageEditor` が読み取り専用の帯として出し、上流の `409 visual_editor_frozen` は競合（`conflict`）と分けて `409 { "error": "visual_editor_frozen" }` で返す。凍結の切り替えは kamakura-site の `worker/visual-freeze.ts` 1 か所。Experience は従来どおり凍結し、上流を呼ばない。

Issue #68 / #69 / #70 の Studio host です。共有 `@niho/web` ライブラリとは別に Cloudflare Workers へ配置し、静的 React UI、Worker API、Studio 専用 D1 registry、Experience / Kamakura editor BFF を1つの境界として運用します。

## この host が所有するもの

- Cloudflare Access の Google ログイン後に使う Studio shell
- `1 Project = 1 Site` の registry と `owner` / `editor` membership
- owner による期限付き one-time 招待、権限変更、参加解除、招待取消
- `project-kamakura` / `kamakura` と `project-experience` / `experience` の安定した Project / Site ID
- 参加 Project の一覧と、Project・Site ID を含む安定 URL の Dashboard、人向けの固定別名 URL
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

### サイト機能（kamakura-site#108 U1）

Dashboard の上部のサイトナビには、ホスト（`studio/client.tsx`）が接続したサイト機能を「ホーム」の後ろに並べます。各機能は alias の URL を持ちます（`/projects/<別名>/admin/cms`・`/assets`・`/translations`、`/project/<別名>/cms` などからも入れる）。

| 機能 | Kamakura での中身 |
| --- | --- |
| ページ | 右上の「デザインエディタ」（従来どおり） |
| CMS | 既定はサイト側の管理画面（記事・サークル・会社・クリエイター）を Dashboard の中の枠で開く。切替（`KAMAKURA_CMS_VIEW=workspace`）を入れると Studio のコレクション画面で開く（下の「CMS の切替」） |
| 素材 | 今の置き場所（エディタの「素材」と CMS の画像欄）への案内。一覧・検索の画面は素材 provider（#85）の後 |
| 翻訳 | サイト側の翻訳画面を枠で開く |
| 設定 | プロジェクト設定（メンバーと招待）。Home 配下の「プロジェクト設定」と同じ |

- 枠で開くサイト側の管理画面の origin はコードに書かず、Worker の設定値 `KAMAKURA_ADMIN_ORIGIN`（https の origin だけ）から読みます（`studio/site-admin.mjs`）。未設定ならサイト機能を出しません。`wrangler secret put KAMAKURA_ADMIN_ORIGIN --config studio/wrangler.toml` で入れると、配備のたびに消えません。
- `GET /api/projects/<Project>/sites/<Site>/site-admin` は D1 の現在の `owner` / `editor` だけに origin・画面のパス・CMS の開き方（`cmsView`: `"frame"` / `"workspace"`）を返し、接続の無いサイトは 404 `not_connected` です。
- Dashboard の HTML（ID の URL と alias の URL）の CSP は `frame-src` をその origin と Access のチームのドメイン（`ACCESS_ISSUER`）だけにします。サイト側にまだ Access の cookie が無いとき、枠はチームのドメインを経由して戻るためです（Studio にログイン済みならログイン画面は出ない。ログイン画面そのものは Access が枠を拒む）。editor の CSP と `frame-ancestors 'none'` は変えません。枠は `postMessage` を使わず、`sandbox` で Studio の画面の移動を許しません。
- 枠の中は同じ Cloudflare Access のチームの SSO で開きます。サイト側にまだログインしていないと枠の中ではログイン画面を出せないので、画面に「別のタブで開く」を常に置きます（一度ログインすれば枠の中でも開ける）。サイト側は `frame-ancestors` で Studio の origin だけに枠を許します。

### CMS の切替（枠 → コレクション画面）

Dashboard の「CMS」は、Worker の設定値 `KAMAKURA_CMS_VIEW` で中身を切り替えます。値が `workspace` のときだけ Studio のコレクション画面（`CollectionWorkspace` ＋ `createKamakuraCmsAdapter` ＋ 本文の TipTap）、無い・ほかの値は従来の枠です。**既定は枠**で、owner と editor の受入が終わったら on にします。翻訳は切替の後も枠のままです。

- on にする: `wrangler secret put KAMAKURA_CMS_VIEW --config studio/wrangler.toml` で `workspace` を入れる（値は公開 repo に書かない。secret なので配備のたびに消えない）。Worker が新しい値で動き出せば、開き直した Dashboard から新しい画面になります（再配備は要らない）。
- 戻す: `wrangler secret delete KAMAKURA_CMS_VIEW --config studio/wrangler.toml`（または `frame` を入れ直す）。次に開いた Dashboard から枠に戻ります。
- 旧画面の入口: コレクション画面の上の「旧画面（/admin）を開く ↗」で、サイト側の管理画面（`KAMAKURA_ADMIN_ORIGIN` の `/admin`）を別のタブで開けます。切替は `KAMAKURA_ADMIN_ORIGIN` があるときだけ効きます（無いとサイト機能そのものを出さない）。
- URL: 一覧は `/projects/<別名>/admin/cms/<collectionId>`、項目は `/projects/<別名>/admin/cms/<collectionId>/<itemId>`（`/admin/cms` はそのサイトの先頭のコレクション）。画面の中で一覧・項目を移ると URL を積み、ブラウザの戻る・進むはその URL でコレクション画面を開き直します。短い入口 `/project/<別名>/cms/<collectionId>/<itemId>` も同じ形へ 301 で移します。id は collection-model の形（コレクションは `[A-Za-z0-9_][A-Za-z0-9_-]*`、項目は `[A-Za-z0-9_][A-Za-z0-9._~-]*`）だけで、ほかの形の URL は画面の route にしません。
- CSP: on のとき、鎌倉の Dashboard の HTML（ID の URL と alias の URL）だけ `connect-src` に画像本体の直接 PUT 先 `https://next-kamakura.niho.life` を足します。本文と一覧の画像（`https://kamakura-media.niho.life` の縮小を含む）は今の `img-src 'self' https:` で足ります。本文の部品は inline の `<style>` と style 属性を使わず、埋め込みは枠を作らない（中身は公開したページだけ）ので、`style-src`・`frame-src` は変えません。off のときは何も足しません。editor の CSP と `frame-ancestors 'none'` は変えません。
- 読み込み: コレクション画面と TipTap は `import()` で分け（`assets/chunks/`）、CMS を開いたときだけ読みます。読み込み中は「CMS の画面を読み込んでいます…」、失敗は「再試行」を出します。`studio/build.mjs` は、最初に読む分（`app.js` と、そこから静的に読む chunk）に TipTap・ProseMirror・`collection-workspace.tsx` が入ったら build を失敗させます。画面の CSS は `assets/collection.css`（`index.html` から読む）、項目の編集の上のバーは Studio のヘッダーの下に貼り付きます（`--niho-sticky-top`: 68px、幅 600px 以下は 58px）。
- 画面の中の移動では作り直さないので、adapter が覚えた version で差分だけを保存します。ブラウザの戻る・進むで開き直すときは、自動保存（約 1 秒）の前の直しは残りません（画面の「一覧へ」は先に保存してから戻る）。

Alias は Worker と client router の固定対応表で内部の Project / Site ID へ解決します。別名 URL 自体をブラウザに保ち、alias から Dashboard と Editor の間を移動しても同じ表記を使います。API/BFF の path、membership 判定、Project / Site ID は変わりません。招待 URL と Experience STG 専用 URL は引き続き ID 付き route です。

Experience と Kamakura の Editor UI / BFF は実装されています。Experience の本番編集は niho-app Backend Draft PR #19268 が本番反映済みで、NIHO API と Studio Worker の `NIHO_STUDIO_BRIDGE_SECRET` が同じ値に設定されている場合に限り有効です。STG検証画面は `/projects/project-experience/sites/experience/editor/staging` に限り、D1 の Experience owner のみ開けます。画面・APIの両方で owner を確認し、固定した `https://api-stg.niho.life` と別の `NIHO_STUDIO_BRIDGE_SECRET_STG` を使います。Kamakura は `kamakura-site` の内部 endpoint、service binding `KAMAKURA_SITE`、両 Worker の `KAMAKURA_STUDIO_BRIDGE_SECRET` が揃った後に利用します。この host は Dashboard の公開状態や解析値を合成せず、`unknown` / `unavailable` / `disconnected` / `null` のまま表示します。

両Editorは `PageEditor` の共通workspaceを使います。左のツール列とパネル、中央キャンバス、右インスペクター上段の倍率と編集操作、下部の表示幅操作はサイト間で共通です。各hostはダッシュボードへ戻る入口だけを `toolbarStart` に渡し、サイト固有のレイアウト指定は行いません。左右パネルは開閉でき、狭い表示でもoverlayで編集を続けられます。

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
- API と静的応答は `no-store`。CSP、frame 拒否、MIME sniff 拒否等を付与する

Member 管理 mutation は従来どおり `POST` のみです。request URL と完全一致する `Origin`、`Sec-Fetch-Site: same-origin`、`application/json`、16 KiB の streaming 上限、JSON object、endpoint ごとの完全な key set を必須にします。この 16 KiB 境界は editor 追加後も変更しません。Editor mutation も同じ same-origin / JSON 条件を要求し、draft だけ 600 KiB、release-plan / release は 16 KiB の streaming 上限です。token、token hash、JWT、HMAC secret、request body は application log に出力しません。

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

Editor HTML route だけ `PageEditor` の inline style と `iframe srcDoc` に必要な `style-src 'unsafe-inline'` / `frame-src 'self'` を追加します。`script-src 'self'` は維持し、Directory / Dashboard など他 route の CSP は緩和しません。

## Kamakura editor bridge

ブラウザは同一 origin の `/api/projects/project-kamakura/sites/kamakura/editor` 配下だけを呼びます。利用できる route は `GET catalog`、`GET :pageId`、`PUT :pageId/draft`、`POST :pageId/release-plan`、`POST :pageId/release`、素材の `POST assets/{list,upload-intent,update,usages,resolve}`・`GET assets/:uuid/preview`（下記）だけです。`pageId` は `^(?!(?:catalog|create|index)$)[a-z][a-z0-9-]{0,59}$` に固定し、query string、未知の route / method、600 KiB を超える draft を拒否します。

上流は Cloudflare service binding `KAMAKURA_SITE`（service `kamakura-site`）だけです。署名用 URL は `https://next-kamakura.niho.life/internal/studio/web-content/...` に固定し、任意 origin のネットワーク fetch や generic proxy にはしません。browser cookie、Cloudflare Access JWT、NIHO account 情報は転送しません。各 request は Experience と同じ HMAC message 形式で、Project header だけ `project-kamakura` を使います。secret は別の `KAMAKURA_STUDIO_BRIDGE_SECRET` とし、canonical base64url、decode 後 32 byte 以上を必須にします。

上流応答は redirect 拒否、timeout、JSON media type、2 MiB 上限を適用します。409 は editor conflict として保持し、上流の 401 / 403 / 429 / 5xx と catalog endpoint の 404 は Studio の Access session expiry と混同せず 503 として扱います。既存ページの 404 はそのまま保持します。catalog の契約検証・正規化は `studio/kamakura-catalog.ts` に集約し、BFF と browser が同じ parser を使います。Project / Site metadata、`ja` の新形式 page ID、旧形式 page path、件数、重複、制御文字を検証し、既知 field だけを browser へ返します。ページタイトルはコンテンツ文字列として扱い、2 MiB の応答上限で保護します。表示用の文字数制約を API 契約へ持ち込みません。

catalog がこの契約に合わない場合は `502 { "error": "upstream_contract_invalid", "supportId": "<UUID>" }` を返し、通信・Binding・secret の利用不能を示す `503 { "error": "service_unavailable", "supportId": "<UUID>" }` と分けます。Kamakura bridge のログには同じ問い合わせID、固定 operation、固定 failure category、存在する場合だけ上流HTTP statusを記録し、同じIDを service binding request header に渡します。secret、署名、Access subject、本文、上流応答本文、任意の例外メッセージは記録しません。

失敗カテゴリは `bridge_secret_missing_or_invalid`、`bridge_signing_failed`、`service_binding_failed` / `service_binding_timeout`、`upstream_auth_rejected`、`upstream_unexpected_4xx`、`catalog_endpoint_missing`、`upstream_rate_limited`、`upstream_server_error`、`upstream_redirect_rejected`、`upstream_invalid_response`、`upstream_contract_invalid`、`bridge_processing_failed` です。operation は `catalog`、`page_read`、`draft_save`、`release_plan`、`release`、`asset_list`、`asset_upload_intent`、`asset_update`、`asset_usages`、`asset_resolve` の固定値です。画面で問い合わせIDを受け取ったら、Studio Worker のログから同一IDの行を検索してください。HTTP status が無い `service_binding_*` はStudio側のbinding・到達性を、`upstream_auth_rejected` は両Workerのsecret設定と署名検証を、`catalog_endpoint_missing` は kamakura-site のendpoint配備を確認します。

Kamakura の `PageEditor` が編集するのは `src/site/niho-web` の新形式ページだけです。現時点では0件のため、UI は移行待ちを明示し、catalog の旧形式一覧を読み取り専用で表示します。旧形式のデザインは `https://next-kamakura.niho.life/admin/pages`、記事・サークル・会社などの CMS は `https://next-kamakura.niho.life/admin` で引き続き編集します。Studio は CMS を変更せず、STUDIO からの全面移行を完了扱いにしません。source of truth は `studio` のままで、移行作業は kamakura-site #42 に残ります。

Kamakura の editor route にも Experience と同じ範囲限定 CSP 緩和を適用します。native presentation のフォントだけは `https://kamakura-media.niho.life/niho-web/fonts/v1/` を font-src に追加します。manifest・共有枠・保存CASの契約は [site-presentation.md](../docs/site-presentation.md) に従います。Directory / Dashboard / invite route の CSP は変えません。

### Kamakura の素材ライブラリ（#85）

Kamakura の `PageEditor` には `studio/kamakura-assets.ts` の素材 adapter を渡します。ブラウザが呼ぶのは同一 origin の `POST .../editor/assets/{list,upload-intent,update,usages,resolve}` と `GET .../editor/assets/<uuid>/preview`、そしてアップロード本体の `PUT https://next-kamakura.niho.life/internal/studio/asset-upload/<uuid>` だけです（Kamakura editor route の `connect-src` に固定）。

- BFF は要求ごとに Access `sub` と D1 の `owner` / `editor` membership を照合し、本文を検証して正規化した JSON だけを署名して service binding へ渡します。`siteId` は `kamakura`、出所は `kamakura-upload`（Studio からのアップロード。ID は UUID）・`kamakura-admin-upload`・`kamakura-studio`・`kamakura-cms`・`kamakura-approved-remote` に固定し、`update` と `upload-intent` は `kamakura-upload` だけを受けます。削除の route はありません。
- 上流の `409 visual_editor_frozen` はそのまま返し、素材の拒否（413・415・507）は status を保って `{ "error": "asset_rejected" }` で返します。画面はこれで「大きすぎる」「形式」「容量」を表示します。それ以外の 4xx・5xx は従来どおり 503 `service_unavailable` と問い合わせ ID です。
- `GET .../assets/<uuid>/preview` は同一 origin（`Sec-Fetch-Site: same-origin`）の GET を署名つき `POST assets/preview` に変え、画像の Content-Type の応答だけを `no-store` で流します。公開前の Studio アップロードを公開 URL なしで表示するための経路で、ほかの出所の素材は公開 CDN（`kamakura-media.niho.life` の `/cdn-cgi/image` 幅指定）のサムネイルをそのまま使います（`img-src https:`）。
- アップロードは、`upload-intent` で得た一回限りのトークンを `Authorization: Bearer` に付け、`credentials: "omit"` で kamakura-site へ直接 PUT します。Studio Worker は画像本体を中継しません。Access Cookie・JWT・bridge secret はブラウザにも kamakura-site にも渡りません。
- 追加の secret はありません（`KAMAKURA_STUDIO_BRIDGE_SECRET` を共用）。契約の全体は [素材ライブラリ契約](../docs/asset-contract.md)「鎌倉サイトでの接続」と kamakura-site の `worker/README.md`、テストは `test/studio-worker-assets.test.mjs`・`test/kamakura-assets-adapter.test.mjs` です。

## Kamakura の CMS bridge（コレクション）

鎌倉サイトの記事・サークル・会社を、[コレクションの画面](../docs/collection-contract.md)（`CollectionWorkspace`）から編集するための BFF と adapter です。Dashboard の「CMS」から使うには「CMS の切替」の `KAMAKURA_CMS_VIEW` を入れます（既定は枠のまま）。

- ブラウザが呼ぶのは同一 origin の `/api/projects/project-kamakura/sites/kamakura/cms/...` と、画像本体の `PUT https://next-kamakura.niho.life/internal/studio/cms-upload/<uuid>` だけです。BFF は service binding `KAMAKURA_SITE` の `/internal/studio/cms/...` へ、editor と同じ HMAC の header（同じ関数）で署名して渡します。追加の secret はありません。
- 鎌倉以外の Project / Site は 404 です。要求ごとに Access の `sub` と D1 の現在の `owner` / `editor` を確かめます（無ければ 403）。query string、知らない route（404）・method（405）、GET の本文は拒否します。
- 書き込みの本文は、同一 origin（`Origin` 一致・`Sec-Fetch-Site: same-origin`）・`application/json`・JSON object を要求し、操作ごとの key の集合が完全に一致するときだけ通します。BFF は確かめた値だけで JSON を作り直し、Access で確かめた email を `actor: { email }` に入れます。ブラウザが `actor` を送ってきたら 400 です。

| route（`cms/` の後ろ） | ブラウザの本文 | 上流の成功 |
| --- | --- | --- |
| `GET schema` | – | 200 `{ status: "ready", collections }` |
| `GET collections/:col/items` | – | 200 `{ status: "ready", collectionId, items }` |
| `GET collections/:col/items/:id` | – | 200 `{ status: "ready", item }` |
| `POST collections/:col/items` | `{}` | 201 `{ status: "created", item }` |
| `PUT …/:id/draft` | `{ version, values }`（直した key だけ） | 200 `{ status: "saved", item }` |
| `POST …/:id/publish`・`unpublish` | `{ version }` | 202 `{ status: "publishing", item }` |
| `POST …/:id/discard-draft`・`cancel-schedule` | `{ version }` | 200 saved |
| `POST …/:id/schedule` | `{ version, at }`（BFF が UTC の ISO にそろえる） | 200 saved |
| `POST …/:id/duplicate` | `{ version }` | 201 created（別の id） |
| `POST …/:id/remove` | `{ version }` | 200 `{ status: "removed" }` |
| `POST uploads/intent` | `{ collectionId, name, mimeType, bytes }` | 201 `{ uploadUrl, uploadToken, uploadId }` |

- 上限: 下書きの本文 2 MiB（`values` の key は `^[a-z][A-Za-z0-9]{0,63}$` で 100 個まで、値は string〔100 万字まで〕・null・string[]〔200 個まで・各 1〜200 字・重複なし〕）、ほかの本文 16 KiB、上流の応答 3 MiB（upload intent は 16 KiB）。`collectionId` は `^[a-z][a-z0-9-]{0,39}$`、画像は jpeg / png / webp / avif / gif で 50 MiB まで（実際の上限は鎌倉の Worker の 413）。
- 上流の待ち時間は、読み取り 12 秒、書き込み 30 秒（公開・非公開・削除は鎌倉側で commit まで行う）。
- 応答は `studio/kamakura-cms-contract.ts` の parser（BFF とブラウザで共有、`src/collection-model.ts` の parser を使う）で確かめ、既知の field だけを返します。schema の項目の key も `values` と同じ形に限ります。

| 上流 | ブラウザへ |
| --- | --- |
| 契約どおりの成功 | 同じ status で、確かめ直した JSON |
| 409（項目つき） | 409 `{ error: "conflict", item }`（item はほかの人が保存した最新） |
| 422 | 422 `{ error: "invalid", errors }`（先頭の 50 件） |
| upload intent の 413 / 415 | 同じ status で `{ error: "image_rejected" }` |
| 404 | 404 `{ error: "not_found" }`（schema の 404 は endpoint の未配備として 503） |
| 400（と本文の 413） | 400 `{ error: "invalid_request" }` |
| 401 / 403 / 429 / 5xx / 3xx / JSON でない / 上限超え / timeout / 想定外の 4xx | 503 `{ error: "service_unavailable", supportId }` |
| 契約に合わない応答（field の過不足・id の不一致・成功の status 違いなど） | 502 `{ error: "upstream_contract_invalid", supportId }` |

log は editor と同じく問い合わせ ID・固定の operation（`cms_schema`・`cms_list`・`cms_read`・`cms_create`・`cms_draft_save`・`cms_publish`・`cms_discard_draft`・`cms_unpublish`・`cms_duplicate`・`cms_remove`・`cms_schedule`・`cms_cancel_schedule`・`cms_upload_intent`）・固定の分類（editor の分類と `cms_endpoint_missing`）・上流の status だけで、本文・email・subject は出しません。

ブラウザ側は `studio/kamakura-cms.ts` の `createKamakuraCmsAdapter({ siteOrigin })` が `CollectionAdapter` を返します（`siteOrigin` は Project の `site.domains[0]`）。

- 項目ごとに最後に読んだ version と値を覚え、`saveDraft` は**その値との差分だけ**を送ります（触っていない本文などを、画面側の正規化で書き換えないため）。覚えていない version なら読み直し、違えば保存せずに conflict を返します。
- 403 → forbidden、404 → not_found、409 → conflict、422 → invalid。非公開（上流は 202 publishing）は画面の契約に合わせて saved で返します。複製は覚えている version で呼び、競合なら最新の version でもう一度だけ試します。
- 画像: BFF の `uploads/intent` を呼び、`uploadUrl` が鎌倉の Worker の `/internal/studio/cms-upload/<uploadId>` であることを確かめてから、`credentials: "omit"`・`Authorization: Bearer <uploadToken>` で直接 PUT します。結果の URL は `https://kamakura-media.niho.life/uploads/...` だけを受けます。拒否は type / size / permission / invalid で返します。
- `imageUrl` は `kamakura-media.niho.life` の画像だけ `/cdn-cgi/image/width=<w>,format=auto/` の URL にします。`previewUrl` は公開中（変更ありを含む）の項目だけ、サイトの公開 URL と `item.path` から作ります（下書きのプレビューはありません）。
- Dashboard の HTML の `connect-src` には、切替が on のときだけ画像の PUT 先（`https://next-kamakura.niho.life`）を足します（editor の画面は従来どおり）。
- Dashboard の中では `studio/site-cms.tsx` が `studio/kamakura-cms-workspace.tsx` を `import()` で読み、adapter と本文の部品（`createStudioRichText({ imageUrl: adapter.imageUrl })`）を描画の外でサイトごとに 1 回だけ作ります。

テストは `test/studio-worker-cms.test.mjs`（BFF）、`test/kamakura-cms-adapter.test.mjs`（adapter）、`test/studio-site-admin.test.mjs`（切替・CSP・URL）、`test/studio-client-cms.test.mjs`（client の枠とコレクション画面の切り替え・URL・戻る/進む）です。

## Migration と初回セットアップ

前提: Node.js 22、依存関係、Wrangler CLI。Wrangler は環境側で管理し、Cloudflare にログイン済みの operator が実行します。

1. NIHO アカウントに作成済みの `niho-web-studio` D1 と `studio/wrangler.toml` の binding・account ID を照合する。token、credential、実メールアドレスはリポジトリへ書かない。
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

`0001_studio_registry.sql` は2つの Project/Site を seed し、membership を暗黙追加しません。`0002_membership_administration.sql` は既存 membership を保持したまま nullable email、招待、audit を追加します。`0003_experience_site_metadata.sql` は Experience site を API と同じ metadata に更新します。`0004_kamakura_site_metadata.sql` は Kamakura site を catalog と同じ `鎌倉サイト（新サイト確認用）` / `https://next-kamakura.niho.life` に更新します。Migration は既存 membership と owner bootstrap を壊しません。

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

- `GET dashboard`: 現在 member のみ
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
- Kamakura CMS: `GET cms/schema`、`GET|POST cms/collections/:col/items`、`GET cms/collections/:col/items/:id`、`PUT …/:id/draft`、`POST …/:id/{publish,discard-draft,unpublish,duplicate,remove,schedule,cancel-schedule}`、`POST cms/uploads/intent`（owner/editor・鎌倉以外は 404）

unknown Project/Site と権限のない Project/Site は、外部から区別できる詳細を返しません。owner API が返す member 情報は、その owner が管理する同一 Project に限定します。

編集対象の追加手順、trusted registry、client component map、worker adapter mapの境界は [ビルダー接続ガイド](../docs/builder-integration-guide.md) を正とします。登録されていないProject/Site/environmentはHTMLとAPIの両方で閉じます。

## local 確認と配置

```sh
npm run studio:typecheck
npm run studio:build
wrangler dev --config studio/wrangler.toml
```

ローカルでも Worker は実 Access JWT を要求します。JWT 検証を迂回する development mode は設けていません。配置前に Access application の hostname、issuer、AUD、D1 binding、custom domain を相互確認し、`wrangler deploy --config studio/wrangler.toml` を実行します。

## 制約と follow-up

- Experience editor の本番UIは Backend Draft PR #19268 の本番配備と、Studio Worker／NIHO API の本番 secret 設定が揃った場合だけ有効にします。secret が欠落・不正なら API 接続は 503 で fail-closed します。STG用 secret は本番で再利用しません。
- Kamakura editor は新形式の共通ページだけを扱います。ブロック契約は kamakura-site の `GET catalog` が保存時検証と同じ正本から返し、Studio はそれを検証して安全なローカルプレビューを組み立てます。外部表示・予約・送信・CMS取得のコードは実行しません。旧形式一覧は読み取り専用です。素材は「Kamakura の素材ライブラリ」のとおり接続済みで、アップロードと更新は kamakura-site の凍結解除後に通ります。作成、旧形式ページ編集、CMS 操作、全面移行はこの bridge の対象外です。
- Experience editor は production API が提供するページ文書・下書き・公開・復元だけを扱います。自由追加できない NIHO 業務ブロックは `insertableBlocks=[]` とし、components / localization / assets は未実装です。
- 招待メールの配信、再送、token の再表示はありません。URL の安全な共有は owner の運用責任です。
- Access email の変更や IdP account の統合は自動追従しません。membership の主体は安定 `sub` で、保存 email は招待照合と owner 表示用です。
- out-of-band bootstrap SQL 自体は application audit に自動記録されません。operator 側の変更記録を残してください。
- audit の閲覧 UI/API、保持期間、export は未実装です。D1 には改変・削除を拒否する record として保存します。
