# Studio CLI

Studioの操作を、権限を委任されたクライアントがNode.js 22以上から非対話で実行する。対象の操作と権限はサイト単位のcapabilitiesで取得する。CLIのAPIは `/api/cli/v1/` 配下で版を固定する。操作の入力と結果は既存のStudio契約を共有する。

## 実行方法

パッケージが提供する `niho-studio` を使用する。既存の外部ホストは運用環境のシークレット管理から `CF_ACCESS_CLIENT_ID` と `CF_ACCESS_CLIENT_SECRET` を渡す。Studioで新規作成したmanaged projectは、人がCloudflare Accessへログインして取得した短時間の `CF_ACCESS_TOKEN` を渡す。2つの認証方式は同時に指定しない。実行例のサイトとプロジェクトは架空の値。

```sh
niho-studio --origin https://studio.example --project demo-project --site demo-site discover
niho-studio --origin https://studio.example --project demo-project --site demo-site request pages.read home
niho-studio --origin https://studio.example --project demo-project --site demo-site request pages.save home --json draft.json
niho-studio --origin https://studio.example --project demo-project --site demo-site request translations.overview --json -
```

最後の例では標準入力に `{}` を渡す。`--json FILE` は操作に渡す既存APIのJSON本文。対象サイトと一致するHTTPSオリジンを指定する。CLIは認証情報を指定オリジンだけに送信し、リダイレクトは追跡しない。

標準出力は `apiVersion`、`httpStatus`、`operationId`、`result` を含むJSON。監査記録に対応する応答には `X-Studio-Operation-Id` があり、CLIはこれを `operationId` として返す。応答に識別子がないときは `null`。終了コードは成功が `0`、HTTPまたは通信エラーが `1`、引数・入力の誤りが `2`。翻訳など、HTTP 200で `conflict` や `blocked` を返す契約では `result.status` も確認する。

## 認証と委任

既存の外部ホストはCloudflare AccessのService Authで認証する。StudioはAccessが署名したアプリケーションJWTの発行者、audience、期限、署名とサービスのClient IDを検証する。Studioの操作権限はAccessポリシーと分離し、D1でサイトごとの委任と期限を検証する。CloudflareでのService Authの設定方法は [Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) を参照する。

