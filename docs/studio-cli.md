# Studio 経由の niho-edit

Node.js 22 以上で `niho-edit --studio` を使う。origin は Studio の管理 origin を指定する。Cloudflare Access Service Auth の資格情報は `CF_ACCESS_CLIENT_ID` と `CF_ACCESS_CLIENT_SECRET` で渡す。Studio-native site を人として操作するときは、短時間の Access application token を `NIHO_EDIT_TOKEN` で渡す。

Studio-native site の共通SEO設定は owner 権限で読み書きできます。`site-seo-read` は `{ settings, version }` を返します。`site-seo-save` には編集したsnapshot全体を渡してください。設定は公開許可設定と同じ版を使うため、競合したら再読込して編集を確認します。

```sh
niho-edit --studio --origin https://studio.example --site demo-site site-seo-read > site-seo.json
# site-seo.json の settings を編集
niho-edit --studio --origin https://studio.example --site demo-site site-seo-save --json site-seo.json

niho-edit --studio --origin https://studio.example --site demo-site site-redirects-read > redirects.json
# redirects.json の redirects 配列を編集
niho-edit --studio --origin https://studio.example --site demo-site site-redirects-save --json redirects.json
```

`site-redirects-read` は `{ redirects, version }` を返します。各項目は `{ locale, fromPath, toPath }` で、パスはサイト内の相対パスです。保存は読み込んだversionとの照合を行い、重複した転送元や転送ループは拒否します。ページのURLを変更したとき自動作成された転送も、同じCLIとGUI一覧から確認・削除できます。

## Studio-native サイト共通スタイル

Studio-native site の色 token と文字スタイルは、GUI の「スタイル」パネルと同じ `site.styles.*` 操作で読み書きします。

```sh
niho-edit --studio --origin https://studio.example --site demo-site styles read > styles.json
# styles.json の draft.styles を編集し、snapshot全体を保持
niho-edit --studio --origin https://studio.example --site demo-site styles edit --json edits.json
niho-edit --studio --origin https://studio.example --site demo-site styles publish --json publish.json
```

`styles read` は `{ draft: { version, styles }, published: { version, styles } }` を返します。`styles edit` には `{ expectedVersion, edits }`、`styles publish` には `{ expectedDraftVersion, expectedPublishedVersion }` を渡します。編集は版照合付きです。ページが参照する共通値の rename/delete は利用箇所を返して拒否し、文字スタイル内の token 参照は rename と同時に更新します。公開済みスタイルはページ生成時の HTML に使われます。スタイルの公開を全ページの作り直しへつなぐ操作は、#527 の共通部分公開に合わせて行います。

## Studio内サイトの画像ライブラリ

```sh
niho-edit --studio --origin https://studio.example --site demo-site assets-upload --file ./sea.png --name sea.png
niho-edit --studio --origin https://studio.example --site demo-site assets-list [--provider studio-upload|kamakura-source] [--cursor <cursor>]
```

`assets-upload` は JPEG・PNG・WebP・AVIF・GIF（20 MiB まで、拡張子で形式を決める）を 1 回の PUT で送り、`{ status: "uploaded", asset }` を返します。返った `provider` と `id` の参照を、ページの `img` の `asset` や CMS の image / gallery に入れます。`assets-list` は新しい順で、`assets-upload` は `pages.edit`、`assets-list` は `pages.read` の grant が要ります。`pull` / `push` は素材を同期しません（参照だけ）。

## Studio内サイトの公開配信設定と埋め込み

GUI 操作との対応は `niho-edit --help` の一覧を参照してください。

```sh
niho-edit --studio --origin https://studio.example --site demo-site site-public-read > public-settings.json
niho-edit --studio --origin https://studio.example --site demo-site site-public-save --json public-settings.json
niho-edit --studio --origin https://studio.example --site demo-site page-embed-register home --locale ja --json embed.json
```

