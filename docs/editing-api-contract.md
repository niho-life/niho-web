# サイト編集HTTP契約

`@niho/web/editing-api` は、GUIと機械クライアントが同じページ本文・CMS項目・ページ管理・サイト設定・素材・翻訳の正本を編集するためのReact非依存HTTP契約です。Studio UIやStudio Workerを必要条件にしません。各サイトのホストがhandlerを組み込み、認証・権限・永続化・監査記録・公開を所有します。Studio GUIとCUIは同じ操作カタログとwire形式を使い、各クライアントの操作履歴をホストのactorと版に結び付けます。

`@niho/web/editing-client` の `createPageEditingApiClient` は同じwire契約を呼ぶReact非依存clientです。ブラウザーのGUIは既定のsame-origin credentialsまたはhost提供headerを使え、Node CLIはhost bearer headerと `credentials: "omit"` を使えます。ホストorigin自体がCloudflare Accessで保護される場合、`niho-edit` は別途設定されたAccess Service Auth headerも指定originだけに送れます。GUIと `niho-edit` CLIはページ本文・CMS項目・ページ管理・ブレークポイント・素材の同じ操作を呼べます。Studio GUIはAccess sessionをWorker BFFで短期の操作別tokenへ委任し、サイトoriginの共通APIへservice bindingで接続します。ブラウザーのAccess tokenやcookieはサイトへ転送しません。

Kamakura の Studio GUI は editor snapshot profile から共通APIでページsnapshotを取得します。日本語キャンバスは `editorState` を、英語キャンバスは `presentation`（alias URL解決用の `presentation.links` を含む）を必須とし、欠けた場合はページを開きません。専用snapshot routeから不足分を補うfallbackは使いません。CMS項目・ページ管理・素材の書込は共通APIを使います。翻訳の共通APIは、対応するホストが登録した操作をCUIから直接呼び出せます。Studioの翻訳画面は既存の接続を使います。

## 操作カタログ

ホストは `createPageEditingApi(adapter)` の返すRequest handlerを、自分が選んだoriginとpathへ接続します。既定pathは `/api/edit/v1` です。操作ID・権限・method・path・input/result schema・安定エラーの正本は `EDITING_OPERATIONS` です。公開する操作IDの型もこのcatalogから導出し、discoveryとクライアント型が別々の一覧にならないようにします。`GET /sites/{siteId}/capabilities` は、その認証主体が使える操作ID・権限・HTTP method・path・JSON Schema・安定エラー一覧を返します。

サイト共通スタイル拡張は `GET /sites/{siteId}/capabilities?features=site.styles` でopt-inします。対応hostは実装済みadapterの操作だけを追加し、queryなしdiscoveryとfeature queryなしrequestでは従来のoperation一覧・schemaを維持します。対応clientは拡張schemaを使う `pages.*` requestにもfeature queryを付け、旧hostがqueryを拒否した場合はlegacy discoveryへfallbackしてstyle operationや拡張fieldを送信しません。

