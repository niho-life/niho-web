# ページ編集HTTP契約

`@niho/web/editing-api` は、GUIと機械クライアントが同じページ正本を編集するためのReact非依存HTTP契約です。Studio UIやStudio Workerを必要条件にしません。各サイトのホストがhandlerを組み込み、認証・権限・永続化・監査記録・公開を所有します。現段階では契約と参照handlerを追加し、既存Studio GUI/CLI routeはまだ移行していません。

`@niho/web/editing-client` の `createPageEditingApiClient` は同じwire契約を呼ぶReact非依存clientです。ブラウザーのGUIは既定のsame-origin credentialsまたはhost提供headerを使え、Node CLIはbearer headerと `credentials: "omit"` を使えます。現在の `niho-edit` はこのclient上に実装しています。既存Studio GUI routeはまだこのclientへ切り替わっていません。

## 操作カタログ

ホストは `createPageEditingApi(adapter)` の返すRequest handlerを、自分が選んだoriginとpathへ接続します。既定pathは `/api/edit/v1` です。1つのWorkerで複数サイトを扱う場合は `createRegisteredPageEditingApi([{ siteIds, adapter }, ...])` を使い、完全一致するsite IDを登録済みadapterへ振り分けます。登録重複は起動時に拒否し、未登録site IDは404になります。ホストごとの処理でsite名を条件分岐する必要はありません。`GET /sites/{siteId}/capabilities` は、その認証主体が使える操作ID・権限・HTTP method・path・JSON Schema・安定エラー一覧を返します。

| ID | Method | Path | 権限 | 入力 | 結果 |
| --- | --- | --- | --- | --- | --- |
| `pages.read` | GET | `/sites/{siteId}/operations/pages.read/{pageId}?locale={locale}` | `pages.read` | site/page/locale | `{ document, version }` |
| `pages.save` | PUT | `/sites/{siteId}/operations/pages.save/{pageId}?locale={locale}` | `pages.edit` | `{ expectedVersion, document }` | `{ status: "saved", version, document }` |
| `pages.release-plan` | POST | `/sites/{siteId}/operations/pages.release-plan/{pageId}?locale={locale}` | `pages.publish` | expected version, publish/rollback action, optional rollback revision and dependency versions | `{ plan }` |
| `pages.release` | POST | `/sites/{siteId}/operations/pages.release/{pageId}?locale={locale}` | `pages.publish` | expected version, one-use confirmation token, UUID v4 operation ID | `{ status: "released", operationId, version, document }` |

`pages.save` は `expectedVersion` を原子的に比較します。競合時はHTTP 409と `version_conflict` を返し、ホストは古い下書きを上書きしません。documentは受信側で `parsePageDocument` を通し、pathのsite/pageとqueryのlocaleに一致しない文書、任意HTML・JavaScript・CSSなど検証に失敗する値はHTTP 400 `invalid_request` で拒否します。登録ブロック・部品インスタンス・サイト共通スタイルを使うホストは、adapterの `validationContext(actor, target)` から信頼済みの `blocks`・`components`・`siteStyles` を渡します。読み取り、入力文書、保存後の正規文書の検証に同じcontextを使います。

## CUIでの編集

`niho-edit` はホストAPI originへ直接接続し、ブラウザーやStudio画面を開きません。ホストが発行する短期tokenを環境変数 `NIHO_EDIT_TOKEN` から読み、`discover` は利用可能な操作、`read` と `save` は文書と版、`release-plan` は公開先・差分を含む計画をJSONで扱います。`release` は計画の一回限りtokenと呼出側が先に保存したoperation IDを渡すため、通信タイムアウト後も同じIDで安全に再試行できます。CLIはPageDocumentの外形・対象・版を確認し、ホスト固有のブロック定義を持たなくても文書を往復できるようにします。要素、登録ブロック、部品、styleの完全な検証は、信頼済みcontextを持つホストが行います。

