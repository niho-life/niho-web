# CMS v2 契約と core

#373。`@niho/web/cms-v2` はホストから独立した型、入力検証、計画と適用の規則を提供します。実際の編集 API は、ホストが認証、Site の所属、認可、永続化、操作記録を実装した時点で利用できます。既存の外部ホストと `CollectionWorkspace` の接続には [CMS v1 の画面と adapter 契約](collection-contract.md) を使います。

## 契約の版と権限

ホストは認証後に Site の CMS を解決し、discover で `siteId`、`contractVersion`、`schemaRevision`、v2 では現在の権限で利用できる `operations` を返します。`discoverCmsContract` に渡す権限は、現在の membership と CLI grant の積集合です。クライアントは `parseCmsDiscovery` で対象 Site と版を照合します。識別子を受け取る各 API でも同じ Site の権限を確認します。

| 操作 | 権限 |
| --- | --- |
| `cms.schema.read` / `cms.schema.plan` / `cms.release.status` / `cms.schedule.status` | `cms.read` |
| `cms.items.save` / `cms.items.remove` / `cms.items.restore` | `cms.edit` |
| `cms.release.plan` / `cms.release.apply` / `cms.schedule.create` / `cms.schedule.cancel` | `cms.publish` |
| `cms.schema.apply` | `cms.schema.apply`（owner のみ） |

v1 の意味は既存の通りです。v2 を使う Site の v1 の書込み入口は、`checkCmsWriteVersion` により本文を処理する前に閉じます。旧クライアントから版番号が届かない場合は v1 と判断します。v2 の項目変更は、読取り時の `expectedSchemaRevision` と `expectedRevision` の両方が必要です。確認付きの適用要求にも `siteId` を含め、scope と照合します。定義・release 操作は v2 の経路だけに公開します。未対応版と競合は区別し、v2 の変更要求を v1 へフォールバックしません。

## 定義と項目

`CmsSchema` は Site、`contractVersion: 2`、`schemaRevision`、コレクション定義、引退済み `fieldId` を持ちます。field は同じコレクション内で不変の `fieldId`、既存画面との接続や人が読む名前に使う `key`、表示する `label` をそれぞれ持ちます。項目の正本の値、定義の `titleField` 等の役割、外部の結び付けには `fieldId` を使います。画面の既存 adapter に値を渡すときだけ現在の `key` に変換します。削除済みの `fieldId` は再利用せず、同じ field を名前変更するときは `fieldId` を引き継ぎます。

値の形は既存の型と共通です。v2 は知らない `fieldId` を拒否します。`CmsItemRevision` は `siteId`、`locale`、`collectionId`、`itemId`、`schemaRevision`、`revision`、`values` を持ちます。保存するたびにホストが不変の `revision` を発行します。`parseCmsDraftWrite` の `save` は当該定義にそろえた全 field の値を扱います。

項目状態は `draftRevision`、`publishedRevision`、`deliveryState`、`schedule`、`tombstone` を分けます。`cmsWorkspaceItem` はこの状態から既存の `status`、`scheduledAt`、`publishFailed` と値を組み立てます。公開中の版と下書きが違えば「変更あり」です。配信中は「反映中」を優先し、予約時刻と失敗は別に表示します。tombstone のある項目は一覧と読取りから外します。削除の前に公開から外し、配信待ちが終わるまで待ち、予約を取り消します。復元で戻るのは以前の下書きです。再公開には新しい release が必要です。

## 定義の移行

1. `cms.schema.plan` に期待する定義の版、完全な次の定義、必要なら項目ごとの変換値を渡します。ホストは Site の全 locale の編集可能な下書きと、ごみ箱から復元できる下書きを読みます。
2. `planCmsMigration` は `fieldId` で対応づけ、追加・名前変更・変換・削除を示します。互換のある型の値は引き継ぎます。変換できない値は対象項目と field を返し、明示的な置換値と再計画が必要です。削除した field の過去値は不変の旧版に残します。削除するコレクションの項目は `removedItems` に元 revision を含め、適用時の再確認まで追跡します。ごみ箱の下書きも新しい定義へ移せますが、生きている項目の参照先にはできません。
3. ホストは `CmsMigrationImpact` で CMS リスト、テンプレート等への結び付けの影響と、公開予定パスの衝突を追加します。確認できる計画だけに期限付きの確認 token を発行します。計画を要求した人が owner に変わっても、別 actor はその token を使えません。owner 本人が plan と apply を行います。
4. `cms.schema.apply` は `checkCmsSchemaApply` で token、Site、actor、期限、現在の定義と下書き、影響の変化を再確認します。ホストは同じ CAS 内で新しい定義の版と移行した下書き、操作受領記録を確定します。まだ書き込まれていない版と保存済み履歴が重複しないよう、版の採番もホストが管理します。

既存の不変 release は移行で書き換えません。新しい定義で release を作る際は、その定義で検証された項目版を明示的に選びます。ホストは `CmsMigrationImpact` の結果を利用して、公開中または予約された項目への影響も計画に出せます。

## Release と予約

`cms.release.plan` は1つの Site と locale の現在の release ID、定義の版、公開後に含めたい全項目の `collectionId` / `itemId` / `revision`、転送表を固定します。日時 `at` を指定した入力は予約用の確認計画です。対象に残す既存項目の版も選択に含めます。snapshot の順序は選択の順序で、ホストは適用時も同じ順序を使います。

