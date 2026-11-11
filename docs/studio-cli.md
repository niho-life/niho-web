# Studio CLI

Studioの操作を、権限を委任されたクライアントがNode.js 22以上から非対話で実行する。対象の操作と権限はサイト単位のcapabilitiesで取得する。CLIのAPIは `/api/cli/v1/` 配下で版を固定する。操作の入力と結果は既存のStudio契約を共有する。

## 実行方法

パッケージが提供する `niho-studio` を使用する。運用環境のシークレット管理から `CF_ACCESS_CLIENT_ID` と `CF_ACCESS_CLIENT_SECRET` を環境変数として渡す。実行例のサイトとプロジェクトは架空の値。

```sh
niho-studio --origin https://studio.example --project demo-project --site demo-site discover
niho-studio --origin https://studio.example --project demo-project --site demo-site request pages.read home
niho-studio --origin https://studio.example --project demo-project --site demo-site request pages.save home --json draft.json
niho-studio --origin https://studio.example --project demo-project --site demo-site request translations.overview --json -
```

最後の例では標準入力に `{}` を渡す。`--json FILE` は操作に渡す既存APIのJSON本文。対象サイトと一致するHTTPSオリジンを指定する。CLIは認証情報を指定オリジンだけに送信し、リダイレクトは追跡しない。

標準出力は `apiVersion`、`httpStatus`、`operationId`、`result` を含むJSON。監査記録に対応する応答には `X-Studio-Operation-Id` があり、CLIはこれを `operationId` として返す。応答に識別子がないときは `null`。終了コードは成功が `0`、HTTPまたは通信エラーが `1`、引数・入力の誤りが `2`。翻訳など、HTTP 200で `conflict` や `blocked` を返す契約では `result.status` も確認する。

## 認証と委任

Cloudflare AccessのService Authで認証する。StudioはAccessが署名したアプリケーションJWTの発行者、audience、期限、署名とサービスのClient IDを検証する。Studioの操作権限はAccessポリシーと分離し、D1でサイトごとの委任と期限を検証する。CloudflareでのService Authの設定方法は [Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) を参照する。

サービスの識別子はホストへの署名と監査に利用する。委任元は別に記録する。クライアントがactorを指定することはできない。既存のブラウザ経路は人のAccessログインと同一オリジンの検証を行う。

配備前に `studio/migrations/0007_cli_grants.sql` を適用する。Studio運用担当は、認証済みのプロジェクトownerから委任を受けたことを確認し、`studio_cli_grants` へ必要な権限を1行ずつ登録する。各行は `client_id`、`project_id`、`site_id`、`capability`、`delegated_by_subject`、期限 `expires_at`（Unix秒）を持つ。Client SecretはD1に格納しない。編集・公開・レビュー・翻訳サービス起動は個別に付与する。委任行の削除、期限切れ、委任元のowner権限の喪失が次回リクエストから反映される。

利用可能な操作名と必要権限は `discover` で確認する。APIでは `GET /api/cli/v1/projects/:projectId/sites/:siteId/capabilities` に対応し、操作実行は `.../operations/:operation[/…]` を使う。操作名・メソッド・引数は[操作定義](../cli/operations.mjs)の許可リストで決まる。Studioは任意の上流URLやブラウザAPIのパスを受け取らない。CLIの権限は `discover` の結果を使う。

## 編集と公開

編集は対象の最新状態と版を読み、既存の保存契約へ変更と版を渡す。公開の確認計画で対象サイト、ページ、差分、版を照合し、その計画を公開に適用する。競合時は最新版と手元の変更を比較してから再実行する。公開時に応答が得られなかった場合は、現在の公開版とホストの配備状況を照合する。

公開処理の成功は、配備や公開URLでの反映完了と区別する。ホストがビルドを行う場合は、配備結果と公開URLまで確認する。翻訳の確認と公開は、対象サイトの承認方針と権限に従う。

現在の対応は接続済みのページ文書、CMS項目、素材のメタ情報、翻訳の操作。素材本体の転送、サイトのソース編集、管理機能の追加は #270 の後続で扱う。
