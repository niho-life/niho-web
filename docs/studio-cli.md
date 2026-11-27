# Studio 経由の niho-edit

Node.js 22 以上で `niho-edit --studio` を使う。origin は Studio の管理 origin を指定する。Cloudflare Access Service Auth の資格情報は `CF_ACCESS_CLIENT_ID` と `CF_ACCESS_CLIENT_SECRET` で渡す。Studio-native site を人として操作するときは、短時間の Access application token を `NIHO_EDIT_TOKEN` で渡す。

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

Studio-native site は `publish`、`history`、`restore` を各1回のAPI呼出しで実行します。`publish --changed` の一括公開とサイト全体の公開復元は別途対応中です。鎌倉の既存経路では移行が終わるまで上記の二段階コマンドを使います。

```sh
niho-edit --studio --origin https://studio.example --site site-id publish home --locale ja
niho-edit --studio --origin https://studio.example --site site-id history home --locale ja
niho-edit --studio --origin https://studio.example --site site-id restore home 4 --locale ja
```

結果はJSONです。`history` の `id` を確認し、残っているrevisionを `restore` の `<revision>` に渡します。CLIの機械認証には site に委任された `pages.publish` grant が必要です。

## Studio-native CMS

管理側の Studio origin を指定して `niho-edit --studio` を使います。人として呼ぶ場合は短時間の Access application token を `NIHO_EDIT_TOKEN` に渡します。サービスでは `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` と対象 site の D1 grant を使います。定義の適用は人の owner の権限です。例の origin と site は架空です。

```sh
niho-edit --studio --origin https://studio.example --site demo-site cms-schema
niho-edit --studio --origin https://studio.example --site demo-site cms-list posts
niho-edit --studio --origin https://studio.example --site demo-site cms-discover
niho-edit --studio --origin https://studio.example --site demo-site \
  cms-v2 cms.schedule.status --json schedule-status.json
```

`cms-v2` の入力ファイルには対象の `siteId` を含めます。`cms.release.plan` は事前に `cms.release.current` から得た `routeTableRevision` を含めます。定義計画の `cms.schema.plan` には、同じ応答の locale と `routeTableRevision` を `routeTableVersions` に含めます。予約は `cms.release.plan` にUTCのISO 8601日時 `at` を渡して作った計画を `cms.schedule.create` へ適用します。取消、下書き保存、削除・復元の操作IDは `--operation-id` で渡し、通信障害後は同じ入力とIDを再送します。既存 `cms-publish` の反映結果は `cms-status` で確認できます。同じ入力とIDの再送が受領記録を返す CMS の操作には、汎用 Studio CLI の重複拒否規則に代わって CMS の規則が適用されます。[CMS v2 契約](cms-v2-contract.md)

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
