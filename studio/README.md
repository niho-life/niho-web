# Studio Worker の運用

Cloudflare にログイン済みの運用者が、リポジトリのルートから実行します。Node.js 22 以上と Wrangler CLI が必要です。

## 配備と D1 migration

1. [Wrangler 設定](wrangler.toml)の account、D1 binding、custom domain を対象環境と照合します。管理 origin の Cloudflare Access application の hostname、issuer、AUD、スタッフの許可ポリシーも照合します。
2. Studio 管理サイトを配信する環境では、管理画面と別の共有 HTTPS origin を `PUBLIC_SITES_ORIGIN` に設定します。値に path は含めません。外部サイトへ接続する環境では、先に接続先を配備し、同じ環境の service binding または API と secret の組で接続できることを確認します。
3. 未適用の [D1 migration](migrations/) と既存データへの影響を確認し、Worker の配備に先立ち適用します。配備前に現在の Worker version と対応する Git SHA を記録します。

```sh
npm ci
npm run studio:typecheck
npm run studio:build
wrangler d1 migrations list niho-web-studio --remote --config studio/wrangler.toml
wrangler d1 migrations apply niho-web-studio --remote --config studio/wrangler.toml
wrangler deploy --config studio/wrangler.toml
```

配備された Worker version を確認し、Chrome で Studio を再読み込みします。Access 認証後に Dashboard と各サイトで有効な CMS・翻訳などの遅延読み込み画面を開き、新しい JS と CSS が読み込まれることを確かめます。接続先も変更した場合は、対象環境の受入用データで読み取り・保存・公開の接続を確認します。

ローカル確認は `npm run studio:dev` で実行できます。Worker の Access JWT 検証はローカルでも有効です。

## 切り戻し

Worker と静的アセットの組を、記録した Git SHA の状態へ戻します。旧 Worker へ切り戻した後に旧 chunk が取得できない場合は、記録した版から `npm ci`・`npm run studio:build` を実行し、旧 chunk を含むアセットと Worker を一緒に再配備します。配備時と同じ画面で読み込みを再確認してください。

Worker の切り戻し後も D1 の適用済み migration は残ります。旧 Worker と適用済みスキーマの互換性を事前に確認し、データ復旧が必要な場合は対象環境の D1 復旧手順を使います。

## Secrets

有効な接続に必要な Worker secret を対話入力で設定します。

```sh
wrangler secret put KAMAKURA_STUDIO_BRIDGE_SECRET --config studio/wrangler.toml
wrangler secret put NIHO_STUDIO_BRIDGE_SECRET --config studio/wrangler.toml
wrangler secret put NIHO_STUDIO_BRIDGE_SECRET_STG --config studio/wrangler.toml
wrangler secret put STUDIO_ANALYTICS_GOOGLE_SA_JSON --config studio/wrangler.toml
```

ブリッジの値は接続先と一致させ、サイト間・本番と STG の間では別の値を使います。分析用には読み取り権限のサービスアカウントの JSON 鍵を設定します。値、実アドレス、認証情報はコマンド引数、リポジトリ、ログに残しません。