`site-public-read` は `{ domain: { hostname, noindex, version }, origins: { frameOrigins, resourceOrigins, version } }` を返します。独自ドメインにはホスト名を指定し、解除は `hostname: null` を使います。各 origin は `https://` で始まる origin の配列で指定します。編集した JSON を両方の版を保って `site-public-save` へ渡します。変更する項目だけを保存する場合は、`domain` または `origins` の片方を指定できます。`origins.version` は SEO 設定と共有します。

保存時に版が競合したら読み直して編集内容を確認します。両方を変更した際にドメインだけが保存されて後続の許可 origin の保存が失敗すると、CLI は失敗として終了し、`partial_save` と保存済みの項目を返します。再読込してから残りを適用してください。

配信設定は GUI と同じ owner 権限を使います。機械認証には `site.settings.read` / `site.settings.write` の grant が必要です。対応する HTTP 操作は GET `/api/edit/v2/sites/{siteId}/operations/site.public.read` と PUT `/api/edit/v2/sites/{siteId}/operations/site.public.save` です。

`embed.json` の `src` に対象ページ用に NIHO で発行した埋め込み URL を指定します。出力の `result.refId` をページの `ManagedEmbed` ブロックに設定して、`apply` または `save` で保存します。埋め込み先の origin はサイト設定で許可してください。HTTP 操作は POST `/api/edit/v2/sites/{siteId}/operations/pages.embed-register/{pageId}` で、入力は `{ locale, src }` です。GUI と同じ編集権限を使い、機械認証には `pages.edit` の grant が必要です。

## ファイル同期（pull・check・push）

Studio を正本のまま、サイトをディレクトリのファイルとして直すための3コマンドです。3つとも `--studio` が必須で、無ければ `invalid_arguments` です。`[dir]` の既定は `.` です。

```sh
niho-edit --studio --origin https://studio.example --site site-id pull ./site
niho-edit --studio --origin https://studio.example --site site-id check ./site --html ./preview
niho-edit --studio --origin https://studio.example --site site-id push ./site
niho-edit --studio --origin https://studio.example --site site-id publish --changed
```

ディレクトリの形です。JSON はキーを再帰的に辞書順に並べ、2スペース字下げ、末尾改行で書きます（配列の順は保ちます）。

| パス | 中身 |
| --- | --- |
| `pages/<locale>/<pageId>.json` | `read` の `document` そのもの |
| `cms/<collectionId>/<itemId>.json` | CMS 項目の `values`（訳は含めません） |
| `site/seo.json` | `site-seo-read` の `settings` |
| `site/redirects.json` | `site-redirects-read` の `redirects` 配列 |
| `site/public.json` | `{ domain: { hostname, noindex }, origins: { frameOrigins, resourceOrigins } }` |
| `site/styles.json` | `styles read` の `draft.styles`（共通の枠 `frame` を含む。[site-styles-contract.md](site-styles-contract.md)） |
| `.niho/state.json` | CLI だけが書く。各ファイルの種別・識別子・版・内容の hash・CMS 保存の操作 ID |
| `.niho/context.json` | `check` が使う読取専用の文脈（ブレークポイント設定、公開パス一覧） |

版と操作 ID は `.niho/state.json` にだけあり、編集するファイルには含めません。ページに紐づく CMS binding（`cmsBindings`）はファイルに含めません。変更は `apply --cms-bindings` で行います。一覧の `filter` は `{ fieldId, equals }` か、参照・複数選択の select 用の `{ fieldId, includes }` です。素材（画像）は `pull` せず、参照の ID だけを置きます。アップロードは `assets-upload` です。

機械認証の grant は、`pull` に `pages.read`・`site.settings.read`・`cms.read`、`push` に `pages.edit`・`site.settings.write`・`cms.edit` が要ります。どれかが無いと `pull` は 403 で止まります。

