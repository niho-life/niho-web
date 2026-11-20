# ページ・サイト設定編集HTTP契約

`@niho/web/editing-api` は、GUIと機械クライアントが同じページ本文・CMS項目・ページ管理・サイト設定の正本を編集するためのReact非依存HTTP契約です。Studio UIやStudio Workerを必要条件にしません。各サイトのホストがhandlerを組み込み、認証・権限・永続化・監査記録・公開を所有します。Studio GUIとCUIは同じ操作カタログとwire形式を使い、各クライアントの操作履歴をホストのactorと版に結び付けます。

`@niho/web/editing-client` の `createPageEditingApiClient` は同じwire契約を呼ぶReact非依存clientです。ブラウザーのGUIは既定のsame-origin credentialsまたはhost提供headerを使え、Node CLIはbearer headerと `credentials: "omit"` を使えます。GUIと `niho-edit` CLIはページ本文・CMS項目・ページ管理・ブレークポイントの同じ操作を呼べます。Studio GUIはAccess sessionをWorker BFFで短期の操作別tokenへ委任し、サイトoriginの共通APIへservice bindingで接続します。ブラウザーのAccess tokenやcookieはサイトへ転送しません。

Studio GUIはページの表示・編集材料の一部（presentation metadata、英語公開状態）を取得するため、引き続きread-onlyの既存snapshot routeも併用します。日本語本文・CMS項目・ページ管理の書込は共通APIを使います。素材と翻訳は別操作です。

## 操作カタログ

ホストは `createPageEditingApi(adapter)` の返すRequest handlerを、自分が選んだoriginとpathへ接続します。既定pathは `/api/edit/v1` です。1つのWorkerで複数サイトを扱う場合は `createRegisteredPageEditingApi([{ siteIds, adapter }, ...])` を使い、完全一致するsite IDを登録済みadapterへ振り分けます。登録重複は起動時に拒否し、未登録site IDは404になります。ホストごとの処理でsite名を条件分岐する必要はありません。`GET /sites/{siteId}/capabilities` は、その認証主体が使える操作ID・権限・HTTP method・path・JSON Schema・安定エラー一覧を返します。

| ID | Method | Path | 権限 | 入力 | 結果 |
| --- | --- | --- | --- | --- | --- |
| `pages.read` | GET | `/sites/{siteId}/operations/pages.read/{pageId}?locale={locale}` | `pages.read` | site/page/locale | `{ document, version }` |
| `pages.save` | PUT | `/sites/{siteId}/operations/pages.save/{pageId}?locale={locale}` | `pages.edit` | `{ expectedVersion, document }` | `{ status: "saved", version, document }` |
| `pages.release-plan` | POST | `/sites/{siteId}/operations/pages.release-plan/{pageId}?locale={locale}` | `pages.publish` | expected version, publish/rollback action, optional rollback revision and dependency versions | `{ plan }` |
| `pages.release` | POST | `/sites/{siteId}/operations/pages.release/{pageId}?locale={locale}` | `pages.publish` | expected version, one-use confirmation token, UUID v4 operation ID | `{ status: "released", operationId, version, document }` |
| `pages.catalog` | GET | `/sites/{siteId}/operations/pages.catalog` | `pages.read` | site ID | `{ version, pages }` |
| `pages.change-prepare` | POST | `/sites/{siteId}/operations/pages.change-prepare` | `pages.publish` | `{ expectedVersion, operationId, change }` | `{ plan }` |
| `pages.change-apply` | POST | `/sites/{siteId}/operations/pages.change-apply` | `pages.publish` | `{ expectedVersion, operationId, confirmationToken, change }` | `{ status: "applied", operationId, page }` |
| `site.breakpoints.read` | GET | `/sites/{siteId}/operations/site.breakpoints.read` | `site.settings.read` | site ID | `{ settings, version }` |
| `site.breakpoints.save` | PUT | `/sites/{siteId}/operations/site.breakpoints.save` | `site.settings.write` | `{ expectedVersion, settings }` | `{ status: "saved", version }` |
| `cms.schema` | GET | `/sites/{siteId}/operations/cms.schema` | `cms.read` | site ID | `{ collections }` |
| `cms.list` | GET | `/sites/{siteId}/operations/cms.list/{collectionId}` | `cms.read` | site / collection ID | `{ collectionId, items }` |
| `cms.read` | GET | `/sites/{siteId}/operations/cms.read/{collectionId}/{itemId}` | `cms.read` | collection / item ID | `{ item }` |
| `cms.create` | POST | `/sites/{siteId}/operations/cms.create/{collectionId}` | `cms.edit` | `{ operationId }` | `{ item }` |
| `cms.save` | PUT | `/sites/{siteId}/operations/cms.save/{collectionId}/{itemId}` | `cms.edit` | `{ expectedVersion, operationId, values }` | `{ status: "saved", item }` |
| `cms.publish-plan` | POST | `/sites/{siteId}/operations/cms.publish-plan/{collectionId}/{itemId}` | `cms.publish` | `{ expectedVersion, operationId, redirect? }` | `{ plan }` |
| `cms.publish` | POST | `/sites/{siteId}/operations/cms.publish/{collectionId}/{itemId}` | `cms.publish` | `{ expectedVersion, operationId, confirmationToken, redirect? }` | `{ status, operationId, item }` |
| `cms.operation-status` | GET | `/sites/{siteId}/operations/cms.operation-status/{operationId}` | `cms.read` | site / operation ID | `{ status, operationId, ... }` |