```sh
niho-edit --origin https://site.example --site site-id discover
niho-edit --origin https://site.example --site site-id read home --locale ja > page.json
# page.json の document を編集し、version は保持する
niho-edit --origin https://site.example --site site-id save home --locale ja --json page.json > saved.json
niho-edit --origin https://site.example --site site-id release-plan home --locale ja --action publish --json saved.json > release-plan.json
# 公開先と差分を確認し、再試行にも使うoperation IDを先に決めて保存する
OPERATION_ID=$(node -p 'crypto.randomUUID()')
niho-edit --origin https://site.example --site site-id release home --locale ja --json release-plan.json --operation-id "$OPERATION_ID"
```

`release-plan` の `--expected-version` は最新の `read` / `save` 結果から指定します。ロールバックは `--action rollback --revision <公開版>` を指定します。applyがタイムアウトした場合は計画ファイルと同じoperation IDを使って再送します。IDを変えると別操作として扱われます。

このAPIはホストのサイトorigin上で直接公開し、Studioの画面やWorkerを経由させません。既存Studio CLIは互換経路として残し、GUIも同じページ正本と版競合を使います。ホストはAPIの認証・認可・監査・永続化・公開を実装し、配備と認証設定を別途完了する必要があります。

host adapterの最小実装は `npm run build` の後に `node examples/editing-api-demo.mjs` で実行できます。この例は認証・権限・BlockContractを持つメモリ内ホストでdiscover、ページ読取、見出し・背景色の変更、フォームの追加、版付き保存、古い版の409を確認します。

ページ文書のJSON Schemaはwire上のトップレベル形を説明します。細部の要素・style・属性は `@niho/web/core` の `parsePageDocument` が閉じた文書契約として検証し、登録ブロック・部品・サイト共通styleはホストが渡したcontextに従います。機械クライアントはdiscoverのschemaを入力UI・引数検査に使い、サーバーの文書validatorを正本として扱います。保存成功時はホストが保存後の正規文書とversionを返すため、CLIはそのまま次の編集へ使えます。

## ホストの責務

ホストadapterは次を実装します。

- `authenticate(request)` はセッション/API tokenを検証し、`human` または `machine` のactorと、必要なら委任元を返す。
- `authorize(actor, capability, scope)` はリクエストごとにサイト/ページの権限を判断する。discover時も同じ判定を使う。
- `validationContext(actor, target)` は、対象文書の検証に必要なホスト登録block・部品library・サイトstyleを返す。これらの実装定義はクライアントへ公開しない。
- `readPage` は文書とopaque versionを返す。
- `savePage` はexpectedVersionを永続層で原子的に比較して保存する。並行更新は `conflict` を返し、成功時は正規化済みの保存後PageDocumentと新versionを返す。
- 公開操作を提供する場合は `releaseSite` から信頼済みの許可originを返し、`preparePageRelease` が現行版・依存版・公開先に束縛された計画を作る。handlerは計画の対象・action・版・domainを検証する。
- `publishPage` はexpectedVersionと一回限りconfirmation tokenを検証し、actor + operation ID + 同一入力の再送で最初の結果を返すように原子的に実装する。別入力で同じIDを再利用した場合は競合として拒否する。
- actor、委任元、操作ID、対象、対象version、結果をホストの監査記録へ原子的に結び付ける。公開・配備はそれぞれ別権限の操作としてホストが実装する。

複数サイトのWorkerでは `createRegisteredPageEditingApi` の登録表を使い、各サイトの認証・権限・保存先を個別adapterへ閉じ込めます。単一サイトだけを配信するホストは `createPageEditingApi` を直接mountできます。どちらも同じ操作カタログ、wire schema、入力検証、安定エラーを使います。

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

この段階ではページ読取・版付き保存・公開計画/適用の共通契約とCUIクライアントを実装しています。各ホストがこのhandlerをサイトoriginにmountし、認証・監査・CAS・operation IDを組み込んで初めて実サイトで利用できます。Studio CLIのCMS・素材・翻訳や他のGUI adapterは、このページ契約の対象外です。