| ID | Method | Path | 権限 | 入力 | 結果 |
| --- | --- | --- | --- | --- | --- |
| `pages.inspect` | GET | `/sites/{siteId}/operations/pages.inspect/{pageId}?locale={locale}&view={view}[&features=site.styles]` | `pages.read` | outline/find/subtree/effectiveStyleの投影条件 | 部分読取結果と各版。style拡張時は `draftStylesVersion`、対応 host は `cmsBindings?` を含む |
| `pages.read` | GET | `/sites/{siteId}/operations/pages.read/{pageId}?locale={locale}[&features=site.styles]` | `pages.read` | site/page/locale、任意のeditor snapshot profile | `{ document, version, componentsVersion?, presentationVersion?, presentation?, editorState?, draftStylesVersion?, cmsBindings? }` |
| `pages.history` | GET | `/sites/{siteId}/operations/pages.history/{pageId}?locale={locale}&cursor={cursor}` | `pages.history.read` | site/page/locale and optional cursor | `{ entries, next? }` (operation summaries only) |
| `pages.history-read` | POST | `/sites/{siteId}/operations/pages.history-read/{pageId}?locale={locale}` | `pages.history.read` | `{ id }` in the JSON body | `{ document, siteStyles?, presentation? }` for one retained revision |
| `pages.save` | PUT | `/sites/{siteId}/operations/pages.save/{pageId}?locale={locale}[&features=site.styles]` | `pages.edit` | `{ expectedVersion, draftStylesVersion?, document }` | `{ status: "saved", version, document }` |
| `pages.apply` | POST | `/sites/{siteId}/operations/pages.apply/{pageId}?locale={locale}[&features=site.styles]` | `pages.edit` | `{ baseVersion, operationId, operations, componentsVersion?, presentationVersion?, stylesVersion?, draftStylesVersion?, cmsBindings?, dryRun? }` (`stylesVersion` はlegacy alias)。`pages.cms-bindings` 対応 host だけ sidecar を受理し、sidecar 単独変更では `operations: []` を許可 | `{ status: "applied", version, revision, document }` / dry-run `{ status: "valid", diff, touched }` |
| `pages.preview-intent` | POST | `/sites/{siteId}/operations/pages.preview-intent/{pageId}?locale={locale}` | `pages.read` | `{}` | `{ url, expiresAt }` |
| `pages.release-plan` | POST | `/sites/{siteId}/operations/pages.release-plan/{pageId}?locale={locale}[&features=site.styles]` | `pages.publish` | expected page version、公開 `stylesVersion`、`sitePublicationEpoch`、publish/rollback action | `{ plan }` |
| `pages.release` | POST | `/sites/{siteId}/operations/pages.release/{pageId}?locale={locale}[&features=site.styles]` | `pages.publish` | planの両版、one-use confirmation token、UUID v4 operation ID | `{ status: "released", operationId, version, document }` |
| `pages.release-set-plan` | POST | `/sites/{siteId}/operations/pages.release-set-plan[?features=site.styles]` | `pages.publish` per target | `{ siteId, operationId, sitePublicationEpoch, items: [{ target, expectedVersion, stylesVersion?, componentsVersion?, presentationVersion? }] }` (1–50 pages) | `{ plan }` |
| `pages.release-set` | POST | `/sites/{siteId}/operations/pages.release-set[?features=site.styles]` | `pages.publish` per target | the exact plan's site, operation ID, epoch, confirmation token and items | `{ status: "completed" | "publishing", operationId, items: [...] }` |
| `pages.release-set-status` | GET | `/sites/{siteId}/operations/pages.release-set-status/{operationId}` | `pages.read` | site / operation ID | `{ status, operationId, ... }` |
| `pages.catalog` | GET | `/sites/{siteId}/operations/pages.catalog` | `pages.read` | site ID | `{ version, pages }` |
| `pages.change-prepare` | POST | `/sites/{siteId}/operations/pages.change-prepare` | `pages.publish` | `{ expectedVersion, operationId, change }` | `{ plan }` |
| `pages.change-apply` | POST | `/sites/{siteId}/operations/pages.change-apply` | `pages.publish` | `{ expectedVersion, operationId, confirmationToken, change }` | `{ status: "applied", operationId, page }` |
| `site.breakpoints.read` | GET | `/sites/{siteId}/operations/site.breakpoints.read` | `site.settings.read` | site ID | `{ settings, version }` |
| `site.breakpoints.save` | PUT | `/sites/{siteId}/operations/site.breakpoints.save` | `site.settings.write` | `{ expectedVersion, settings }` | `{ status: "saved", version }` |
| `site.styles.read` | GET | `/sites/{siteId}/operations/site.styles.read` | `site.settings.read` | site ID | `{ sitePublicationEpoch, draft: { version, styles }, published: { stylesVersion, styles } }` |
| `site.styles.save` | PUT | `/sites/{siteId}/operations/site.styles.save` | `site.settings.write` | `{ expectedVersion, styles }` | `{ status: "saved", version }` |
| `site.styles.release-plan` | POST | `/sites/{siteId}/operations/site.styles.release-plan` | `site.settings.write` + site-wide `pages.publish` | `{ expectedVersion, expectedStylesVersion, sitePublicationEpoch, operationId }` | `{ plan }` |
| `site.styles.release` | POST | `/sites/{siteId}/operations/site.styles.release` | `site.settings.write` + site-wide `pages.publish` | planの両版、epoch、operation ID、confirmation token | `{ status: "released", operationId, stylesVersion, sitePublicationEpoch }` |
| `site.styles.migration-plan` | POST | `/sites/{siteId}/operations/site.styles.migration-plan` | `site.settings.write` + site-wide `pages.publish` | delete/rename change、両版、epoch、operation ID | `{ plan }` |
| `site.styles.migration-apply` | POST | `/sites/{siteId}/operations/site.styles.migration-apply` | `site.settings.write` + site-wide `pages.publish` | planの変更・両版・epoch・operation ID・confirmation token | `{ status: "applied", operationId, ... }` |
| `cms.schema` | GET | `/sites/{siteId}/operations/cms.schema` | `cms.read` | site ID | `{ collections }` |
| `cms.list` | GET | `/sites/{siteId}/operations/cms.list/{collectionId}` | `cms.read` | site / collection ID | `{ collectionId, items }` |
| `cms.read` | GET | `/sites/{siteId}/operations/cms.read/{collectionId}/{itemId}` | `cms.read` | collection / item ID | `{ item }` |
| `cms.create` | POST | `/sites/{siteId}/operations/cms.create/{collectionId}` | `cms.edit` | `{ operationId }` | `{ item }` |
| `cms.save` | PUT | `/sites/{siteId}/operations/cms.save/{collectionId}/{itemId}` | `cms.edit` | `{ expectedVersion, operationId, values }` | `{ status: "saved", item }` |
| `cms.publish-plan` | POST | `/sites/{siteId}/operations/cms.publish-plan/{collectionId}/{itemId}` | `cms.publish` | `{ expectedVersion, operationId, redirect? }` | `{ plan }` |
| `cms.publish` | POST | `/sites/{siteId}/operations/cms.publish/{collectionId}/{itemId}` | `cms.publish` | `{ expectedVersion, operationId, confirmationToken, redirect? }` | `{ status, operationId, item }` |
| `cms.operation-status` | GET | `/sites/{siteId}/operations/cms.operation-status/{operationId}` | `cms.read` | site / operation ID | `{ status, operationId, ... }` |
| `assets.list` | GET | `/sites/{siteId}/operations/assets.list` | `assets.read` | search, kind, folder, provider, cursor, recent | `{ assets, folders, ... }` |
| `assets.usages` | GET | `/sites/{siteId}/operations/assets.usages/{provider}/{assetId}` | `assets.read` | stable asset reference | `{ usages }` |
| `assets.resolve` | POST | `/sites/{siteId}/operations/assets.resolve` | `assets.read` | `{ references }` | `{ assets }` with host delivery URLs |
| `assets.update` | PUT | `/sites/{siteId}/operations/assets.update/{provider}/{assetId}` | `assets.edit` | `{ expectedVersion, changes }` | saved metadata, conflict, or rejection |
| `assets.upload-intent` | POST | `/sites/{siteId}/operations/assets.upload-intent` | `assets.upload` | name, MIME, bytes, provider | one-time upload URL/token and asset ID |
| `assets.delete` | POST | `/sites/{siteId}/operations/assets.delete/{provider}/{assetId}` | `assets.delete` | `{ expectedVersion }` | deleted, in-use, conflict, or rejection |
| `assets.restore` | POST | `/sites/{siteId}/operations/assets.restore/{provider}/{assetId}` | `assets.delete` | `{ expectedVersion }` | restored, conflict, or rejection |

`pages.preview-intent` は、ページ読取権限を持つactorに対してホストが発行する短期プレビューURLです。`PageEditingHostAdapter.createPagePreviewIntent(actor, target)` を実装したhostだけがdiscoveryに公開できます。ホストはURLにbearer token、Access資格情報、cookieなどを含めず、サーバー側の不透明な許可記録をactor・site/page/locale・発行時の文書版・styles/components/presentation/翻訳の依存版・期限・利用回数上限に結び付けます。プレビューHTMLのGET時に認証主体と全ての版・期限・利用回数を再検証し、一致しない場合は拒否します。CLIは認証header付きでHTMLを一度だけ取得し、幅ごとの撮影には同じメモリ内HTMLを使います。

プレビューHTMLのhost responseには `Cache-Control: no-store`、`Referrer-Policy: no-referrer`、`X-Robots-Tag: noindex` を付け、公開ページ用cache経路を通しません。共通APIが返すintent JSONにも `PAGE_PREVIEW_INTENT_HEADERS` を付けますが、プレビューHTML自体の安全な配信はhostの責務です。HTMLは公開時と同じrenderer・登録block・presentation・host viewで描画します。clientは期限を15分以内に制限し、HTTPSかつAPIと同じoriginのURLだけを受け入れます。

