# CMS v2 契約と core

#373。`@niho/web/cms-v2` はホストから独立した型、入力検証、計画と適用の規則を提供します。実際の編集 API は、ホストが認証、Site の所属、認可、永続化、操作記録を実装した時点で利用できます。既存の外部ホストと `CollectionWorkspace` の接続には [CMS v1 の画面と adapter 契約](collection-contract.md) を使います。

## 契約の版と権限

ホストは認証後に Site の CMS を解決し、discover で `siteId`、`contractVersion`、`schemaRevision`、v2 では現在の権限で利用できる `operations` を返します。`discoverCmsContract` に渡す権限は、現在の membership と CLI grant の積集合です。クライアントは `parseCmsDiscovery` で対象 Site と版を照合します。識別子を受け取る各 API でも同じ Site の権限を確認します。

| 操作 | 権限 |
| --- | --- |
| `cms.schema.read` / `cms.schema.plan` / `cms.release.status` / `cms.schedule.status` | `cms.read` |
| `cms.items.save` / `cms.items.remove` / `cms.items.restore` | `cms.edit` |
| `cms.release.plan` / `cms.release.apply` / `cms.schedule.create` / `cms.schedule.cancel` | `cms.publish` |
| `cms.localization.overview` / `cms.localization.items.list` / `cms.localization.items.read` / `cms.localization.release.current` | `cms.read` |
| `cms.localization.items.command` | `cms.edit` |
| `cms.localization.release.plan` / `cms.localization.release.apply` | `cms.publish` |
| `cms.schema.apply` | `cms.schema.apply`（owner のみ） |

v1 の意味は既存の通りです。v2 を使う Site の v1 の書込み入口は、`checkCmsWriteVersion` により本文を処理する前に閉じます。旧クライアントから版番号が届かない場合は v1 と判断します。v2 の項目変更は、読取り時の `expectedSchemaRevision` と `expectedRevision` の両方が必要です。確認付きの適用要求にも `siteId` を含め、scope と照合します。定義・release 操作は v2 の経路だけに公開します。未対応版と競合は区別し、v2 の変更要求を v1 へフォールバックしません。

## 定義と項目

`CmsSchema` は Site、`contractVersion: 2`、`schemaRevision`、コレクション定義、引退済み `fieldId` を持ちます。field は同じコレクション内で不変の `fieldId`、既存画面との接続や人が読む名前に使う `key`、表示する `label` をそれぞれ持ちます。項目の正本の値、定義の `titleField` 等の役割、外部の結び付けには `fieldId` を使います。画面の既存 adapter に値を渡すときだけ現在の `key` に変換します。削除済みの `fieldId` は再利用せず、同じ field を名前変更するときは `fieldId` を引き継ぎます。

値の形は既存の型と共通です。v2 は知らない `fieldId` を拒否します。`CmsItemRevision` は `siteId`、`locale`、`collectionId`、`itemId`、`schemaRevision`、`revision`、`values` を持ちます。保存するたびにホストが不変の `revision` を発行します。`parseCmsDraftWrite` の `save` は当該定義にそろえた全 field の値を扱います。

項目状態は `draftRevision`、`publishedRevision`、`deliveryState`、`schedule`、`tombstone` を分けます。`cmsWorkspaceItem` はこの状態から既存の `status`、`scheduledAt`、`publishFailed` と値を組み立てます。公開中の版と下書きが違えば「変更あり」です。配信中は「反映中」を優先し、予約時刻と失敗は別に表示します。tombstone のある項目は一覧と読取りから外します。削除の前に公開から外し、配信待ちが終わるまで待ち、予約を取り消します。復元で戻るのは以前の下書きです。再公開には新しい release が必要です。

## 版付きルート表

ホストは Site と locale ごとに `CmsRouteTable` を発行し、`revision` を更新します。予約には公開 CMS 項目、CMS またはホスト所有の転送、固定ページ、動的テンプレート、その他の予約 path を含めます。path は query・fragment・末尾 slash のない正規化済み URL path です。CMS はホストの予約を編集しません。