`planCmsRelease` は同じ Site、locale、版の項目を読んで公開用に変換します。必須値、同じ snapshot 内の参照先、削除済みの項目、スラッグ、重複パスを検証します。転送元は空いているパス、転送先は公開項目のパスです。転送は1回で解決します。固定ページ、テンプレート、予約パス等との衝突は `CmsReleaseImpact` で照合します。公開される本文にはホストの無害化と公開素材の検査が必要です。画像とギャラリーは安定素材参照を使い、プレビュー URL を含む旧 URL 値を公開 release に持ち込みません。素材の公開 manifest と配信は #379 / #380 で扱います。

`cms.release.apply` はサーバーで保持した確認内容を `checkCmsReleaseApply` で再構成し、元の計画と一致する場合に確定します。snapshot の保存後、D1 transaction で受領記録・監査・outbox を確定します。この時点では公開 pointer は前の release のままです。outbox worker は前提を再検証してから、公開 pointer・release 履歴・監査・outbox 完了を一つの transaction で切り替えます。`cms.release.status` は現在の権限を再確認し、同じ Site、actor、操作の受領記録と配信状態（`pending` / `delivered` / `dead`）を返します。完全に同じ request の再送だけ既存結果を返します。同じ ID で異なる操作や入力を送ると conflict です。成功済みの再送は確認期限の判定より先に受領記録を確認します。

`cms.schedule.create` は release で固定した内容と時刻を保存します。実行時は `dueCmsSchedule` と `revalidateCmsRelease` を使い、時刻、公開 pointer、定義、選んだ版の存在、削除、現在のルート制約を確認します。あとから保存した新しい下書きは予約へ混ぜません。前提が変われば失敗を保存し、現在の公開を維持します。取消は未確定の予約だけに適用し、scheduler の実行と競合させないよう CAS を使います。再試行では現在の前提にもとづく新しい計画を確認します。

メモリ内参照ホストと Studio-native の適合テストで認可、永続化、公開、復元を確認できます。Studio の保存順序、容量、バックアップと復元は、運用契約を参照してください。[Studio-native site 契約](studio-managed-sites.md#cms-の公開と復旧)

## Studio-native の HTTP 接続

管理画面は `/api/projects/{projectId}/sites/{siteId}/cms/v2/discover`（GET）と、その `/cms/v2/{operation}`（POST）を使います。機械クライアントには同じ操作を `/api/edit/v2/sites/{siteId}/capabilities`（GET）と `/api/edit/v2/sites/{siteId}/operations/{operation}`（POST）に公開します。POST 本文に `siteId` を含めます。R2 を有効にした Studio-native site のみが対象です。

| Studio の追加操作 | 入力と結果 |
| --- | --- |
| `cms.items.create` | `collectionId`、`contractVersion: 2`、`expectedSchemaRevision`。空の下書きと不透明な項目ID・revisionを発行 |
| `cms.items.list` | `collectionId`、`deleted`、任意の `cursor`。項目概要と次の cursor を返す。cursor は site・actor・コレクション・ごみ箱の選択・現在世代に固定 |
| `cms.items.read` | `collectionId`、`itemId`。現行の下書き版と項目概要 |
| `cms.release.current` / `cms.release.snapshot` | 現在の公開 snapshot、または `releaseId` で公開済みの snapshot を取得 |
| `cms.preview.prepare` / `cms.preview.read` | `collectionId`、`itemId`、現行の `revision` から5分間に1度だけ使える `previewId` を発行し、POST の `previewId` でプレビューを読む。認証中の actor、site、版、定義を照合 |
| `cms.schedule.cancel` / `cms.schedule.status` | `scheduleId` で予約を取り消すか状態を読む。配信開始済みでも公開 pointer 確定前なら取消と配信の CAS で先着のみ成功 |

作成・保存・削除・復元・予約取消は `X-Studio-Operation-Key` に不透明な操作IDを指定します。定義と公開の適用および予約作成は plan に含まれる `operationId` を本文に入れます。D1 が確定済みの同じ actor、site、操作ID、操作、入力には保存済みの同じ受領記録を返します。公開受領は `cms.release.status`、現在反映された版は `cms.release.current` で確認します。予約を作った後の下書き保存は予約版を変更しません。現在の公開版、schema、固定ルートなどの前提が変わった場合、別の確認計画が必要です。

GUI、Access 人トークン、Access サービスの現在の権限を操作ごとに照合します。定義の適用は人の owner のみです。プレビューの参照IDはURLに載せず、ログ・履歴・公開 snapshot にも含めません。読み込み応答は no-store / no-referrer / noindex。使い切った参照ID、期限切れ、対象の下書きが更新された参照IDは404になります。

既存の共通 `cms.schema` / `cms.list` / `cms.read` には従来の DTO を返します。同じ `/api/edit/v1` の形式で書き込む Studio クライアントは、`X-Studio-CMS-Version: 2` を送ります。このヘッダーによって版を宣言した要求は内部の v2 revision、release、outbox で処理します。宣言のない書込みは `409 unsupported_version` です。公開 apply の受領応答は再送時も保持されます。v2 の `cms.release.status` は受領記録に加えて outbox の `pending` / `delivered` / `dead` と失敗理由を返し、legacy の `cms.operation-status` は配信後の結果を取得できます。