`pages.save` は `expectedVersion` を原子的に比較します。競合時はHTTP 409と `version_conflict` を返し、ホストは古い下書きを上書きしません。documentは受信側で `parsePageDocument` を通し、pathのsite/pageとqueryのlocaleに一致しない文書、任意HTML・JavaScript・CSSなど検証に失敗する値はHTTP 400 `invalid_request` で拒否します。登録ブロック・部品インスタンス・サイト共通スタイルを使うホストは、adapterの `validationContext(actor, target)` から信頼済みの `blocks`・`components`・`siteStyles` を渡します。読み取り、入力文書、保存後の正規文書の検証に同じcontextを使います。

`site.breakpoints.*` は、hostの設定正本へ保存するsite単位の操作です。各操作は対応するadapter関数が登録されているhostだけがdiscoverに出します。settingsは `parseBreakpointSettings` の閉じた契約で検証し、saveはhostの永続層でexpectedVersionを原子的に比較します。stale versionは409 `version_conflict` です。

`pages.catalog` は管理可能なページと一覧のopaque versionを返します。`pages.change-prepare` は作成・名前/URL変更・公開状態変更を実行せずに影響と短期確認tokenを返し、`pages.change-apply` は同じ `expectedVersion`・UUID v4 `operationId`・change・tokenを照合して適用します。stale versionは409 `version_conflict`、別prepareでのoperation ID再利用は409 `duplicate_operation` です。同じactorが同じapplyを再送した場合は、ホストが記録した同じ結果を返します。

`cms.schema` はホストの `CollectionDefinition` を返します。`cms.list` / `cms.read` は一覧と項目の読み取り、`cms.create` / `cms.save` は下書きの作成と版付き保存、`cms.publish-plan` / `cms.publish` は確認token付き二段階公開を行います。`cms.create` は対象collectionの `capabilities.create` が有効な場合だけ受け付けます。保存値は定義済みフィールドで検証され、stale versionは409 `version_conflict` と現行項目を返します。保存・公開計画・公開適用のフィールド検証エラーは422 `validation_failed` と `fields` を返します。公開計画には対象・expectedVersion・operation ID・confirmation token・確認用項目を含め、`redirect` が指定された場合は公開時の転送設定も計画へ結び付けます。ホストはactor・入力・tokenを保存して同じIDの再送を冪等に処理します。`cms.operation-status` は操作結果の照会用です。各CMS操作は対応するadapter関数があるホストだけdiscoverに出します。

## CUIでの編集

`niho-edit` はホストAPI originへ直接接続し、ブラウザーやStudio画面を開きません。ホストが発行する短期tokenを環境変数 `NIHO_EDIT_TOKEN` から読み、ページ文書、CMS項目、ページ管理、サイト設定をJSONで操作します。書込には期待版を渡し、公開・作成・保存には呼出側が先に決めたoperation IDを付けます。タイムアウト後は同じIDと同じ入力で再試行できます。PageDocumentの完全な検証は信頼済みcontextを持つホストが行います。ブレークポイントもCMS項目も読取結果のversionを維持して保存します。