`pages.save` は `expectedVersion` を原子的に比較します。競合時はHTTP 409と `version_conflict` を返し、ホストは古い下書きを上書きしません。documentは受信側で `parsePageDocument` を通し、pathのsite/pageとqueryのlocaleに一致しない文書、任意HTML・JavaScript・CSSなど検証に失敗する値はHTTP 400 `invalid_request` で拒否します。登録ブロック・部品インスタンス・サイト共通スタイルを使うホストは、adapterの `validationContext(actor, target)` から信頼済みの `blocks`・`components`・`siteStyles` を渡します。読み取り、入力文書、保存後の正規文書の検証に同じcontextを使います。

site.styles対応hostの `pages.read` / `pages.inspect` はdraft版を `draftStylesVersion` として返し、`pages.save` / `pages.apply` は同じdraft版で検証します。ページCAS `version` は文書版とdraft styles versionの両方を束縛します。公開planの `stylesVersion` はpublished版だけを指し、`sitePublicationEpoch` と一緒にcommit時にも再照合します。queryなしlegacy `pages.apply.stylesVersion` はdraft版aliasとして受け付けます。

`pages.inspect` はページ文書を変更せず、`pages.read` と同じ認可でAI向けの小さな投影を返します。`view=outline` は要素のID・型・名前・tag/block・40文字までの本文抜粋・レイアウト要約・token参照・responsive/state override数と、先頭のtoken/text style/breakpoint定義を返します。`depth` と `node` で範囲を絞れます。`view=find` は `text`・`name`・`tag`・`style=property=value`・`usesToken`・`block`・`node` のいずれかで検索し、ID・祖先名・抜粋を返します。`view=subtree` は指定nodeのJSONを返し、結果が大きい場合は `{ path, node }` 項目へ分けて返します。`view=effectiveStyle` は指定nodeのbase・各breakpoint・hover/focus/activeの値と、その値がページ・site shared・component・継承のどこから来たかを返します。

outline/find/subtreeは `limit`（既定1000、最大1000件）と `cursor` で継続できます。1応答は最大240 KiBです。cursorは同じ文書版・同じ検索条件にだけ使えます。ホストは文書版に加えて、取得できる場合は `componentsVersion`、`presentationVersion`、`stylesVersion` も返します。安定エラーは `invalid_request`、`invalid_cursor`、`node_not_found`、`result_too_large` です。ホストが `pages.inspect` に対応しない場合、CLIは `pages.read` の結果から同じ投影をローカル生成します。

`pages.apply` は GUI と機械クライアントが同じ `EditorOperationById` 操作列を送る版付き書込です。操作列は1〜500件で、UUID v4 の `operationId` を付けます。discoverは全操作の入力 JSON Schema を返しますが、受信側は schema と独立した閉じた wire parser で各操作を検査します。初版では `restore`、token / textStyle の削除、`replaceChildren`、`replaceAsset` を拒否します。これらの全置換・移行操作には `pages.save` を使います。

`baseVersion` が古い場合も、依存版が指定されていれば先に照合します。自動 rebase するのは `style` / `text` / `attribute` / `prop` の葉の更新だけです。各操作に `{ parentId, oldValue }` の `preconditions` が必要で、現在の対象ノードが一意に存在し、親IDと対象フィールドの旧値が一致するときだけ現在文書へ再適用します。text操作は安定IDを持たない `childPath` で対象を指すため、GUIは親直下の子の順序を表す `textPathContext` も送ります。このcontextは最大8件の子を記録し、対象以外のtext nodeは128文字まで記録します。contextが省略された場合や現在の子の順序と一致しない場合、対象が親直下の子でない場合は HTTP 409 `version_conflict` です。前提条件のない要求、構造・ページ全体・token・textStyle操作、フォームのlabel/controlの関連に影響する属性変更も HTTP 409 `version_conflict` です。同じ要素・同じフィールドが先に変更されていた場合も適用しません。前提不一致を検出した409は `{ error: "version_conflict", unmetPreconditions: [{ index, condition }] }` を返し、`condition` は `rebase_supported` / `preconditions` / `node_exists` / `parent_id` / `old_value` / `child_path` のいずれかです。指定依存版の競合は従来どおり `{ error: "version_conflict" }` です。
`niho-edit apply <page> --locale <locale> --ops <file|-> [--dry-run]` はJSONの `EditorOperationById[]` を受け取ります。ホストが `pages.apply` を公開していれば、CLIは `pages.read` で版を取り、操作列を同じ操作として送信します。`--dry-run` はホスト側で検証し、差分と対象IDを返します。再試行に使う `--operation-id` は `--expected-version` と併せて指定します。両方を固定すると、同じ版・操作列による再送が前回の結果を返します。API非対応ホストでは `pages.read` → ローカル `editDocumentById` → `pages.save` にフォールバックします。この経路ではhost-neutralな操作適用だけを行い、ホストの信頼済みblock・component・style contextを使う全文検証は保存時まで延期します。dry-run出力にその制限を明記します。差分は要素ID・種類・変更箇所・変更前後の値を含む `diffDocuments` の一覧です。

`{ "type": "name", "nodeId": "hero", "value": "ヒーロー" }` で要素の名前を設定・変更し、`value` を省略すると解除します。ホストは保存・読取・公開側で `name` を扱えるようにした後、`PageEditingHostAdapter.pageNodeNames: true` を指定します。通常の `pages.edit` 認可を満たす `pages.apply` / `pages.save` の discover 定義に `capabilities: ["pages.name"]` が付き、`pages.apply` の入力 schema は `name` 操作と名前付きの追加ノードを含みます。未対応ホストの定義もクライアントは読み取れます。GUI と CLI は、書込先の操作がこの機能を公開した場合だけ `name` 操作や名前を含むノードを送ります。`schemaVersion` は 1 のままです。CLI の `apply` で未対応の名前を含む入力を受けた場合は、書き込む前に `name_not_supported` を返します。

`add` / `addMany` / `move` は、`{ before: nodeId }` / `{ after: nodeId }` または `{ edge: "start" | "end" }` の `anchor` で位置を指定できます。アンカーは移動先の同じ親にある要素IDを指します。既存の数値 `index` も受け付けますが、indexとanchorは同時に指定できず、`move` はどちらか一方が必須です。位置を省略した追加は末尾へ挿入します。