- **pull**: dir が空、または同じ origin・site の state がある場合だけ進みます（`sync_dir_not_empty` / `sync_dir_other_site`）。ローカルが未変更ならサーバーの内容で更新し、ローカルだけが変更済みなら残します（`kept`）。両方が変わったファイルは触らず `conflicts` に報告し、終了コード 1 です。ローカルの変更を捨てるときは、そのファイルを消してから `pull` し直します。サーバーから消えた項目は、ローカルが未変更なら消し、変更済みなら報告だけです。
- **check**: サーバーに問い合わせません。既定は変わったファイル、`--all` で全ファイルです。ページの形式・識別子・lint、SEO・リダイレクト・スタイルの形式、1ページ 200KB 超の警告を出します。`--html <out>` は本文を `<out>/<locale>/<pageId>.html` に参考描画し、公開 HTML の SEO 検査をかけます。部品は空の枠で描き、head・CMS・埋め込みは公開時に描くため、HTML は本文の参考です。描けないページは `html_render_unavailable` の警告です。`unused-token` などサイト全体の lint は `--all` のときだけ出ます。errors があれば終了コード 1 です。
- **push**: 変わったファイルだけを、ファイルごとに独立して版照合付きで下書きに保存します。1件が競合・失敗しても残りは続けます。ローカル検証（`check` と同じ）に失敗したファイルは送らず `invalid` です。結果は `saved`・`conflicts`・`invalid`・`skipped` で、競合か invalid があれば終了コード 1 です。公開はしません。
  - 新しいファイルと、ローカルで消したファイルは `skipped` です。ページは `page-change`、CMS 項目は `cms-create` で作ってから `pull` します。削除は GUI か `page-change` で行います。
  - CMS の保存は操作 ID を state に残してから送り、通信失敗後の再 `push` では同じ ID を使います。
  - SEO 設定と `origins` は版を共有します。`seo` を先に保存し、返った版を `origins` に引き継いでから `public` を保存します。`public` は変えた側（`domain` / `origins`）だけを送り、`partial_save` はそのまま報告します。
  - スタイルは、サーバーの現在の draft との差分を `styles edit` の edits にして送ります。使用中の値の削除は `referenced` として使用箇所を返します。名前の変更は推測しないので、`styles edit` の rename を使います。

## 鎌倉のページ編集と公開

Studio Worker は Access で検証済みの service identity と、対象 Project・Site の `studio_cli_grants` を照合する。現在のオーナーが委任した有効な `pages.read`、`pages.edit`、`pages.publish` がそれぞれ読取、保存、公開に必要になる。公開は計画を作り、確認した計画と一意の operation ID を渡して適用する。共通 API は `/api/edit/v1/sites/:siteId` 配下で、利用できる操作を `discover` が返す。CMS の読み取り・編集・公開も、応答に含まれる `cms.*` 操作を対応する grant で呼び出す。

例の Studio origin は架空の値。Access 資格情報は引数やファイルに含めない。

```sh
niho-edit --studio --origin https://studio.example --site kamakura discover
niho-edit --studio --origin https://studio.example --site kamakura read home --locale ja > snapshot.json
niho-edit --studio --origin https://studio.example --site kamakura save home --locale ja --json snapshot.json > saved.json
niho-edit --studio --origin https://studio.example --site kamakura release-plan home --locale ja --action publish --json saved.json > plan.json
niho-edit --studio --origin https://studio.example --site kamakura release home --locale ja --json plan.json --operation-id "$operation_id"
```

`snapshot.json` の `document` を編集して保存する。競合したら現行版を読み直す。`operation_id` は UUID v4 を使い、結果が不明な場合は同じ plan・operation ID で再試行する。共通APIの入出力は[ページ編集 HTTP 契約](editing-api-contract.md)を参照。

## Studio-native ページの公開と版履歴

ページの「公開」は指定ページの下書きを公開します。どの公開操作でも、選ばれなかったページは公開中の版から作り直します。内容が同じHTMLは既存の生成物を使います。`changes` と `publish --changed` は、Studio GUI と同じ未公開変更一覧を使います。複数ページ・共通設定・CMS 項目をまとめて生成し、全URLを用意できた後に公開manifestを1回だけ切り替えます。どれか1つでも生成できなければ、何も切り替えません。対象ページ以外は公開済みの版から生成し、保存しただけの下書きは混ぜません。