`cms.release.plan` の `routeTableRevision` は必須です。計画時に現在版と違えば conflict を返します。`planCmsRouteTable` は locale の CMS 項目と CMS 所有転送を新しい snapshot に置き換え、固定ページ・テンプレート・予約 path・ホスト所有転送を保持します。固定 path、テンプレートに一致する path、別の CMS 項目、転送元との衝突を見つけた場合は計画を invalid にします。項目の公開 path が前の release から変わった場合は、旧 path から新 path への一段の転送を自動生成します。更新後の予約表はホスト所有の保持分を含め100,000件以下とし、超える計画は `invalid` を返します。snapshot には更新後の完全な route table と転送が入り、release の適用では公開 pointer と route table を同じ CAS で切り替えます。予約実行時にも現在の route table で release 全体を再検証します。

定義移行の入力 `routeTableVersions` は Site の全 locale の現在版を含みます。`planCmsMigrationWithRouteTables` は locale ごとの全 migration item の新 path を予約表と照合し、固定 path、template、予約 path、他の公開 CMS 項目との衝突を計画へ追加します。確認 token は route table の全 locale 版に結び付けられ、適用直前に一致しなければ conflict です。Studio-native は不変 route table を非公開 R2 に保存し、最後に公開した snapshot の revision を D1 の CMS state に保持します。計画時にはStudioで管理する固定・予約 pathを照合し、snapshot に更新後の完全な route table を含めます。

## 定義の移行

1. `cms.schema.plan` に期待する定義の版、全 locale の `routeTableVersions`、完全な次の定義、必要なら項目ごとの変換値を渡します。ホストは Site の全 locale の編集可能な下書きと、ごみ箱から復元できる下書きを読みます。
2. `planCmsMigration` は `fieldId` で対応づけ、追加・名前変更・変換・削除を示します。互換のある型の値は引き継ぎます。変換できない値は対象項目と field を返し、明示的な置換値と再計画が必要です。削除した field の過去値は不変の旧版に残します。削除するコレクションの項目は `removedItems` に元 revision を含め、適用時の再確認まで追跡します。ごみ箱の下書きも新しい定義へ移せますが、生きている項目の参照先にはできません。
3. ホストは `CmsMigrationImpact` で CMS リスト、テンプレート等への結び付けの影響と、公開予定パスの衝突を追加します。確認できる計画だけに期限付きの確認 token を発行します。計画を要求した人が owner に変わっても、別 actor はその token を使えません。owner 本人が plan と apply を行います。
4. `cms.schema.apply` は `checkCmsSchemaApply` で token、Site、actor、期限、現在の定義と下書き、影響の変化を再確認します。ホストは同じ CAS 内で新しい定義の版と移行した下書き、操作受領記録を確定します。まだ書き込まれていない版と保存済み履歴が重複しないよう、版の採番もホストが管理します。

既存の不変 release は移行で書き換えません。新しい定義で release を作る際は、その定義で検証された項目版を明示的に選びます。ホストは `CmsMigrationImpact` の結果を利用して、公開中または予約された項目への影響も計画に出せます。

## Release と予約

`cms.release.plan` は1つの Site と locale の現在の release ID、定義の版、ルート表の版、公開後に含めたい全項目の `collectionId` / `itemId` / `revision`、明示する転送表を固定します。日時 `at` を指定した入力は予約用の確認計画です。対象に残す既存項目の版も選択に含めます。snapshot の順序は項目選択の順序で、ホストは適用時も同じ順序を使います。

`planCmsRelease` は同じ Site、locale、版の項目を読んで公開用に変換します。必須値、同じ snapshot 内の参照先、削除済みの項目、スラッグ、重複 path、版付き route table の衝突を検証します。転送先は公開項目または固定 route です。転送は1回で解決し、転送元は現在の route を占有できません。固定ページ、テンプレート、予約 path、ホスト所有転送との照合は route table を通して行います。slug 変更で自動生成する転送と明示転送の合計は25,000件以下です。上限を超える計画は `invalid` を返します。公開される本文にはホストの無害化と公開素材の検査が必要です。