`wrap` / `unwrap` は囲みボックスの追加・解除を1操作で適用します。[CLIでの入力例](#ボックスで囲む囲みを解除)を参照してください。

ホストの `pageOperations.transact` は、常に最新の文書/versionと、その読み取りと同じ版に属する信頼済み `blocks`・`locks`・`components`・`siteStyles` を `prepare(snapshot, validationContext)` に渡します。古い `baseVersion` を理由にprepare前に拒否せず、上記の葉操作だけを条件付きで再適用できるか判定します。`pages.apply` は別途 `validationContext(actor, target)` を読みません。`editDocumentById` を順に適用し、最後に全文を `parsePageDocument` で検証します。途中の一操作でも失敗した場合は HTTP 422 `validation_failed` と、失敗 index・理由を返し、何も保存しません。prepareが使ったページ版と依存版をCASで再照合し、文書・操作記録を同時に確定してください。CASに負けた場合は最新snapshotから操作IDの再送判定とprepareをやり直します。依存版の指定は任意ですが、指定値がprepare時点の現在値と異なる場合はHTTP 409です。成功時は保存後の正規文書と新しい版・revision を返します。

ホストの `pageOperations.transact(actor, target, transaction)` は、ページ状態と同じCAS/transactionで操作記録を確定します。操作本文は不変の journal blob として保存し、現在状態にはその参照だけを持ちます。`actor + operationId` は正規化入力のhashと保存結果に結び付き、同じ要求の再送は前回と同じ結果、同じIDで違う要求を送った場合は HTTP 409 `duplicate_operation` になります。文書 pointer、journal pointer、ID/hash/結果は同時に確定してください。安全にrebaseした記録には、元要求の `baseVersion` に加えて実際に適用した版 `rebasedFromVersion` を記録します。actor・委任元・GUI/CLI/APIの種別は認証済み文脈から取得し、要求本文から受け取りません。`dryRun: true` は全操作を検証して `{ status: "valid", diff, touched }` を返しますが、保存もoperation IDの消費も行いません。

編集用の完全なスナップショットを読むクライアントは `Accept: application/json; profile=niho-editor-snapshot-v1` を指定します。共通クライアントでは `editorSnapshot: { blocks }` で有効にします。完全対応ホストの `readPage` は、同じ読取結果から `document` と `version`、`editorState`、表示コンテキストがある場合は `presentation` と `presentationVersion` を組にして返します。Kamakura Studioは日本語canvasでは `editorState`、English canvasでは `presentation` を必須とし、未対応応答を専用routeから補完しません。通常の `Accept: application/json` では従来の本文と版の応答を返します。

`presentation` は core の `SitePresentation` です。APIとクライアントは `parseSitePresentation` で対象・登録ブロック・共通レイアウトや共有文書を検証します。完全なスナップショットでは、`presentationVersion` は `presentation.version` と一致する場合に限り受け付け、どちらもない場合は表示コンテキストを省略できます。`editorState` は `readOnly`、`englishPublication`、公開版一覧の `releases` を必要に応じて保持します。対応ホストは、該当する状態が一つもない場合も空の `editorState` を返します。壊れた完全スナップショットは拒否します。旧ホストの応答には `editorState` がありません。Kamakura Studioは旧snapshotとの複数読取を組み合わせず、ホストが完全なprofileを返すまでページを開きません。

`pages.release-set-*` は同じサイト内のページを、一つの計画・適用操作で公開します。対象は1〜50件で、重複ページは禁止します。単一ページの非同期公開も同じoperation ID・status契約を使えます。各項目の `expectedVersion` と任意の `componentsVersion` / `presentationVersion`、対象一覧、operation IDを計画へ固定します。APIは全対象の `pages.publish` 権限を個別に確認します。ホストadapterは対象ごとに版を再検証し、結果として `released`（公開済み）、`conflict`（版が変わった）、`pending`（処理中）を返します。全体の `status` は未完了項目があれば `publishing`、全項目が確定したら `completed` です。ある対象の競合で他ページの成功を隠さず、全ページ同時切替も要求しません。トップレベルの `version_conflict` は操作が始まっておらず、公開済みページがない場合に限ります。

site.styles対応hostではrelease-set計画に公開 `stylesVersion` とsite全体の `sitePublicationEpoch` を固定し、各commit直前に再検証します。同じrelease-setの非同期残項目はfence lease内で最新epochを引き継ぎます。他の公開操作はlease解放まで409 `site_publication_in_progress` となり、lease失効時は未処理項目をconflictに確定して古いworkerのcommitを拒否します。

確認tokenは対象と全版を含む計画に結び付けます。同じactor・operation ID・入力の再送では、完了済み対象を二重に公開せず、前回の項目別状態を返します。タイムアウト時は同じ計画を再適用して処理を再開でき、`pages.release-set-status` で最終結果を照会できます。競合したページは再読込して新しい計画を作ります。ホストはactor、対象版、各項目の結果を監査記録へ保存します。自動mergeは行いません。

`site.breakpoints.*` は、hostの設定正本へ保存するsite単位の操作です。各操作は対応するadapter関数が登録されているhostだけがdiscoverに出します。settingsは `parseBreakpointSettings` の閉じた契約で検証し、saveはhostの永続層でexpectedVersionを原子的に比較します。stale versionは409 `version_conflict` です。

`site.styles.read/save` は共通スタイルのdraftとimmutableな公開snapshotを扱い、readは同じsnapshotの `sitePublicationEpoch` も返します。saveはdraft `version` をCASし、追加と値更新だけを受け付けます。定義を省く削除やrenameは422 `style_migration_required` です。hostは保存前に全draft page/template/shared document/component/slot styleを同じ新しいstylesで再検証します。release-plan/releaseはdraft `version` と現行 `stylesVersion`、sitePublicationEpoch、影響する全公開ページ・localeと依存版をplanに固定し、`site.settings.write` とsite-wide `pages.publish` の両方を要求します。release時はpublication fenceの下で全公開page/locale snapshotとstyle pointerを一括して切り替えます。

`site.styles.migration-plan/apply` はdelete/rename専用です。全参照とbefore/afterをplanへ固定し、page・component・locale・styleの書込をmigration fence中409 `site_style_migration_in_progress` で拒否します。fence leaseと全依存版をcommit時に再検証し、draft/public pointer・locale snapshot・operation結果を一つのCAS境界で確定します。

`pages.catalog` は管理可能なページと一覧のopaque versionを返します。`pages.change-prepare` は作成・名前/URL変更・公開状態変更を実行せずに影響と短期確認tokenを返し、`pages.change-apply` は同じ `expectedVersion`・UUID v4 `operationId`・change・tokenを照合して適用します。stale versionは409 `version_conflict`、別prepareでのoperation ID再利用は409 `duplicate_operation` です。同じactorが同じapplyを再送した場合は、ホストが記録した同じ結果を返します。

Studio の鎌倉エディタは初期表示に editor catalog の一覧を使い、管理操作を確認する時点で `pages.catalog` の版を取得します。既存ページを変更する場合は表示中の対象と現在の管理用一覧を照合し、他の変更で表示が古くなっていれば再読み込みを促します。計画から適用までの変更は同じ `expectedVersion` で検出します。

`cms.schema` はホストの `CollectionDefinition` を返します。`cms.list` / `cms.read` は一覧と項目の読み取り、`cms.create` / `cms.save` は下書きの作成と版付き保存、`cms.publish-plan` / `cms.publish` は確認token付き二段階公開を行います。`cms.create` は対象collectionの `capabilities.create` が有効な場合だけ受け付けます。保存値は定義済みフィールドで検証され、stale versionは409 `version_conflict` と現行項目を返します。保存・公開計画・公開適用のフィールド検証エラーは422 `validation_failed` と `fields` を返します。公開計画には対象・expectedVersion・operation ID・confirmation token・確認用項目を含め、`redirect` が指定された場合は公開時の転送設定も計画へ結び付けます。ホストはactor・入力・tokenを保存して同じIDの再送を冪等に処理します。`cms.operation-status` は操作結果の照会用です。各CMS操作は対応するadapter関数があるホストだけdiscoverに出します。

`assets.*` は素材の安定IDを操作します。配信URLは `assets.resolve` の応答に限って返し、ページ文書へは保存しません。一覧・使用先・解決は `assets.read`、メタデータ更新は `assets.edit`、一時アップロード許可の発行は `assets.upload`、削除と復元は `assets.delete` を個別に要求します。更新・削除・復元は `expectedVersion` をホストが比較します。`assets.upload-intent` は画像本体を受け取らず、短命の一回限りtokenを返します。クライアントは本体を `PUT` する前に、URLのHTTPS originがAPI originか、明示的に信頼設定したupload originと一致することを確認し、tokenをそのorigin以外へ送ってはいけません。ホストは実データの形式・サイズ・内容を再検査し、操作主体と結果を監査記録へ結び付けます。

pages.read と pages.catalog は version から生成する opaque な ETag を返します。pages.read の tag は文書・components・presentation の各 versionと編集状態の応答形式を含み、pages.catalog は catalog version を使います。再読込は If-None-Match を送り、同じ版ならホストが認証・権限を毎回確認した後に本文なしの304を返します。200と304には Cache-Control: private, no-cache と Vary: Authorization, Cookie（pages.read は Accept も）を設定します。ホストは応答内容が変わるとき version も更新してください。共通clientはETagを受け取った読み取りを保持し、返却値とキャッシュを分離して、304では前回検証済みの値を返します。

## ページと CMS の結び付け

`CmsPageBindingsDocument` は `PageDocument` とは別の sidecar です。`pages.cms-bindings` capability は `pages.read` / `pages.inspect` の応答で sidecar を返し、`pages.apply` の `cmsBindings` 更新を明示する host が公開します。sidecar は下書きの page version と同じ CAS transaction で保存してください。省略は既存 sidecar を保持し、JSON `null` は解除を意味します。sidecar を送るときは `baseVersion` が一致する必要があり、文書操作の stale rebase と同時に適用しません。

Studio の preview は別の editor adapter 操作で、認証済み actor、site/page、文書 version、CMS schema revision、選択した item revision の digest に結び付く短命一回限り token を使います。token は URL・client recovery・履歴・公開文書へ保存しません。外部 host は同じ権限と版検証、保存 CAS、公開 snapshot を実装してください。ページと CMS snapshot は個別に確認・公開し、両方を横断する原子切替は提供しません。CMS を結び付けたページの公開計画は route table revision も固定し、適用直前に同じ revision か照合してください。schema migration は bindings の field 参照を検査してから適用します。

CLI は `niho-edit apply <page> --locale <locale> --cms-bindings bindings.json` で sidecar を追加・置換できます。`--cms-bindings -` は標準入力から JSON を読み、JSON `null` は sidecar を解除します。対応 discovery がなければ CLI は送信前に `cms_bindings_not_supported` で停止します。sidecar の形と許可する field / node target は [CMS v2 契約](cms-v2-contract.md#pagedocument-と-cms-の結び付け) を参照してください。

## 翻訳操作

`PageEditingHostAdapter.localization` に操作IDをキーにして必要な関数を登録します。各関数は `(actor, siteId, input)` を受け取り、翻訳作業画面と共通の [workspace契約](localization-workspace-contract.md) の結果を返します。公開される入力と結果は `EDITING_OPERATIONS` にあり、クライアントは `executeLocalization(operationId, input, signal?)` で同じ契約を呼びます。ホストは共通の認証・認可を使い、翻訳のoverlay・unit・releaseを既存の保存先で扱います。

パスはすべて `/sites/{siteId}/operations/{operationId}` です。GETの追加フィールドはqueryに渡します。初回の `cursor` は省略できます。書込は `Content-Type: application/json` で、一致する `siteId` をJSONのトップレベルに加えます。clientは設定されたsite IDを補い、ホストの関数には検証済みのsite IDを第2引数で渡します。未知のキー、形式不正なID、同名queryの繰り返し、4 MiB超の書込はHTTP 400になります。プレビュー材料は1ページ2 MiBまでです。

| 操作 | Method | 権限 | 追加の入力 | 結果 |
| --- | --- | --- | --- | --- |
| `localization.overview` | GET | `localization.read` | — | `{ status: "ready", overview }` |
| `localization.items.list` | GET | `localization.read` | `cursor?` | `{ status: "ready", items, nextCursor }` |
| `localization.items.read` | GET | `localization.read` | `itemKey` | `{ status: "ready", item }` |
| `localization.items.command` | POST | `localization.edit` または `localization.review` | `LocalizationCommandInput` | `{ status: "applied", unit, summary }` |
| `localization.items.translate` | POST | `localization.translate` | `{ itemKey, expectedVersion, operationId, unitIds }`。全項目は `unitIds: null` | `{ status: "queued", job }` |
| `localization.jobs.read` | GET | `localization.read` | `jobId` | `{ status: "ready", job }` |
| `localization.catalog.advance` | POST | `localization.edit` | `{ expectedVersion, operationId }` | `{ status: "updating", progress }` または `{ status: "current" }` |
| `localization.preview` | GET | `localization.read` | `itemKey, previewId, cursor?` | `{ status: "ready", material, nextCursor }` |
| `localization.release.read` | GET | `localization.read` | — | `{ status: "ready", current, history, pending }` |
| `localization.release.prepare` | POST | `localization.publish` または `localization.rollback` | `LocaleReleasePrepareInput`。初回は `operationId` も必要 | `{ status: "ready", plan }`、`{ status: "preparing", progress, resumeToken }`、`{ status: "blocked", blockers }`、または `{ status: "expired" }` |
| `localization.release.apply` | POST | `localization.publish` または `localization.rollback` | `LocaleReleaseApplyInput` に `operation`、`expectedVersion`、任意の `prepared: { releaseId, version }` | `{ status: "applied", current }`、`{ status: "applying", progress, resumeToken, waiting? }`、または `{ status: "expired" }` |
| `localization.settings.save` | PUT | `localization.manage` | `LocalizationSettingsInput` と `operationId` | `{ status: "saved", settings }` |

ホストはトークンのscope検証に `EDITING_CAPABILITIES` を使えます。discoverは、対応するhost関数があり、サイト単位でいずれかの必要権限がある操作を返します。複数の権限を持つ操作は `capabilityByInput` に入力フィールドと値ごとの必要権限を示します。`review-current` と `review-image` は `localization.review`、訳文・候補・画像を変更するcommandは `localization.edit` です。公開と戻しは `operation` に応じて `localization.publish` と `localization.rollback` を個別に要求します。実行時のscopeには、対象に応じて `localizationItemKey`、`localizationUnitId`、`localizationJobId`、`localizationPreviewId` を加えます。

すべての書込で、ホストは監査用のactorとサイトを記録し、版を原子的に照合します。commandは編集開始時のunitの `version` と `sourceVersion`、設定保存は `settings.version`、翻訳開始・原文取り込み・公開準備は `overview.version` を使用します。公開準備は `expectedCurrentVersion` も照合し、公開反映は準備時の `expectedVersion` と同じ値を渡します。ホストは公開に必要な翻訳の確認状態、対象と公開版を検査します。

初回書込の `operationId` は16〜64文字の英数字・アンダースコア・ハイフンです。ホストはactor・サイト・操作ID・入力と結果を結び付け、同一入力の再送には先の結果を返します。別入力で同じIDを使った場合は `{ status: "duplicate" }` を返し、APIは409 `duplicate_operation` に変換します。版競合は409 `version_conflict` です。commandの競合には `current: { unit, summary }`、設定の競合には `current` に現行設定が入ります。clientはそれぞれ `{ status: "conflict", unit, summary }` と `{ status: "conflict", settings }` を返すため、呼出側は入力した値を保持したまま照合できます。

公開準備の初回は `resumeToken: null` を指定し、続きは返された `resumeToken` と元の版を渡します。公開計画を確認したら、反映に `confirmationToken` と `resumeToken: null` を渡します。反映が `applying` の場合は `confirmationToken: null` に切り替え、返された `resumeToken` と同じ操作・版を渡します。進捗には `waiting: "uploading"` または `waiting: "deployment"` が付くことがあります。`release.read` は現在版と途中状態の照会に使えます。

確認・再開tokenはactor・サイト・操作種別・版・計画に束縛します。`prepared` を指定した反映では、ホストはtokenの対象と一致することを反映前に確かめ、APIも応答の公開版を照合します。ホストは期限と一回限りの消費を検証し、同じ入力の再送が同じ処理を二重に実行しないようにします。公開の準備・反映で期限切れや不正なtokenを拒否した場合は `{ status: "expired" }` を終端結果として返し、呼出側はtokenを再送せず新しい準備を始めます。取得結果の `pending` は再開権限を持つactorにだけ返し、tokenをURLやログに含めません。

## CUIでの編集

`niho-edit` はホストAPI originへ直接接続し、ブラウザーやStudio画面を開きません。ホストが発行する短期tokenを環境変数 `NIHO_EDIT_TOKEN` から読み、ページ文書、CMS項目、ページ管理、サイト設定、素材、翻訳をJSONで操作します。ホストoriginがCloudflare Accessで保護される場合は、環境のSecret Managerなどから `CF_ACCESS_CLIENT_ID` と `CF_ACCESS_CLIENT_SECRET` も渡します。この2つは対になるAccess Service Auth資格情報で、どちらか片方だけの設定はエラーです。Access資格情報は指定したAPI originへの通信だけに使い、`NIHO_EDIT_TOKEN` のhost認証を置き換えません。APIはAccessとhost bearerの両方を検証します。Access redirectは追跡せず、応答に含まれるログインURLも表示しません。素材本体をAPI originと異なるupload originへ送る場合、Access資格情報は転送せず、素材APIが発行した一回限りtokenだけを使います。書込には期待版を渡し、公開・作成・保存には呼出側が先に決めたoperation IDを付けます。タイムアウト後は同じIDと同じ入力で再試行できます。PageDocumentの完全な検証は信頼済みcontextを持つホストが行います。ブレークポイント、CMS項目、素材メタデータは読取結果のversionを維持して保存します。

Accessがログイン画面へredirectした場合、CLIは追跡せず `access_redirect` とHTTP statusをJSON envelopeで返して終了コード1で終了します。redirect先や応答本文は出力しません。資格情報が片方だけ、または形式不正なら、通信前に `invalid_access_credentials` を返します。

`niho-edit preview <page> --locale <locale> --widths 375,768,1280` は `pages.preview-intent` 対応hostに下書きHTMLを要求します。任意依存のPlaywrightとローカルChromiumが使える場合は各幅のPNGを `--out` の下の `niho-preview-*` ディレクトリへ保存し、`--compare published` では下書き・公開版の個別PNGと横並び比較PNGを同じ幅ごとに保存します。どちらも利用できなければ、スクリーンショット取得を行わず、下書きURLと期限（比較指定時は公開URL）をJSONで返します。HTMLはhost bearerと必要なら同じorigin向けAccess headerで一度取得し、ブラウザーへ認証headerを渡さずに各幅を撮影します。HTML応答の `no-store` / `no-referrer` / `noindex` が不足する場合は撮影を拒否します。

`--compare published` の公開HTMLはAPI originに対するAccess Service Auth headerだけをNode fetchへ付け、host bearerは送らず、redirectは拒否してからブラウザーへ渡します。Access保護された同一origin上の画像・CSS等もAccess headerだけで読み、Access資格情報を他originへ渡しません。ブラウザーからのPOST等の変更要求は遮断します。

```sh
niho-edit --origin https://site.example --site site-id discover
niho-edit --origin https://site.example --site site-id read home --locale ja > page.json
niho-edit --origin https://site.example --site site-id outline home --locale ja --depth 1
niho-edit --origin https://site.example --site site-id find home --locale ja --text "鎌倉"
niho-edit --origin https://site.example --site site-id preview home --locale ja --widths 375,768,1280 --compare published --out ./previews
niho-edit --origin https://site.example --site site-id get home heading --locale ja --effective-style
# page.json の document を編集し、version は保持する
niho-edit --origin https://site.example --site site-id save home --locale ja --json page.json > saved.json
niho-edit --origin https://site.example --site site-id release-plan home --locale ja --action publish --json saved.json > release-plan.json
# 公開先と差分を確認し、再試行にも使うoperation IDを先に決めて保存する
OPERATION_ID=$(node -p 'crypto.randomUUID()')
niho-edit --origin https://site.example --site site-id release home --locale ja --json release-plan.json --operation-id "$OPERATION_ID"

# 複数ページを一括公開する入力。対象と各版を確認してから計画を作ります。
# release-set-items.json: {"items":[{"target":{"siteId":"site-id","pageId":"home","locale":"ja"},"expectedVersion":"..."},{"target":{"siteId":"site-id","pageId":"about","locale":"ja"},"expectedVersion":"..."}]}
OPERATION_ID=$(node -p 'crypto.randomUUID()')
niho-edit --origin https://site.example --site site-id page-release-set-plan --json release-set-items.json --operation-id "$OPERATION_ID" > release-set-plan.json
# 公開差分がある対象だけを計画し、版を確認して適用します。
# 結果は対象ごとに released / conflict / pending を返します。
# 同じ計画ファイルで再試行すると未完了項目を再開し、完了済み項目は二重公開しません。
niho-edit --origin https://site.example --site site-id page-release-set-apply --json release-set-plan.json
niho-edit --origin https://site.example --site site-id page-release-set-status --operation-id "$OPERATION_ID"

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

niho-edit --origin https://site.example --site site-id assets-list --kind image --recent > assets.json
niho-edit --origin https://site.example --site site-id assets-usages uploads image-123
niho-edit --origin https://site.example --site site-id assets-resolve --json references.json
niho-edit --origin https://site.example --site site-id assets-update uploads image-123 --json asset-update.json
# API originと別のアップロード先を使うhostでは、そのHTTPS originを明示してから短命tokenを送る
niho-edit --origin https://site.example --site site-id assets-upload ./sea.png --mime-type image/png --provider uploads --upload-origin https://uploads.example
niho-edit --origin https://site.example --site site-id assets-delete uploads image-123 --expected-version '<version>'
niho-edit --origin https://site.example --site site-id assets-restore uploads image-123 --expected-version '<version>'
```

`--upload-origin` を固定して繰り返し使う場合は同じHTTPS originを `NIHO_EDIT_UPLOAD_ORIGIN` に設定できます。API originは常に許可されます。別originへ一回限りtokenを送るときは、コマンドまたは環境設定で送信先を明示します。

`release-plan` の `--expected-version` は最新の `read` / `save` 結果から指定します。ロールバックは `--action rollback --revision <公開版>` を指定します。applyがタイムアウトした場合は計画ファイルと同じoperation IDを使って再送します。IDを変えると別操作として扱われます。

このAPIはCUIからホストのサイトorigin上で直接利用できます。Studio GUIも同じwire契約をWorker BFF経由で利用します。ホストはAPIの認証・認可・監査・永続化・公開を実装し、配備と認証設定を別途完了する必要があります。

host adapterの最小実装は `npm run build` の後に `node examples/editing-api-demo.mjs` で実行できます。この例は認証・権限・BlockContractを持つメモリ内ホストでdiscover、ページ読取、outline部分読取、見出し・背景色の変更、フォームの追加、版付き保存、古い版の409、別要素への安全なrebaseを確認します。

ページ文書のJSON Schemaはwire上のトップレベル形を説明します。細部の要素・style・属性は `@niho/web/core` の `parsePageDocument` が閉じた文書契約として検証し、登録ブロック・部品・サイト共通styleはホストが渡したcontextに従います。機械クライアントはdiscoverのschemaを入力UI・引数検査に使い、サーバーの文書validatorを正本として扱います。保存成功時はホストが保存後の正規文書とversionを返すため、CLIはそのまま次の編集へ使えます。

翻訳コマンド名は操作IDのピリオドをハイフンに置き換えます。例では `aG9tZQ` が項目ID、`job-1` が翻訳開始で返されたジョブIDです。

```sh
niho-edit --origin https://site.example --site site-id localization-overview
niho-edit --origin https://site.example --site site-id localization-items-list
niho-edit --origin https://site.example --site site-id localization-items-read aG9tZQ
niho-edit --origin https://site.example --site site-id localization-items-command aG9tZQ --json command.json
niho-edit --origin https://site.example --site site-id localization-items-translate aG9tZQ --json translate.json
niho-edit --origin https://site.example --site site-id localization-jobs-read job-1
niho-edit --origin https://site.example --site site-id localization-release-read
```

書込の `--json` には操作表の追加フィールドを渡します。`siteId` は `--site` から、commandとtranslateの `itemKey` は位置引数から補います。たとえば `command.json` は `{"action":"set-value","unitId":"title","value":"Workshop by the sea","expectedVersion":"v1","expectedSourceVersion":"s1","operationId":"command-operation-1"}` です。確認・再開tokenを含む `localization-release-prepare` および `localization-release-apply` の入力は `--json -` で標準入力から渡せます。呼出側が応答を確認して続く操作を決めます。CLIの409は終了コード1で、現行値がある場合はJSON出力の `result.current` に保持します。

### ボックスで囲む・囲みを解除

`niho-edit apply` に渡す操作列で `wrap` を指定します。`nodeIds` は同じ親にある隣り合う要素のIDを文書順に1〜500件指定し、`wrapperId` は `group_` で始まる未使用の要素IDを指定します。

```json
[{"type":"wrap","nodeIds":["heading","intro","details"],"wrapperId":"group_intro"}]
```

`unwrap` は `{"type":"unwrap","nodeId":"group_intro"}` と指定し、囲みの子を元の位置へ展開します。属性やスタイル、表示状態、埋め込みなどを持つボックスは解除できません。

Flex / Grid などで見た目が変わりうる場合は、操作に `"allowLayoutChange":true` を指定したうえで `--dry-run` を実行し、ボックスの追加・削除と対象要素の親や位置の差分を確認してください。確認後、同じ版を `--expected-version` に指定し、`--dry-run` を外して適用します。この指定があっても、HTMLの入れ子やロックに抵触する操作は拒否されます。

## ホストの責務

ホストadapterは次を実装します。

- `authenticate(request)` はセッション/API tokenを検証し、`human` または `machine` のactorと、必要なら委任元を返す。`pages.apply` 対応hostは `gui` / `cli` / `api` の `clientKind` も認証文脈から返す。監査に人の連絡先が必要な操作では、hostが検証済みのemailだけを `actor.email` に渡す。
- `authorize(actor, capability, scope)` はリクエストごとにサイト/ページの権限を判断する。discover時も同じ判定を使う。
- `createPagePreviewIntent(actor, target)` を提供するhostは、認証済みactor・site/page/locale・現行の文書版とstyles/components/presentation/翻訳の依存版・期限・利用回数に結び付く不透明な許可記録をサーバー側で発行する。HTMLを返すpreview routeでも同じactorと全版を再検証し、要件外のrequestを拒否する。
- `validationContext(actor, target)` は、`pages.read` / `pages.save` で対象文書の検証に必要なホスト登録block・部品library・サイトstyleを返す。`pages.apply` は後述のtransactionが、同じ版に対応するblock・lock・部品library・サイトstyleを `prepare` に渡す。これらの実装定義はクライアントへ公開しない。
- `readPage` は文書とopaque versionを返す。
- 版履歴を公開するホストは `listPageHistory(actor, target, cursor?)` と `readPageHistoryRevision(actor, target, id)` を実装します。両操作は独立した `pages.history.read` 権限で再認可し、`pages.read` から推測・継承しません。履歴一覧は表示名・actor種別・確認済み委任元の表示名・操作種別と対象IDだけを返します。変更前後の値、メール、ユーザーID、subjectは要約へ含めません。revision IDはopaqueとして `pages.history-read` のPOST bodyで受け取り、URL・query・ログへ出しません。snapshotは通常の文書検証とsite/page/locale照合を通し、対象違い・不正な履歴はhost contract violationにします。
- `savePage` はexpectedVersionを永続層で原子的に比較して保存する。並行更新は `conflict` を返し、成功時は正規化済みの保存後PageDocumentと新versionを返す。
- `pageOperations.transact` を提供するホストは、actorとoperation IDの既存記録を版照合より先に確認し、同じ版から取得した文書・依存版・信頼済みcontextに対する全操作を検証してから、文書・revision・journal blob参照・operation ID/hash/結果を一つのCAS/transactionで確定する。同一要求の再送は同じ結果を返し、同一IDの異なる入力は `duplicate_operation` として拒否する。dry-runでは保存記録を作らない。
- 公開操作を提供する場合は `releaseSite` から信頼済みの許可originを返し、`preparePageRelease` が現行版・依存版・公開先に束縛された計画を作る。handlerは計画の対象・action・版・domainを検証する。
- `publishPage` はexpectedVersionと一回限りconfirmation tokenを検証し、actor + operation ID + 同一入力の再送で最初の結果を返すように原子的に実装する。別入力で同じIDを再利用した場合は競合として拒否する。
- ブレークポイント操作を公開するhostは `readBreakpointSettings` と `saveBreakpointSettings` を実装し、site単位の認可・expectedVersion CAS・actor監査を行う。
- CMS操作を公開するhostは `readCmsSchema` / `listCmsItems` / `readCmsItem` / `createCmsItem` / `saveCmsItem` / `prepareCmsPublish` / `publishCmsItem` / `readCmsOperationStatus` を実装し、定義済みCollection値・scope権限・expectedVersion CASを検証する。create/save/publishはactor・operation ID・同一入力の結果を原子的に記録し、別入力の再利用を拒否する。
- 素材操作を公開するhostは `listAssets` / `listAssetUsages` / `resolveAssets` / `updateAsset` / `createAssetUploadIntent` / `deleteAsset` / `restoreAsset` を実装し、provider・site・actorの権限、実データのMIME/サイズ/内容、expectedVersion、使用中素材を保存層で検証する。一時tokenは一つのassetと一回のPUTに限定し、actor・委任元・asset ID・version・結果を監査する。
- actor、委任元、操作ID、対象、対象version、結果をホストの監査記録へ原子的に結び付ける。公開・配備はそれぞれ別権限の操作としてホストが実装する。

Cookie認証を使うホストは、write requestのCSRF境界とCORSも自分のrouterで強制します。公開HTMLにcredential・内部ID・Git source pathを含めません。Handlerは認証方法、DB、CMS、素材、翻訳、Gitへ依存しないので、Studioを使わないホストも同じ契約を組み込めます。

## 安定エラー

| Error | HTTP | 意味 |
| --- | --- | --- |
| `authentication_required` | 401 | 認証主体を確定できない |
| `forbidden` | 403 | 操作権限がない |
| `duplicate_operation` | 409 | 別の入力または計画に結び付いたoperation IDを再利用した |
| `host_failure` | 503 | ホストの認証/検証context/保存adapterが一時的に失敗した |
| `invalid_request` | 400 | path、query、JSON、PageDocument、確認・再開tokenが契約に合わない |
| `method_not_allowed` | 405 | 操作に定義されていないmethod |
| `not_found` | 404 | 対象または操作が存在しない |
| `validation_failed` | 422 | ホストの値検証に失敗した。CMSでは `fields` に項目別の問題を含む |
| `version_conflict` | 409 | expectedVersionが現行版と一致しない |
| `host_contract_violation` | 502 | ホスト保存層の応答がこの契約に合わない |

## 実装状況

ページ本文・ページ管理・ブレークポイント・CMS項目・素材の共通wireとCUI clientを実装しています。Studio GUIはBFFから、AIの `niho-edit` CLIはサイトoriginへ直接、同じ素材の一覧・参照・更新・アップロード・削除・復元操作を呼びます。どちらもホストの同じ認可・保存・版管理・監査を使います。Studio GUIは短期の操作別tokenだけを委任し、Access cookie/JWTをサイトへ転送しません。旧Studio D1にだけブレークポイント値がある場合は、初回読取でその版をexpectedVersionとしてサイトAPIへ一度だけ移します。以後の読取・保存の正本はサイト側です。翻訳の共通APIは、対応するホストが登録した操作をCUIから直接呼び出せます。Studioの翻訳画面は既存の接続を使います。