Studio-native siteでもoperatorが既に設定したservice grantは同じ仕組みで使えるが、新規作成時にservice grantを自動発行しない。grantがない場合は作成者または現在のmember本人が、[CloudflareのCLI手順](https://developers.cloudflare.com/cloudflare-one/tutorials/cli/)に従ってapplication tokenを取得する。

```sh
export CF_ACCESS_TOKEN="$(cloudflared access token -app=https://studio.example)"
niho-studio --origin https://studio.example --project demo-project --site demo-site discover
```

CLIはこの値を `cf-access-token` headerだけに入れ、標準出力へ出さない。Workerはブラウザと同じ署名済みAccess JWTの検証後、tokenのhuman subjectと現在のD1 owner/editor membershipを毎回照合する。ブラウザcookieから付く `Cf-Access-Jwt-Assertion` だけではmanaged CLIを認可しない。tokenはAccess applicationのsession期間で失効するため、期限切れなら再取得する。

サービスの識別子はホストへの署名と監査に利用する。委任元は別に記録する。クライアントがactorを指定することはできない。既存のブラウザ経路は人のAccessログインと同一オリジンの検証を行う。

既存のservice認証では、配備前にStudioのD1 migrationを0009まで適用する。Studio運用担当は、認証済みのプロジェクトownerから委任を受けたことを確認し、`studio_cli_grants` へ必要な権限を1行ずつ登録する。各行は `client_id`、`project_id`、`site_id`、`capability`、`delegated_by_subject`、`expires_at` を持つ。`expires_at` はUnix秒の期限か、無期限を表す `NULL` を指定する。Client SecretはD1に格納しない。編集・公開・レビュー・翻訳サービス起動・サイト管理は個別に付与する。委任行の削除、期限切れ、委任元のowner権限の喪失が次回リクエストから反映される。Studio-native siteは0011も適用し、service grantがなければ上記のhuman tokenと現在membershipを使う。

利用可能な操作名と必要権限は `discover` で確認する。APIでは `GET /api/cli/v1/projects/:projectId/sites/:siteId/capabilities` に対応し、操作実行は `.../operations/:operation[/…]` を使う。操作名・メソッド・引数は[操作定義](../cli/operations.mjs)の許可リストで決まる。Studioは任意の上流URLやブラウザAPIのパスを受け取らない。CLIの権限は `discover` の結果を使う。

確認用Studioでは、ホストの確認用WorkerをService Bindingに設定し、`KAMAKURA_CLI_PREVIEW_ORIGIN` にそのHTTPSオリジンを指定する。ページ・CMS・翻訳はその確認用Workerへ接続する。ページ一覧・翻訳プレビュー・画像アップロード許可が返すURLも、設定したオリジンと照合する。確認用Studioには専用のAccessアプリとD1を使い、ホストのGitブランチとR2も本番と分ける。

## サイト設定とメンバー管理

`site.breakpoints.read` でブレークポイント設定と版を取得し、`site.breakpoints.save` に `settings` と `expectedVersion` を渡す。409のときは現在の設定を取り直す。変更前の `settings` を保存しておけば、取得し直した版を使って元に戻せる。

`site.members.read` でメンバーと招待を取得する。メンバーの役割変更・削除は `site.members.role` と `site.members.remove`、招待の発行・取消は `site.invitations.create` と `site.invitations.revoke` を使う。招待の受理には招待された本人のAccess認証が必要。サイト設定とメンバー管理は読み取り・変更をそれぞれ委任し、変更の監査には機械クライアント自身を記録する。

## 編集と公開

編集は対象の最新状態と版を読み、既存の保存契約へ変更と版を渡す。公開の確認計画で対象サイト、ページ、差分、版を照合し、その計画を公開に適用する。競合時は最新版と手元の変更を比較してから再実行する。

Gitから原文が更新されてページの下書きが競合した場合は、`pages.draft-conflict <pageId>` の `published` と `draft` を保存して比較する。調整後の文書は下書きの `revision` を使い、取得した `version` を `expectedVersion` として `pages.draft-resolve <pageId>` に渡す。どちらの操作にもページの編集権限が必要。解消後は通常の公開手順を使う。

公開処理の成功は、配備や公開URLでの反映完了と区別する。ホストがビルドを行う場合は、配備結果と公開URLまで確認する。翻訳の確認と公開は、対象サイトの承認方針と権限に従う。

`discover` にページの予約操作があるサイトでは、`pages.release-plan <pageId>` の公開計画から `confirmationToken` と版を取り、`pages.schedule <pageId>` にUTCのISO 8601日時を `scheduledAt` として添える。予約を `pages.schedule-status <pageId>` で取得し、待機中なら取得した `version` を `expectedVersion` として `pages.schedule-cancel <pageId>` に渡せる。ホストが公開を受理したあとに、配備結果と公開URLを確認する。元の版への復元には通常の公開計画と適用を使う。

## 操作の応答を受け取れなかった場合

配備前に `studio/migrations/0008_cli_operation_keys.sql` を適用する。操作を送る前にUUID v4を作り、対象サイト、操作、入力の版と合わせて保存する。例では `STUDIO_OPERATION_KEY` に保存済みのUUIDを指定する。

```sh
niho-studio --origin https://studio.example --project demo-project --site demo-site \
  request pages.release home --operation-id "$STUDIO_OPERATION_KEY" --json release.json
niho-studio --origin https://studio.example --project demo-project --site demo-site \
  status "$STUDIO_OPERATION_KEY"
```

`--operation-id` はリクエストの照会に使うキー。応答の `operationId` はStudioが発行する監査ID。Studioは同じ機械クライアント・プロジェクト・サイトで同じキーを使った操作を一度だけ受け付ける。重複リクエストは `duplicate_operation` を返す。照会時にも同じサイトの操作権限を検証する。

`status` は `result.status` に、受付済みの `received` またはHTTP結果を記録済みの `completed` を返す。後者では `result.httpStatus` を確認する。Studioが受付済みなら、ホストの公開版・履歴と配備結果を照合してから次の操作を判断する。アップロードで照会できるのはStudioのアップロード許可の受付までで、転送先へのPUTの結果は素材一覧またはホストの状態で確認する。

## 素材のアップロード

`discover` の操作に `upload` がある場合、`upload` コマンドでアップロード許可の取得とファイルの転送を行う。例のアップロード先は架空の値。実際にはホストが指定したHTTPSオリジンを使用する。

```sh
printf '%s\n' '{"collectionId":"articles","mimeType":"image/png"}' |
  niho-studio --origin https://studio.example --project demo-project --site demo-site \
  upload cms.upload-intent --upload-origin https://media.example --file cover.png --json -
```

JSONの項目は既存のアップロード許可と同じ。`name` の既定値はファイル名で、`bytes` はCLIがファイルのサイズから指定する。共通の素材には `assets.upload-intent`、翻訳の差し替え画像には `translations.upload-intent` を使う。転送先のオリジンとパスを照合し、転送には短時間だけ有効なアップロード用トークンを使う。

確認環境では `--upload-origin` に `KAMAKURA_CLI_PREVIEW_ORIGIN` と同じオリジンを指定する。ホスト側でも確認用Studioと確認用アップロード先を設定し、専用の素材ストレージを接続する。

`assets.state` には `siteId` と `reference` を渡す。ホストが `assets.delete` と `assets.restore` を提供する場合は、その結果の `version` を `expectedVersion` に指定する。削除後も復元に必要な素材データをホストが保持する。利用中の素材の扱いと、公開済みファイルの保持はホストの契約に従う。

`pages.batch-stage` は `pages.release-plan` のトークンと版を使い、公開原稿と素材・埋め込みの参照を一括公開用に固定します。必要な委任は `pages.publish` です。 `cms.migration-preflight` は型変換する `cmsMigrations` を受け取り、保存済みの下書き・予約を検査します。必要な委任は `cms.publish` です。返された結果を、サイト側のGit公開計画に渡します。