`cms.release.apply` はサーバーで保持した確認内容を `checkCmsReleaseApply` で再構成し、元の計画と一致する場合に確定します。snapshot の保存後、D1 transaction で受領記録・監査・outbox を確定します。この時点では公開 pointer は前の release のままです。outbox worker は前提を再検証してから、公開 pointer・release 履歴・監査・通知イベント・outbox 完了を一つの transaction で切り替えます。`cms.release.status` は現在の権限を再確認し、同じ Site、actor、操作の受領記録と配信状態（`pending` / `delivered` / `dead`）を返します。完全に同じ request の再送だけ既存結果を返します。同じ ID で異なる操作や入力を送ると conflict です。成功済みの再送は確認期限の判定より先に受領記録を確認します。

`cms.schedule.create` は release で固定した内容と時刻を保存します。実行時は `dueCmsSchedule` と `revalidateCmsRelease` を使い、時刻、公開 pointer、定義、選んだ版の存在、削除、現在のルート制約を確認します。あとから保存した新しい下書きは予約へ混ぜません。前提が変われば失敗を保存し、現在の公開を維持します。取消は未確定の予約だけに適用し、scheduler の実行と競合させないよう CAS を使います。再試行では現在の前提にもとづく新しい計画を確認します。

メモリ内参照ホストと Studio-native の適合テストで認可、永続化、公開、復元を確認できます。Studio の保存順序、容量、バックアップと復元は、運用契約を参照してください。[Studio-native site 契約](studio-managed-sites.md#cms-の公開と復旧)

## CMS 項目の翻訳と locale snapshot

Studio-native CMS は同じ `CmsSchema` と項目の `fieldId` を使い、テキスト・長文・URL・slug の field ID ごとに翻訳 overlay を作ります。Studio は翻訳サービスを接続していないため、訳文は人が入力します。手編集は後の自動候補で上書きせず、原文 fingerprint が変わった訳文は再確認が必要です。安全な parser / serializer を持たない Studio の rich-text field は翻訳項目として扱わず、値が入っている項目を locale snapshot から省きます。

翻訳 workspace は現在の CMS 下書きを原文として表示し、項目を保存・確認します。`cms.localization.release.plan` は原文 locale の公開 snapshot にある項目だけを候補にし、全訳文がその公開版と一致して確認済みの項目を新しい locale revision として固定します。未完了・未確認・原文更新後の項目は公開 snapshot から省き、原文 locale の値へフォールバックしません。`cms.localization.release.apply` は route table と現在の target release を再確認してから、locale 専用の不変 CMS snapshot と公開 pointer を更新します。原文 locale の pointer は変わりません。公開 route は `/{locale}/cms/...` で、固定ページや別 route との衝突を検査します。

CMS 定義は Site ごとに一つです。editor は項目を翻訳して locale snapshot を公開できます。定義の変更・適用は owner のみです。Studio-native の CMS snapshot と固定ページは別の CAS / snapshot で公開し、同じ切替にはまとめません。外部 host も CMS 全体の locale snapshot を一単位として公開します。自サイトの認証、保存先、配信・公開 pointer は host が管理します。

### 公開素材の manifest

画像とギャラリーに保存する値は `{ provider, id }` の安定素材参照です。`collectCmsReleaseAssetReferences` は公開に選んだ項目版から素材参照を集めます。ホストの素材 adapter は対象 Site の素材が存在し、削除されておらず、公開を許可されていることを確認し、該当する素材の公開情報だけを `CmsReleaseContext.publicAssets` に渡します。照合できない素材の情報は返しません。Studio の `CmsStore` には Site と参照一覧を受け取る resolver を接続できます。resolver が未設定の Site では素材付きの公開計画はエラーになります。

公開 snapshot の `assetManifest` は、選んだ版で実際に使用する素材ごとの `reference`、`url`、`width`、`height`、`altText` を含みます。URL は閲覧者が認証なしで利用できる HTTPS URL または配信先と同じ origin のルート相対 URL です。寸法は正の整数または `null` です。素材情報の欠落、未検証の旧 URL、無効な配信情報があれば公開計画を止めます。本文に含まれない下書き素材や adapter が余分に返した素材は manifest に入りません。適用時と Studio の公開切替直前にも公開条件と元の manifest との一致を照合します。

保存済み snapshot は `parseCmsReleaseAssetManifest` で全参照と manifest の一致を確かめます。旧 snapshot に manifest が無い場合、素材参照が無いものは空配列として読めます。Studio の CMS 詳細は manifest の URL、寸法、代替テキストで画像を描画します。下書きプレビューは、認証した actor・Site・項目版に固定された短命の別操作で提供し、素材参照と配信用 URL を含みません。

## Studio-native の HTTP 接続

管理画面は `/api/projects/{projectId}/sites/{siteId}/cms/v2/discover`（GET）と、その `/cms/v2/{operation}`（POST）を使います。機械クライアントには同じ操作を `/api/edit/v2/sites/{siteId}/capabilities`（GET）と `/api/edit/v2/sites/{siteId}/operations/{operation}`（POST）に公開します。POST 本文に `siteId` を含めます。R2 を有効にした Studio-native site のみが対象です。

JSON リクエスト本文は `cms.items.save` が128 KiB、その他の操作が64 KiBまでです。本文全体を UTF-8 のバイト数で数え、上限超過は `400 invalid_request` を返します。

Studio-native の1サイトに保存できる CMS 項目は、全コレクションの復元可能な削除済み項目を含めて200件です。上限を超える作成は `409 quota_exceeded` を返します。公開・予約の1計画には最大200項目と25件の明示転送を指定できます。配信待ちの公開・予約は1サイトで合計25件までです。[Studio-native site の容量制限](studio-managed-sites.md#cms-の公開と復旧)

旧CMSの公開画像URLを移行する場合、ホストは `kamakura-source` provider の安定参照へ変換し、サイト専用の非公開 `CMS_OBJECTS` manifest に URL と公開metadataを保存できます。公開計画は同じサイトのmanifestにあり、許可された安定参照だけを公開snapshotのasset manifestへ含めます。manifestが無い、別サイトのもの、またはURLが契約外の場合は公開を止めます。

| Studio の追加操作 | 入力と結果 |
| --- | --- |
| `cms.items.create` | `collectionId`、`contractVersion: 2`、`expectedSchemaRevision`。空の下書きと不透明な項目ID・revisionを発行 |
| `cms.items.list` | `collectionId`、`deleted`、任意の `cursor`。項目概要と次の cursor を返す。cursor は site・actor・コレクション・ごみ箱の選択・現在世代に固定 |
| `cms.items.read` | `collectionId`、`itemId`。現行の下書き版と項目概要 |
| `cms.release.current` / `cms.release.snapshot` | 現在の公開 snapshot、または `releaseId` で公開済みの snapshot を取得 |
| `cms.localization.overview` / `cms.localization.items.list` / `cms.localization.items.read` | 翻訳対象、項目の安定 unit ID、原文版に対する訳文状態を取得 |
| `cms.localization.items.command` | `set-value` / `review-current` で訳文を保存・確認。項目 overlay 版と原文 revision の両方を CAS で照合 |
| `cms.localization.release.current` / `.plan` / `.apply` | 現在の locale snapshot を読む、新しい snapshot の内容と省略項目を確認し、確認 token を適用 |
| `cms.preview.prepare` / `cms.preview.read` | `collectionId`、`itemId`、現行の `revision` から5分間に1度だけ使える `previewId` を発行し、POST の `previewId` でプレビューを読む。認証中の actor、site、版、定義を照合 |
| `cms.schedule.cancel` / `cms.schedule.status` | `scheduleId` で予約を取り消すか状態を読む。配信開始済みでも公開 pointer 確定前なら取消と配信の CAS で先着のみ成功 |

作成・保存・削除・復元・予約取消は `X-Studio-Operation-Key` に不透明な操作IDを指定します。定義と公開の適用および予約作成は plan に含まれる `operationId` を本文に入れます。D1 が確定済みの同じ actor、site、操作ID、操作、入力には保存済みの同じ受領記録を返します。公開受領は `cms.release.status`、現在反映された版は `cms.release.current` で確認します。予約を作った後の下書き保存は予約版を変更しません。現在の公開版、schema、固定ルートなどの前提が変わった場合、別の確認計画が必要です。

GUI、Access 人トークン、Access サービスの現在の権限を操作ごとに照合します。定義の適用は人の owner のみです。プレビューの参照IDはURLに載せず、ログ・履歴・公開 snapshot にも含めません。読み込み応答は no-store / no-referrer / noindex。使い切った参照ID、期限切れ、対象の下書きが更新された参照IDは404になります。

locale 公開の確認・適用は `niho-edit --studio localization-release-read`、`localization-release-prepare`、`localization-release-apply` からも同じ Studio CMS 操作を呼びます。準備は publish 操作、`releaseId: null`、`resumeToken: null` と一意な `operationId` を入力し、適用は準備済み `confirmationToken` を使います。

既存の共通 `cms.schema` / `cms.list` / `cms.read` には従来の DTO を返します。同じ `/api/edit/v1` の形式で書き込む Studio クライアントは、`X-Studio-CMS-Version: 2` を送ります。このヘッダーによって版を宣言した要求は内部の v2 revision、release、outbox で処理します。宣言のない書込みは `409 unsupported_version` です。公開 apply の受領応答は再送時も保持されます。v2 の `cms.release.status` は受領記録に加えて outbox の `pending` / `delivered` / `dead` と失敗理由を返し、legacy の `cms.operation-status` は配信後の結果を取得できます。

## 外部ホストへの配信

外部ホストは Site 専用の配信資格で、locale ごとの公開 snapshot と通知イベントを読みます。ホストが配備した成果物の ack は Studio の公開状態と独立しており、現行の release ID、snapshot digest、renderer 版を照合します。認証、ETag、通知 cursor、Astro / Next.js のビルド用関数は [外部ホストへの CMS 配信契約](cms-delivery-contract.md) を参照してください。

## PageDocument と CMS の結び付け

`CmsPageBindingsDocument` は `PageDocument` に含めず、ページごとの版付き sidecar として保存します。`schemaVersion: 1`、`siteId`、`pageId`、`locale` に加え、繰り返す list node と collection、上限25件、任意の field filter / sort、node・`fieldId`・target の対応を持てます。detail は collection の slug field を使い、ページ path に slug を足した URL で公開します。field は名前が変わらない `fieldId` で参照します。

対応する `PageEditor` は CMS 項目テンプレートの挿入、field の結び付け、下書きデータのプレビューを行います。プレビューは actor・site・page・文書版・CMS schema revision・item revision に結び付いた5分間の一回限り token を使います。`pages.read` / `pages.inspect` は対応 host だけ `cmsBindings` を返し、`pages.apply` は `pages.cms-bindings` capability を公開する host だけ sidecar の更新を受け付けます。`niho-edit apply --cms-bindings <file|->` は JSON sidecar を追加・置換し、JSON `null` で解除します。空の `operations` と sidecar だけの更新も可能です。

Studio-native は page version row に sidecar を一緒に保存し、公開計画が page publication に CMS `releaseId`、`schemaRevision`、現在の `routeTableRevision` を固定します。公開適用時に route table を読み直し、予約状態が変わっていれば `409 conflict` にして計画を適用しません。公開 HTML はその不変 CMS release の項目から描画し、後の CMS schema / 下書き変更を反映しません。CMS release と固定ページの公開は別々の CAS / snapshot であり、両方をまたぐ原子的な切替はありません。公開計画では list / detail の field 型と node を検証し、detail slug の生成 URL と現在の固定・予約・CMS route を照合します。schema migration は現在のページ sidecar をすべて検査し、影響する bindings を計画へ含めます。過去の公開 page と CMS release は migration で変更しません。

bindings の image mapping は安定 asset reference を使います。ホストがこの参照を公開描画で解決する場合は、[公開素材の manifest](#公開素材の-manifest) に固定された情報を使います。

## CMS 項目の翻訳

CMS v2 の翻訳 identity、下書き overlay、翻訳状態、target locale revision の生成は [CMS翻訳契約](cms-localization-contract.md) を使います。英語の公開 snapshot と素材配信は別の境界で、[素材契約](asset-contract.md) と [外部ホストへの CMS 配信契約](cms-delivery-contract.md) に従います。