```sh
niho-edit --studio --origin https://studio.example --site site-id publish home --locale ja --json saved.json
niho-edit --studio --origin https://studio.example --site site-id changes
niho-edit --studio --origin https://studio.example --site site-id publish page-one page-two --locale ja
niho-edit --studio --origin https://studio.example --site site-id publish --changed
niho-edit --studio --origin https://studio.example --site site-id publish --site
niho-edit --studio --origin https://studio.example --site site-id publish --all
niho-edit --studio --origin https://studio.example --site site-id site-history
niho-edit --studio --origin https://studio.example --site site-id rollback <release-id>
niho-edit --studio --origin https://studio.example --site site-id history home --locale ja
niho-edit --studio --origin https://studio.example --site site-id restore home 4 --locale ja --expected-version "$page_version"
niho-edit --studio --origin https://studio.example --site site-id pages-catalog
niho-edit --studio --origin https://studio.example --site site-id page-change --expected-version "$catalog_version" --json new-page.json
```

結果は JSON です。ページ単位の `publish` と `restore` は `read` または `save` のスナップショットを `--json` に渡すか、その `version` を `--expected-version` に指定します。`changes` はページ本文・path/visibility・共通設定・CMS 項目の未公開変更を返します。CMS 項目は元の言語の項目で、公開中の版と下書きが違うもの（`reason: "draft"`）と未公開のもの（`"new"`）です。公開予約か反映待ちの CMS 公開がある間は、予約を崩さないよう CMS 項目を一覧にも公開にも含めません。`publish --changed` はその全件を一括公開し、CMS 項目は1つの CMS release にまとめ、それを表示する一覧・詳細とページを同じ公開で作り直します。URL を変えた公開済みの CMS 項目は、`cms-publish --redirect true` と同じく旧 URL から新 URL へ転送します。成功後に同じ版で再送すると `version_conflict` になります。`publish --site` は共通設定だけを公開します。複数のページIDを指定すると、指定したページの下書きをまとめて公開します。公開中の版を作り直す `publish --all` はコード変更・移行時の CLI 専用操作です。`site-history` は公開版の日時・実行者・変更URLを返し、`rollback <release-id>` は選んだ公開版へ一度で戻します。古い履歴では実行者や変更URLが未記録の場合があります。`restore` の履歴版は `history` の `id` または revision から選びます。`page-change` で `action: "create"` を使う場合は `pages-catalog` の版を、`"update"` または `"visibility"` では対象ページを `read` した版を指定します。例の `new-page.json` は `{ "action": "create", "siteId": "site-id", "locale": "ja", "title": "About", "path": "/about" }` です。

公開結果の `elapsedMs` と GUI の表示時間は、変更一覧の取得を含む操作側の壁時計時間です。CLI の `serverElapsedMs` はサーバーが返した参考値で、Cloudflare Workers上のtimerはI/O間だけ進むためCPU処理時間を含みません。95 URLの全量公開を15秒以内か判断するときは `elapsedMs` を使います。

版が競合すると HTTP 409 `version_conflict` で終了します。入力ファイルはそのまま使って最新状態と比較できます。機械認証は対象サイトに委任された `pages.publish` grant を使い、読取には対応する読取 grant を使います。CMS 項目は `cms.publish` grant があるときだけ一覧と `publish --changed` に含まれます。

## Studio-native CMS

管理側の Studio origin を指定して `niho-edit --studio` を使います。人として呼ぶ場合は短時間の Access application token を `NIHO_EDIT_TOKEN` に渡します。サービスでは `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` と対象 site の D1 grant を使います。定義の適用は人の owner の権限です。例の origin と site は架空です。

```sh
niho-edit --studio --origin https://studio.example --site demo-site cms-schema
niho-edit --studio --origin https://studio.example --site demo-site cms-list posts
niho-edit --studio --origin https://studio.example --site demo-site \
  cms-publish posts item-123 --expected-version "$item_version" --operation-id "$operation_id"
niho-edit --studio --origin https://studio.example --site demo-site cms-status --operation-id "$operation_id"
niho-edit --studio --origin https://studio.example --site demo-site cms-discover
niho-edit --studio --origin https://studio.example --site demo-site \
  cms-v2 cms.schedule.status --json schedule-status.json
```

