# ページ編集HTTP契約

`@niho/web/editing-api` は、GUIと機械クライアントが同じページ正本を編集するためのReact非依存HTTP契約です。Studio UIやStudio Workerを必要条件にしません。各サイトのホストがhandlerを組み込み、認証・権限・永続化・監査記録・公開を所有します。現段階では契約と参照handlerを追加し、既存Studio GUI/CLI routeはまだ移行していません。

## 操作カタログ

ホストは `createPageEditingApi(adapter)` の返すRequest handlerを、自分が選んだoriginとpathへ接続します。既定pathは `/api/edit/v1` です。`GET /sites/{siteId}/capabilities` は、その認証主体が使える操作ID・権限・HTTP method・path・JSON Schema・安定エラー一覧を返します。

| ID | Method | Path | 権限 | 入力 | 結果 |
| --- | --- | --- | --- | --- | --- |
| `pages.read` | GET | `/sites/{siteId}/operations/pages.read/{pageId}?locale={locale}` | `pages.read` | site/page/locale | `{ document, version }` |
| `pages.save` | PUT | `/sites/{siteId}/operations/pages.save/{pageId}?locale={locale}` | `pages.edit` | `{ expectedVersion, document }` | `{ status: "saved", version, document }` |

`pages.save` は `expectedVersion` を原子的に比較します。競合時はHTTP 409と `version_conflict` を返し、ホストは古い下書きを上書きしません。documentは受信側で `parsePageDocument` を通し、pathのsite/pageとqueryのlocaleに一致しない文書、任意HTML・JavaScript・CSSなど検証に失敗する値はHTTP 400 `invalid_request` で拒否します。登録ブロック・部品インスタンス・サイト共通スタイルを使うホストは、adapterの `validationContext(actor, target)` から信頼済みの `blocks`・`components`・`siteStyles` を渡します。読み取り、入力文書、保存後の正規文書の検証に同じcontextを使います。

## CUIでの編集

`niho-edit` はAPI originへ直接接続し、ブラウザーやStudio画面を開きません。ホストが発行する短期tokenを環境変数 `NIHO_EDIT_TOKEN` から読み、`discover` は操作カタログ、`read` は `{ document, version }`、`save` は保存後の `{ document, version }` をJSONで返します。CLIはPageDocumentの外形・対象・版を確認し、ホスト固有のブロック定義を持たなくても文書を往復できるようにします。要素、登録ブロック、部品、styleの完全な検証は、信頼済みcontextを持つホストが行います。

```sh
niho-edit --origin https://site.example --site site-id discover
niho-edit --origin https://site.example --site site-id read home --locale ja > page.json
# page.json の document を編集し、version は保持する
niho-edit --origin https://site.example --site site-id save home --locale ja --json page.json
```

実在サイトがこのAPIを提供するまでは接続できません。既存Studio CLI `niho-studio` の操作とは互換性を保ちながら、ホストを順次移行します。

host adapterの最小実装は `npm run build` の後に `node examples/editing-api-demo.mjs` で実行できます。この例は認証・権限・BlockContractを持つメモリ内ホストでdiscover、ページ読取、版付き保存、古い版の409を確認します。

ページ文書のJSON Schemaはwire上のトップレベル形を説明します。細部の要素・style・属性は `@niho/web/core` の `parsePageDocument` が閉じた文書契約として検証し、登録ブロック・部品・サイト共通styleはホストが渡したcontextに従います。機械クライアントはdiscoverのschemaを入力UI・引数検査に使い、サーバーの文書validatorを正本として扱います。保存成功時はホストが保存後の正規文書とversionを返すため、CLIはそのまま次の編集へ使えます。

## ホストの責務

ホストadapterは次を実装します。

- `authenticate(request)` はセッション/API tokenを検証し、`human` または `machine` のactorと、必要なら委任元を返す。
- `authorize(actor, capability, scope)` はリクエストごとにサイト/ページの権限を判断する。discover時も同じ判定を使う。
- `validationContext(actor, target)` は、対象文書の検証に必要なホスト登録block・部品library・サイトstyleを返す。これらの実装定義はクライアントへ公開しない。
- `readPage` は文書とopaque versionを返す。
- `savePage` はexpectedVersionを永続層で比較して保存する。並行更新は `conflict` を返し、成功時は正規化済みの保存後PageDocumentと新versionを返す。
- actor、操作ID、対象、対象version、結果をホストの監査記録に結び付ける。公開・配備はそれぞれ別権限の操作としてホストが実装する。

Cookie認証を使うホストは、write requestのCSRF境界とCORSも自分のrouterで強制します。公開HTMLにcredential・内部ID・Git source pathを含めません。Handlerは認証方法、DB、CMS、素材、翻訳、Gitへ依存しないので、Studioを使わないホストも同じ契約を組み込めます。

## 安定エラー

| Error | HTTP | 意味 |
| --- | --- | --- |
| `authentication_required` | 401 | 認証主体を確定できない |
| `forbidden` | 403 | 操作権限がない |
| `host_failure` | 503 | ホストの認証/検証context/保存adapterが一時的に失敗した |
| `invalid_request` | 400 | path、query、JSON、PageDocumentが契約に合わない |
| `method_not_allowed` | 405 | 操作に定義されていないmethod |
| `not_found` | 404 | 対象または操作が存在しない |
| `version_conflict` | 409 | expectedVersionが現行版と一致しない |
| `host_contract_violation` | 502 | ホスト保存層の応答がこの契約に合わない |

## 実装状況

この段階ではページの読み取りと版付き保存の共通契約とCUIクライアントを定義しています。既存Studio CLIの全操作、公開計画、CMS・素材・翻訳、およびStudioの各GUI adapterは、互換性を保ちながら後続の#303/#304で順次共通カタログとhost adapterへ移します。