```sh
niho-edit --origin https://site.example --site site-id discover
niho-edit --origin https://site.example --site site-id read home --locale ja > page.json
# page.json の document を編集し、version は保持する
niho-edit --origin https://site.example --site site-id save home --locale ja --json page.json > saved.json
niho-edit --origin https://site.example --site site-id release-plan home --locale ja --action publish --json saved.json > release-plan.json
# 公開先と差分を確認し、再試行にも使うoperation IDを先に決めて保存する
OPERATION_ID=$(node -p 'crypto.randomUUID()')
niho-edit --origin https://site.example --site site-id release home --locale ja --json release-plan.json --operation-id "$OPERATION_ID"

niho-edit --origin https://site.example --site site-id breakpoints-read > breakpoints.json
# breakpoints.json のsettingsを編集し、versionは保持する
niho-edit --origin https://site.example --site site-id breakpoints-save --json breakpoints.json

niho-edit --origin https://site.example --site site-id cms-schema > cms-schema.json
niho-edit --origin https://site.example --site site-id cms-list posts > posts.json
niho-edit --origin https://site.example --site site-id cms-read posts item-123 > item.json
cp item.json edited-item.json
# edited-item.json の values を編集し、id と version は維持する
niho-edit cms-diff --base item.json --json edited-item.json
# 保存の再試行には同じoperation IDを使う
OPERATION_ID=$(node -p 'crypto.randomUUID()')
niho-edit --origin https://site.example --site site-id cms-save posts item-123 --json edited-item.json --operation-id "$OPERATION_ID" > saved-item.json
# 公開は別操作としてoperation IDを新しく用意する
OPERATION_ID=$(node -p 'crypto.randomUUID()')
niho-edit --origin https://site.example --site site-id cms-publish-plan posts item-123 --expected-version '<version>' --operation-id "$OPERATION_ID" --redirect false > cms-publish-plan.json
# 公開計画を確認し、タイムアウト後は同じ計画ファイルで再送する
niho-edit --origin https://site.example --site site-id cms-publish --json cms-publish-plan.json
niho-edit --origin https://site.example --site site-id cms-status --operation-id "$OPERATION_ID"

niho-edit --origin https://site.example --site site-id pages-catalog > pages.json
# pages.json の version を保ち、change.json にページ変更を記述する
niho-edit --origin https://site.example --site site-id page-change-prepare --expected-version '<version>' --json change.json > plan.json
# plan.json の影響を確認してから適用する
niho-edit --origin https://site.example --site site-id page-change-apply --json plan.json
```

`release-plan` の `--expected-version` は最新の `read` / `save` 結果から指定します。ロールバックは `--action rollback --revision <公開版>` を指定します。applyがタイムアウトした場合は計画ファイルと同じoperation IDを使って再送します。IDを変えると別操作として扱われます。

このAPIはCUIからホストのサイトorigin上で直接利用できます。Studio GUIも同じwire契約をWorker BFF経由で利用します。ホストはAPIの認証・認可・監査・永続化・公開を実装し、配備と認証設定を別途完了する必要があります。

host adapterの最小実装は `npm run build` の後に `node examples/editing-api-demo.mjs` で実行できます。この例は認証・権限・BlockContractを持つメモリ内ホストでdiscover、ページ読取、見出し・背景色の変更、フォームの追加、版付き保存、古い版の409を確認します。

ページ文書のJSON Schemaはwire上のトップレベル形を説明します。細部の要素・style・属性は `@niho/web/core` の `parsePageDocument` が閉じた文書契約として検証し、登録ブロック・部品・サイト共通styleはホストが渡したcontextに従います。機械クライアントはdiscoverのschemaを入力UI・引数検査に使い、サーバーの文書validatorを正本として扱います。保存成功時はホストが保存後の正規文書とversionを返すため、CLIはそのまま次の編集へ使えます。

## ホストの責務

ホストadapterは次を実装します。