`cms-v2` の入力ファイルには対象の `siteId` を含めます。`cms.release.plan` は事前に `cms.release.current` から得た `routeTableRevision` を含めます。定義計画の `cms.schema.plan` には、同じ応答の locale と `routeTableRevision` を `routeTableVersions` に含めます。予約は `cms.release.plan` にUTCのISO 8601日時 `at` を渡して作った計画を `cms.schedule.create` へ適用します。取消、下書き保存、削除・復元の操作IDは `--operation-id` で渡し、通信障害後は同じ入力とIDを再送します。`cms-publish` は `cms-read` または `cms-save` の項目版を使い、項目公開を1回で要求します。応答に含まれる operation ID を `cms-status` に渡して反映結果を確認できます。転送を作る場合は `--redirect true` も送ります。同じ入力とIDの再送が受領記録を返す CMS の操作には、汎用 Studio CLI の重複拒否規則に代わって CMS の規則が適用されます。[CMS v2 契約](cms-v2-contract.md)

コレクション・フィールドの定義変更は Studio GUI と同じ `cms.schema.plan` / `cms.schema.apply` を使います。`cms-schema-plan` が現行定義の版と公開ルート版を取得するため、JSONには変更後の定義と必要な変換値だけを書きます。`cms-v2 cms.schema.read` の応答 `result` を `nextSchema` として編集し、`schema-draft.json` に保存します。

```sh
niho-edit --studio --origin https://studio.example --site demo-site cms-v2 cms.schema.read --json schema-read-request.json > schema-read.json
```

`schema-read-request.json` は `{ "siteId": "demo-site" }` です。変換値が必要なら `replacements` に項目・locale・field ID単位の値を加えます。

```json
{
  "nextSchema": {
    "contractVersion": 2,
    "siteId": "demo-site",
    "schemaRevision": "current-revision",
    "collections": [{
      "id": "posts", "label": "お知らせ", "addLabel": "項目を追加", "ordering": "publishedAt", "pathPrefix": null,
      "titleField": "title", "slugField": null, "imageField": null, "subtitleField": null,
      "capabilities": { "create": true, "duplicate": false, "remove": true, "unpublish": true, "schedule": true },
      "fields": [{ "fieldId": "title", "key": "title", "label": "タイトル", "type": "text", "placement": "main" }]
    }],
    "retiredFields": []
  },
  "replacements": []
}
```

```sh
niho-edit --studio --origin https://studio.example --site demo-site cms-schema-plan --json schema-draft.json > schema-plan.json
niho-edit --studio --origin https://studio.example --site demo-site cms-schema-apply --json schema-plan.json
```

計画の `candidate.changes` にフィールド削除または型・設定変更が含まれる場合、値への影響を確認し `--confirm-data-loss` を付けて適用します。変換できない値・壊れる参照・ルート衝突を含む計画は問題一覧を返し、適用できません。フォーム定義の編集には対応しません。

Studio-native CMS の翻訳には、共通の `localization-*` CLI を `--studio` とともに使います。対象 locale の CMS snapshot を個別に準備・公開し、下書きや未確認の訳は公開されません。

```sh
niho-edit --studio --origin https://studio.example --site demo-site localization-release-read
niho-edit --studio --origin https://studio.example --site demo-site localization-release-prepare --json locale-publish.json > locale-plan.json
niho-edit --studio --origin https://studio.example --site demo-site localization-release-apply --json locale-apply.json
```

`locale-publish.json` には `operation: "publish"`、`releaseId: null`、`expectedVersion`、`expectedCurrentVersion: null`、`resumeToken: null`、一意な UUID `operationId` を指定します。CLI は準備時に操作IDを再送キーとして使います。準備応答の `plan.confirmationToken` を使い、`locale-apply.json` に `operation: "publish"`、`expectedVersion`、`confirmationToken`、`resumeToken: null` を指定します。CMS locale 公開では未完了項目を snapshot から省き、日本語への fallback は行いません。詳細は [CMS v2 契約](cms-v2-contract.md#cms-項目の翻訳と-locale-snapshot) を参照してください。
