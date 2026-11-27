# NIHO Web Studio 運用

Studio Worker の配備、D1 migration、secret、切り戻しの手順です。画面機能と API 契約は [共通編集 API](../docs/editing-api-contract.md)、[Studio CLI](../docs/studio-cli.md)、[Studio-native site](../docs/studio-managed-sites.md) を参照してください。

## 配備の準備

本番配備は owner の依頼がある場合に行います。同じ環境への配備、migration、切り戻しは同時に行わないでください。Node.js 22.12 以上で `npm ci` を済ませ、対象 Cloudflare account にログインするか、配備に必要な権限を持つ `CLOUDFLARE_API_TOKEN` を実行環境に設定します。Cloudflare の管理画面で Worker、D1、R2、Access application、両方の custom domain を照合します。

次の値を、ローカルの非公開設定または承認済みの secret 管理から実行環境へ渡します。配備スクリプトは非公開の一時ファイルを Wrangler 設定として使い、終了時に削除します。値をリポジトリ、ログ、Issue、PR、shell history に記録しないでください。

| 環境変数 | 設定値 |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | 配備先の Cloudflare account ID |
| `STUDIO_DATABASE_ID` | 既存の Studio D1 database ID |
| `STUDIO_ORIGIN` | Access で保護された Studio の HTTPS origin |
| `PUBLIC_SITES_ORIGIN` | Studio と異なる公開配信用の HTTPS origin |
| `STUDIO_ACCESS_ISSUER` / `STUDIO_ACCESS_AUDIENCE` | Studio の Access JWT の `iss` と application の AUD。Worker では `ACCESS_ISSUER` / `ACCESS_AUDIENCE` |
| `STUDIO_SMOKE_PROJECT_ID` / `STUDIO_SMOKE_SITE_ID` | smoke で開く既存プロジェクトとサイトの ID |
| `STUDIO_SMOKE_PUBLIC_PATH` | 公開中の代表ページの正規パス。 `/s/<site-slug>/` またはその下の公開ページ |
| `STUDIO_SMOKE_ACCESS_TOKEN` | 対象プロジェクトのメンバーが取得した短命の Access application JWT |

HTTPS origin は末尾に `/` を付けずに指定します。公開ページはリダイレクト後の URL のパスを指定します。JWT は [Cloudflare Access の CLI 手順](https://developers.cloudflare.com/cloudflare-one/tutorials/cli/) で取得できます。shell のトレースを無効にして実行し、JWT は配備用のサブシェル内に保持します。

```sh
(
  STUDIO_SMOKE_ACCESS_TOKEN="$(cloudflared access token -app="$STUDIO_ORIGIN")" || exit
  export STUDIO_SMOKE_ACCESS_TOKEN
  npm run studio:release
)
```

管理済みの JWT を実行環境に渡せる場合は、直接 `npm run studio:release` を実行します。Access service token は Dashboard のメンバー認証に使えません。`studio:deploy` も同じ配備手順を実行します。

## 配備と smoke

1. `npm test`（パッケージの build と全テスト）、`npm run studio:typecheck`、`npm run studio:build` を実行します。
2. 切り戻し先、Worker secret、Access セッション、Dashboard API のメンバー権限を確認します。現在の Worker は単一 version が 100% のトラフィックを受けている必要があります。
3. Wrangler で D1 の適用状況を確認し、配備前に適用できる未適用 migration があれば適用します。再確認で未適用が 0 件になってから配備します。
4. Wrangler で Worker と静的 asset を配備します。
5. `/api/session`、対象 Dashboard の API と HTML、今回のビルドと一致する entry script と Dashboard の遅延読込 chunk、代表公開ページの `og:url` を確認します。認証情報は Studio のリクエストにだけ付け、リダイレクトは追跡しません。

失敗したステップを表示し、終了コードは非 0 になります。配備を開始した後の失敗では、切り戻し手順も表示します。

## D1 migration

SQL の正本は `studio/migrations/` です。適用済みの SQL は保持し、修正は新規 migration を追加します。配備前に、対象 D1 と復元できるバックアップがあることを確認します。

- 新 Worker の配備前に実行できるのは、旧 Worker の読み書きがそのまま動く列、表、index の追加だけです。既存行と旧 Worker が使う INSERT・UPDATE・SELECT を確認した SQL を、`studio/release.mjs` の `beforeDeployMigrations` に追加します。未登録の migration が保留中なら配備を止めます。
- 列や表の削除、既存データの意味や制約の変更は、新 Worker が安定して旧 schema に依存する version が切り戻し対象から外れた後、別の release で行います。対象 D1 のバックアップと復元手順を確認し、その作業用の非公開 Wrangler 設定で `d1 migrations list DB --remote` と `d1 migrations apply DB --remote` を使います。
- `0014` までの履歴 migration は事前適用済みであることを前提にしています。空の D1 の初期化は、既存 Worker への通常配備と別に行います。

## Worker secret と設定診断

`KAMAKURA_STUDIO_BRIDGE_SECRET` を事前に設定します。CMS delivery を使う環境では `CMS_DELIVERY_MASTER_KEY` も設定します。値は Wrangler の対話入力または承認済みの secret 管理を使って設定し、環境ごとに分けます。

```sh
WRANGLER_WRITE_LOGS=false npx wrangler secret put <SECRET_NAME> --name niho-web-studio
```

Worker は最初の HTTP または cron イベントで設定を確認します。必要な binding、Access 設定、公開 origin、Kamakura bridge・CMS delivery の鍵に不足や形式違いがあると、設定名だけをエラーログに出します。cron は 5 分ごとに実行します。

## Worker と asset の切り戻し

配備直前の version ID は `studio/.studio-rollback-version` に保存されます。切り戻しの前に配備履歴を開き、問題の version が現在有効であることを確認します。同じ Cloudflare account で次を実行します。

```sh
npx wrangler rollback "$(cat studio/.studio-rollback-version)" --name niho-web-studio
```

ローカルに記録がない場合は、Cloudflare 管理画面の Deployments から問題の配備の直前に有効だった version に戻します。切り戻し後は新しく開いた Dashboard、参照される entry script と遅延読込 chunk、代表公開ページを確認します。asset が揃わない場合は既知の正常な source SHA の bundle を使い、同じ配備手順で反映します。詳細は [Cloudflare の Worker rollback 手順](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) を参照してください。

D1 に適用した migration は残ります。D1 の復元が必要な場合は、確認済みのバックアップから復元し、参照先 object との整合性を検証します。

## ローカル開発

`studio/wrangler.json` は `npm run studio:dev` 用です。ローカル D1 を用意するには `npx wrangler d1 migrations apply DB --local --config studio/wrangler.json` を実行します。ローカルで認証や接続を確認する場合は、開発用の設定や値を `studio/.dev.vars` に渡します。