- `authenticate(request)` はセッション/API tokenを検証し、`human` または `machine` のactorと、必要なら委任元を返す。監査に人の連絡先が必要な操作では、hostが検証済みのemailだけを `actor.email` に渡す。
- `authorize(actor, capability, scope)` はリクエストごとにサイト/ページの権限を判断する。discover時も同じ判定を使う。
- `validationContext(actor, target)` は、対象文書の検証に必要なホスト登録block・部品library・サイトstyleを返す。これらの実装定義はクライアントへ公開しない。
- `readPage` は文書とopaque versionを返す。
- `savePage` はexpectedVersionを永続層で原子的に比較して保存する。並行更新は `conflict` を返し、成功時は正規化済みの保存後PageDocumentと新versionを返す。
- 公開操作を提供する場合は `releaseSite` から信頼済みの許可originを返し、`preparePageRelease` が現行版・依存版・公開先に束縛された計画を作る。handlerは計画の対象・action・版・domainを検証する。
- `publishPage` はexpectedVersionと一回限りconfirmation tokenを検証し、actor + operation ID + 同一入力の再送で最初の結果を返すように原子的に実装する。別入力で同じIDを再利用した場合は競合として拒否する。
- ブレークポイント操作を公開するhostは `readBreakpointSettings` と `saveBreakpointSettings` を実装し、site単位の認可・expectedVersion CAS・actor監査を行う。
- CMS操作を公開するhostは `readCmsSchema` / `listCmsItems` / `readCmsItem` / `createCmsItem` / `saveCmsItem` / `prepareCmsPublish` / `publishCmsItem` / `readCmsOperationStatus` を実装し、定義済みCollection値・scope権限・expectedVersion CASを検証する。create/save/publishはactor・operation ID・同一入力の結果を原子的に記録し、別入力の再利用を拒否する。
- actor、委任元、操作ID、対象、対象version、結果をホストの監査記録へ原子的に結び付ける。公開・配備はそれぞれ別権限の操作としてホストが実装する。

複数サイトのWorkerでは `createRegisteredPageEditingApi` の登録表を使い、各サイトの認証・権限・保存先を個別adapterへ閉じ込めます。単一サイトだけを配信するホストは `createPageEditingApi` を直接mountできます。どちらも同じ操作カタログ、wire schema、入力検証、安定エラーを使います。

Cookie認証を使うホストは、write requestのCSRF境界とCORSも自分のrouterで強制します。公開HTMLにcredential・内部ID・Git source pathを含めません。Handlerは認証方法、DB、CMS、素材、翻訳、Gitへ依存しないので、Studioを使わないホストも同じ契約を組み込めます。

## 安定エラー

| Error | HTTP | 意味 |
| --- | --- | --- |
| `authentication_required` | 401 | 認証主体を確定できない |
| `forbidden` | 403 | 操作権限がない |
| `duplicate_operation` | 409 | すでに別prepareで使われたoperation IDを再利用した |
| `host_failure` | 503 | ホストの認証/検証context/保存adapterが一時的に失敗した |
| `invalid_request` | 400 | path、query、JSON、PageDocumentが契約に合わない |
| `method_not_allowed` | 405 | 操作に定義されていないmethod |
| `not_found` | 404 | 対象または操作が存在しない |
| `validation_failed` | 422 | CMS値が定義済みフィールド検証に失敗した。`fields` に項目別の問題を含む |
| `version_conflict` | 409 | expectedVersionが現行版と一致しない |
| `host_contract_violation` | 502 | ホスト保存層の応答がこの契約に合わない |

## 実装状況

ページ本文・ページ管理・ブレークポイント・CMS項目の共通wireとCUI clientを実装しています。鎌倉サイトではStudio GUIのCMS schema、一覧、読取、作成、保存、公開をBFFから同じサイトAPIへ接続します。AIの `niho-edit` CLIもサイトoriginを直接呼ぶため、両方の操作がホストの同じ保存・検証・版管理・監査を使います。Studio GUIは短期の操作別tokenだけを委任し、Access cookie/JWTをサイトへ転送しません。旧Studio D1にだけブレークポイント値がある場合は、初回読取でその版をexpectedVersionとしてサイトAPIへ一度だけ移します。以後の読取・保存の正本はサイト側です。素材と翻訳は別のhost操作です。
